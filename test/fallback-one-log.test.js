// SPDX-License-Identifier: GPL-3.0-only
/**
 * P10 step 1 (#82): OrbitDB's own replication and courier-sync on one log.
 *
 * Internet first, the mesh when it is gone — and never both at once. Two peers
 * keep a list in step over IP the way any OrbitDB app does. The IP path goes:
 * each side stops OrbitDB's sync and starts courier-sync, they keep editing,
 * and the changes cross a lossy in-memory mesh. The IP path returns: each side
 * stops courier-sync first, then starts OrbitDB's sync again.
 *
 * Exclusive on purpose. Running both paths at the same time under concurrent
 * writes stalled joins behind blocks nobody could serve, while each path alone
 * stayed clean (issue #82), so the switch has to be enforced in code rather
 * than left to connectivity.
 *
 * The question this settles before any UI is built: does one hash-linked log
 * survive being carried by one path, then the other, then the first again?
 * The gate: both logs identical, and every write in them exactly once.
 */
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { tcp } from "@libp2p/tcp";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { identify } from "@libp2p/identify";
import { gossipsub } from "@libp2p/gossipsub";
import { createHelia } from "helia";
import { MemoryBlockstore } from "blockstore-core";
import { MemoryDatastore } from "datastore-core";
import { createOrbitDB, IPFSAccessController } from "@orbitdb/core";
import { createCourierSync } from "orbitdb-storage-bridge/courier-sync";

import { createMeshtasticCourier } from "../lib/meshtastic-courier.js";
import { createMemoryMeshPair } from "../lib/links/memory-mesh.js";
import { decodeFrame } from "../lib/framing.js";

const until = async (fn, timeoutMs = 30000, stepMs = 25) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  throw new Error("condition not reached in time");
};

/**
 * A peer with an IP path that can be taken away: while `ip.down`, the
 * connection gater refuses every dial and every inbound connection, so
 * nothing — OrbitDB, gossipsub, bitswap — can quietly reconnect.
 */
async function makePeer(name, dir) {
  const ip = { down: false };
  // Helia 7 builds libp2p from options, and fills every key left out from
  // defaults that reach the public network — so each is given, even empty.
  const helia = await createHelia({
    libp2p: {
      addresses: { listen: ["/ip4/127.0.0.1/tcp/0"] },
      transports: [tcp()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      connectionGater: {
        denyDialMultiaddr: () => ip.down,
        denyInboundConnection: () => ip.down,
        denyOutboundConnection: () => ip.down,
      },
      peerDiscovery: [],
      services: {
        identify: identify(),
        pubsub: gossipsub({ allowPublishToZeroTopicPeers: true }),
      },
    },
    blockstore: new MemoryBlockstore(),
    datastore: new MemoryDatastore(),
  }).start();
  const orbitdb = await createOrbitDB({ ipfs: helia, id: name, directory: join(dir, name) });
  return { name, ip, libp2p: helia.libp2p, helia, orbitdb };
}

const stateOf = async (db) =>
  (await db.all()).map(({ key, value }) => [key, value]).sort(([a], [b]) => a.localeCompare(b));
const headsOf = async (db) => (await db.log.heads()).map((entry) => entry.hash).sort();
const logOf = async (db) => (await db.log.values()).map((entry) => entry.hash);

describe("P10 step 1: OrbitDB's own sync and courier-sync on one log", () => {
  let dir;
  let alice;
  let bob;
  const cleanup = [];

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "fallback-one-log-"));
    alice = await makePeer("alice", dir);
    bob = await makePeer("bob", dir);
  });

  after(async () => {
    for (const fn of cleanup.reverse()) {
      try {
        await fn();
      } catch {
        // best-effort teardown
      }
    }
    for (const peer of [alice, bob]) {
      if (!peer) continue;
      try {
        await peer.orbitdb.stop();
        await peer.helia.stop();
      } catch {
        // best-effort teardown
      }
    }
    await rm(dir, { recursive: true, force: true });
  });

  test("IP, then the mesh alone, then IP alone again: every write lands exactly once", { timeout: 120000 }, async () => {
    let writes = 0;
    const put = async (db, key, value) => {
      await db.put(key, value);
      writes++;
    };
    const converged = async (a, b) =>
      JSON.stringify(await headsOf(a)) === JSON.stringify(await headsOf(b)) &&
      (await a.log.values()).length === writes &&
      (await b.log.values()).length === writes;
    const connections = () => alice.libp2p.getConnections().length + bob.libp2p.getConnections().length;

    // ── 1 · over IP, as any OrbitDB app syncs ───────────────────────────
    const dbA = await alice.orbitdb.open("mesh-todo", {
      type: "keyvalue",
      AccessController: IPFSAccessController({ write: ["*"] }),
    });
    await bob.libp2p.dial(alice.libp2p.getMultiaddrs()[0]);
    const dbB = await bob.orbitdb.open(dbA.address);
    cleanup.push(() => dbA.close(), () => dbB.close());

    await put(dbA, "milk", { text: "Milch kaufen", done: false });
    await put(dbB, "beer", { text: "Bier kaufen", done: false });
    await until(() => converged(dbA, dbB));

    // ── 2 · the internet goes: switch to the mesh ───────────────────────
    alice.ip.down = true;
    bob.ip.down = true;
    await Promise.all([alice, bob].flatMap((peer) => peer.libp2p.getPeers().map((id) => peer.libp2p.hangUp(id))));
    await until(() => connections() === 0);
    await dbA.sync.stop();
    await dbB.sync.stop();

    // A mesh that loses the first transmission of every third data frame.
    const dropped = new Set();
    const pair = createMemoryMeshPair({
      mtu: 200,
      delayMs: 1,
      lossFn: ({ bytes, from }) => {
        const frame = decodeFrame(bytes);
        if (!frame || frame.type !== "data" || frame.idx % 3 !== 1) return false;
        const key = `${from}:${frame.msgId}:${frame.idx}`;
        if (dropped.has(key)) return false;
        dropped.add(key);
        return true;
      },
    });
    const courierA = createMeshtasticCourier({ link: pair.a, region: "EU_868", rtoMs: 80, gapMs: 30 });
    const courierB = createMeshtasticCourier({ link: pair.b, region: "EU_868", rtoMs: 80, gapMs: 30 });
    cleanup.push(() => courierA.close(), () => courierB.close());

    // Attached the way mesh-todo attaches it: nothing is sent until the app
    // decides to (P8a's button), not on every write.
    const meshA = await createCourierSync({ db: dbA, courier: courierA, announceOnLocalUpdate: false });
    const meshB = await createCourierSync({ db: dbB, courier: courierB, announceOnLocalUpdate: false });
    cleanup.push(() => meshA.stop(), () => meshB.stop());
    const carried = { messages: 0, blocks: 0, errors: [] };
    for (const mesh of [meshA, meshB]) {
      mesh.on("message", ({ direction, type }) => {
        if (direction !== "in") return;
        carried.messages++;
        if (type === "blocks") carried.blocks++;
      });
      mesh.on("error", (error) => carried.errors.push(error));
    }
    await meshA.start();
    await meshB.start();

    await put(dbA, "milk", { text: "Milch kaufen", done: true });
    await put(dbB, "bread", { text: "Brot", done: false });
    await put(dbA, "eggs", { text: "Eier", done: false });
    // Both change the same entry while apart.
    await put(dbB, "milk", { text: "Hafermilch kaufen", done: false });

    await meshA.announce(); // the send button, on both phones
    await meshB.announce();
    await until(() => converged(dbA, dbB));

    assert.equal(connections(), 0, "the mesh carried the outage's changes, not IP");
    assert.ok(carried.blocks > 0, "blocks really crossed the mesh");
    assert.ok(dropped.size > 0, "and the mesh really lost frames on the way");
    assert.deepEqual(await stateOf(dbA), await stateOf(dbB), "the conflicting edit resolved the same way on both");

    // ── 3 · the internet returns: courier off first, then IP sync on ────
    await meshA.stop();
    await meshB.stop();
    const messagesAtSwitch = carried.messages;

    alice.ip.down = false;
    bob.ip.down = false;
    await dbA.sync.start();
    await dbB.sync.start();
    await bob.libp2p.dial(alice.libp2p.getMultiaddrs()[0]);

    await put(dbA, "coffee", { text: "Kaffee", done: false });
    await put(dbB, "beer", { text: "Bier kaufen", done: true });
    await put(dbB, "coffee", { text: "Kaffee", done: true });
    await until(() => converged(dbA, dbB));
    assert.equal(carried.messages, messagesAtSwitch, "after the switch nothing crossed the mesh");
    assert.ok(connections() > 0, "the last phase converged over IP");

    // ── the gate ────────────────────────────────────────────────────────
    const [logA, logB] = [await logOf(dbA), await logOf(dbB)];
    assert.equal(new Set(logA).size, logA.length, "no entry twice in alice's log");
    assert.equal(new Set(logB).size, logB.length, "no entry twice in bob's log");
    assert.deepEqual([...logA].sort(), [...logB].sort(), "both logs hold the same entries");
    assert.equal(logA.length, writes, "every write is in the log, exactly once");
    assert.deepEqual(await stateOf(dbA), await stateOf(dbB), "and both show the same list");
    assert.deepEqual(carried.errors, [], "courier-sync reported no errors");

    // Leave the world quiet. The test ends with both OrbitDB syncs running and
    // the two nodes connected, so teardown races whatever is in flight on the
    // heads topic — and a message that arrives while its store is closing has
    // surfaced on CI as an unhandled rejection charged to the `before` hook
    // ("CBOR decode error: too many terminals"), twice, never reproducibly and
    // never here. Whether or not that is the whole of it, a test should switch
    // off what it switched on.
    await dbA.sync.stop();
    await dbB.sync.stop();
  });
});
