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
export async function connectCourier({ mode, onEvent, onTelemetry }) {
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
    return { courier, kind: "BroadcastChannel (fake mesh)", region: "EU_868", device: null };
  }

  const [{ TransportWebBluetooth }, { MeshDevice }] = await Promise.all([
    import("@meshtastic/transport-web-bluetooth"),
    import("@meshtastic/core"),
  ]);
  const transport = await TransportWebBluetooth.create(); // browser chooser
  const device = new MeshDevice(transport);

  // The region decides the pacing law; wait briefly for the node to say
  // where it stands. UNSET stays UNSET — the courier will refuse, which is
  // the design (issue #1): configure the node, then transmit.
  const region = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      stop();
      resolve("UNSET");
    }, 7000);
    const stop = watchDeviceRegion(device, (name) => {
      clearTimeout(timer);
      stop();
      resolve(name);
    });
    device.configure().catch(() => {
      clearTimeout(timer);
      resolve("UNSET");
    });
  });

  if (onTelemetry) watchAirUtilTx(device, onTelemetry);

  const link = createMeshtasticDeviceLink({ device, destination: "broadcast" });
  const courier = createMeshtasticCourier({ link, region, onEvent });
  return { courier, kind: "Meshtastic node (Web Bluetooth)", region, device };
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
