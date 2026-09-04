// SPDX-License-Identifier: GPL-3.0-only
/**
 * Wires the whole data plane for the demo:
 *
 *   OrbitDB (browser) → courier-sync (orbitdb-storacha-bridge, MIT seam)
 *   → meshtastic courier (framing · ARQ · duty-cycle pacing, this repo)
 *   → a link: Web Bluetooth to a real node, or a BroadcastChannel fake.
 *
 * The libp2p node here exists only because Helia wants one — it listens
 * nowhere, dials nobody, and every database is opened with `sync: false`.
 * Every replicated byte travels through the courier or not at all.
 */

import { createLibp2p } from "libp2p";
import { webSockets } from "@libp2p/websockets";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { createHelia } from "helia";
import { MemoryBlockstore } from "blockstore-core";
import { MemoryDatastore } from "datastore-core";
import { createOrbitDB, IPFSAccessController } from "@orbitdb/core";
import { createCourierSync } from "orbitdb-storacha-bridge/courier-sync";
import * as dagCbor from "@ipld/dag-cbor";
import {
  createMeshtasticCourier,
  createMeshtasticDeviceLink,
  watchDeviceRegion,
  watchAirUtilTx,
  watchDeviceStatus,
  watchNodeInfo,
  watchChannels,
  watchMyNodeInfo,
} from "@le-space/funkpost";
import { createBroadcastChannelLink } from "./fake-bc-link.js";

const INVITE_VERSION = 1;

/** One OrbitDB per tab; memory stores, so Reset is a reload. */
export async function createDatabaseStack() {
  const libp2p = await createLibp2p({
    addresses: { listen: [] },
    transports: [webSockets()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
  });
  const helia = await createHelia({
    libp2p,
    blockstore: new MemoryBlockstore(),
    datastore: new MemoryDatastore(),
  });
  const id = `mesh-todo-${Math.random().toString(36).slice(2, 10)}`;
  const orbitdb = await createOrbitDB({ ipfs: helia, id, directory: `./${id}` });
  return { libp2p, helia, orbitdb };
}

/**
 * Connect the radio side. `mode.kind === "bc"` uses the BroadcastChannel fake
 * (two tabs, no hardware); anything else opens the Web Bluetooth chooser —
 * which must be called from a user gesture.
 */
const MESHTASTIC_BLE_SERVICE = "6ba1b218-15a8-461f-9fa8-5dcae273eafd";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function connectCourier({ mode, onEvent, onTelemetry, onStatus, onNodeInfo, onChannel, onMyNodeInfo, onRegion, onError, onReconnecting, onReconnected, onGaveUp }) {
  if (mode.kind === "bc") {
    const link = createBroadcastChannelLink({ room: mode.room, loss: mode.loss });
    // preset only changes the airtime *estimates* (and with them the ARQ's
    // patience) — e2e uses SHORT_TURBO so lossy runs heal at test pace.
    const courier = createMeshtasticCourier({
      link,
      region: "EU_868",
      preset: mode.preset,
      onEvent,
    });
    return {
      courier,
      kind: "BroadcastChannel (fake mesh)",
      region: "EU_868",
      device: null,
      setTxChannel: () => {},
    };
  }

  const [{ TransportWebBluetooth }, { MeshDevice }] = await Promise.all([
    import("@meshtastic/transport-web-bluetooth"),
    import("@meshtastic/core"),
  ]);
  // Request the device ourselves (rather than TransportWebBluetooth.create,
  // which hides it) so we hold the BluetoothDevice and can reconnect to it
  // later without a chooser — the phone's BLE stack drops the GATT link under
  // load, and we must be able to bring it straight back.
  const bleDevice = await navigator.bluetooth.requestDevice({
    filters: [{ services: [MESHTASTIC_BLE_SERVICE] }],
  });
  const newMeshDevice = async () =>
    new MeshDevice(await TransportWebBluetooth.createFromDevice(bleDevice));

  let device = await newMeshDevice();
  const link = createMeshtasticDeviceLink({ device, destination: "broadcast" });
  // The courier starts UNSET and adopts the real region live (below). Nothing
  // transmits until the user acts, so a brief UNSET window costs nothing.
  // minFrameGapMs paces BLE writes so a multi-fragment payload (e.g. the
  // bootstrap blocks) does not burst and flood the phone's BLE stack.
  const courier = createMeshtasticCourier({ link, region: "UNSET", onEvent, minFrameGapMs: 150 });

  const MAX_ATTEMPTS = 5;
  let closedByUser = false;
  let reconnecting = false;
  let attempts = 0;
  let currentDevice = null; // only THIS device's events may drive a reconnect
  let stableTimer = null; // reset the backoff only after the link stays up

  // Attach every watcher to a device and configure it. Run once at connect
  // and again on each reconnect (a fresh MeshDevice each time). Watchers
  // subscribe BEFORE configure() — the config stream delivers region,
  // channels, identity and neighbours in its first second and does not
  // replay, so a late subscription races it (sixth field report). Region is
  // watched CONTINUOUSLY, not once: a node that just rebooted reports it late
  // (seventh field report), and the courier adopts it whenever it lands.
  const attach = (dev) => {
    currentDevice = dev;
    watchDeviceRegion(dev, (name) => {
      if (dev !== currentDevice) return;
      courier.setRegion(name);
      if (onRegion) onRegion(name);
    });
    watchAirUtilTx(dev, (value) => {
      if (dev !== currentDevice) return;
      courier.reconcileNodeAirtime(value);
      if (onTelemetry) onTelemetry(value);
    });
    if (onNodeInfo) watchNodeInfo(dev, (n) => dev === currentDevice && onNodeInfo(n));
    if (onChannel) watchChannels(dev, (c) => dev === currentDevice && onChannel(c));
    if (onMyNodeInfo) watchMyNodeInfo(dev, (i) => dev === currentDevice && onMyNodeInfo(i));
    watchDeviceStatus(dev, (name) => {
      // Ignore events from a device we have already replaced — otherwise the
      // zombie watchers of every past reconnect pile up and each fires its own
      // reconnect, and the teardown disconnect of the old device would itself
      // trigger a new cycle. Only the current device speaks.
      if (dev !== currentDevice) return;
      if (onStatus) onStatus(name);
      if (name === "disconnected" && !closedByUser) reconnect();
    });
    // Keep the BLE session alive: browsers drop an idle GATT link after a few
    // minutes (first field report). The official clients ping for this reason.
    dev.setHeartbeatInterval(30_000);
    dev.configure().catch((e) => {
      if (onError) onError(`configure() failed: ${e?.message ?? e}`);
    });
  };

  // A phone drops the GATT link under load — a write and a notification-read
  // overlap and one fails. Reconnect and let the courier's ARQ resume rather
  // than end the run. Correctness rules learned the hard way (the reconnect
  // busy-loop): tear the OLD device down first (its disconnect() clears the
  // heartbeat timer and closes the GATT, so we never run two connections to
  // one device — the "GATT operation already in progress" storm); back off
  // exponentially and DON'T reset the backoff on a connect that immediately
  // drops again (only after it stays up a while); and give up after a cap
  // instead of looping forever.
  const reconnect = async () => {
    if (reconnecting || closedByUser) return;
    reconnecting = true;
    if (stableTimer) {
      clearTimeout(stableTimer);
      stableTimer = null;
    }

    const dying = currentDevice;
    currentDevice = null; // silence the dying device's watchers from here on
    try {
      await dying?.disconnect();
    } catch {
      /* best effort — we are replacing it anyway */
    }

    attempts += 1;
    if (attempts > MAX_ATTEMPTS) {
      reconnecting = false;
      if (onGaveUp) onGaveUp();
      return;
    }
    if (onReconnecting) onReconnecting(attempts);
    await sleep(Math.min(1000 * 2 ** (attempts - 1), 15000));
    if (closedByUser) {
      reconnecting = false;
      return;
    }
    try {
      device = await newMeshDevice();
      attach(device); // sets currentDevice = device
      link.rebind(device);
      reconnecting = false;
      if (onReconnected) onReconnected();
      // Only call the link healthy — and reset the backoff — once it has
      // survived a few seconds. A connect that drops again immediately keeps
      // climbing the backoff toward the cap.
      stableTimer = setTimeout(() => {
        attempts = 0;
      }, 8000);
    } catch (e) {
      reconnecting = false;
      if (onError) onError(`reconnect failed: ${e?.message ?? e}`);
      if (!closedByUser) reconnect();
    }
  };

  attach(device);

  return {
    courier,
    kind: "Meshtastic node (Web Bluetooth)",
    region: "UNSET", // provisional; onRegion carries the live value
    get device() {
      return device;
    },
    setTxChannel: (index) => link.setChannel(index),
    close: () => {
      closedByUser = true;
    },
  };
}

/**
 * Create a fresh list and announce it over the mesh. Write access is open —
 * the demo's channel is the trust boundary; per-identity ACLs are a design
 * conversation in issue #1, not a demo feature.
 */
export async function createList({ orbitdb, courier }) {
  const db = await orbitdb.open("mesh-todo", {
    type: "keyvalue",
    sync: false,
    AccessController: IPFSAccessController({ write: ["*"] }),
  });
  const sync = await createCourierSync({ db, courier });
  await sync.start();
  await sendInvite(courier, db.address);
  return { db, sync };
}

/** Join a list announced by the peer; the first delta materializes it. */
export async function joinList({ orbitdb, courier, address }) {
  const sync = await createCourierSync({ orbitdb, address, courier });
  await sync.start();
  return { sync };
}

/** One packet: here is a database worth joining. */
export function sendInvite(courier, address) {
  return courier.send(dagCbor.encode({ v: INVITE_VERSION, t: "invite", address }));
}

/** Invites share the courier with sync traffic; everything else is ignored. */
export function watchInvites(courier, cb) {
  return courier.onPayload((bytes) => {
    let message;
    try {
      message = dagCbor.decode(bytes);
    } catch {
      return;
    }
    if (
      message &&
      message.v === INVITE_VERSION &&
      message.t === "invite" &&
      typeof message.address === "string" &&
      message.address.startsWith("/orbitdb/")
    ) {
      cb(message.address);
    }
  });
}

/**
 * Exercises the real-radio import path without a radio: constructs a
 * MeshDevice on a stub transport and makes its logger format a line — the
 * code that only ever ran on a phone, until it crashed there
 * ("util.formatWithOptions is not a function"; the browser util polyfill
 * lacks what tslog's node build calls, see src/shims/node-util.js).
 * Driven by ?probe=meshtastic-core and by the e2e suite, so the real
 * import path never goes untested again.
 */
export async function probeMeshtasticCore() {
  const { MeshDevice } = await import("@meshtastic/core");
  const stub = { fromDevice: new ReadableStream(), toDevice: new WritableStream() };
  const device = new MeshDevice(stub);
  device.log.info("probe: logger formats in the browser");
  return "ok";
}
