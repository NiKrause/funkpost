// SPDX-License-Identifier: GPL-3.0-only
/**
 * Keeping the screen awake, which is keeping the radio reachable: Web
 * Bluetooth pauses when the screen locks, and in a pocket nobody notices.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createWakeLock } from "../examples/radio/wake-lock.js";

/** A browser's wake lock, as far as this cares. */
function fakeApi({ refuse = false } = {}) {
  const sentinels = [];
  return {
    sentinels,
    async request() {
      if (refuse) throw new Error("not allowed");
      const s = { released: false, release: async () => (s.released = true), addEventListener() {} };
      sentinels.push(s);
      return s;
    },
  };
}

describe("the screen lock", () => {
  test("asked for, held, and given back", async () => {
    const api = fakeApi();
    const events = [];
    const lock = createWakeLock({ wakeLock: api, onEvent: (e) => events.push(e.kind) });

    await lock.set(true);
    assert.ok(lock.held());
    assert.ok(lock.wanted());

    await lock.set(false);
    assert.ok(!lock.held());
    assert.ok(api.sentinels[0].released);
    assert.deepEqual(events, ["on", "off"]);
  });

  test("a refusal is not an error worth stopping for", async () => {
    // Some browsers have none; some refuse without a gesture.
    const events = [];
    const lock = createWakeLock({ wakeLock: fakeApi({ refuse: true }), onEvent: (e) => events.push(e) });
    assert.equal(await lock.set(true), false);
    assert.ok(!lock.wanted(), "the switch goes back off");
    assert.equal(events[0].kind, "refused");
    assert.match(events[0].reason, /not allowed/);
  });

  test("no wake lock in this browser is its own answer", async () => {
    const events = [];
    const lock = createWakeLock({ wakeLock: null, onEvent: (e) => events.push(e) });
    assert.equal(await lock.set(true), false);
    assert.equal(events[0].kind, "refused");
  });

  test("the browser drops it when the page hides, and does not give it back", async () => {
    // Somebody switching to a map and back has silently lost it; nothing tells
    // the page, so the page has to ask.
    const api = fakeApi();
    const lock = createWakeLock({ wakeLock: api });
    await lock.set(true);

    // What the browser does on hide, as far as a page can see.
    api.sentinels[0].release();
    lock.release();
    assert.ok(!lock.held());
    assert.ok(lock.wanted(), "but it is still what somebody asked for");

    await lock.reacquireIfWanted(true);
    assert.ok(lock.held(), "and coming back gets it again");
    assert.equal(api.sentinels.length, 2);
  });

  test("it is not re-asked while hidden, or when nobody asked", async () => {
    const api = fakeApi();
    const lock = createWakeLock({ wakeLock: api });
    assert.equal(await lock.reacquireIfWanted(true), false, "nobody asked");
    await lock.set(true);
    assert.equal(await lock.reacquireIfWanted(false), false, "still hidden");
    assert.equal(api.sentinels.length, 1);
  });
});

test("the browser taking it away is a thing a page can say", async () => {
  // mesh-calendar was alone in noticing this, and a naive extraction would
  // have lost it: the sentinel is released, nobody asked, and the only moment
  // anything could notice has passed.
  const api = fakeApi();
  const events = [];
  const lock = createWakeLock({ wakeLock: api, onEvent: (e) => events.push(e.kind) });
  await lock.set(true);

  // What the browser does on hide: it releases, and fires at the sentinel.
  api.sentinels[0].listeners?.forEach((fn) => fn());
  assert.deepEqual(events, ["on"], "no listener wired yet in this stub");

  // With one wired, the page hears about it.
  const api2 = {
    sentinels: [],
    async request() {
      const s = {
        release: async () => {},
        addEventListener: (_, fn) => (s.fire = fn),
      };
      api2.sentinels.push(s);
      return s;
    },
  };
  const seen = [];
  const lock2 = createWakeLock({ wakeLock: api2, onEvent: (e) => seen.push(e.kind) });
  await lock2.set(true);
  api2.sentinels[0].fire();
  assert.deepEqual(seen, ["on", "dropped"]);
  assert.ok(lock2.wanted(), "and it is still what somebody asked for");
});
