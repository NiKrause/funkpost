// SPDX-License-Identifier: GPL-3.0-only
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  fragmentPayload,
  encodeStatus,
  decodeFrame,
  createReassembler,
  DATA_HEADER_BYTES,
} from "../lib/framing.js";

const bytesOf = (length, seed = 7) =>
  Uint8Array.from({ length }, (_, i) => (i * seed + 3) & 0xff);

describe("framing", () => {
  test("single-fragment roundtrip", () => {
    const payload = bytesOf(50);
    const { frames, total } = fragmentPayload(payload, { mtu: 200 });
    assert.equal(total, 1);
    assert.equal(frames.length, 1);
    assert.ok(frames[0].length <= 200);

    const decoded = decodeFrame(frames[0]);
    assert.equal(decoded.type, "data");
    assert.equal(decoded.idx, 0);
    assert.equal(decoded.total, 1);
    assert.deepEqual([...decoded.chunk], [...payload]);
  });

  test("fragments never exceed the mtu, and boundaries are exact", () => {
    const mtu = 60;
    const chunk = mtu - DATA_HEADER_BYTES;
    const payload = bytesOf(chunk * 3); // exact multiple
    const { frames, total } = fragmentPayload(payload, { mtu });
    assert.equal(total, 3);
    for (const frame of frames) assert.ok(frame.length <= mtu);
    assert.equal(frames[2].length, mtu); // last one full, no phantom 4th
  });

  test("empty payload still travels (one header-only frame)", () => {
    const { frames } = fragmentPayload(new Uint8Array(0), { mtu: 60 });
    assert.equal(frames.length, 1);
    const r = createReassembler();
    const result = r.push(decodeFrame(frames[0]));
    assert.equal(result.kind, "complete");
    assert.equal(result.payload.length, 0);
  });

  test("garbage and foreign versions decode to null", () => {
    assert.equal(decodeFrame(new Uint8Array(0)), null);
    assert.equal(decodeFrame(bytesOf(3)), null);
    const { frames } = fragmentPayload(bytesOf(10), { mtu: 60 });
    const foreign = Uint8Array.from(frames[0]);
    foreign[0] = (9 << 4) | (foreign[0] & 0x0f); // version 9
    assert.equal(decodeFrame(foreign), null);
  });

  test("status roundtrip carries the received set", () => {
    const status = decodeFrame(encodeStatus(0xdeadbeef, 11, new Set([0, 5, 7, 10])));
    assert.equal(status.type, "status");
    assert.equal(status.msgId, 0xdeadbeef);
    assert.equal(status.total, 11);
    assert.deepEqual([...status.received].sort((a, b) => a - b), [0, 5, 7, 10]);
  });

  test("reassembly survives reordering and duplication", () => {
    const payload = bytesOf(500);
    const { frames } = fragmentPayload(payload, { mtu: 60 });
    const shuffled = [...frames].reverse();
    shuffled.splice(2, 0, frames[0], frames[3]); // duplicates mid-stream

    const r = createReassembler();
    let complete = null;
    for (const frame of shuffled) {
      const result = r.push(decodeFrame(frame));
      if (result.kind === "complete") {
        assert.equal(complete, null, "must complete exactly once");
        complete = result;
      }
    }
    assert.ok(complete);
    assert.deepEqual([...complete.payload], [...payload]);
  });

  test("a fragment after completion reports duplicate-complete, not delivery", () => {
    const { frames } = fragmentPayload(bytesOf(40), { mtu: 60 });
    const r = createReassembler();
    assert.equal(r.push(decodeFrame(frames[0])).kind, "complete");
    const again = r.push(decodeFrame(frames[0]));
    assert.equal(again.kind, "duplicate-complete");
    assert.equal(again.total, 1);
  });

  test("two interleaved messages keep separate state", () => {
    const p1 = bytesOf(120, 5);
    const p2 = bytesOf(130, 11);
    const m1 = fragmentPayload(p1, { mtu: 60, msgId: 1 });
    const m2 = fragmentPayload(p2, { mtu: 60, msgId: 2 });
    const r = createReassembler();
    const done = [];
    for (let i = 0; i < Math.max(m1.frames.length, m2.frames.length); i++) {
      for (const m of [m1, m2]) {
        if (i < m.frames.length) {
          const result = r.push(decodeFrame(m.frames[i]));
          if (result.kind === "complete") done.push(result);
        }
      }
    }
    assert.equal(done.length, 2);
    assert.deepEqual([...done.find((d) => d.msgId === 1).payload], [...p1]);
    assert.deepEqual([...done.find((d) => d.msgId === 2).payload], [...p2]);
  });

  test("stale partial state is evicted after the ttl", () => {
    let clock = 0;
    const r = createReassembler({ ttlMs: 1000, now: () => clock });
    const { frames } = fragmentPayload(bytesOf(120), { mtu: 60, msgId: 42 });
    r.push(decodeFrame(frames[0]));
    assert.ok(r.received(42));
    clock = 2000;
    r.push(decodeFrame(fragmentPayload(bytesOf(10), { mtu: 60, msgId: 43 }).frames[0]));
    assert.equal(r.received(42), null);
  });
});
