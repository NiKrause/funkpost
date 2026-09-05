// SPDX-License-Identifier: GPL-3.0-only
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { createYjsProvider, MSG_STATE_VECTOR, MSG_UPDATE } from "../lib/yjs/provider.js";
import { createMeshtasticCourier } from "../lib/meshtastic-courier.js";
import { createMemoryMeshPair } from "../lib/links/memory-mesh.js";

const NO_LIMIT = { dutyCycle: null };
const FAST = { rtoMs: 40, gapMs: 15, region: NO_LIMIT };

const until = async (fn, timeoutMs = 6000, stepMs = 5) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  throw new Error("condition not reached in time");
};

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A courier that is not funkpost's — two ends, in memory, no framing, no ARQ,
 * no radio. If the provider works here it is not secretly coupled to this
 * repository, which is the whole reusability claim.
 */
const plainCourierPair = () => {
  const endA = new Set();
  const endB = new Set();
  const sent = [];
  const make = (mine, theirs) => ({
    send(bytes) {
      sent.push(bytes);
      queueMicrotask(() => {
        for (const cb of [...theirs]) cb(bytes);
      });
      return Promise.resolve();
    },
    onPayload(cb) {
      mine.add(cb);
      return () => mine.delete(cb);
    },
  });
  return { a: make(endA, endB), b: make(endB, endA), sent };
};

/** A courier end that only records — nothing is delivered anywhere. */
const recordingCourier = () => {
  const sent = [];
  return {
    sent,
    typed: (type) => sent.filter((p) => p[0] === type),
    send(bytes) {
      sent.push(bytes);
      return Promise.resolve();
    },
    onPayload() {
      return () => {};
    },
  };
};

const entriesOf = (doc) => Object.fromEntries(doc.getMap("t").entries());

describe("yjs provider — convergence over the in-memory mesh", () => {
  test("the gate: two documents converge through 20 % frame loss", async () => {
    // Drop every fifth frame. Retransmissions carry a fresh sequence number,
    // so no fragment is systematically doomed — this is loss, not a blackhole.
    const pair = createMemoryMeshPair({
      mtu: 60,
      delayMs: 1,
      lossFn: ({ seq }) => seq % 5 === 4,
    });
    const courierA = createMeshtasticCourier({ link: pair.a, ...FAST });
    const courierB = createMeshtasticCourier({ link: pair.b, ...FAST });

    const docA = new Y.Doc();
    const docB = new Y.Doc();
    // Both sides already hold entries the other has never seen: this is first
    // contact in both directions at once, not a one-way bootstrap.
    docA.getMap("t").set("a1", "Milch");
    docA.getMap("t").set("a2", "Bier");
    docB.getMap("t").set("b1", "Brot");

    const provA = createYjsProvider({ doc: docA, courier: courierA, coalesceMs: 20 });
    const provB = createYjsProvider({ doc: docB, courier: courierB, coalesceMs: 20 });

    await until(() => {
      const a = entriesOf(docA);
      const b = entriesOf(docB);
      return Object.keys(a).length === 3 && Object.keys(b).length === 3;
    });

    assert.deepEqual(entriesOf(docA), { a1: "Milch", a2: "Bier", b1: "Brot" });
    assert.deepEqual(entriesOf(docB), { a1: "Milch", a2: "Bier", b1: "Brot" });
    // State vectors cover each other in both directions — the real assertion.
    assert.ok(provA.synced(docB), "A holds everything B holds");
    assert.ok(provB.synced(docA), "B holds everything A holds");

    provA.destroy();
    provB.destroy();
    courierA.close();
    courierB.close();
  });

  test("a live edit after the bootstrap crosses, and the exchange goes quiet", async () => {
    const pair = createMemoryMeshPair({ mtu: 60, delayMs: 1 });
    const courierA = createMeshtasticCourier({ link: pair.a, ...FAST });
    const courierB = createMeshtasticCourier({ link: pair.b, ...FAST });
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const provA = createYjsProvider({ doc: docA, courier: courierA, coalesceMs: 20 });
    const provB = createYjsProvider({ doc: docB, courier: courierB, coalesceMs: 20 });

    await until(() => provA.synced(docB) && provB.synced(docA));
    await settle(80);
    const quiet = provA.stats.payloadsSent + provB.stats.payloadsSent;

    docA.getMap("t").set("later", "Zahnpasta");
    await until(() => entriesOf(docB).later === "Zahnpasta");

    // One edit must not restart a conversation: a couple of payloads, not a
    // stream. (The edit itself, plus at most an answering vector.)
    await settle(120);
    const after = provA.stats.payloadsSent + provB.stats.payloadsSent;
    assert.ok(after - quiet <= 3, `one edit cost ${after - quiet} payloads`);

    provA.destroy();
    provB.destroy();
    courierA.close();
    courierB.close();
  });

  test("a late joiner asks once and receives the whole document", async () => {
    const pair = createMemoryMeshPair({ mtu: 60, delayMs: 1 });
    const courierA = createMeshtasticCourier({ link: pair.a, ...FAST });
    const courierB = createMeshtasticCourier({ link: pair.b, ...FAST });

    const docA = new Y.Doc();
    for (let i = 0; i < 6; i++) docA.getMap("t").set(`k${i}`, `value ${i}`);
    const provA = createYjsProvider({ doc: docA, courier: courierA, coalesceMs: 20 });
    await settle(60); // A is alone on the air and says so; nobody answers

    const docB = new Y.Doc();
    const provB = createYjsProvider({ doc: docB, courier: courierB, coalesceMs: 20 });

    await until(() => Object.keys(entriesOf(docB)).length === 6);
    assert.deepEqual(entriesOf(docB), entriesOf(docA));

    provA.destroy();
    provB.destroy();
    courierA.close();
    courierB.close();
  });
});

describe("yjs provider — airtime adaptation", () => {
  test("the gate: a burst of ten local edits becomes ONE payload", async () => {
    const courier = recordingCourier();
    const doc = new Y.Doc();
    const provider = createYjsProvider({ doc, courier, coalesceMs: 30 });

    const before = courier.typed(MSG_UPDATE).length;
    for (let i = 0; i < 10; i++) doc.getMap("t").set(`k${i}`, `value ${i}`);
    // Nothing has gone out yet — the burst is still coalescing.
    assert.equal(courier.typed(MSG_UPDATE).length, before);

    await settle(80);
    const updates = courier.typed(MSG_UPDATE);
    assert.equal(updates.length - before, 1, "ten edits must cost one payload");
    assert.equal(provider.stats.updatesCoalesced, 10);

    // And the single payload really carries all ten edits.
    const other = new Y.Doc();
    Y.applyUpdate(other, updates[updates.length - 1].subarray(1));
    assert.equal(Object.keys(entriesOf(other)).length, 10);

    provider.destroy();
  });

  test("coalesceMs 0 sends every edit immediately", async () => {
    const courier = recordingCourier();
    const doc = new Y.Doc();
    const provider = createYjsProvider({ doc, courier, coalesceMs: 0 });

    for (let i = 0; i < 4; i++) doc.getMap("t").set(`k${i}`, i);
    assert.equal(courier.typed(MSG_UPDATE).length, 4);

    provider.destroy();
  });

  test("flush() sends the burst without waiting out the timer", async () => {
    const courier = recordingCourier();
    const doc = new Y.Doc();
    const provider = createYjsProvider({ doc, courier, coalesceMs: 10_000 });

    doc.getMap("t").set("a", 1);
    doc.getMap("t").set("b", 2);
    assert.equal(courier.typed(MSG_UPDATE).length, 0);

    provider.flush();
    assert.equal(courier.typed(MSG_UPDATE).length, 1);

    provider.destroy();
  });

  test("announces on start, and resync() ignores the announce floor", async () => {
    const courier = recordingCourier();
    const doc = new Y.Doc();
    const provider = createYjsProvider({
      doc,
      courier,
      coalesceMs: 0,
      minAnnounceGapMs: 60_000,
    });

    assert.equal(courier.typed(MSG_STATE_VECTOR).length, 1, "announces on start");
    provider.announce(); // inside the floor — suppressed
    assert.equal(courier.typed(MSG_STATE_VECTOR).length, 1);
    provider.resync(); // explicit — always goes out
    assert.equal(courier.typed(MSG_STATE_VECTOR).length, 2);

    provider.destroy();
  });
});

describe("yjs provider — discipline", () => {
  test("an update that arrived from the mesh is never echoed back", async () => {
    const { a, b } = plainCourierPair();
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const provA = createYjsProvider({ doc: docA, courier: a, coalesceMs: 0 });
    const provB = createYjsProvider({ doc: docB, courier: b, coalesceMs: 0 });

    await settle(20);
    const sentByB = provB.stats.payloadsSent;

    docA.getMap("t").set("only-from-a", 1);
    await settle(40);

    assert.equal(entriesOf(docB)["only-from-a"], 1, "B applied it");
    // B must not have put A's own update back on the air. B may answer with a
    // state vector, but never with an UPDATE carrying what it just received.
    assert.ok(
      provB.stats.payloadsSent - sentByB <= 1,
      `B sent ${provB.stats.payloadsSent - sentByB} payloads reacting to one remote edit`,
    );

    provA.destroy();
    provB.destroy();
  });

  test("works with any courier — nothing here is funkpost-specific", async () => {
    // No framing, no ARQ, no pacing, no radio: a bare { send, onPayload }.
    const { a, b } = plainCourierPair();
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    docA.getMap("t").set("hello", "welt");

    const provA = createYjsProvider({ doc: docA, courier: a, coalesceMs: 0 });
    const provB = createYjsProvider({ doc: docB, courier: b, coalesceMs: 0 });

    await until(() => entriesOf(docB).hello === "welt");
    assert.ok(provB.synced(docA));

    provA.destroy();
    provB.destroy();
  });

  test("ignores traffic that is not ours, and survives a corrupt payload", async () => {
    const courier = recordingCourier();
    let deliver = null;
    courier.onPayload = (cb) => {
      deliver = cb;
      return () => {};
    };
    const doc = new Y.Doc();
    const provider = createYjsProvider({ doc, courier, coalesceMs: 0 });
    const errors = [];
    const noisy = createYjsProvider({
      doc: new Y.Doc(),
      courier: { send: () => Promise.resolve(), onPayload: () => () => {} },
      onEvent: (e) => e.kind === "error" && errors.push(e),
    });

    deliver(new Uint8Array([]));                 // empty
    deliver(new Uint8Array([9, 1, 2, 3]));       // an unknown tag — someone else's protocol
    deliver(new Uint8Array([MSG_UPDATE, 255, 255, 255])); // a mangled update
    deliver(new Uint8Array([MSG_STATE_VECTOR, 255, 255])); // a mangled vector

    assert.equal(Object.keys(entriesOf(doc)).length, 0);
    provider.destroy();
    noisy.destroy();
  });

  test("destroy() stops listening and stops sending", async () => {
    const courier = recordingCourier();
    const doc = new Y.Doc();
    const provider = createYjsProvider({ doc, courier, coalesceMs: 0 });
    const sent = courier.sent.length;

    provider.destroy();
    doc.getMap("t").set("after", 1);
    await settle(30);

    assert.equal(courier.sent.length, sent, "nothing goes out after destroy()");
    provider.destroy(); // idempotent
  });

  test("rejects a missing doc or a courier that is not one", () => {
    assert.throws(() => createYjsProvider({ courier: recordingCourier() }), /Y\.Doc/);
    assert.throws(() => createYjsProvider({ doc: new Y.Doc() }), /courier/);
    assert.throws(() => createYjsProvider({ doc: new Y.Doc(), courier: { send() {} } }), /courier/);
  });
});
