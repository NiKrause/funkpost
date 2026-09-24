// SPDX-License-Identifier: GPL-3.0-only
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createFieldLogBuffer } from "../examples/mesh-todo/src/field-log-buffer.js";

/** A Storage the test controls, including the ways a real one fails. */
function fakeStorage({ failWrites = false, corrupt = null } = {}) {
  const map = new Map();
  if (corrupt != null) map.set("mesh-todo:field-log-backlog", corrupt);
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => {
      if (failWrites) throw new Error("QuotaExceededError");
      map.set(k, v);
    },
    removeItem: (k) => map.delete(k),
    get length() {
      return map.size;
    },
  };
}

describe("field log backlog", () => {
  test("keeps what nobody heard, and hands it back oldest first", () => {
    const buffer = createFieldLogBuffer({ store: fakeStorage() });
    buffer.keep({ at: "1", text: "first" });
    buffer.keep({ at: "2", text: "second" });

    assert.equal(buffer.size, 2);
    assert.deepEqual(
      buffer.take().map((l) => l.text),
      ["first", "second"],
      "a replay out of order would be worse than no replay",
    );
  });

  test("taking empties it, so a line is not sent twice", () => {
    const buffer = createFieldLogBuffer({ store: fakeStorage() });
    buffer.keep({ text: "once" });
    assert.equal(buffer.take().length, 1);
    assert.deepEqual(buffer.take(), []);
    assert.equal(buffer.size, 0);
  });

  test("drops the oldest rather than growing without end", () => {
    // An hour offline must not fill the phone's storage, and the oldest lines
    // of a long silence are the least interesting.
    const buffer = createFieldLogBuffer({ store: fakeStorage(), limit: 3 });
    for (const n of [1, 2, 3, 4, 5]) buffer.keep({ text: `line ${n}` });

    assert.deepEqual(
      buffer.take().map((l) => l.text),
      ["line 3", "line 4", "line 5"],
      "the newest survive, because whatever went wrong is still being written",
    );
  });

  test("clear leaves nothing behind", () => {
    const store = fakeStorage();
    const buffer = createFieldLogBuffer({ store });
    buffer.keep({ text: "channel names live in here" });
    buffer.clear();
    assert.equal(buffer.size, 0);
    assert.equal(store.length, 0, "removed, not merely emptied");
  });

  test("survives storage that refuses to write", () => {
    // Private mode, quota, blocked site data. A diagnostic that breaks the app
    // it is watching is worse than one that loses a line.
    const buffer = createFieldLogBuffer({ store: fakeStorage({ failWrites: true }) });
    assert.doesNotThrow(() => buffer.keep({ text: "nowhere to go" }));
    assert.equal(buffer.size, 0);
    assert.doesNotThrow(() => buffer.clear());
  });

  test("survives whatever else is under that key", () => {
    for (const corrupt of ["not json", '{"not":"an array"}', "null"]) {
      const buffer = createFieldLogBuffer({ store: fakeStorage({ corrupt }) });
      assert.deepEqual(buffer.take(), [], `starts over on ${corrupt}`);
      assert.doesNotThrow(() => buffer.keep({ text: "after" }));
    }
  });

  test("does nothing where there is no storage at all", () => {
    const buffer = createFieldLogBuffer({ store: null });
    // `store: null` falls back to localStorage, which does not exist in Node.
    assert.doesNotThrow(() => buffer.keep({ text: "x" }));
    assert.deepEqual(buffer.take(), []);
    assert.equal(buffer.size, 0);
    assert.doesNotThrow(() => buffer.clear());
  });
});
