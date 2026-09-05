// SPDX-License-Identifier: GPL-3.0-only
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { createYjsProvider } from "@le-space/funkpost/yjs";
import { createMeshtasticCourier } from "@le-space/funkpost/courier";
import { createMemoryMeshPair } from "@le-space/funkpost/links/memory-mesh";
import { createBookingBook } from "../src/domain/booking.js";
import { createClaimLog, encodeDigest, KIND_DECISION, KIND_CANCEL } from "../src/domain/claimlog.js";
import { createClaimSync } from "../src/domain/claimsync.js";
import { CONFIRMED, PENDING, DECLINED, SUPERSEDED, CANCELLED } from "../src/domain/arbitration.js";
import { newToken, keysFromToken, actionMessage } from "../src/domain/capability.js";
import { epochDay, parseISODate } from "../src/domain/time.js";

const MONDAY = "2026-09-07";
const DAYS = 21;
const FROM_DAY = epochDay(parseISODate(MONDAY));
const horizon = () => ({ fromDay: FROM_DAY, days: DAYS });

const NO_LIMIT = { dutyCycle: null };
const FAST = { rtoMs: 40, gapMs: 15, region: NO_LIMIT };

const until = async (fn, timeoutMs = 8000, stepMs = 5) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  throw new Error("condition not reached in time");
};

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A salon on its own: rules in Yjs, bookings in a claim log. */
const makeBook = async (patch = {}) => {
  const doc = new Y.Doc();
  const log = createClaimLog();
  const book = createBookingBook({ doc, log });
  const salonToken = await book.becomeSalon();
  if (Object.keys(patch).length) book.setShop(patch);
  return { doc, log, book, salonToken };
};

const ask = (book, extra = {}) => ({ fromISO: MONDAY, days: DAYS, ...extra });

describe("the booking book on a claim log", () => {
  test("a request occupies exactly its service length, and shows as busy", async () => {
    const { book } = await makeBook();
    await book.request(ask(book, { slotIndex: 8, serviceId: "cut", handle: "Nico", at: 1000 }));

    const state = await book.state(MONDAY, DAYS);
    assert.deepEqual([...state.busy].sort((a, b) => a - b), [8, 9, 10], "45 min = 3 steps");
    assert.ok(!state.offerable("cut").some((s) => s.index === 8));
    assert.ok(state.offerable("cut").some((s) => s.index === 11));
  });

  test("a booking keeps its meaning when the horizon moves", async () => {
    const { book } = await makeBook();
    // Book Thursday, then look at the book from a week starting Wednesday.
    const grid = book.grid(MONDAY, DAYS);
    const thursday = grid.findIndex((s) => s.iso === "2026-09-10");
    await book.request(ask(book, { slotIndex: thursday, serviceId: "cut", handle: "Nico", at: 1 }));

    const shifted = await book.state("2026-09-09", 14);
    const booking = shifted.bookings.find((b) => b.handle === "Nico");
    assert.ok(booking, "the booking is still there");
    assert.equal(booking.status, CONFIRMED);
    assert.equal(shifted.grid[booking.slotIndex].iso, "2026-09-10", "and still on Thursday");
  });

  test("auto mode confirms itself; ask mode waits for the salon", async () => {
    const auto = await makeBook();
    const { id: autoId } = await auto.book.request(ask(auto.book, { slotIndex: 4, serviceId: "trim", handle: "A", at: 1 }));
    assert.equal((await auto.book.state(MONDAY, DAYS)).statusOf(autoId).status, CONFIRMED);

    const w = await makeBook({ mode: "ask" });
    const { id } = await w.book.request(ask(w.book, { slotIndex: 4, serviceId: "trim", handle: "B", at: 1 }));
    assert.equal((await w.book.state(MONDAY, DAYS)).statusOf(id).status, PENDING);

    await w.book.decide(id, CONFIRMED, { salonToken: w.salonToken, at: 2 });
    assert.equal((await w.book.state(MONDAY, DAYS)).statusOf(id).status, CONFIRMED);
  });

  test("a decline frees the time and carries its note", async () => {
    const { book, salonToken } = await makeBook({ mode: "ask" });
    const { id } = await book.request(ask(book, { slotIndex: 4, serviceId: "trim", handle: "C", at: 1 }));
    await book.decide(id, DECLINED, { salonToken, at: 2, note: "leider voll" });

    const state = await book.state(MONDAY, DAYS);
    assert.equal(state.statusOf(id).status, DECLINED);
    assert.equal(state.statusOf(id).reason, "leider voll");
    assert.equal(state.busy.size, 0);
  });

  test("the mask still hides who is booked, which is now its only job", async () => {
    const { book, doc } = await makeBook();
    await book.request(ask(book, { slotIndex: 2, serviceId: "cut", handle: "Nico", at: 1 }));
    const bytes = await book.publishMask(MONDAY, DAYS);
    assert.ok(bytes.length <= 200);

    // A customer holding only the rules and the mask sees the time is gone,
    // and learns nothing about whose it is.
    const fresh = new Y.Doc();
    Y.applyUpdate(fresh, Y.encodeStateAsUpdate(doc));
    const customer = createBookingBook({ doc: fresh, log: createClaimLog() });
    const state = await customer.state(MONDAY, DAYS);
    assert.ok(state.busy.has(2) && state.busy.has(3) && state.busy.has(4));
    assert.equal(state.bookings.length, 0, "no names, no handles, nothing");
  });
});

describe("authority is a signature, not a convention", () => {
  test("only the salon's key can decide — even locally", async () => {
    const { book, salonToken } = await makeBook({ mode: "ask" });
    const { id } = await book.request(ask(book, { slotIndex: 4, serviceId: "trim", handle: "A", at: 1 }));

    await assert.rejects(
      () => book.decide(id, CONFIRMED, { salonToken: newToken(), at: 2 }),
      /not signed by this shop's key/,
      "an impostor's decision is refused on the device that wrote it",
    );
    assert.equal((await book.state(MONDAY, DAYS)).statusOf(id).status, PENDING);

    await book.decide(id, CONFIRMED, { salonToken, at: 3 });
    assert.equal((await book.state(MONDAY, DAYS)).statusOf(id).status, CONFIRMED);
  });

  test("a forged decision arriving over the air is discarded", async () => {
    const { book, log } = await makeBook({ mode: "ask" });
    const { id } = await book.request(ask(book, { slotIndex: 4, serviceId: "trim", handle: "A", at: 1 }));
    const request = book.find(id);

    const impostor = await keysFromToken(newToken());
    const sig = await impostor.sign(actionMessage({ bookingId: id, action: "decide:confirmed", at: 2 }));
    const accepted = await log.accept({
      kind: KIND_DECISION, id, day: request.day, status: CONFIRMED, decidedAt: 2, sig,
    });

    assert.equal(accepted, false, "a decision is only a decision if the salon signed it");
    assert.equal((await book.state(MONDAY, DAYS)).statusOf(id).status, PENDING);
  });

  test("only the token holder can cancel, and the slot then comes free", async () => {
    const { book } = await makeBook();
    const { id, token } = await book.request(ask(book, { slotIndex: 6, serviceId: "trim", handle: "Nico", at: 1 }));
    assert.equal((await book.state(MONDAY, DAYS)).statusOf(id).status, CONFIRMED);

    await assert.rejects(() => book.cancel(id, newToken(), { at: 2 }), /not signed by this booking's key/);
    assert.equal((await book.state(MONDAY, DAYS)).statusOf(id).status, CONFIRMED, "the booking stands");

    await book.cancel(id, token, { at: 3 });
    const state = await book.state(MONDAY, DAYS);
    assert.equal(state.statusOf(id).status, CANCELLED);
    assert.equal(state.busy.size, 0);
  });

  test("a cancellation for a booking nobody holds is not taken on faith", async () => {
    const { log } = await makeBook();
    const { sign } = await keysFromToken(newToken());
    const sig = await sign(actionMessage({ bookingId: "ghost", action: "cancel", at: 1 }));
    assert.equal(
      await log.accept({ kind: KIND_CANCEL, id: "ghost", day: FROM_DAY, at: 1, sig }),
      false,
    );
  });
});

describe("the claim log: the greeting stops growing", () => {
  test("the headline: a digest is constant, whatever the number of writers", async () => {
    const sizes = [];
    for (const customers of [1, 100, 1000]) {
      const { book } = await makeBook();
      for (let i = 0; i < customers; i++) {
        // Every customer is a different person on a different device — the
        // case that made a Yjs state vector 5.9 kB at this scale (issue #45).
        // eslint-disable-next-line no-await-in-loop
        await book.request(ask(book, { slotIndex: i % 500, serviceId: "trim", handle: `k${i}`, at: 1000 + i }));
      }
      sizes.push(encodeDigest(book.log, FROM_DAY, DAYS).length);
    }
    assert.deepEqual(sizes, [111, 111, 111], "111 bytes — one frame — at every scale");
  });

  test("expiry is forgetting: yesterday's bookings simply stop existing", async () => {
    const { book, log } = await makeBook();
    const grid = book.grid(MONDAY, DAYS);
    const monday = grid.findIndex((s) => s.iso === "2026-09-07");
    const thursday = grid.findIndex((s) => s.iso === "2026-09-10");
    await book.request(ask(book, { slotIndex: monday, serviceId: "trim", handle: "past", at: 1 }));
    await book.request(ask(book, { slotIndex: thursday, serviceId: "trim", handle: "future", at: 2 }));
    assert.equal(log.size, 2);

    const dropped = log.forgetBefore(epochDay(parseISODate("2026-09-09")));
    assert.equal(dropped, 1);
    assert.equal(log.size, 1, "no tombstone, no client id, nothing left behind");

    const state = await book.state(MONDAY, DAYS);
    assert.equal(state.bookings.length, 1);
    assert.equal(state.bookings[0].handle, "future");
  });

  test("two decisions for one booking settle the same way on every device", async () => {
    const { book, salonToken, log } = await makeBook({ mode: "ask" });
    const { id } = await book.request(ask(book, { slotIndex: 4, serviceId: "trim", handle: "A", at: 1 }));
    const request = book.find(id);
    const { sign } = await keysFromToken(salonToken);

    // The salon answers from two devices; the later one arrives first.
    const late = { kind: KIND_DECISION, id, day: request.day, status: DECLINED, decidedAt: 900, note: null,
      sig: await sign(actionMessage({ bookingId: id, action: "decide:declined", at: 900 })) };
    const early = { kind: KIND_DECISION, id, day: request.day, status: CONFIRMED, decidedAt: 100, note: null,
      sig: await sign(actionMessage({ bookingId: id, action: "decide:confirmed", at: 100 })) };

    assert.ok(await log.accept(late));
    assert.ok(await log.accept(early));
    assert.equal(
      (await book.state(MONDAY, DAYS)).statusOf(id).status,
      CONFIRMED,
      "the earlier decision stands, whichever order they landed in",
    );
  });
});

/** Rules over Yjs, bookings over the claim log — both on one courier. */
const meshPair = (lossFn = null) => {
  const pair = createMemoryMeshPair({ mtu: 60, delayMs: 1, lossFn });
  const a = createMeshtasticCourier({ link: pair.a, ...FAST });
  const b = createMeshtasticCourier({ link: pair.b, ...FAST });
  return { a, b, close: () => (a.close(), b.close()) };
};

const wire = (doc, log, courier) => ({
  provider: createYjsProvider({ doc, courier, coalesceMs: 20 }),
  sync: createClaimSync({ log, courier, horizon, minAnnounceGapMs: 20 }),
});

describe("the gate: two customers race for one slot over a lossy mesh", () => {
  test("both sides reach the same winner, and no packet is spent deciding", async () => {
    const couriers = meshPair(({ seq }) => seq % 5 === 4);

    const annaDoc = new Y.Doc();
    const bertDoc = new Y.Doc();
    const annaLog = createClaimLog();
    const bertLog = createClaimLog();
    const anna = createBookingBook({ doc: annaDoc, log: annaLog });
    await anna.becomeSalon();

    const annaWire = wire(annaDoc, annaLog, couriers.a);
    const bertWire = wire(bertDoc, bertLog, couriers.b);
    await until(() => bertWire.provider.synced(annaDoc));
    const bert = createBookingBook({ doc: bertDoc, log: bertLog, sync: bertWire.sync });
    const annaBook = createBookingBook({ doc: annaDoc, log: annaLog, sync: annaWire.sync });

    const { id: annaId } = await annaBook.request(ask(annaBook, { slotIndex: 20, serviceId: "cut", handle: "Anna", at: 1_000 }));
    const { id: bertId } = await bert.request(ask(bert, { slotIndex: 20, serviceId: "cut", handle: "Bert", at: 1_500 }));

    await until(() => annaLog.size === 2 && bertLog.size === 2);
    await settle(150);
    const trafficAfterConverging = annaWire.sync.stats.payloadsSent + bertWire.sync.stats.payloadsSent;

    const stateA = await annaBook.state(MONDAY, DAYS);
    const stateB = await bert.state(MONDAY, DAYS);

    assert.equal(stateA.statusOf(annaId).status, CONFIRMED, "Anna claimed it first");
    assert.equal(stateA.statusOf(bertId).status, SUPERSEDED);
    assert.equal(stateB.statusOf(annaId).status, CONFIRMED);
    assert.equal(stateB.statusOf(bertId).status, SUPERSEDED);
    assert.match(stateB.statusOf(bertId).reason, /booked it first/);

    await settle(250);
    assert.equal(
      annaWire.sync.stats.payloadsSent + bertWire.sync.stats.payloadsSent,
      trafficAfterConverging,
      "arbitration put bytes on the air",
    );

    const alternatives = stateB.offerable("cut");
    assert.ok(alternatives.length > 0 && !alternatives.some((s) => s.index === 20));

    annaWire.provider.destroy();
    bertWire.provider.destroy();
    annaWire.sync.close();
    bertWire.sync.close();
    couriers.close();
  });

  test("peers already in step exchange one digest and fall silent", async () => {
    const couriers = meshPair();
    const salonDoc = new Y.Doc();
    const guestDoc = new Y.Doc();
    const salonLog = createClaimLog();
    const guestLog = createClaimLog();

    const salonWire = wire(salonDoc, salonLog, couriers.a);
    const guestWire = wire(guestDoc, guestLog, couriers.b);
    const salon = createBookingBook({ doc: salonDoc, log: salonLog, sync: salonWire.sync });
    await salon.becomeSalon();
    await until(() => guestWire.provider.synced(salonDoc));

    await salon.request(ask(salon, { slotIndex: 8, serviceId: "cut", handle: "Anna", at: 1 }));
    await until(() => guestLog.size === 1);
    await settle(200);

    const quiet = salonWire.sync.stats.payloadsSent + guestWire.sync.stats.payloadsSent;
    salonWire.sync.resync();
    guestWire.sync.resync();
    await settle(250);

    // Two digests went out, and nothing came back: agreement is one frame each.
    assert.equal(
      salonWire.sync.stats.payloadsSent + guestWire.sync.stats.payloadsSent - quiet,
      2,
      "an in-step greeting must cost exactly one payload per side",
    );
    assert.ok(salonWire.sync.inStepWith(guestLog));

    salonWire.provider.destroy();
    guestWire.provider.destroy();
    salonWire.sync.close();
    guestWire.sync.close();
    couriers.close();
  });

  test("in ask mode the salon decides, and its signature crosses with the decision", async () => {
    const couriers = meshPair();
    const salonDoc = new Y.Doc();
    const guestDoc = new Y.Doc();
    const salonLog = createClaimLog();
    const guestLog = createClaimLog();

    const salonWire = wire(salonDoc, salonLog, couriers.a);
    const guestWire = wire(guestDoc, guestLog, couriers.b);
    const salon = createBookingBook({ doc: salonDoc, log: salonLog, sync: salonWire.sync });
    const salonToken = await salon.becomeSalon();
    salon.setShop({ mode: "ask" });

    await until(() => guestWire.provider.synced(salonDoc));
    const guest = createBookingBook({ doc: guestDoc, log: guestLog, sync: guestWire.sync });
    assert.equal(guest.shop().mode, "ask", "the rules crossed the air");

    const { id } = await guest.request(ask(guest, { slotIndex: 20, serviceId: "cut", handle: "Anna", at: 1_000 }));
    await until(() => salonLog.size === 1);
    assert.equal((await guest.state(MONDAY, DAYS)).statusOf(id).status, PENDING);

    await salon.decide(id, CONFIRMED, { salonToken, at: 10_000 });
    // The guest's log verifies the salon's signature against the key it learned
    // from the rules — it never has to take the decision on trust.
    await until(async () => (await guest.state(MONDAY, DAYS)).statusOf(id)?.status === CONFIRMED);
    assert.ok(guestLog.salonKey, "the guest knows who the salon is");

    salonWire.provider.destroy();
    guestWire.provider.destroy();
    salonWire.sync.close();
    guestWire.sync.close();
    couriers.close();
  });
});

describe("joining a room that already has a book", () => {
  test("a fresh peer greets first, and the book comes to it", async () => {
    const couriers = meshPair();
    const salonDoc = new Y.Doc();
    const salonLog = createClaimLog();
    const salonWire = wire(salonDoc, salonLog, couriers.a);
    const salon = createBookingBook({ doc: salonDoc, log: salonLog, sync: salonWire.sync });
    await salon.becomeSalon();
    await salon.request(ask(salon, { slotIndex: 8, serviceId: "cut", handle: "Anna", at: 1 }));

    // Nobody was listening while all of that happened — the case of a calendar
    // link opened months later on a phone that has never seen this book.
    await settle(60);

    const guestDoc = new Y.Doc();
    const guestLog = createClaimLog();
    const guestWire = wire(guestDoc, guestLog, couriers.b);

    // Without a greeting on start, this waits for ever: the salon has no reason
    // to speak, and the guest has nothing to publish.
    await until(() => guestLog.size === 1);
    const guest = createBookingBook({ doc: guestDoc, log: guestLog, sync: guestWire.sync });
    const state = await guest.state(MONDAY, DAYS);
    assert.equal(state.bookings.length, 1);
    assert.equal(state.bookings[0].handle, "Anna");

    salonWire.provider.destroy();
    guestWire.provider.destroy();
    salonWire.sync.close();
    guestWire.sync.close();
    couriers.close();
  });
});

describe("a booking is a fact, not a row in today's grid", () => {
  test("it stays visible even when the shown grid does not contain its time", async () => {
    const { book } = await makeBook();
    const grid = book.grid(MONDAY, DAYS);
    // Thursday AFTERNOON — the part the shortened hours below will remove.
    const thursday = grid.findIndex((s) => s.iso === "2026-09-10" && s.minuteOfDay === 14 * 60);
    const { id } = await book.request(ask(book, { slotIndex: thursday, serviceId: "cut", handle: "Nico", at: 1 }));

    // The salon shortens its day; that Thursday afternoon is no longer a slot
    // on the grid at all. The appointment did not stop existing.
    book.setShop({ hours: { 1: [["09:00", "10:00"]], 4: [["09:00", "10:00"]] } });
    const state = await book.state(MONDAY, DAYS);

    const booking = state.bookings.find((b) => b.id === id);
    assert.ok(booking, "a booking must never vanish because the view changed");
    assert.equal(booking.onGrid, false);
    assert.equal(booking.slotIndex, null);
    assert.equal(booking.status, CONFIRMED);
    assert.equal(state.offGrid.length, 1, "and it is reported as off-grid, not lost");
  });

  test("off-grid bookings do not block slots that are on it", async () => {
    const { book } = await makeBook();
    const grid = book.grid(MONDAY, DAYS);
    const thursday = grid.findIndex((s) => s.iso === "2026-09-10" && s.minuteOfDay === 14 * 60);
    await book.request(ask(book, { slotIndex: thursday, serviceId: "cut", handle: "Nico", at: 1 }));
    book.setShop({ hours: { 1: [["09:00", "10:00"]] } });

    const state = await book.state(MONDAY, DAYS);
    assert.equal(state.busy.size, 0, "an appointment off the grid occupies nothing on it");
  });
});

describe("presence", () => {
  test("each side hears the other, and never counts itself", async () => {
    const couriers = meshPair();
    const salonLog = createClaimLog();
    const guestLog = createClaimLog();
    const salonSync = createClaimSync({ log: salonLog, courier: couriers.a, horizon });
    const guestSync = createClaimSync({ log: guestLog, courier: couriers.b, horizon });

    await until(() => salonSync.presence().peers.length === 1 && guestSync.presence().peers.length === 1);
    assert.equal(salonSync.presence().peers.length, 1, "one peer, not two — our own digest is ours");
    assert.ok(salonSync.presence().lastHeardAgoMs != null);

    salonSync.close();
    guestSync.close();
    couriers.close();
  });

  test("nothing heard means nothing claimed", () => {
    const sync = createClaimSync({
      log: createClaimLog(),
      courier: { send: () => Promise.resolve(), onPayload: () => () => {} },
      horizon,
    });
    const seen = sync.presence();
    assert.deepEqual(seen.peers, []);
    assert.equal(seen.lastHeardAgoMs, null, "silence must not read as company");
    sync.close();
  });
});
