// SPDX-License-Identifier: GPL-3.0-only
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SHOP, slotGrid, bookableSlots, serviceById } from "../src/domain/slots.js";
import { utcFromWall, wallAt, civilDays } from "../src/domain/time.js";

// Europe/Berlin, 2026: the clocks go forward on 29 March and back on 25 October.
const SPRING_FORWARD = "2026-03-29";
const FALL_BACK = "2026-10-25";

/** A salon open across the small hours, purely so the transitions are in range. */
const NIGHT_SHOP = {
  ...DEFAULT_SHOP,
  slotMinutes: 15,
  hours: { 0: [["01:00", "05:00"]] }, // Sundays only
  services: [{ id: "cut", label: "Schnitt", minutes: 30 }],
};

describe("slot grid — rules in, grid out", () => {
  test("a Ruhetag and a closure both remove a whole day", () => {
    const monday = "2026-09-07";
    const openDays = slotGrid(DEFAULT_SHOP, { fromISO: monday, days: 7 });
    // Wednesday is a Ruhetag in the defaults, Sunday has no entry at all.
    assert.ok(!openDays.some((s) => s.iso === "2026-09-09"), "Wednesday is closed");
    assert.ok(!openDays.some((s) => s.iso === "2026-09-13"), "Sunday is closed");

    const withClosure = slotGrid(
      { ...DEFAULT_SHOP, closures: ["2026-09-10"] },
      { fromISO: monday, days: 7 },
    );
    assert.ok(!withClosure.some((s) => s.iso === "2026-09-10"), "the closure removed Thursday");
    assert.ok(withClosure.length < openDays.length);
  });

  test("indices are dense and times strictly increase", () => {
    const grid = slotGrid(DEFAULT_SHOP, { fromISO: "2026-09-07", days: 7 });
    grid.forEach((slot, i) => assert.equal(slot.index, i));
    for (let i = 1; i < grid.length; i++) {
      assert.ok(grid[i].startMs > grid[i - 1].startMs, `slot ${i} goes backwards`);
    }
  });

  test("the same rules produce the same grid — every device must agree", () => {
    const a = slotGrid(DEFAULT_SHOP, { fromISO: "2026-09-07", days: 21 });
    const b = slotGrid(DEFAULT_SHOP, { fromISO: "2026-09-07", days: 21 });
    assert.deepEqual(
      a.map((s) => s.startMs),
      b.map((s) => s.startMs),
    );
  });

  test("the gate: three weeks of availability costs no bytes — it is a rule", () => {
    const grid = slotGrid(DEFAULT_SHOP, { fromISO: "2026-09-07", days: 21 });
    // 15 open days (Wednesdays and Sundays are shut) — 516 quarter-hours.
    assert.ok(grid.length > 500, `only ${grid.length} slots in three weeks?`);
    // What actually travels is the rule. Generously encoded, still tiny —
    // and it describes any horizon, not just this one.
    const onTheWire = new TextEncoder().encode(JSON.stringify(DEFAULT_SHOP)).length;
    assert.ok(onTheWire < 600, `the rules cost ${onTheWire} bytes`);
    assert.ok(
      onTheWire < grid.length * 4,
      "shipping the rule must beat shipping even 4 bytes per slot",
    );
  });
});

describe("slot grid — daylight saving", () => {
  test("skips the hour that does not exist when the clocks go forward", () => {
    const normal = slotGrid(NIGHT_SHOP, { fromISO: "2026-03-22", days: 1 }); // the Sunday before
    const transition = slotGrid(NIGHT_SHOP, { fromISO: SPRING_FORWARD, days: 1 });

    assert.equal(normal.length, 16, "01:00–05:00 in quarter-hours");
    assert.equal(transition.length, 12, "02:00–02:45 do not happen that night");
    assert.ok(
      !transition.some((s) => s.minuteOfDay >= 120 && s.minuteOfDay < 180),
      "no slot may claim a wall time the clock skipped",
    );
  });

  test("a wall time inside the gap has no instant at all", () => {
    assert.equal(
      utcFromWall({ year: 2026, month: 3, day: 29, hour: 2, minute: 30 }, "Europe/Berlin"),
      null,
    );
    assert.ok(
      utcFromWall({ year: 2026, month: 3, day: 29, hour: 3, minute: 30 }, "Europe/Berlin") != null,
    );
  });

  test("keeps every slot when the clocks go back, and still runs forwards", () => {
    const transition = slotGrid(NIGHT_SHOP, { fromISO: FALL_BACK, days: 1 });
    assert.equal(transition.length, 16, "every wall time exists — one of them twice");
    for (let i = 1; i < transition.length; i++) {
      assert.ok(transition[i].startMs > transition[i - 1].startMs, "instants must still increase");
    }
    // 01:00 to 05:00 is a five-hour night that day, and the grid should say so.
    const spanHours = (transition[15].startMs - transition[0].startMs) / 3_600_000;
    assert.equal(spanHours, 4.75, "the repeated hour makes the night longer");
  });

  test("round-trips a wall time through the zone in both directions", () => {
    for (const iso of ["2026-01-15", "2026-06-15", SPRING_FORWARD, FALL_BACK]) {
      const [year, month, day] = iso.split("-").map(Number);
      const at = utcFromWall({ year, month, day, hour: 14, minute: 30 }, "Europe/Berlin");
      const back = wallAt(at, "Europe/Berlin");
      assert.equal(back.hour, 14, `14:30 on ${iso}`);
      assert.equal(back.minute, 30);
    }
  });

  test("civil days step by dates, not by 24 hours", () => {
    const days = civilDays("2026-03-28", 3);
    assert.deepEqual(days.map((d) => d.iso), ["2026-03-28", "2026-03-29", "2026-03-30"]);
    assert.deepEqual(days.map((d) => d.weekday), [6, 0, 1]);
  });
});

describe("what can actually be booked", () => {
  const shop = DEFAULT_SHOP;
  const grid = slotGrid(shop, { fromISO: "2026-09-07", days: 1 }); // Monday, 09:00–18:00
  const cut = serviceById(shop, "cut"); // 45 min = 3 steps

  test("a long service needs consecutive free steps", () => {
    const free = bookableSlots(shop, grid, () => false, cut);
    // 36 quarter-hours in the day; the last two cannot fit a 45-minute cut.
    assert.equal(grid.length, 36);
    assert.equal(free.length, 34);
    assert.equal(free[free.length - 1].minuteOfDay, 17 * 60 + 15, "last start is 17:15");
  });

  test("a busy step blocks every overlapping start", () => {
    const busy = new Set([12]); // 12:00
    const free = bookableSlots(shop, grid, (i) => busy.has(i), cut);
    // Starts at 11:30, 11:45 and 12:00 all overlap index 12.
    for (const index of [10, 11, 12]) {
      assert.ok(!free.some((s) => s.index === index), `index ${index} must not be offered`);
    }
    assert.ok(free.some((s) => s.index === 9), "11:15 still fits before the gap");
    assert.ok(free.some((s) => s.index === 13), "12:15 is fine after it");
  });

  test("a service may not straddle two days", () => {
    const twoDays = slotGrid(shop, { fromISO: "2026-09-07", days: 2 });
    const lastOfMonday = 35;
    const free = bookableSlots(shop, twoDays, () => false, cut);
    assert.ok(
      !free.some((s) => s.index > lastOfMonday - 2 && s.index <= lastOfMonday),
      "no cut may start late enough to run past closing into Tuesday",
    );
  });
});
