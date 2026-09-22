// SPDX-License-Identifier: GPL-3.0-only
/**
 * OrbitDB 4's heads exchange over libp2p 3, with a log that has two heads (#107).
 *
 * When two peers meet, each sends its heads on a stream — one `stream.send()`
 * per head, nothing between them — and the other side decodes each chunk it
 * reads as exactly one entry. libp2p 3 hands a reader that starts late
 * everything already buffered as one chunk, so two heads become one read and
 * the decode fails: "CBOR decode error: too many terminals". It takes a log
 * with two heads and a reader a moment late, which is why it only ever showed
 * on a loaded CI runner. Here both are arranged on purpose.
 *
 * Until OrbitDB fixes it, patches/@orbitdb+core+4.0.0.patch does.
 */
import { test, after } from "node:test";
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

const until = async (fn, timeoutMs = 20000, stepMs = 25) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  throw new Error("condition not reached in time");
};

/**
 * A peer whose IP path can be cut, and whose heads reader can be made late:
 * with `late.ms` set, a heads stream this node dials is handed to OrbitDB only
 * that long after it opened — by then the other side's heads are all buffered.
 */
async function makePeer(name, dir) {
  const ip = { down: false };
  const late = { ms: 0 };
  // Helia 7 fills every libp2p key left out with defaults that reach the
  // public network, so each is given, even empty.
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

  const dial = helia.libp2p.dialProtocol.bind(helia.libp2p);
  helia.libp2p.dialProtocol = async (peer, protocols, options) => {
    const stream = await dial(peer, protocols, options);
    if (late.ms && String(protocols).startsWith("/orbitdb/heads")) {
      await new Promise((resolve) => setTimeout(resolve, late.ms));
    }
    return stream;
  };

  const orbitdb = await createOrbitDB({ ipfs: helia, id: name, directory: join(dir, name) });
  return { name, ip, late, libp2p: helia.libp2p, helia, orbitdb };
}

const heads = async (db) => (await db.log.heads()).map((entry) => entry.hash).sort();

let dir;
const peers = [];

after(async () => {
  for (const peer of peers) {
    try {
      await peer.orbitdb.stop();
      await peer.helia.stop();
    } catch {
      // best-effort teardown
    }
  }
  if (dir) await rm(dir, { recursive: true, force: true });
});

test("a log with two heads crosses whole, however late the other side reads", { timeout: 60000 }, async () => {
  dir = await mkdtemp(join(tmpdir(), "heads-framing-"));
  const alice = await makePeer("alice", dir);
  const bob = await makePeer("bob", dir);
  peers.push(alice, bob);

  const dbA = await alice.orbitdb.open("two-heads", {
    type: "keyvalue",
    AccessController: IPFSAccessController({ write: ["*"] }),
  });
  await bob.libp2p.dial(alice.libp2p.getMultiaddrs()[0]);
  const dbB = await bob.orbitdb.open(dbA.address);

  // Every sync error is kept, so none escapes as an unhandled rejection and
  // the assertion below can say what it was.
  const errors = [];
  for (const db of [dbA, dbB]) db.events.on("error", (error) => errors.push(error));

  const apart = async () => {
    await dbA.sync.stop();
    await dbB.sync.stop();
    alice.ip.down = bob.ip.down = true;
    await Promise.all(
      [alice, bob].flatMap((peer) => peer.libp2p.getPeers().map((id) => peer.libp2p.hangUp(id))),
    );
    await until(() => alice.libp2p.getConnections().length + bob.libp2p.getConnections().length === 0);
  };
  const together = async () => {
    alice.ip.down = bob.ip.down = false;
    await dbA.sync.start();
    await dbB.sync.start();
    await bob.libp2p.dial(alice.libp2p.getMultiaddrs()[0]);
  };

  // Apart, each writes: the log forks.
  await apart();
  await dbA.put("a", 1);
  await dbB.put("b", 2);

  // Together: each sends its one head, and both end up holding the fork.
  await together();
  await until(async () => {
    const [a, b] = [await heads(dbA), await heads(dbB)];
    return a.length === 2 && JSON.stringify(a) === JSON.stringify(b);
  });

  // Apart once more, and back with every heads reader late: each side now sends
  // two heads, and the other reads them only once both have arrived.
  await apart();
  alice.late.ms = bob.late.ms = 300;
  const joined = { alice: false, bob: false };
  dbA.events.on("join", () => (joined.alice = true));
  dbB.events.on("join", () => (joined.bob = true));
  await together();
  await until(() => (joined.alice && joined.bob) || errors.length > 0);

  assert.deepEqual(
    errors.map((error) => error.message),
    [],
    "the heads exchange raised no error",
  );
  assert.ok(joined.alice && joined.bob, "both sides finished the exchange");

  await dbA.sync.stop();
  await dbB.sync.stop();
});
