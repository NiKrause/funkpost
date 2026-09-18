// SPDX-License-Identifier: GPL-3.0-only
/**
 * Wires the whole data plane for the demo:
 *
 *   OrbitDB (browser) → courier-sync (orbitdb-storage-bridge, MIT seam)
 *   → meshtastic courier (framing · ARQ · duty-cycle pacing, this repo)
 *   → a link: Web Bluetooth to a real node, or a BroadcastChannel fake.
 *
 * Two paths carry one log, and never both at once.
 *
 *   · the mesh — OrbitDB → courier-sync → this repo's courier → a radio link
 *   · the internet — OrbitDB's own sync over libp2p, through a relay
 *
 * Mesh-only was the whole point until P10: the node listened nowhere and
 * dialled nobody, and every replicated byte went through the courier. It still
 * can — `createDatabaseStack()` without `internet` is exactly that node. What
 * changed is that the demo can now *start* on the internet and fall back to
 * the radio when it goes, which is the case #82 asks about; and that a list's
 * founding may arrive by CID over HTTPS, named over the radio in one frame
 * (P9, funkpost#68).
 *
 * Never both at once is not taste: with OrbitDB's sync and courier-sync on one
 * log at the same time, every run stalled — see test/fallback-one-log.test.js.
 */

import { webSockets } from "@libp2p/websockets";
import { webRTC } from "@libp2p/webrtc";
import { circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import { identify } from "@libp2p/identify";
import { gossipsub } from "@libp2p/gossipsub";
import { bootstrap } from "@libp2p/bootstrap";
import { pubsubPeerDiscovery } from "@libp2p/pubsub-peer-discovery";
import { relayMultiaddrs, relaySource } from "./relays.js";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { createHeliaLight } from "helia";
import { withLibp2pLight } from "@helia/libp2p";
import { withBitswap } from "@helia/bitswap";
import { MemoryBlockstore } from "blockstore-core";
import { MemoryDatastore } from "datastore-core";
import { createOrbitDB, IPFSAccessController } from "@orbitdb/core";
import { createCourierSync, databaseTag } from "orbitdb-storage-bridge/courier-sync";
// The two light entries. Through the main entry this would cost 88 kB more, for
// a Storacha client the demo never calls (bridge #95); these two and the Aleph
// driver are 18.6 kB gzipped together, and they are imported rather than split
// off because splitting them measured *worse*: Rollup then duplicates what the
// page and the chunk share, and the page grew by 280 kB.
import { backupDatabaseCAR } from "orbitdb-storage-bridge/backup-car";
import { restoreFromCID } from "orbitdb-storage-bridge/restore-cid";
import { createAlephBackend } from "orbitdb-storage-bridge/backends/aleph";
import {
  encodeFoundingPointer,
  decodeFoundingPointer,
} from "@le-space/funkpost/founding-pointer";
import * as dagCbor from "@ipld/dag-cbor";
import {
  createMeshtasticCourier,
  connectMeshtasticDevice,
  describeMeshtasticError,
} from "@le-space/funkpost";
import { createBroadcastChannelLink } from "./fake-bc-link.js";

const INVITE_VERSION = 1;

const PUBSUB_TOPICS = ["todo._peer-discovery._p2p._pubsub"];

/**
 * The libp2p an internet path needs: a relay to be reachable through, WebRTC
 * to leave it again, pubsub for OrbitDB's own sync and for finding the other
 * browser. None of this is used while the mesh carries the list — it is the
 * *other* path, and only one runs at a time (see carryOverInternet).
 */
async function internetLibp2pOptions() {
  const relays = await relayMultiaddrs();

  return {
    addresses: { listen: ["/p2p-circuit", "/webrtc"] },
    transports: [
      webSockets(),
      webRTC({
        rtcConfiguration: {
          iceServers: [
            { urls: "stun:stun.l.google.com:19302" },
            { urls: "stun:global.stun.twilio.com:3478" },
          ],
        },
      }),
      circuitRelayTransport(),
    ],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    // A browser dials a relay on a private address in local testing, and the
    // default gater refuses that.
    connectionGater: {
      denyDialMultiaddr: () => false,
    },
    peerDiscovery: [
      ...(relays.length > 0
        ? [bootstrap({ list: relays, timeout: 30_000, tagName: "bootstrap", tagValue: 50 })]
        : []),
      pubsubPeerDiscovery({ interval: 3000, topics: PUBSUB_TOPICS, listenOnly: false }),
    ],
    services: {
      // A relay announces one protocol per database it holds open
      // (`/orbitdb/heads/<address>`), and libp2p rejects an identify response
      // over 8192 bytes *whole* — so a busy relay is never recognised as a
      // relay at the default limit: no HOP, no reservation, no address.
      // Measured against the registered relay, 2026-09-18: 611 protocols.
      identify: identify({ maxMessageSize: 65_536 }),
      pubsub: gossipsub({ allowPublishToZeroTopicPeers: true }),
    },
  };
}

/**
 * One OrbitDB per tab; memory stores, so Reset is a reload.
 *
 * `internet: true` adds the IP path — a relay, pubsub, WebRTC — which is what
 * P10 falls back *from*. Without it this is the mesh-only node the demo has
 * always been: listening nowhere, dialling nobody.
 */
export async function createDatabaseStack({ internet = false } = {}) {
  // Composed rather than createHelia(). Helia 7's createHelia builds libp2p
  // on top of its default stack — WebRTC, TLS, DHT, UPnP, a relay server,
  // delegated routing over public HTTP endpoints — which put +157 kB gzipped
  // into this bundle, and it adds a broker that asks public HTTP gateways for
  // any block it lacks. A mesh-only app wants neither: the light variants take
  // exactly the libp2p options given, and bitswap is kept for the IP path.
  const helia = await withBitswap(
    withLibp2pLight(
      createHeliaLight({
        blockstore: new MemoryBlockstore(),
        datastore: new MemoryDatastore(),
        codecs: [dagCbor],
      }),
      internet
        ? await internetLibp2pOptions()
        : {
            addresses: { listen: [] },
            transports: [webSockets()],
            connectionEncrypters: [noise()],
            streamMuxers: [yamux()],
          },
    ),
  ).start();
  const id = `mesh-todo-${Math.random().toString(36).slice(2, 10)}`;
  const orbitdb = await createOrbitDB({ ipfs: helia, id, directory: `./${id}` });
  return { libp2p: helia.libp2p, helia, orbitdb };
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
    /** Frames the radio gave up retransmitting — see funkpost issue #73. */
    get refusals() {
      return managed.link.refusals;
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

/**
 * Join over the internet: OrbitDB opens the address and replicates it itself.
 *
 * The courier sync is built but not started — it is the other path, and the
 * two do not share a log at the same time.
 */
export async function joinOverInternet({ orbitdb, courier, address }) {
  const db = await orbitdb.open(address, { type: "keyvalue", sync: true });
  const sync = await createCourierSync({ db, courier, announceOnLocalUpdate: false });
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

/**
 * Back the list up where there is internet, and name it over the radio.
 *
 * The backup is one CAR file and the message that points at it is one frame —
 * against the seven or so a first contact costs over the air. Aleph takes the
 * upload without an account; it is also not kept without a wallet-signed STORE
 * message, so a pointer is a shortcut for a peer who is listening now, not an
 * archive.
 */
export async function backUpAndPoint({ orbitdb, db, courier }) {
  const backend = createAlephBackend();
  const result = await backupDatabaseCAR(orbitdb, db.address, { backend });
  if (!result.success) throw new Error(result.error ?? "backup failed");

  const cid = result.backupFiles.metadataCID;
  const tag = await databaseTag(db.address);
  await courier.send(encodeFoundingPointer({ tag, address: db.address, cid }));
  return { cid, blocks: result.blocksTotal };
}

/**
 * Take a list from a pointer somebody beamed: the bytes come over HTTPS, and
 * the radio carried nothing but the CID. From here on the courier carries the
 * changes, exactly as it would after a join.
 */
export async function restoreFromPointer({ orbitdb, courier, pointer }) {
  const backend = createAlephBackend();
  const restored = await restoreFromCID(orbitdb, {
    metadataCID: pointer.cid,
    fetchBytes: (cid) => backend.getBlob(cid),
    // No pubsub on this node: OrbitDB's Sync subscribes on open and would throw
    // before the restore ever hands the database back. The courier is the sync.
    open: { sync: false },
  });

  const sync = await createCourierSync({
    db: restored.database,
    courier,
    announceOnLocalUpdate: false,
  });
  await sync.start();
  return { db: restored.database, sync, entries: restored.entries, blocks: restored.blocks };
}

/** Pointers share the courier with sync traffic and invites; the rest is ignored. */
export function watchFoundingPointers(courier, cb) {
  return courier.onPayload((bytes) => {
    const pointer = decodeFoundingPointer(bytes);
    if (pointer) cb(pointer);
  });
}

/**
 * Carry the list over the internet: OrbitDB's own sync, and the courier quiet.
 *
 * The order matters. Stopping the courier first is what keeps the two off the
 * log together — a late switch is exactly the overlap that stalled every run
 * in test/fallback-one-log.test.js.
 */
export async function carryOverInternet({ db, sync }) {
  if (sync) await sync.stop();
  await db.sync.start();
}

/** Carry it over the mesh: OrbitDB's sync stopped, the courier doing the work. */
export async function carryOverMesh({ db, sync }) {
  await db.sync.stop();
  if (sync) await sync.start();
}

/** Peers this node is actually connected to over IP — what "online" should mean. */
export function internetPeers(libp2p) {
  return libp2p
    .getConnections()
    .filter((connection) => connection.status === "open")
    .map((connection) => connection.remotePeer.toString());
}

export { relaySource };

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
