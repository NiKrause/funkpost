// SPDX-License-Identifier: GPL-3.0-only
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createMeshtasticCourier } from "../lib/meshtastic-courier.js";
import { createMemoryMeshPair } from "../lib/links/memory-mesh.js";
import { decodeFrame } from "../lib/framing.js";

const NO_LIMIT = { dutyCycle: null };
const FAST = { rtoMs: 40, gapMs: 15, region: NO_LIMIT };

const bytesOf = (length, seed = 7) =>
  Uint8Array.from({ length }, (_, i) => (i * seed + 3) & 0xff);

const until = async (fn, timeoutMs = 4000, stepMs = 5) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  throw new Error("condition not reached in time");
};

const pairOfCouriers = (pairOptions = {}, courierOptions = {}) => {
  const pair = createMemoryMeshPair({ mtu: 60, delayMs: 1, ...pairOptions });
  const a = createMeshtasticCourier({ link: pair.a, ...FAST, ...courierOptions });
  const b = createMeshtasticCourier({ link: pair.b, ...FAST, ...courierOptions });
  return { pair, a, b, close: () => (a.close(), b.close()) };
};

describe("meshtastic courier (over the in-memory mesh)", () => {
  test("delivers a multi-fragment payload exactly once, and send() resolves", async () => {
    const { a, b, close } = pairOfCouriers();
    const received = [];
    b.onPayload((payload) => received.push(payload));

    const payload = bytesOf(500); // ~10 fragments at mtu 60
    await a.send(payload, { awaitDelivery: true });

    assert.equal(received.length, 1);
    assert.deepEqual([...received[0]], [...payload]);
    assert.equal(a.stats.payloadsSent, 1);
    assert.equal(b.stats.payloadsDelivered, 1);
    close();
  });

  test("heals fragment loss by retransmitting exactly the gaps", async () => {
    const droppedOnce = new Set();
    const { a, b, close } = pairOfCouriers({
      lossFn: ({ from, bytes }) => {
        if (from !== "a") return false;
        const frame = decodeFrame(bytes);
        if (!frame || frame.type !== "data" || frame.idx % 3 !== 1) return false;
        const key = `${frame.msgId}:${frame.idx}`;
        if (droppedOnce.has(key)) return false;
        droppedOnce.add(key);
        return true;
      },
    });
    const received = [];
    b.onPayload((payload) => received.push(payload));

    const payload = bytesOf(600, 13);
    await a.send(payload, { awaitDelivery: true });

    assert.equal(received.length, 1);
    assert.deepEqual([...received[0]], [...payload]);
    assert.ok(droppedOnce.size > 0, "the test really dropped fragments");
    assert.ok(a.stats.retransmitRounds > 0, "healing took a retransmit round");
    close();
  });

  test("a dead channel makes send() reject after bounded rounds", async () => {
    const { a, close } = pairOfCouriers(
      { lossFn: ({ from }) => from === "a" },
      { rtoMs: 15, maxRounds: 3 },
    );
    await assert.rejects(() => a.send(bytesOf(100), { awaitDelivery: true }), /undelivered after 3 rounds/);
    close();
  });

  test("duplicated frames do not duplicate the payload", async () => {
    const { a, b, close } = pairOfCouriers({ duplicateFn: () => true });
    const received = [];
    b.onPayload((payload) => received.push(payload));
    await a.send(bytesOf(300), { awaitDelivery: true });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(received.length, 1);
    close();
  });

  test("jittered delivery (reordering in flight) still reassembles", async () => {
    const { a, b, close } = pairOfCouriers({ delayMs: 1, jitterMs: 6 });
    const received = [];
    b.onPayload((payload) => received.push(payload));
    const payload = bytesOf(700, 3);
    await a.send(payload, { awaitDelivery: true });
    assert.equal(received.length, 1);
    assert.deepEqual([...received[0]], [...payload]);
    close();
  });

  test("both directions at once", async () => {
    const { a, b, close } = pairOfCouriers();
    const atB = [];
    const atA = [];
    b.onPayload((payload) => atB.push(payload));
    a.onPayload((payload) => atA.push(payload));

    const p1 = bytesOf(250, 5);
    const p2 = bytesOf(260, 9);
    await Promise.all([a.send(p1, { awaitDelivery: true }), b.send(p2, { awaitDelivery: true })]);
    await until(() => atB.length === 1 && atA.length === 1);

    assert.deepEqual([...atB[0]], [...p1]);
    assert.deepEqual([...atA[0]], [...p2]);
    close();
  });

  test("an UNSET region refuses to transmit — the misconfiguration rule", async () => {
    const pair = createMemoryMeshPair({ mtu: 60 });
    const courier = createMeshtasticCourier({ link: pair.a, region: "UNSET", rtoMs: 20 });
    await assert.rejects(() => courier.send(bytesOf(10)), /region is UNSET/);
    assert.equal(courier.budget().misconfigured, true);
    courier.close();
  });

  test("a broadcast into an empty room resolves on transmission, then gives up quietly", async () => {
    // Nobody on the other end at all: no courier B, so no STATUS will ever
    // come. The default send must resolve once the wave is out (announces and
    // invites are broadcasts), and the ARQ ends in a giveup EVENT, not a
    // rejection — this is the demo's create-a-list-before-anyone-joined case.
    const pair = createMemoryMeshPair({ mtu: 60, delayMs: 1 });
    const events = [];
    const a = createMeshtasticCourier({
      link: pair.a,
      region: NO_LIMIT,
      rtoMs: 10,
      maxRounds: 2,
      onEvent: (e) => events.push(e.kind),
    });

    const t0 = Date.now();
    await a.send(bytesOf(150)); // resolves without any acknowledgement
    assert.ok(Date.now() - t0 < 1000, "resolved on transmission, not on a timeout");

    await until(() => events.includes("giveup"));
    assert.ok(!events.includes("delivered"));
    a.close();
  });

  test("budget(): EU_868 pacing is wired through and airtime is accounted", async () => {
    const pair = createMemoryMeshPair({ mtu: 60, delayMs: 1 });
    const a = createMeshtasticCourier({ link: pair.a, region: "EU_868", rtoMs: 40, gapMs: 15 });
    const b = createMeshtasticCourier({ link: pair.b, region: "EU_868", rtoMs: 40, gapMs: 15 });
    b.onPayload(() => {});

    const before = a.budget();
    assert.equal(before.region, "EU_868");
    assert.equal(before.dutyCycle, 0.1);
    assert.equal(before.misconfigured, false);
    assert.ok(Number.isFinite(before.remainingAirtimeMs));

    await a.send(bytesOf(400));
    const after = a.budget();
    assert.ok(after.remainingAirtimeMs < before.remainingAirtimeMs, "airtime was spent");
    assert.ok(a.stats.airtimeSpentMs > 0);
    a.close();
    b.close();
  });

  test("the node's own airtime accounting overrides the local estimate", async () => {
    const pair = createMemoryMeshPair({ mtu: 60 });
    const courier = createMeshtasticCourier({ link: pair.a, region: "EU_868" });
    // The device reports 9.5 % of the hour already spent — beacons, relaying,
    // things our local counter never saw. 10 % − 9.5 % = 18 s of legal air.
    courier.reconcileNodeAirtime(9.5);
    const remaining = courier.budget().remainingAirtimeMs;
    assert.ok(Math.abs(remaining - 18_000) < 50, `remaining=${remaining}`);
    // A no-limit region ignores reconciliation (nothing to mirror).
    const free = createMeshtasticCourier({ link: pair.b, region: { dutyCycle: null } });
    free.reconcileNodeAirtime(50);
    assert.equal(free.budget().remainingAirtimeMs, Number.POSITIVE_INFINITY);
    courier.close();
    free.close();
  });

  test("close() rejects in-flight sends instead of leaving them hanging", async () => {
    const { a, close } = pairOfCouriers(
      { lossFn: ({ from }) => from === "a" }, // nothing ever arrives
      { rtoMs: 5000, maxRounds: 50 },
    );
    const pending = a.send(bytesOf(50), { awaitDelivery: true });
    pending.catch(() => {}); // rejection is expected; keep it handled meanwhile
    await new Promise((resolve) => setTimeout(resolve, 20));
    close();
    await assert.rejects(() => pending, /courier closed/);
  });
});
