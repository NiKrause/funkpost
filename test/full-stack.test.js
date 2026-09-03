// SPDX-License-Identifier: GPL-3.0-only
/**
 * The whole data plane, no radio: OrbitDB → courier-sync (MIT seam, from
 * orbitdb-storacha-bridge) → this repo's meshtastic courier (framing, ARQ,
 * EU_868 pacing) → an in-memory mesh that drops frames.
 *
 * Two OrbitDB peers converge through all of it while their libp2p nodes hold
 * zero connections — the composed version of the claim each layer asserts
 * alone. Only physics is missing, and physics is bench step S5.
 */
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createLibp2p } from "libp2p";
import { tcp } from "@libp2p/tcp";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { createHelia } from "helia";
import { MemoryBlockstore } from "blockstore-core";
import { MemoryDatastore } from "datastore-core";
import { createOrbitDB } from "@orbitdb/core";
import { createCourierSync } from "orbitdb-storacha-bridge/courier-sync";

import { createMeshtasticCourier } from "../lib/meshtastic-courier.js";
import { createMemoryMeshPair } from "../lib/links/memory-mesh.js";
import { decodeFrame } from "../lib/framing.js";

const until = async (fn, timeoutMs = 20000, stepMs = 20) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  throw new Error("condition not reached in time");
};

const keysOf = async (db) => (await db.all()).map((entry) => entry.key).sort();

async function makeOrbitDBNode(name, dir) {
  const libp2p = await createLibp2p({
    addresses: { listen: [] },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
  });
  const helia = await createHelia({
    libp2p,
    blockstore: new MemoryBlockstore(),
    datastore: new MemoryDatastore(),
  });
  const orbitdb = await createOrbitDB({ ipfs: helia, id: name, directory: join(dir, name) });
  return { libp2p, helia, orbitdb };
}

describe("full stack: OrbitDB over the mesh courier", () => {
  let dir;
  let alice;
  let bob;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "mesh-data-plane-"));
    alice = await makeOrbitDBNode("alice", dir);
    bob = await makeOrbitDBNode("bob", dir);
  });

  after(async () => {
    for (const node of [alice, bob]) {
      if (!node) continue;
      try {
        await node.orbitdb.stop();
        await node.helia.stop();
      } catch {
        // best-effort teardown
      }
    }
    await rm(dir, { recursive: true, force: true });
  });

  test("two peers converge over a lossy mesh with zero libp2p connections", async () => {
    // A mesh that loses the first transmission of every sixth frame.
    const droppedOnce = new Set();
    const pair = createMemoryMeshPair({
      mtu: 200,
      delayMs: 1,
      lossFn: ({ bytes, from }) => {
        const frame = decodeFrame(bytes);
        if (!frame) return false;
        const key = `${from}:${frame.msgId}:${frame.type === "data" ? frame.idx : "s"}`;
        if (droppedOnce.has(key)) return false;
        if (droppedOnce.size % 6 === 5) return false; // let some through unscarred
        if (frame.type === "data" && frame.idx % 6 === 2) {
          droppedOnce.add(key);
          return true;
        }
        return false;
      },
    });
    const courierA = createMeshtasticCourier({
      link: pair.a,
      region: "EU_868",
      rtoMs: 80,
      gapMs: 30,
    });
    const courierB = createMeshtasticCourier({
      link: pair.b,
      region: "EU_868",
      rtoMs: 80,
      gapMs: 30,
    });

    // sync: false — these libp2p nodes carry no pubsub at all; every byte of
    // replication must go through the mesh courier or not at all.
    const db = await alice.orbitdb.open("mesh-todo", { type: "keyvalue", sync: false });
    await db.put("one", { text: "reaches across the mesh" });
    await db.put("two", { text: "no ip anywhere" });

    const syncA = await createCourierSync({ db, courier: courierA });
    const syncB = await createCourierSync({
      orbitdb: bob.orbitdb,
      address: db.address,
      courier: courierB,
    });
    await syncA.start();
    await syncB.start();

    // Bootstrap: bob materializes the database from mesh frames alone.
    await until(async () => syncB.db && (await keysOf(syncB.db)).length === 2);
    assert.deepEqual(await keysOf(syncB.db), ["one", "two"]);
    assert.equal(syncB.db.address, db.address);

    // Live update crosses the same path.
    await db.put("three", { text: "added later" });
    await until(async () => (await keysOf(syncB.db)).length === 3);
    assert.deepEqual(await keysOf(syncB.db), ["one", "three", "two"]);

    // The composed claim, asserted at the bottom of the stack:
    assert.equal(alice.libp2p.getConnections().length, 0);
    assert.equal(bob.libp2p.getConnections().length, 0);
    // The loss was real, the healing was real:
    assert.ok(droppedOnce.size > 0, "the mesh really dropped frames");
    // And the law was priced in:
    assert.ok(courierA.budget().remainingAirtimeMs < 0.1 * 3_600_000);
    assert.equal(courierA.budget().region, "EU_868");

    await syncA.stop();
    await syncB.stop();
    await syncB.db.close();
    await db.close();
    courierA.close();
    courierB.close();
  });
});
