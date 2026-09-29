// SPDX-License-Identifier: GPL-3.0-only
/**
 * The track mesh-heartbeat produces (#180).
 *
 * What a range test has to answer is not "does the mesh work" but "from where,
 * and how hard was it" — so the beat number the echo carries since #174 is
 * recorded beside the position, and a place answered on the fourth beat is not
 * filed with one answered at once.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createCoverageTrack } from "../examples/mesh-heartbeat/src/track.js";

/** A clock the test moves by hand. */
const clock = () => {
  let at = 0;
  return { now: () => at, tick: (ms) => (at += ms) };
};

const HERE = { lat: 48.4, lon: 12.8 };

describe("the coverage track", () => {
  test("a beat answered on the first is not filed with one answered on the fourth", () => {
    const c = clock();
    const t = createCoverageTrack({ now: c.now });

    t.sent({ n: 1, of: 5, position: HERE });
    c.tick(900);
    t.answered({ n: 1 });

    c.tick(60_000);
    t.sent({ n: 4, of: 5, position: { lat: 48.5, lon: 12.9 } });
    c.tick(40_000);
    t.answered({ n: 4 });

    const [easy, hard] = t.points();
    assert.equal(easy.answered, 1);
    assert.equal(hard.answered, 4);
    assert.equal(t.summary().reached, 2, "both places answered");
    assert.equal(t.summary().firstBeat, 1, "only one answered at once");
  });

  test("silence is a point too, and keeps its position", () => {
    const t = createCoverageTrack({ now: clock().now });
    t.sent({ n: 1, of: 5, position: HERE });
    const gone = t.unanswered();

    assert.equal(gone.answered, null);
    assert.deepEqual(gone.position, HERE, "where it failed is the useful part");
    assert.equal(t.summary().reached, 0);
    assert.equal(t.summary().sent, 1);
  });

  test("a beat with no fix is recorded, not dropped", () => {
    // A node without GPS, or a browser that refused the permission. The answer
    // is still true; it simply cannot go on a map. Dropping it would make the
    // track look better than the ride was.
    const t = createCoverageTrack({ now: clock().now });
    t.sent({ n: 1, of: 5, position: null });
    t.answered({ n: 1 });

    const s = t.summary();
    assert.equal(s.sent, 1);
    assert.equal(s.reached, 1);
    assert.equal(s.located, 0, "and the page can say so");
  });

  test("an echo the radio repeated is not counted twice", () => {
    const t = createCoverageTrack({ now: clock().now });
    t.sent({ n: 2, of: 5, position: HERE });

    assert.ok(t.answered({ n: 2 }), "the first one lands");
    assert.equal(t.answered({ n: 2 }), null, "the repeat does not");
    assert.equal(t.summary().reached, 1);
  });

  test("an echo naming a beat we are not waiting on is ignored", () => {
    const t = createCoverageTrack({ now: clock().now });
    t.sent({ n: 3, of: 5, position: HERE });
    assert.equal(t.answered({ n: 1 }), null, "a straggler from an older round");
    assert.equal(t.summary().reached, 0);
  });

  test("a long ride keeps its newest points and drops the oldest", () => {
    const t = createCoverageTrack({ limit: 3, now: clock().now });
    for (const n of [1, 2, 3, 4]) {
      t.sent({ n, of: 5, position: HERE });
      t.answered({ n });
    }
    assert.deepEqual(
      t.points().map((p) => p.n),
      [2, 3, 4],
      "a phone's memory is finite and the ride is not",
    );
  });
});
