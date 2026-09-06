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
  connectMeshtasticDevice,
  describeMeshtasticError,
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
  // later without a chooser — the supervisor needs a repeatable createDevice.
  const bleDevice = await navigator.bluetooth.requestDevice({
    filters: [{ services: [MESHTASTIC_BLE_SERVICE] }],
  });

  // Everything about surviving a phone's Bluetooth — subscribe-before-configure,
  // the generation guard, teardown-first reconnect, backoff, the stability
  // timer, the give-up cap — now lives in the library (issue #37). The courier
  // is built through the supervisor so it exists BEFORE configure() runs and
  // cannot miss the config stream; region and airtime are wired into it there.
  const managed = await connectMeshtasticDevice({
    createDevice: async () =>
      new MeshDevice(await TransportWebBluetooth.createFromDevice(bleDevice)),
    // The transport reports a failed GATT write as a disconnection, and
    // Android Chrome produces those readily. This is the ground truth that
    // stops us closing a connection that never actually dropped.
    isLinkAlive: () => bleDevice.gatt?.connected === true,
    // minFrameGapMs paces BLE writes so a multi-fragment payload (the bootstrap
    // blocks) does not burst and flood the phone's stack. maxRounds 12 (vs the
    // lib default 8): first contact is the biggest payload and the public
    // channel is lossy, so give the selective-ACK ARQ room to fill the gaps.
    createCourier: (link) =>
      createMeshtasticCourier({
        link,
        region: "UNSET", // provisional — the node reports the real one live
        onEvent,
        minFrameGapMs: 150,
        maxRounds: 12,
      }),
    on: {
      region: onRegion,
      airUtilTx: onTelemetry,
      status: onStatus,
      nodeInfo: onNodeInfo,
      channel: onChannel,
      myNodeInfo: onMyNodeInfo,
      reconnecting: onReconnecting,
      reconnected: onReconnected,
      gaveUp: onGaveUp,
      error: (e) => onError && onError(describeMeshtasticError(e)),
    },
  });

  return {
    courier: managed.courier,
    kind: "Meshtastic node (Web Bluetooth)",
    region: "UNSET", // provisional; onRegion carries the live value
    get device() {
      return managed.device;
    },
    setTxChannel: (index) => managed.setChannel(index),
    close: () => managed.close(),
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
  // The radio waits to be asked. Announcing on every write is right when the
  // courier is cheap; here each announce draws a want and a block reply, so
  // five todos become five round trips where one delta would carry all five.
  const sync = await createCourierSync({ db, courier, announceOnLocalUpdate: false });
  await sync.start();
  await sendInvite(courier, db.address);
  return { db, sync };
}

/** Join a list announced by the peer; the first delta materializes it. */
export async function joinList({ orbitdb, courier, address }) {
  // Same on this side: a joiner's own writes wait for the button too. Going
  // quiet does not go deaf — an announce from the peer is still answered.
  const sync = await createCourierSync({ orbitdb, address, courier, announceOnLocalUpdate: false });
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
