// SPDX-License-Identifier: GPL-3.0-only
/**
 * Where everyone is: the wire, and what a group of them costs.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  encodeBeacon,
  decodeBeacon,
  sameGroup,
  groupAirtime,
  STATES,
  ROLES,
} from "../lib/beacon.js";
import { encodeHeartbeat, decodeHeartbeat } from "../lib/heartbeat.js";

const TAG = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
const OTHER_TAG = new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9]);
const ME = new Uint8Array([0xb3, 0x8a, 0x69, 0x1f]);
const PLACE = [484116100, 127603500]; // Eggenfelden-ish, Meshtastic's scaling

describe("a beacon on the wire", () => {
  test("round-trips a place, how good it is, and a state", () => {
    const message = decodeBeacon(
      encodeBeacon({ tag: TAG, from: ME, pos: PLACE, accuracy: 8, state: "come" }),
    );
    assert.deepEqual(message.pos, PLACE);
    assert.deepEqual([...message.from], [...ME]);
    assert.equal(message.accuracy, 8);
    assert.equal(message.state, "come");
    assert.ok(sameGroup(message, TAG));
    assert.ok(!sameGroup(message, OTHER_TAG), "another group on the same channel");
  });

  test("44, 49 and 53 bytes — the three shapes a walk sends", () => {
    // Quoted by the page's own cost line and by groupAirtime's default, which
    // is why they are held still here rather than estimated there.
    const size = (opts) => encodeBeacon({ tag: TAG, from: ME, pos: PLACE, ...opts }).length;
    assert.equal(size({}), 44, "a bare position");
    assert.equal(size({ accuracy: 8 }), 49, "the scheduled one, with a good fix");
    assert.equal(size({ accuracy: 8, state: "help" }), 53, "and a deliberate check-in");
  });

  test("saying you are fine costs nothing, because it is the default", () => {
    const plain = encodeBeacon({ tag: TAG, from: ME, pos: PLACE, accuracy: 8 });
    const ok = encodeBeacon({ tag: TAG, from: ME, pos: PLACE, accuracy: 8, state: "ok" });
    assert.equal(ok.length, plain.length);
    assert.equal(decodeBeacon(ok).state, "ok");
  });

  test("a state nobody here knows is not a reason to drop a position", () => {
    // A newer peer with a fifth state still knows where it is, and that is the
    // part a map needs.
    const bytes = encodeBeacon({ tag: TAG, from: ME, pos: PLACE });
    const tampered = decodeBeacon(bytes);
    assert.equal(tampered.state, "ok");
    assert.ok(STATES.includes(tampered.state));
  });

  test("refuses what is not a beacon, rather than guessing", () => {
    for (const [why, bytes] of [
      ["not dag-cbor at all", new Uint8Array([0xff, 0xfe, 0xfd])],
      ["empty", new Uint8Array()],
    ]) {
      assert.equal(decodeBeacon(bytes), null, why);
    }
    assert.throws(() => encodeBeacon({ tag: TAG.slice(0, 4), from: ME, pos: PLACE }), /8-byte tag/);
    assert.throws(() => encodeBeacon({ tag: TAG, from: TAG, pos: PLACE }), /4-byte sender/);
    // The Gulf of Guinea, which is what a receiver with no fix reports.
    assert.throws(() => encodeBeacon({ tag: TAG, from: ME, pos: [0, 0] }), /without a place/);
    assert.throws(() => encodeBeacon({ tag: TAG, from: ME, pos: [1.5, 2] }), /without a place/);
  });

  test("being the fox is a role, not a mood — a device can be both", () => {
    // Separate fields on purpose: "I am stopping here" and "I am the one being
    // hunted" are different kinds of fact.
    const hunted = decodeBeacon(
      encodeBeacon({ tag: TAG, from: ME, pos: PLACE, role: "fox", state: "help" }),
    );
    assert.equal(hunted.role, "fox");
    assert.equal(hunted.state, "help");
    assert.ok(ROLES.includes(hunted.role));
  });

  test("a game costs nothing to the people not playing it", () => {
    const plain = encodeBeacon({ tag: TAG, from: ME, pos: PLACE, accuracy: 8 });
    const walker = encodeBeacon({ tag: TAG, from: ME, pos: PLACE, accuracy: 8, role: "walker" });
    assert.equal(walker.length, plain.length, "walker is the absence of the field");
    assert.equal(decodeBeacon(plain).role, "walker", "and the absence reads as walker");
    // The fox pays for itself, which is the right way round: one device in a
    // group carries the three bytes that make the game legible.
    assert.equal(encodeBeacon({ tag: TAG, from: ME, pos: PLACE, accuracy: 8, role: "fox" }).length, 52);
  });

  test("a role nobody here knows is not a reason to drop a position", () => {
    assert.throws(() => encodeBeacon({ tag: TAG, from: ME, pos: PLACE, role: "badger" }), /not a role/);
  });

  test("the two protocols on one channel do not read each other's post", () => {
    // Both are dag-cbor behind no prefix byte, and a group out walking may well
    // have a mesh-todo phone on the same channel asking whether anyone is there.
    const beat = encodeHeartbeat({ type: "beat", tag: TAG, from: ME, n: 1 });
    assert.equal(decodeBeacon(beat), null, "a beat is not a beacon");

    const beacon = encodeBeacon({ tag: TAG, from: ME, pos: PLACE, accuracy: 8 });
    assert.equal(decodeHeartbeat(beacon), null, "and a beacon is not a beat");
  });
});

describe("what a group costs", () => {
  test("the interval follows the group size, not the other way round", () => {
    // The number that shapes the whole app: ten people at one a minute is the
    // entire measured carrier, and LoRa collapses long before it is full.
    assert.equal(groupAirtime({ people: 10, everyMin: 1 }).share, 98);
    assert.equal(groupAirtime({ people: 10, everyMin: 2 }).share, 49);
    assert.equal(groupAirtime({ people: 10, everyMin: 5 }).share, 20);
    assert.equal(groupAirtime({ people: 2, everyMin: 5 }).share, 4);
  });

  test("both figures come from the exact rate, not from each other", () => {
    // 5 people every 2 minutes is 122.5 B a minute. Rounding that to 123 and
    // then multiplying gives 7380 an hour, which is 30 bytes that nobody
    // sends. Each figure is rounded from the exact rate instead — so
    // multiplying the displayed minute by 60 need not match the displayed
    // hour, and the hour is the one that is right.
    const cost = groupAirtime({ people: 5, everyMin: 2 });
    assert.equal(cost.perMinute, 123);
    assert.equal(cost.perHour, 7350);
    assert.notEqual(cost.perHour, cost.perMinute * 60);
  });

  test("nobody walking costs nothing to say", () => {
    assert.equal(groupAirtime({ people: 0, everyMin: 1 }), null);
    assert.equal(groupAirtime({ people: 3, everyMin: 0 }), null);
  });
});
