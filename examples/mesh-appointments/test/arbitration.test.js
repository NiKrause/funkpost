// SPDX-License-Identifier: GPL-3.0-only
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import {
  arbitrate,
  busyIndices,
  CONFIRMED,
  PENDING,
  DECLINED,
  CANCELLED,
  SUPERSEDED,
} from "../src/domain/arbitration.js";

/** Deterministic shuffling, so a failure can be reproduced from its seed. */
const rng = (seed) => () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 0x100000000;

const shuffled = (items, random) => {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};

const claim = (id, slotIndex, claimedAt, steps = 1) => ({ id, slotIndex, steps, claimedAt });

const statuses = (verdict) =>
  [...verdict.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([id, v]) => `${id}:${v.status}`);

describe("arbitration — auto mode, where time decides", () => {
  test("the earliest claim wins and the rest are superseded", () => {
    const requests = [claim("b", 10, 1000), claim("a", 10, 900), claim("c", 10, 1100)];
    const verdict = arbitrate({ mode: "auto", requests });

    assert.equal(verdict.get("a").status, CONFIRMED);
    assert.equal(verdict.get("b").status, SUPERSEDED);
    assert.equal(verdict.get("c").status, SUPERSEDED);
    assert.match(verdict.get("b").reason, /booked it first/);
  });

  test("identical timestamps still resolve — the id breaks the tie", () => {
    const verdict = arbitrate({
      mode: "auto",
      requests: [claim("zeta", 5, 1000), claim("alpha", 5, 1000)],
    });
    assert.equal(verdict.get("alpha").status, CONFIRMED);
    assert.equal(verdict.get("zeta").status, SUPERSEDED);
  });

  test("a long service blocks the steps it actually occupies", () => {
    // 90 minutes at index 4 covers 4,5,6,7,8,9.
    const requests = [claim("long", 4, 900, 6), claim("short", 7, 1000, 1), claim("after", 10, 1000)];
    const verdict = arbitrate({ mode: "auto", requests });

    assert.equal(verdict.get("long").status, CONFIRMED);
    assert.equal(verdict.get("short").status, SUPERSEDED, "07 is inside the long booking");
    assert.equal(verdict.get("after").status, CONFIRMED, "10 is past it");
  });

  test("a cancelled booking releases its slot to the next in line", () => {
    const requests = [claim("first", 3, 900), claim("second", 3, 1000)];
    const withoutCancel = arbitrate({ mode: "auto", requests });
    assert.equal(withoutCancel.get("second").status, SUPERSEDED);

    const verdict = arbitrate({
      mode: "auto",
      requests,
      cancels: new Map([["first", { at: 1100 }]]),
    });
    assert.equal(verdict.get("first").status, CANCELLED);
    assert.equal(verdict.get("second").status, CONFIRMED, "the slot came free");
  });
});

describe("arbitration — ask mode, where the salon decides", () => {
  test("a confirmation outranks an earlier request", () => {
    const requests = [claim("early", 8, 900), claim("late", 8, 2000)];
    const verdict = arbitrate({
      mode: "ask",
      requests,
      decisions: new Map([["late", { status: CONFIRMED, decidedAt: 2100 }]]),
    });
    // In auto mode "early" would have won. The salon's word is the point of
    // this mode, so it does not.
    assert.equal(verdict.get("late").status, CONFIRMED);
    assert.equal(verdict.get("early").status, SUPERSEDED);
    assert.match(verdict.get("early").reason, /while you waited/);
  });

  test("undecided requests wait, and do not block each other", () => {
    const verdict = arbitrate({
      mode: "ask",
      requests: [claim("x", 8, 900), claim("y", 8, 950)],
    });
    // Both pending: the salon has not spoken, and an abandoned request must
    // never hold a slot hostage.
    assert.equal(verdict.get("x").status, PENDING);
    assert.equal(verdict.get("y").status, PENDING);
  });

  test("a decline releases the slot and is reported with its note", () => {
    const verdict = arbitrate({
      mode: "ask",
      requests: [claim("x", 8, 900), claim("y", 8, 950)],
      decisions: new Map([
        ["x", { status: DECLINED, decidedAt: 1000, note: "schon vergeben" }],
        ["y", { status: CONFIRMED, decidedAt: 1010 }],
      ]),
    });
    assert.equal(verdict.get("x").status, DECLINED);
    assert.equal(verdict.get("x").reason, "schon vergeben");
    assert.equal(verdict.get("y").status, CONFIRMED);
  });

  test("even two confirmations for one slot resolve identically everywhere", () => {
    // Only reachable if the salon ran on two devices at once — but it must not
    // produce a crash or a coin flip.
    const requests = [claim("p", 8, 900), claim("q", 8, 950)];
    const decisions = new Map([
      ["p", { status: CONFIRMED, decidedAt: 2000 }],
      ["q", { status: CONFIRMED, decidedAt: 1000 }],
    ]);
    const first = arbitrate({ mode: "ask", requests, decisions });
    const again = arbitrate({ mode: "ask", requests: [...requests].reverse(), decisions });

    assert.equal(first.get("q").status, CONFIRMED, "the earlier decision stands");
    assert.equal(first.get("p").status, SUPERSEDED);
    assert.deepEqual(statuses(first), statuses(again));
  });
});

describe("arbitration — the gate: order can never change the answer", () => {
  test("200 shuffles of 12 contested claims give one identical verdict", () => {
    const random = rng(20260905);
    const requests = Array.from({ length: 12 }, (_, i) =>
      claim(`bk${String(i).padStart(2, "0")}`, [3, 3, 3, 4, 7, 7, 9, 9, 9, 12, 12, 15][i], 1000 + (i % 5) * 10, i % 3 === 0 ? 2 : 1),
    );
    const decisions = new Map([["bk04", { status: DECLINED, decidedAt: 1200 }]]);
    const cancels = new Map([["bk09", { at: 1300 }]]);

    const reference = statuses(arbitrate({ mode: "auto", requests, decisions, cancels }));
    for (let round = 0; round < 200; round++) {
      const verdict = arbitrate({
        mode: "auto",
        requests: shuffled(requests, random),
        decisions,
        cancels,
      });
      assert.deepEqual(statuses(verdict), reference, `shuffle ${round} disagreed`);
    }
    // And it really is contested — a test that resolves nothing proves nothing.
    assert.ok(reference.some((s) => s.endsWith(SUPERSEDED)), "no contention in the fixture");
  });

  test("and neither can Yjs merge order — three replicas, three orders", () => {
    const random = rng(7);
    const entries = Array.from({ length: 10 }, (_, i) => ({
      id: `id${i}`,
      value: claim(`id${i}`, [2, 2, 5, 5, 5, 8, 8, 11, 11, 11][i], 1000 + ((i * 37) % 90)),
    }));

    // Each entry authored in its own document, so each is an independent update.
    const updates = entries.map(({ id, value }) => {
      const doc = new Y.Doc();
      doc.getMap("requests").set(id, value);
      return Y.encodeStateAsUpdate(doc);
    });

    const verdicts = [0, 1, 2].map((seed) => {
      const replica = new Y.Doc();
      for (const update of shuffled(updates, rng(seed + 1))) Y.applyUpdate(replica, update);
      const requests = [...replica.getMap("requests").entries()].map(([id, v]) => ({ id, ...v }));
      assert.equal(requests.length, 10, "every replica converged first");
      return statuses(arbitrate({ mode: "auto", requests }));
    });

    assert.deepEqual(verdicts[1], verdicts[0]);
    assert.deepEqual(verdicts[2], verdicts[0]);
    assert.ok(verdicts[0].some((s) => s.endsWith(SUPERSEDED)));
    void random;
  });
});

describe("busy indices", () => {
  test("count confirmed and pending, never superseded or cancelled", () => {
    const requests = [claim("a", 2, 900, 3), claim("b", 2, 1000), claim("c", 20, 900)];
    const verdict = arbitrate({ mode: "auto", requests });
    const busy = busyIndices(requests, verdict);

    assert.deepEqual([...busy].sort((x, y) => x - y), [2, 3, 4, 20]);
    assert.ok(!busy.has(5), "the superseded booking occupies nothing");
  });
});
