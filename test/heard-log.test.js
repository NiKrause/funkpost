// SPDX-License-Identifier: GPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHeardLog } from "../examples/mesh-heartbeat/src/heard.js";

test("counts the beats it was asked, and the ones it answered", () => {
  const log = createHeardLog({ now: () => 5 });
  log.heard({ type: "beat", from: "aaaa", n: 1, bytes: 49, position: { lat: 48.4, lon: 12.7 } });
  log.answered({ to: "aaaa", n: 1 });
  log.heard({ type: "beat", from: "aaaa", n: 2, bytes: 34 });

  assert.deepEqual(log.summary(), {
    heard: 2,
    answered: 1,
    askers: 1,
    echoes: 0,
    // Only the first beat of a round carries one, so this is rounds, not beats.
    located: 1,
  });
  const rows = log.rows();
  assert.equal(rows[0].answered, false, "newest first, and the newest is unanswered");
  assert.equal(rows[0].position, null, "a beat in the middle of a round has no place");
  assert.equal(rows[1].answered, true);
  assert.equal(rows[1].answeredAt, 5);
  assert.deepEqual(rows[1].position, { lat: 48.4, lon: 12.7 }, "the round's first beat has one");
});

test("an echo from somebody else's conversation is not a question to us", () => {
  const log = createHeardLog();
  log.heard({ type: "beat", from: "aaaa", n: 1 });
  log.heard({ type: "echo", from: "bbbb", n: 2 });

  const summary = log.summary();
  assert.equal(summary.heard, 1, "one device asked us something");
  assert.equal(summary.echoes, 1, "and the channel carried somebody else's answer");
  assert.equal(log.answered({ to: "bbbb", n: 2 }), null, "an echo is never answered");
});

test("counts the devices that asked, because a channel is shared", () => {
  const log = createHeardLog();
  log.heard({ type: "beat", from: "aaaa", n: 1 });
  log.heard({ type: "beat", from: "bbbb", n: 1 });
  log.heard({ type: "beat", from: "aaaa", n: 2 });
  assert.equal(log.summary().askers, 2);
});

test("keeps the newest when a ride outlasts the limit", () => {
  const log = createHeardLog({ limit: 2 });
  for (const n of [1, 2, 3]) log.heard({ type: "beat", from: "aaaa", n });
  const rows = log.rows();
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.n), [3, 2], "oldest dropped, newest first");
});
