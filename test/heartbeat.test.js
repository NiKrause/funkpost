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
  return {
    courier,
    sent,
    beatsFrom,
    echoesFrom,
    deafen: (name) => deaf.add(name),
    undeafen: (name) => deaf.delete(name),
  };
}

describe("heartbeat on the wire", () => {
  test("a beat and an echo each cross in one frame", () => {
    for (const type of ["beat", "echo"]) {
      const bytes = encodeHeartbeat({ type, tag: TAG, from: ID_A });
      const { total } = fragmentPayload(bytes, { mtu: 200 });
      assert.equal(total, 1, `a ${type} is ${bytes.length} bytes and needs ${total} frames`);
    }
  });

  test("round-trips the beat number, and says so when there is none", () => {
    const withNumber = decodeHeartbeat(
      encodeHeartbeat({ type: "beat", tag: TAG, from: ID_A, n: 3 }),
    );
    assert.equal(withNumber.n, 3);

    // A peer on an older version sends no number. Unknown, not zero: a zero
    // would read as an answer to a beat that never went out.
    const without = decodeHeartbeat(encodeHeartbeat({ type: "echo", tag: TAG, from: ID_A }));
    assert.equal(without.n, null);

    for (const bad of [0, -1, 1.5, "2", null]) {
      const message = decodeHeartbeat(
        encodeHeartbeat({ type: "beat", tag: TAG, from: ID_A, n: bad }),
      );
      assert.equal(message.n, null, `n=${JSON.stringify(bad)} is not a beat number`);
    }
  });

  test("the number costs nothing on the air: still one frame", () => {
    const bytes = encodeHeartbeat({ type: "beat", tag: TAG, from: ID_A, n: 5 });
    const { total } = fragmentPayload(bytes, { mtu: 200 });
    assert.equal(total, 1, `a numbered beat is ${bytes.length} bytes`);
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

  /**
   * Which try got through, not merely that one did.
   *
   * The beats of a round are a minute apart, so being answered on the fourth
   * costs three minutes of waiting that the first would not have. On a carrier
   * rationed by law that is the number worth seeing, and only the far side
   * knows it — so it says so in the echo.
   */
  test("an echo names the beat it answers", () => {
    const clock = fakeClock();
    const air = fakeAir();
    const b = createHeartbeat({ courier: air.courier("b"), tag: TAG, id: ID_B, timers: clock });
    const a = createHeartbeat({ courier: air.courier("a"), tag: TAG, id: ID_A, timers: clock });

    // B beats into an empty room and its round runs out — A is not listening
    // yet, so none of it is heard, and B's next round is an hour away. Then B
    // goes deaf, so A beats alone without B answering or speaking.
    b.start();
    clock.advance(6 * MINUTE);
    assert.equal(b.state().verdict, "alone");

    air.deafen("b");
    a.start();
    clock.advance(2 * MINUTE + 1);
    assert.equal(air.beatsFrom("a").length, 3, "three beats went out unanswered");
    assert.equal(air.echoesFrom("b").length, 0);

    air.undeafen("b");
    clock.advance(MINUTE);

    const echo = air.echoesFrom("b").at(-1);
    assert.equal(echo.message.n, 4, "B heard A's fourth beat and says which");
    assert.equal(air.beatsFrom("a").at(-1).message.n, 4, "and that is the beat that went out");
  });

  test("hearing reports what it cost and which beat it was", () => {
    const clock = fakeClock();
    const air = fakeAir();
    const events = [];
    const a = createHeartbeat({
      courier: air.courier("a"),
      tag: TAG,
      id: ID_A,
      timers: clock,
      onEvent: (event) => events.push(event),
    });
    a.start();

    // A stranger's beat, sent by hand so the number under test is chosen here.
    const beat = encodeHeartbeat({ type: "beat", tag: TAG, from: ID_C, n: 2 });
    air.courier("c").send(beat);

    const heard = events.find((event) => event.kind === "heard");
    assert.equal(heard.type, "beat");
    assert.equal(heard.n, 2, "which beat of their round it was");
    assert.equal(heard.bytes, beat.length, "and what came off the carrier");

    const echo = events.find((event) => event.kind === "echo");
    assert.equal(echo.n, 2, "the answer carries the same number back");
  });

  test("a peer that sends no number is heard as unknown, not as beat zero", () => {
    const clock = fakeClock();
    const air = fakeAir();
    const events = [];
    const a = createHeartbeat({
      courier: air.courier("a"),
      tag: TAG,
      id: ID_A,
      timers: clock,
      onEvent: (event) => events.push(event),
    });
    a.start();

    air.courier("c").send(encodeHeartbeat({ type: "beat", tag: TAG, from: ID_C }));

    assert.equal(events.find((event) => event.kind === "heard").n, null);
    // And the echo back says nothing rather than something wrong.
    assert.equal(air.echoesFrom("a").at(-1).message.n, null);
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

/**
 * The two halves of a range test (#180): one device that asks and moves, one
 * that answers and stays. Both live in the heartbeat rather than in the page,
 * because a page cannot be tested with a clock that skips an hour.
 */
describe("a device that only answers", () => {
  test("opens no round of its own, and still echoes what it hears", () => {
    const air = fakeAir();
    const clock = fakeClock();
    const office = createHeartbeat({
      courier: air.courier("office"),
      tag: TAG,
      id: ID_B,
      beatsPerRound: 0,
      minuteMs: MINUTE,
      timers: clock,
    });
    const rider = createHeartbeat({
      courier: air.courier("rider"),
      tag: TAG,
      id: ID_A,
      minuteMs: MINUTE,
      timers: clock,
    });

    office.start();
    // An hour of an office on its own is an hour of silence. This is the whole
    // point: on a carrier with a duty cycle, a device that has nothing to ask
    // must not spend airtime asking it.
    clock.advance(2 * HOUR);
    assert.equal(air.beatsFrom("office").length, 0);
    assert.equal(office.state().rounds, 0);

    rider.start();
    clock.advance(1000);
    assert.equal(air.beatsFrom("rider").length, 1);
    assert.equal(air.echoesFrom("office").length, 1, "it answers, it just does not ask");
    assert.equal(rider.state().verdict, "answered");

    office.stop();
    rider.stop();
  });

  test("a round of no beats needs no room, so the timing rule does not apply", () => {
    const air = fakeAir();
    // Five beats a minute apart would not fit in this round; none always do.
    assert.throws(
      () =>
        createHeartbeat({ courier: air.courier("a"), tag: TAG, roundEveryMs: MINUTE }),
      /round must end/,
    );
    assert.doesNotThrow(() =>
      createHeartbeat({
        courier: air.courier("b"),
        tag: TAG,
        beatsPerRound: 0,
        roundEveryMs: MINUTE,
      }),
    );
    assert.throws(
      () => createHeartbeat({ courier: air.courier("c"), tag: TAG, beatsPerRound: -1 }),
      /whole number/,
    );
  });
});

describe("where the stationary device is", () => {
  const OFFICE = [485200000, 113400000]; // Meshtastic's scaling, München-ish
  /** Every pending promise, whatever the fake clock says the time is. */
  const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

  test("rides on the first echo and never again", () => {
    const air = fakeAir();
    const clock = fakeClock();
    const office = createHeartbeat({
      courier: air.courier("office"),
      tag: TAG,
      id: ID_B,
      beatsPerRound: 0,
      minuteMs: MINUTE,
      timers: clock,
      position: () => OFFICE,
    });
    const heard = [];
    const rider = createHeartbeat({
      courier: air.courier("rider"),
      tag: TAG,
      id: ID_A,
      minuteMs: MINUTE,
      timers: clock,
      onEvent: (event) => event.kind === "heard" && heard.push(event),
    });

    office.start();
    rider.start();
    clock.advance(1000);
    assert.deepEqual(heard.at(-1).pos, OFFICE, "the first answer says where it is");

    // A second round, an hour later: the office answers again and says nothing
    // about itself, because it has not moved and the air is not free.
    clock.advance(HOUR + 1000);
    assert.ok(heard.length >= 2, "a second round was answered");
    assert.equal(heard.at(-1).pos, null, "and it cost nothing to answer it");

    office.stop();
    rider.stop();
  });

  test("a send that failed keeps the position for the next one", async () => {
    const air = fakeAir();
    const clock = fakeClock();
    let region = "UNSET";
    const office = createHeartbeat({
      courier: air.courier("office", { fail: () => region === "UNSET" }),
      tag: TAG,
      id: ID_B,
      beatsPerRound: 0,
      minuteMs: MINUTE,
      timers: clock,
      position: () => OFFICE,
    });
    const heard = [];
    const rider = createHeartbeat({
      courier: air.courier("rider"),
      tag: TAG,
      id: ID_A,
      minuteMs: MINUTE,
      timers: clock,
      onEvent: (event) => event.kind === "heard" && heard.push(event),
    });

    office.start();
    rider.start();
    clock.advance(1000);
    // The clock is fake; the rejection is not. Real microtasks have to drain
    // before the heartbeat has learnt that the send failed.
    await settled();
    assert.equal(heard.length, 0, "an unconfigured node transmits nothing");

    region = "EU_868";
    clock.advance(HOUR + 1000);
    await settled();
    // The *first* echo that got through, not the last: by now a second round
    // has been answered too, and that one rightly says nothing about a device
    // that has not moved.
    assert.deepEqual(heard[0].pos, OFFICE, "the position waited for a node that could send it");
    assert.equal(heard.at(-1).pos, null, "and was not repeated once it had");

    office.stop();
    rider.stop();
  });

  test("the null island is refused, on the way out and on the way in", () => {
    const from = ID_A;
    assert.equal(decodeHeartbeat(encodeHeartbeat({ type: "echo", tag: TAG, from, pos: [0, 0] })).pos, null);
    assert.equal(decodeHeartbeat(encodeHeartbeat({ type: "echo", tag: TAG, from, pos: [1, 2.5] })).pos, null);
    assert.equal(
      decodeHeartbeat(dagCbor.encode({ v: 1, t: "echo", tag: TAG, p: from, pos: [0, 0] })).pos,
      null,
    );
    assert.deepEqual(
      decodeHeartbeat(encodeHeartbeat({ type: "echo", tag: TAG, from, pos: [485200000, 113400000] })).pos,
      [485200000, 113400000],
    );
  });
});

describe("asking only when asked", () => {
  const rider = (air, clock, extra = {}) =>
    createHeartbeat({
      courier: air.courier("rider"),
      tag: TAG,
      id: ID_A,
      minuteMs: MINUTE,
      timers: clock,
      ...extra,
    });

  test("no schedule means nothing goes out until the button", () => {
    const air = fakeAir();
    const clock = fakeClock();
    const heart = rider(air, clock, { roundEveryMs: null });

    heart.start();
    clock.advance(24 * HOUR);
    assert.equal(air.beatsFrom("rider").length, 0, "a day of silence");

    assert.equal(heart.beatNow(), true);
    assert.equal(air.beatsFrom("rider").length, 1);
    // After a round, not before it: the round is what would name a next time,
    // and a screen saying "next at 14:20" when nothing is coming is worse than
    // one that says nothing.
    assert.equal(heart.state().nextRoundAt, null, "and still no time to promise");
    // Still nothing on its own afterwards: one press is one round.
    clock.advance(24 * HOUR);
    assert.equal(air.beatsFrom("rider").length, beatsAfterOneUnansweredRound);

    heart.stop();
  });

  // A round nobody answers spends all its beats; that is what the round is for.
  const beatsAfterOneUnansweredRound = 5;

  test("the button resets the clock, so a round does not land on its heels", () => {
    const air = fakeAir();
    const clock = fakeClock();
    const heart = rider(air, clock, { roundEveryMs: HOUR, beatsPerRound: 1 });

    heart.start();
    assert.equal(air.beatsFrom("rider").length, 1, "the first round is at start");
    clock.advance(50 * MINUTE);

    heart.beatNow();
    assert.equal(air.beatsFrom("rider").length, 2);
    // Ten minutes later the original schedule would have fired. It must not:
    // the press moved the hour.
    clock.advance(11 * MINUTE);
    assert.equal(air.beatsFrom("rider").length, 2, "the old timer was cancelled");
    clock.advance(50 * MINUTE);
    assert.equal(air.beatsFrom("rider").length, 3, "an hour after the press");

    heart.stop();
  });

  test("it refuses when there is nothing to ask", () => {
    const air = fakeAir();
    const clock = fakeClock();

    const stopped = rider(air, clock, { roundEveryMs: null });
    assert.equal(stopped.beatNow(), false, "not started");

    const office = createHeartbeat({
      courier: air.courier("office"),
      tag: TAG,
      id: ID_B,
      beatsPerRound: 0,
      timers: clock,
    });
    office.start();
    assert.equal(office.beatNow(), false, "a device that only answers");
    office.stop();

    const busy = rider(air, clock, { roundEveryMs: null });
    busy.start();
    busy.beatNow();
    assert.equal(busy.beatNow(), false, "a round is already in the air");
    busy.stop();
  });
});
