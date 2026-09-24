// SPDX-License-Identifier: GPL-3.0-only
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as dagCbor from "@ipld/dag-cbor";
import { fragmentPayload } from "../lib/framing.js";
import { encodeFoundingPointer, decodeFoundingPointer } from "../lib/founding-pointer.js";
import { createMeshtasticCourier } from "../lib/meshtastic-courier.js";
import { createMemoryMeshPair } from "../lib/links/memory-mesh.js";
import {
  encodeHeartbeat,
  decodeHeartbeat,
  createHeartbeat,
  HEARTBEAT_VERSION,
} from "../lib/heartbeat.js";

const TAG = Uint8Array.from([0x9a, 0x1f, 0x00, 0x7c, 0xd3, 0x44, 0xb1, 0x0e]);
const OTHER_TAG = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
const ID_A = Uint8Array.from([0xaa, 0, 0, 1]);
const ID_B = Uint8Array.from([0xbb, 0, 0, 2]);
const ID_C = Uint8Array.from([0xcc, 0, 0, 3]);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** A clock the test moves by hand; timers fire in time order. */
function fakeClock() {
  let now = 0;
  let seq = 0;
  const pending = new Map();
  return {
    now: () => now,
    setTimeout: (fn, ms) => {
      seq++;
      pending.set(seq, { at: now + ms, fn });
      return seq;
    },
    clearTimeout: (id) => pending.delete(id),
    advance(ms) {
      const until = now + ms;
      for (;;) {
        let next = null;
        for (const [id, timer] of pending) {
          if (timer.at > until) continue;
          if (!next || timer.at < next.timer.at) next = { id, timer };
        }
        if (!next) break;
        pending.delete(next.id);
        now = next.timer.at;
        next.timer.fn();
      }
      now = until;
    },
  };
}

/**
 * One shared air, every courier on it hearing everyone else — synchronously,
 * the hardest case: an answer can arrive while the beat is still being sent.
 */
function fakeAir() {
  const listeners = new Set();
  const sent = [];
  const deaf = new Set();
  const courier = (name, { fail = null } = {}) => ({
    async send(bytes, options = {}) {
      if (fail?.()) throw new Error("node region is UNSET — refusing to transmit");
      sent.push({ from: name, message: decodeHeartbeat(bytes), options });
      for (const listener of listeners) {
        if (listener.name !== name && !deaf.has(listener.name)) listener.cb(bytes);
      }
    },
    onPayload(cb) {
      const listener = { name, cb };
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
  const beatsFrom = (name) => sent.filter((s) => s.from === name && s.message?.type === "beat");
  const echoesFrom = (name) => sent.filter((s) => s.from === name && s.message?.type === "echo");
  return { courier, sent, beatsFrom, echoesFrom, deafen: (name) => deaf.add(name) };
}

describe("heartbeat on the wire", () => {
  test("a beat and an echo each cross in one frame", () => {
    for (const type of ["beat", "echo"]) {
      const bytes = encodeHeartbeat({ type, tag: TAG, from: ID_A });
      const { total } = fragmentPayload(bytes, { mtu: 200 });
      assert.equal(total, 1, `a ${type} is ${bytes.length} bytes and needs ${total} frames`);
    }
  });

  test("round-trips type, tag and sender", () => {
    const message = decodeHeartbeat(encodeHeartbeat({ type: "echo", tag: TAG, from: ID_B }));
    assert.equal(message.type, "echo");
    assert.deepEqual(message.tag, TAG);
    assert.deepEqual(message.from, ID_B);
  });

  test("is not confused with courier-sync, founding pointers or invites", () => {
    // courier-sync frames its messages behind a prefix byte: 0 raw, 1 gzip.
    assert.equal(decodeHeartbeat(Uint8Array.from([0, 0xa1, 0x61, 0x76, 0x01])), null);
    assert.equal(decodeHeartbeat(Uint8Array.from([1, 0x1f, 0x8b, 0x08, 0x00])), null);
    const pointer = encodeFoundingPointer({
      tag: TAG,
      address: "/orbitdb/zdpuB2rhHeykxLvtwpMHRPsQsUmwjYMBETL2ZVQHb9WdkN6hH",
      cid: "QmXxXxd4sCni9M7YqAv81s25PCEfHAbTxpYePWYGb2AvvN",
    });
    assert.equal(decodeHeartbeat(pointer), null);
    const invite = dagCbor.encode({ v: 1, t: "invite", address: "/orbitdb/zdpu" });
    assert.equal(decodeHeartbeat(invite), null);

    // And the other way round: a beat is none of those.
    const beat = encodeHeartbeat({ type: "beat", tag: TAG, from: ID_A });
    assert.equal(decodeFoundingPointer(beat), null);
    assert.ok(beat[0] >= 0xa0 && beat[0] <= 0xbf, "a dag-cbor map, which courier-sync's unframe refuses");
  });

  test("refuses other versions, shapes and garbage", () => {
    const shaped = (fields) =>
      decodeHeartbeat(dagCbor.encode({ v: HEARTBEAT_VERSION, t: "beat", tag: TAG, p: ID_A, ...fields }));
    assert.ok(shaped({}));
    assert.equal(shaped({ v: HEARTBEAT_VERSION + 1 }), null);
    assert.equal(shaped({ t: "hello" }), null);
    assert.equal(shaped({ tag: TAG.slice(0, 4) }), null);
    assert.equal(shaped({ p: "aa000001" }), null);
    assert.equal(decodeHeartbeat(new Uint8Array(0)), null);
    assert.equal(decodeHeartbeat(Uint8Array.from([0xff, 0xff])), null);
    assert.throws(() => encodeHeartbeat({ type: "here", tag: TAG, from: ID_A }));
    assert.throws(() => encodeHeartbeat({ type: "beat", tag: TAG, from: new Uint8Array(3) }));
  });
});

describe("heartbeat schedule", () => {
  test("alone: five beats a minute apart, then nothing until the next hour", () => {
    const clock = fakeClock();
    const air = fakeAir();
    const a = createHeartbeat({ courier: air.courier("a"), tag: TAG, id: ID_A, timers: clock });
    a.start();

    assert.equal(air.beatsFrom("a").length, 1, "the first beat goes at once");
    assert.equal(a.state().verdict, "unknown");
    assert.equal(a.state().beat, 1);

    clock.advance(4 * MINUTE);
    assert.equal(air.beatsFrom("a").length, 5);
    assert.equal(a.state().verdict, "unknown", "the last beat still waits for its answer");

    clock.advance(MINUTE / 2);
    assert.equal(a.state().verdict, "alone");
    assert.equal(a.state().beat, 0);

    clock.advance(HOUR - 4.5 * MINUTE - 1);
    assert.equal(air.beatsFrom("a").length, 5, "quiet until the hour is up");
    clock.advance(1);
    assert.equal(air.beatsFrom("a").length, 6, "the next round, an hour after the first began");

    // A beat is sent once: nobody may be there to acknowledge it.
    assert.ok(air.beatsFrom("a").every((s) => s.options.rounds === 1));
  });

  test("an answer ends the round at once, and the next one comes on the hour", () => {
    const clock = fakeClock();
    const air = fakeAir();
    const b = createHeartbeat({ courier: air.courier("b"), tag: TAG, id: ID_B, timers: clock });
    const a = createHeartbeat({ courier: air.courier("a"), tag: TAG, id: ID_A, timers: clock });
    b.start(); // into an empty room: nobody hears this one
    a.start(); // b hears it and echoes

    assert.equal(a.state().verdict, "answered");
    assert.equal(a.state().beat, 0, "the round is over");
    assert.equal(b.state().verdict, "answered", "hearing a beat is an answer too");
    assert.deepEqual(a.state().peers.map((peer) => peer.id), ["bb000002"]);

    clock.advance(HOUR - 1);
    assert.equal(air.beatsFrom("a").length, 1, "no more beats this hour");
    clock.advance(1);
    assert.equal(air.beatsFrom("a").length, 2);
  });

  test("a device that goes quiet reads as alone once a whole round goes unanswered", () => {
    const clock = fakeClock();
    const air = fakeAir();
    const b = createHeartbeat({ courier: air.courier("b"), tag: TAG, id: ID_B, timers: clock });
    const a = createHeartbeat({ courier: air.courier("a"), tag: TAG, id: ID_A, timers: clock });
    b.start();
    a.start();
    assert.equal(a.state().verdict, "answered");

    b.stop();
    clock.advance(HOUR);
    assert.equal(a.state().beat, 1, "the hourly round has begun");
    assert.equal(a.state().verdict, "answered", "one silent beat is not a verdict");

    clock.advance(4 * MINUTE);
    assert.equal(a.state().verdict, "answered");
    clock.advance(MINUTE / 2);
    assert.equal(a.state().verdict, "alone");
  });

  test("a device that comes into range turns alone around at once, both ways", () => {
    const clock = fakeClock();
    const air = fakeAir();
    const a = createHeartbeat({ courier: air.courier("a"), tag: TAG, id: ID_A, timers: clock });
    a.start();
    clock.advance(5 * MINUTE);
    assert.equal(a.state().verdict, "alone");

    const c = createHeartbeat({ courier: air.courier("c"), tag: TAG, id: ID_C, timers: clock });
    c.start();
    assert.equal(a.state().verdict, "answered", "without waiting for a's next round");
    assert.equal(c.state().verdict, "answered", "a's echo answered c's first beat");
    assert.equal(air.beatsFrom("c").length, 1);
  });

  test("a beat is answered, an echo never is, and not twice in half a minute", () => {
    const clock = fakeClock();
    const air = fakeAir();
    const a = createHeartbeat({ courier: air.courier("a"), tag: TAG, id: ID_A, timers: clock });
    const raw = air.courier("b");
    a.start();

    raw.send(encodeHeartbeat({ type: "beat", tag: TAG, from: ID_B }));
    assert.equal(air.echoesFrom("a").length, 1);
    // An echo goes to a device that has demonstrably spoken: the ARQ's default
    // rounds, not the one-shot of a beat.
    assert.equal(air.echoesFrom("a")[0].options.rounds, undefined);

    raw.send(encodeHeartbeat({ type: "echo", tag: TAG, from: ID_B }));
    assert.equal(air.echoesFrom("a").length, 1, "an echo is never answered");

    raw.send(encodeHeartbeat({ type: "beat", tag: TAG, from: ID_B }));
    assert.equal(air.echoesFrom("a").length, 1, "not twice in half a minute");
    clock.advance(MINUTE / 2);
    raw.send(encodeHeartbeat({ type: "beat", tag: TAG, from: ID_B }));
    assert.equal(air.echoesFrom("a").length, 2);
  });

  test("it counts what went out and what came back", async () => {
    const clock = fakeClock();
    const air = fakeAir();
    const a = createHeartbeat({ courier: air.courier("a"), tag: TAG, id: ID_A, timers: clock });
    const raw = air.courier("b");
    a.start();
    await Promise.resolve(); // the courier resolves the send on a microtask

    // "Nothing arrives" is two questions, and a round counter answers neither.
    assert.deepEqual(a.state().sent, { beats: 1, echoes: 0 }, "the round's first beat went out");
    assert.deepEqual(a.state().received, { beats: 0, echoes: 0 }, "and nothing came back yet");

    raw.send(encodeHeartbeat({ type: "beat", tag: TAG, from: ID_B }));
    await Promise.resolve();
    assert.deepEqual(a.state().received, { beats: 1, echoes: 0 }, "it heard the other device");
    assert.deepEqual(a.state().sent, { beats: 1, echoes: 1 }, "and answered it");

    raw.send(encodeHeartbeat({ type: "echo", tag: TAG, from: ID_B }));
    await Promise.resolve();
    assert.deepEqual(a.state().received, { beats: 1, echoes: 1 });
    assert.deepEqual(a.state().sent, { beats: 1, echoes: 1 }, "an echo is never answered");

    // Its own frames handed back by the link count for nothing, as everywhere.
    raw.send(encodeHeartbeat({ type: "beat", tag: TAG, from: ID_A }));
    await Promise.resolve();
    assert.deepEqual(a.state().received, { beats: 1, echoes: 1 }, "its own beat is not traffic");
  });

  test("a send the node refuses is not counted as one that went out", async () => {
    const clock = fakeClock();
    const air = fakeAir();
    // The node refuses to transmit — an UNSET region, say.
    const a = createHeartbeat({
      courier: air.courier("a", { fail: () => true }),
      tag: TAG,
      id: ID_A,
      timers: clock,
    });
    a.start();
    await Promise.resolve();

    assert.deepEqual(a.state().sent, { beats: 0, echoes: 0 }, "a refused send is not a beat sent");
    assert.ok(a.state().lastError, "and it is reported");
  });

  test("its own frames and other lists are not an answer", () => {
    const clock = fakeClock();
    const air = fakeAir();
    const a = createHeartbeat({ courier: air.courier("a"), tag: TAG, id: ID_A, timers: clock });
    const raw = air.courier("x");
    a.start();

    raw.send(encodeHeartbeat({ type: "echo", tag: TAG, from: ID_A })); // a link looping a's own
    raw.send(encodeHeartbeat({ type: "beat", tag: OTHER_TAG, from: ID_B })); // another list
    raw.send(Uint8Array.from([0, 0xa1, 0x61, 0x76, 0x01])); // courier-sync traffic

    assert.equal(a.state().verdict, "unknown");
    assert.equal(air.echoesFrom("a").length, 0);
    clock.advance(5 * MINUTE);
    assert.equal(a.state().verdict, "alone");
  });

  test("a send the node refuses is reported, and cleared by the next one that goes", async () => {
    const clock = fakeClock();
    const air = fakeAir();
    let refuse = true;
    const events = [];
    const a = createHeartbeat({
      courier: air.courier("a", { fail: () => refuse }),
      tag: TAG,
      id: ID_A,
      timers: clock,
      onEvent: (event) => events.push(event.kind),
    });
    a.start();
    await Promise.resolve();
    assert.match(a.state().lastError, /UNSET/);
    assert.ok(events.includes("error"));

    refuse = false;
    clock.advance(MINUTE);
    await Promise.resolve();
    assert.equal(a.state().lastError, null);
  });

  test("stop() stops the beats and the answers", () => {
    const clock = fakeClock();
    const air = fakeAir();
    const a = createHeartbeat({ courier: air.courier("a"), tag: TAG, id: ID_A, timers: clock });
    const raw = air.courier("b");
    a.start();
    a.stop();

    clock.advance(3 * HOUR);
    raw.send(encodeHeartbeat({ type: "beat", tag: TAG, from: ID_B }));
    assert.equal(air.beatsFrom("a").length, 1);
    assert.equal(air.echoesFrom("a").length, 0);
  });

  test("refuses a round that would not end before the next one", () => {
    const air = fakeAir();
    assert.throws(
      () => createHeartbeat({ courier: air.courier("a"), tag: TAG, minuteMs: MINUTE, roundEveryMs: 5 * MINUTE }),
      /a round must end/,
    );
    assert.throws(() => createHeartbeat({ courier: {}, tag: TAG }), /courier/);
    assert.throws(() => createHeartbeat({ courier: air.courier("a"), tag: TAG.slice(1) }), /tag/);
  });
});

describe("heartbeat over the courier", () => {
  test("two devices find each other through real framing and the ARQ", async () => {
    const mesh = createMemoryMeshPair();
    const courier = (link) =>
      createMeshtasticCourier({ link, region: "EU_868", preset: "SHORT_TURBO" });
    const couriers = [courier(mesh.a), courier(mesh.b)];
    const [a, b] = couriers.map((c, i) =>
      createHeartbeat({ courier: c, tag: TAG, id: [ID_A, ID_B][i], minuteMs: 50 }),
    );

    a.start();
    b.start();
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (a.state().verdict === "answered" && b.state().verdict === "answered") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(a.state().verdict, "answered");
    assert.equal(b.state().verdict, "answered");
    assert.deepEqual(a.state().peers.map((peer) => peer.id), ["bb000002"]);

    a.stop();
    b.stop();
    for (const c of couriers) c.close();
  });
});
