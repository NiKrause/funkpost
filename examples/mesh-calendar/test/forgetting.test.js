// SPDX-License-Identifier: GPL-3.0-only
/**
 * Expiry, which the claim log promised and did not do.
 *
 * #45 left Yjs because a state vector grows with every author who has ever
 * written and never shrinks, while a day-bucketed log "forgets last month
 * instead of remembering it for ever". Half of that was implemented:
 * `forgetBefore()` existed and **nothing called it** (#70), so the log grew
 * without bound on a different curve from Yjs's but a monotonic one all the
 * same.
 *
 * These tests pin the half that was missing, and the trap underneath it — that
 * dropping a day is not enough on its own, because a peer who still holds it
 * will offer it straight back.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  createClaimLog,
  encodeDigest,
  decodeDigest,
  divergentDays,
  recordId,
  KIND_REQUEST,
} from "../src/domain/claimlog.js";
import { createClaimSync, FORGET_GRACE_DAYS } from "../src/domain/claimsync.js";

const DAY = 20_700; // an arbitrary epoch day; only the arithmetic matters
const DAYS = 21;

const request = (day, id) => ({
  kind: KIND_REQUEST,
  day,
  id,
  at: 1000,
  slotIndex: 4,
  serviceId: "cut",
  handle: "Nico",
  publicKey: new Uint8Array(32).fill(7),
});

/** A log holding one request on each of the given days. */
const logWith = (...days) => {
  const log = createClaimLog();
  for (const day of days) log.put(request(day, `b${day}`));
  return log;
};

/** A courier that records what was sent and never delivers anything. */
const silentCourier = () => {
  const sent = [];
  return { sent, send: (bytes) => sent.push(bytes), onPayload: () => () => {} };
};

const syncOver = (log, fromDay, extra = {}) =>
  createClaimSync({
    log,
    courier: silentCourier(),
    horizon: () => ({ fromDay, days: DAYS }),
    announceOnStart: false,
    timers: { setTimeout: () => 0, clearTimeout: () => {} },
    ...extra,
  });

describe("the log forgets what the horizon has passed", () => {
  test("an announce drops the expired days, and keeps the grace day", () => {
    const yesterday = DAY - 1;
    const log = logWith(DAY - 30, DAY - 5, yesterday, DAY, DAY + 3);
    assert.equal(log.bucket(DAY - 30).size, 1, "before: the old days are held");

    syncOver(log, DAY).resync();

    assert.equal(log.bucket(DAY - 30).size, 0, "a month ago is gone");
    assert.equal(log.bucket(DAY - 5).size, 0, "and last week");
    assert.equal(log.bucket(yesterday).size, 1, "yesterday stays — the grace day");
    assert.equal(log.bucket(DAY).size, 1, "today, obviously");
    assert.equal(log.bucket(DAY + 3).size, 1, "and the future");
    assert.equal(log.floor, DAY - FORGET_GRACE_DAYS);
  });

  test("nothing to forget is not an event", () => {
    const log = logWith(DAY, DAY + 1);
    const events = [];
    syncOver(log, DAY, { onEvent: (e) => events.push(e) }).resync();
    assert.equal(
      events.filter((e) => e.kind === "forgot").length,
      0,
      "a log with nothing expired says nothing about expiry",
    );
  });

  test("dropped keys are handed to whoever is storing them", () => {
    const log = logWith(DAY - 10, DAY - 9, DAY);
    const dropped = [];
    log.onForget((keys) => dropped.push(...keys));

    syncOver(log, DAY).resync();

    assert.deepEqual(
      dropped.sort(),
      [recordId(request(DAY - 10, `b${DAY - 10}`)), recordId(request(DAY - 9, `b${DAY - 9}`))].sort(),
      "persistence is told exactly which records to delete",
    );
  });
});

describe("what is forgotten stays forgotten", () => {
  test("a peer offering an expired record is refused", async () => {
    const log = logWith(DAY - 10, DAY);
    syncOver(log, DAY).resync();

    const returning = request(DAY - 10, `b${DAY - 10}`);
    assert.equal(await log.accept(returning), false, "the day is below the floor");
    assert.equal(log.bucket(DAY - 10).size, 0, "and it did not come back");

    // The boundary itself is inclusive of the grace day, not of the day before.
    assert.equal(await log.accept(request(DAY - 1, "grace")), true);
  });

  test("an expired day in a peer's digest is not a disagreement", () => {
    // Two logs that were once in step. Ours has moved on; theirs has not.
    const ours = logWith(DAY - 10, DAY);
    const theirs = logWith(DAY - 10, DAY);
    syncOver(ours, DAY).resync();

    const theirDigest = decodeDigest(encodeDigest(theirs, DAY - 10, DAYS));

    assert.deepEqual(
      divergentDays(ours, theirDigest),
      [],
      "the day we dropped must not read as a day we are missing",
    );

    // The guard is specific: a genuine gap inside the live horizon still shows.
    theirs.put(request(DAY + 2, "new"));
    assert.deepEqual(divergentDays(ours, decodeDigest(encodeDigest(theirs, DAY - 10, DAYS))), [
      DAY + 2,
    ]);
  });

  test("the floor never moves backwards", async () => {
    const log = logWith(DAY - 3, DAY);
    log.forgetBefore(DAY);
    assert.equal(log.floor, DAY);

    // A clock that jumps back, or a horizon recomputed from a stale value.
    log.forgetBefore(DAY - 5);
    assert.equal(log.floor, DAY, "still today");
    assert.equal(
      await log.accept(request(DAY - 3, "old")),
      false,
      "and the records it dropped are still refused",
    );
  });
});
