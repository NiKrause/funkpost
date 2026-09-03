// SPDX-License-Identifier: GPL-3.0-only
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createTokenBucket, estimateAirtimeMs, PRESET_DATA_RATES_BPS } from "../lib/pacing.js";

describe("airtime estimate", () => {
  test("longer payloads and slower presets cost more air", () => {
    assert.ok(estimateAirtimeMs(200) > estimateAirtimeMs(20));
    assert.ok(estimateAirtimeMs(200, "LONG_FAST") > estimateAirtimeMs(200, "SHORT_FAST"));
    assert.ok(Number.isFinite(estimateAirtimeMs(0)));
  });

  test("unknown preset falls back to LONG_FAST", () => {
    assert.equal(estimateAirtimeMs(100, "NO_SUCH_PRESET"), estimateAirtimeMs(100, "LONG_FAST"));
  });

  test("the preset table is ordered the way physics orders it", () => {
    const r = PRESET_DATA_RATES_BPS;
    assert.ok(r.SHORT_FAST > r.MEDIUM_FAST);
    assert.ok(r.MEDIUM_FAST > r.LONG_FAST);
    assert.ok(r.LONG_FAST > r.LONG_SLOW);
  });
});

describe("token bucket", () => {
  test("no duty cycle means no waiting and infinite budget", () => {
    const bucket = createTokenBucket({ dutyCycle: null });
    assert.equal(bucket.take(100000), 0);
    assert.equal(bucket.remainingMs(), Number.POSITIVE_INFINITY);
  });

  test("burst fits the capacity, then the shortfall is paid in wall-clock", () => {
    let clock = 0;
    const bucket = createTokenBucket({ dutyCycle: 0.1, windowMs: 1000, now: () => clock });
    // capacity = 100 ms of airtime
    assert.equal(bucket.take(60), 0);
    assert.equal(bucket.take(40), 0);
    assert.equal(bucket.remainingMs(), 0);
    // 10 ms over budget: wait = 10 / 0.1 = 100 ms
    assert.equal(bucket.take(10), 100);
  });

  test("time refills the bucket at exactly the duty cycle", () => {
    let clock = 0;
    const bucket = createTokenBucket({ dutyCycle: 0.1, windowMs: 1000, now: () => clock });
    bucket.take(100); // budget spent
    bucket.take(10); // 10 ms borrowed
    clock = 500; // 50 ms refilled
    assert.equal(bucket.remainingMs(), 40); // 50 - 10 borrowed
    clock = 5000;
    assert.equal(bucket.remainingMs(), 100); // capped at capacity
  });

  test("reservations accumulate: concurrent takes serialize the airwaves", () => {
    let clock = 0;
    const bucket = createTokenBucket({ dutyCycle: 0.5, windowMs: 100, now: () => clock });
    // capacity 50 ms; three 30 ms sends reserved back-to-back
    assert.equal(bucket.take(30), 0);
    assert.equal(bucket.take(30), 20); // 10 over → 20 ms wait at 50 %
    assert.equal(bucket.take(30), 80); // 40 over → 80 ms wait
  });

  test("a zero or negative duty cycle is refused", () => {
    assert.throws(() => createTokenBucket({ dutyCycle: 0 }));
    assert.throws(() => createTokenBucket({ dutyCycle: -1 }));
  });
});
