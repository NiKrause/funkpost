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

/**
 * A shared channel (#180).
 *
 * Everyone running this app with the same question hears everyone else. Two
 * parties testing their own pair of devices on the public channel answer each
 * other's beats, and a track that only remembered *that* something answered
 * would report a stranger's coverage as this device's.
 */
describe("who answered", () => {
  test("the row names the device, and the summary counts how many there were", () => {
    const track = createCoverageTrack();

    track.sent({ n: 1, of: 3 });
    track.answered({ n: 1, from: "myoffice" });
    track.sent({ n: 1, of: 3 });
    track.answered({ n: 1, from: "astranger" });
    track.sent({ n: 1, of: 3 });
    track.answered({ n: 1, from: "myoffice" });

    assert.deepEqual(
      track.points().map((p) => p.answeredBy),
      ["myoffice", "astranger", "myoffice"],
    );
    // Three answered beats, two devices behind them: the second number is the
    // one that says the channel was shared.
    assert.equal(track.summary().reached, 3);
    assert.equal(track.summary().answerers, 2);
  });

  test("a silence names nobody", () => {
    const track = createCoverageTrack();
    track.sent({ n: 1, of: 3 });
    track.unanswered();
    assert.equal(track.points()[0].answeredBy, null);
    assert.equal(track.summary().answerers, 0);
  });
});

describe("a round that was cut short", () => {
  test("is removed, not filed as a silence", () => {
    const track = createCoverageTrack();

    track.sent({ n: 1, of: 3, position: { lat: 48.4, lon: 12.7 } });
    track.answered({ n: 1, from: "office" });
    track.sent({ n: 1, of: 3, position: { lat: 48.5, lon: 12.8 } });

    // The radio was reconfigured mid-round. That place was never tested.
    assert.equal(track.abandon()?.n, 1);
    assert.equal(track.points().length, 1, "the abandoned beat is gone");
    assert.equal(track.summary().sent, 1);
    // And a silence still is one: the two must not collapse into each other.
    track.sent({ n: 1, of: 3 });
    track.unanswered();
    assert.equal(track.points().length, 2);
    assert.equal(track.summary().sent, 2);
    assert.equal(track.summary().reached, 1);
  });

  test("with nothing open it does nothing", () => {
    const track = createCoverageTrack();
    assert.equal(track.abandon(), null);
    track.sent({ n: 1, of: 3 });
    track.answered({ n: 1, from: "office" });
    assert.equal(track.abandon(), null, "an answered beat is not open");
    assert.equal(track.points().length, 1);
  });
});

test("an echo slower than the gap between beats still answers its beat", () => {
  // Reported from the field: the stationary device's screen showed the beat
  // arriving, and the riding phone's table said "no answer" against it.
  //
  // On LONG_FAST an answer can easily take longer than the fifteen seconds to
  // the next beat. Beat 1 goes out, beat 2 follows, and *then* the echo naming
  // beat 1 arrives — matched against the open beat alone it is discarded as a
  // duplicate, and a round the office demonstrably answered is filed as two
  // silences.
  const track = createCoverageTrack({ now: () => 1 });
  track.sent({ n: 1, of: 3, position: { lat: 48.4, lon: 12.7 } });
  track.sent({ n: 2, of: 3, position: { lat: 48.4, lon: 12.8 } });

  const answered = track.answered({ n: 1, from: "b38a691f" });
  assert.ok(answered, "the echo answers the beat it names");
  assert.equal(answered.n, 1);
  assert.equal(answered.answered, 1, "and says which beat got through");
  assert.equal(answered.answeredBy, "b38a691f");

  const points = track.points();
  assert.equal(points[0].answeredAt, 1, "beat 1's row is the one that closed");
  assert.equal(points[1].answered, null, "beat 2 was not answered, and does not pretend to be");
});

test("an echo from a round already over does not reopen it", () => {
  const track = createCoverageTrack({ now: () => 1 });
  track.sent({ n: 1, of: 3 });
  track.unanswered();
  track.sent({ n: 1, of: 3 }); // the next round

  // The radio repeats; a stale echo naming beat 1 belongs to the round that is
  // running, not to the one that was given up on.
  const answered = track.answered({ n: 1, from: "b38a691f" });
  const points = track.points(); // copies, so compare what they say
  assert.ok(answered, "the running round is answered");
  assert.equal(points.at(-1).answeredBy, "b38a691f", "by the beat that is in the air");
  assert.equal(points[0].answered, null, "and the old round stays a silence");
  assert.equal(points[0].answeredAt, null);
});
