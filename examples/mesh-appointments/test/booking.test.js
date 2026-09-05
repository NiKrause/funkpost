// SPDX-License-Identifier: GPL-3.0-only
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { createYjsProvider } from "@le-space/funkpost/yjs";
import { createMeshtasticCourier } from "@le-space/funkpost/courier";
import { createMemoryMeshPair } from "@le-space/funkpost/links/memory-mesh";
import { createBookingBook } from "../src/domain/booking.js";
import { CONFIRMED, PENDING, DECLINED, SUPERSEDED, CANCELLED } from "../src/domain/arbitration.js";
import {
  newToken,
  keysFromToken,
  actionMessage,
  verifyAction,
  verifiedCancels,
  toBase64Url,
  fromBase64Url,
} from "../src/domain/capability.js";

const MONDAY = "2026-09-07";
const NO_LIMIT = { dutyCycle: null };
const FAST = { rtoMs: 40, gapMs: 15, region: NO_LIMIT };

const until = async (fn, timeoutMs = 8000, stepMs = 5) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  throw new Error("condition not reached in time");
};

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe("the booking book", () => {
  test("a request occupies exactly its service length, and shows as busy", async () => {
    const doc = new Y.Doc();
    const book = createBookingBook({ doc });
    await book.request({ slotIndex: 8, serviceId: "cut", handle: "Nico", at: 1000 });

    const state = await book.state(MONDAY, 1);
    assert.deepEqual([...state.busy].sort((a, b) => a - b), [8, 9, 10], "45 min = 3 steps");
    assert.ok(!state.offerable("cut").some((s) => s.index === 8));
    assert.ok(state.offerable("cut").some((s) => s.index === 11), "the slot after is free");
  });

  test("auto mode confirms itself; ask mode waits for the salon", async () => {
    const auto = createBookingBook({ doc: new Y.Doc() });
    const { id: autoId } = await auto.request({ slotIndex: 4, serviceId: "trim", handle: "A", at: 1 });
    assert.equal((await auto.state(MONDAY, 1)).statusOf(autoId).status, CONFIRMED);

    const ask = createBookingBook({ doc: new Y.Doc() });
    ask.setShop({ mode: "ask" });
    const { id: askId } = await ask.request({ slotIndex: 4, serviceId: "trim", handle: "B", at: 1 });
    assert.equal((await ask.state(MONDAY, 1)).statusOf(askId).status, PENDING);

    ask.decide(askId, CONFIRMED, { at: 2 });
    assert.equal((await ask.state(MONDAY, 1)).statusOf(askId).status, CONFIRMED);

    const declined = createBookingBook({ doc: new Y.Doc() });
    declined.setShop({ mode: "ask" });
    const { id } = await declined.request({ slotIndex: 4, serviceId: "trim", handle: "C", at: 1 });
    declined.decide(id, DECLINED, { at: 2, note: "leider voll" });
    const state = await declined.state(MONDAY, 1);
    assert.equal(state.statusOf(id).status, DECLINED);
    assert.equal(state.statusOf(id).reason, "leider voll");
    assert.equal(state.busy.size, 0, "a declined booking frees its time");
  });

  test("the mask compacts busy time into one payload and is honoured on read", async () => {
    const doc = new Y.Doc();
    const book = createBookingBook({ doc });
    await book.request({ slotIndex: 2, serviceId: "cut", handle: "Nico", at: 1 });
    const bytes = await book.publishMask(MONDAY, 21);

    assert.ok(bytes.length <= 200, `${bytes.length} bytes must fit one frame`);

    // A customer who has the mask but not the entry still sees the time taken.
    const fresh = new Y.Doc();
    fresh.getMap("mask").set("bytes", bytes);
    const customer = createBookingBook({ doc: fresh });
    const state = await customer.state(MONDAY, 21);
    assert.ok(state.busy.has(2) && state.busy.has(3) && state.busy.has(4));
  });

  test("a mask computed for another horizon is ignored, not misread", async () => {
    const doc = new Y.Doc();
    const book = createBookingBook({ doc });
    await book.request({ slotIndex: 2, serviceId: "cut", handle: "Nico", at: 1 });
    await book.publishMask(MONDAY, 21);

    // Same rules, different week: the indices would mean other days entirely.
    const state = await book.state("2026-09-14", 21);
    assert.equal(state.busy.size, 3, "only the live entry counts, not the stale mask");
  });
});

describe("capability keys", () => {
  test("a token derives the same key pair every time", async () => {
    const token = newToken();
    const first = await keysFromToken(token);
    const second = await keysFromToken(token);
    assert.deepEqual([...first.publicKey], [...second.publicKey]);
    assert.equal(first.publicKey.length, 32);
  });

  test("a signed cancellation verifies; a replayed or altered one does not", async () => {
    const token = newToken();
    const { publicKey, sign } = await keysFromToken(token);
    const action = { bookingId: "bk1", action: "cancel", at: 1000 };
    const sig = await sign(actionMessage(action));

    assert.ok(await verifyAction(publicKey, sig, action));
    // The same signature moved to another booking, or another moment, is void.
    assert.ok(!(await verifyAction(publicKey, sig, { ...action, bookingId: "bk2" })));
    assert.ok(!(await verifyAction(publicKey, sig, { ...action, at: 1001 })));
    // And someone else's key cannot vouch for it.
    const other = await keysFromToken(newToken());
    assert.ok(!(await verifyAction(other.publicKey, sig, action)));
  });

  test("overhearing a booking does not let you cancel it", async () => {
    // The neighbour sees everything on the channel: the id, the public key,
    // the time. None of it is enough.
    const victim = await keysFromToken(newToken());
    const attacker = await keysFromToken(newToken());
    const action = { bookingId: "bk1", action: "cancel", at: 2000 };
    const forged = await attacker.sign(actionMessage(action));

    const cancels = await verifiedCancels(
      [{ id: "bk1", publicKey: victim.publicKey }],
      new Map([["bk1", { at: 2000, sig: forged }]]),
    );
    assert.equal(cancels.size, 0, "a forged cancellation must not survive verification");
  });

  test("malformed input is rejected quietly rather than thrown", async () => {
    assert.equal(await verifyAction(new Uint8Array(5), new Uint8Array(64), { bookingId: "x", action: "cancel", at: 1 }), false);
    assert.equal(await verifyAction(new Uint8Array(32), new Uint8Array(3), { bookingId: "x", action: "cancel", at: 1 }), false);
    await assert.rejects(() => keysFromToken(new Uint8Array(8)), /32 bytes/);
  });

  test("a token survives the round trip through a calendar note", () => {
    const token = newToken();
    const text = toBase64Url(token);
    assert.ok(!/[+/=]/.test(text), "must be URL-safe to sit in a link");
    assert.deepEqual([...fromBase64Url(text)], [...token]);
  });

  test("only the holder can cancel, and then the slot comes free", async () => {
    const doc = new Y.Doc();
    const book = createBookingBook({ doc });
    const { id, token } = await book.request({ slotIndex: 6, serviceId: "trim", handle: "Nico", at: 1 });
    assert.equal((await book.state(MONDAY, 1)).statusOf(id).status, CONFIRMED);

    await book.cancel(id, token, { at: 2 });
    const state = await book.state(MONDAY, 1);
    assert.equal(state.statusOf(id).status, CANCELLED);
    assert.equal(state.busy.size, 0);
  });

  test("a cancellation signed with the wrong token is written but never counts", async () => {
    const doc = new Y.Doc();
    const book = createBookingBook({ doc });
    const { id } = await book.request({ slotIndex: 6, serviceId: "trim", handle: "Nico", at: 1 });

    await book.cancel(id, newToken(), { at: 2 }); // an attacker's token
    assert.equal(
      (await book.state(MONDAY, 1)).statusOf(id).status,
      CONFIRMED,
      "the booking stands — the signature did not check out",
    );
  });
});

describe("the gate: two customers race for one slot over a lossy mesh", () => {
  test("both sides reach the same winner, and no packet is spent deciding", async () => {
    const pair = createMemoryMeshPair({ mtu: 60, delayMs: 1, lossFn: ({ seq }) => seq % 5 === 4 });
    const courierA = createMeshtasticCourier({ link: pair.a, ...FAST });
    const courierB = createMeshtasticCourier({ link: pair.b, ...FAST });

    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const anna = createBookingBook({ doc: docA });
    const bert = createBookingBook({ doc: docB });

    // Both want 14:00 on the Monday, and neither can see the other yet — the
    // partition that makes auto mode interesting.
    const { id: annaId } = await anna.request({ slotIndex: 20, serviceId: "cut", handle: "Anna", at: 1_000 });
    const { id: bertId } = await bert.request({ slotIndex: 20, serviceId: "cut", handle: "Bert", at: 1_500 });

    const provA = createYjsProvider({ doc: docA, courier: courierA, coalesceMs: 20 });
    const provB = createYjsProvider({ doc: docB, courier: courierB, coalesceMs: 20 });

    await until(() => provA.synced(docB) && provB.synced(docA));
    await settle(120);
    const trafficAfterConverging = provA.stats.payloadsSent + provB.stats.payloadsSent;

    const stateA = await anna.state(MONDAY, 1);
    const stateB = await bert.state(MONDAY, 1);

    // The same verdict on both phones, computed independently.
    assert.equal(stateA.statusOf(annaId).status, CONFIRMED, "Anna claimed it first");
    assert.equal(stateA.statusOf(bertId).status, SUPERSEDED);
    assert.equal(stateB.statusOf(annaId).status, CONFIRMED);
    assert.equal(stateB.statusOf(bertId).status, SUPERSEDED);

    // Bert's screen can say why, without asking anyone.
    assert.match(stateB.statusOf(bertId).reason, /booked it first/);

    // Nothing was transmitted to arbitrate. Resolving a race must not be able
    // to start another one, and on a duty-cycled link it must not cost airtime.
    await settle(200);
    assert.equal(
      provA.stats.payloadsSent + provB.stats.payloadsSent,
      trafficAfterConverging,
      "arbitration put bytes on the air",
    );

    // And the loser is offered a way out: the next free time.
    const alternatives = stateB.offerable("cut");
    assert.ok(alternatives.length > 0);
    assert.ok(!alternatives.some((s) => s.index === 20), "not the one that just went");

    provA.destroy();
    provB.destroy();
    courierA.close();
    courierB.close();
  });

  test("in ask mode the salon decides, and the loser is told rather than double-booked", async () => {
    const pair = createMemoryMeshPair({ mtu: 60, delayMs: 1 });
    const courierSalon = createMeshtasticCourier({ link: pair.a, ...FAST });
    const courierGuest = createMeshtasticCourier({ link: pair.b, ...FAST });

    const salonDoc = new Y.Doc();
    const guestDoc = new Y.Doc();
    const salon = createBookingBook({ doc: salonDoc });
    salon.setShop({ mode: "ask" });

    const provSalon = createYjsProvider({ doc: salonDoc, courier: courierSalon, coalesceMs: 20 });
    const provGuest = createYjsProvider({ doc: guestDoc, courier: courierGuest, coalesceMs: 20 });
    await until(() => provGuest.synced(salonDoc));

    const guest = createBookingBook({ doc: guestDoc });
    assert.equal(guest.shop().mode, "ask", "the rules crossed the air");

    const { id: early } = await guest.request({ slotIndex: 20, serviceId: "cut", handle: "Anna", at: 1_000 });
    await until(() => salonDoc.getMap("requests").has(early));
    const { id: late } = await salon.request({ slotIndex: 20, serviceId: "cut", handle: "Bert", at: 9_000 });

    // The salon prefers the later request — its word outranks the clock here.
    salon.decide(late, CONFIRMED, { at: 10_000 });
    salon.decide(early, DECLINED, { at: 10_001, note: "schon vergeben" });
    await until(async () => guestDoc.getMap("decisions").has(early));
    await until(() => provGuest.synced(salonDoc) && provSalon.synced(guestDoc));

    for (const [who, book] of [["salon", salon], ["guest", guest]]) {
      const state = await book.state(MONDAY, 1);
      assert.equal(state.statusOf(late).status, CONFIRMED, `${who} sees the salon's choice`);
      assert.equal(state.statusOf(early).status, DECLINED, `${who} sees the decline`);
      assert.equal(state.statusOf(early).reason, "schon vergeben");
    }

    provSalon.destroy();
    provGuest.destroy();
    courierSalon.close();
    courierGuest.close();
  });
});
