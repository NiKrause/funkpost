// SPDX-License-Identifier: GPL-3.0-only
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { encodeMask, decodeMask, maskMatchesGrid, MASK_VERSION } from "../src/domain/mask.js";
import { DEFAULT_SHOP, slotGrid } from "../src/domain/slots.js";

describe("busy mask", () => {
  test("the gate: a mask round-trips exactly", () => {
    const busy = [0, 1, 7, 8, 63, 64, 511];
    const bytes = encodeMask({ fromISO: "2026-09-07", count: 516, busy });
    const back = decodeMask(bytes);

    assert.equal(back.version, MASK_VERSION);
    assert.equal(back.fromISO, "2026-09-07");
    assert.equal(back.count, 516);
    assert.deepEqual(back.busy(), busy);
    for (let i = 0; i < 516; i++) {
      assert.equal(back.isBusy(i), busy.includes(i), `slot ${i}`);
    }
  });

  test("three weeks of busy time fits in one LoRa frame", () => {
    const grid = slotGrid(DEFAULT_SHOP, { fromISO: "2026-09-07", days: 21 });
    // Worst case: every slot taken. The size does not depend on how many are.
    const full = encodeMask({
      fromISO: "2026-09-07",
      count: grid.length,
      busy: grid.map((s) => s.index),
    });
    assert.ok(full.length <= 200, `${full.length} bytes exceeds the MTU`);
    assert.equal(full.length, 7 + Math.ceil(grid.length / 8));

    const empty = encodeMask({ fromISO: "2026-09-07", count: grid.length, busy: [] });
    assert.equal(empty.length, full.length, "a bitmap costs the same either way");
  });

  test("ignores indices outside the horizon rather than corrupting the bitmap", () => {
    const bytes = encodeMask({ fromISO: "2026-09-07", count: 10, busy: [3, -1, 10, 999] });
    assert.deepEqual(decodeMask(bytes).busy(), [3]);
  });

  test("refuses a truncated or foreign mask instead of guessing", () => {
    assert.throws(() => decodeMask(new Uint8Array(3)), /too short/);
    const bytes = encodeMask({ fromISO: "2026-09-07", count: 100, busy: [1] });
    assert.throws(() => decodeMask(bytes.subarray(0, 9)), /more slots than it carries/);
    const wrongVersion = Uint8Array.from(bytes);
    wrongVersion[0] = 99;
    assert.throws(() => decodeMask(wrongVersion), /version 99/);
  });

  test("a mask only means anything against the grid it was computed for", () => {
    const bytes = encodeMask({ fromISO: "2026-09-07", count: 516, busy: [4] });
    const mask = decodeMask(bytes);
    assert.ok(maskMatchesGrid(mask, { fromISO: "2026-09-07", count: 516 }));
    // Same length, different horizon: indices would silently mean other days.
    assert.ok(!maskMatchesGrid(mask, { fromISO: "2026-09-14", count: 516 }));
    // Same horizon, different rules: the salon changed its hours.
    assert.ok(!maskMatchesGrid(mask, { fromISO: "2026-09-07", count: 500 }));
    assert.ok(!maskMatchesGrid(null, { fromISO: "2026-09-07", count: 516 }));
  });
});
