// SPDX-License-Identifier: GPL-3.0-only
/**
 * The empty store, which is every visitor's first one.
 *
 * A brand-new room greeted its first user with
 * `Speicher: Unexpected end of array` on both hardware bench sessions (#73).
 * Nothing was broken — the error is caught and the app runs — but a storage
 * failure was the first thing the app said to somebody who had stored nothing.
 *
 * The cause was one `??`. These tests pin the rule that replaced it, and the
 * consequence that made it visible.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { settle } from "../src/domain/persistence.js";

test("a missing key resolves as missing, not as the request", () => {
  // What IndexedDB hands back for a key that was never written: a request that
  // completed successfully and whose `result` is `undefined`.
  const missing = { result: undefined };
  assert.equal(settle(missing), undefined);

  // The bug, stated as the assertion it would have failed:
  assert.notEqual(settle(missing), missing);
});

test("a stored value comes back", () => {
  const bytes = new Uint8Array([1, 2, 3]);
  assert.deepEqual(settle({ result: bytes }), bytes);

  // An empty list is a value, not an absence — `getAll` on an empty store.
  assert.deepEqual(settle({ result: [] }), []);
});

test("a write that returns no request resolves with what it returned", () => {
  // `dropKeys` loops over `store.delete(key)` and returns nothing.
  assert.equal(settle(undefined), undefined);
});

test("what the old rule produced, Yjs refuses to decode", () => {
  const request = { result: undefined };
  const old = request?.result ?? request; // the line that shipped

  assert.ok(old, "the IDBRequest is truthy, so `if (update)` let it through");
  assert.equal(new Uint8Array(old).byteLength, 0);
  assert.throws(
    () => Y.applyUpdate(new Y.Doc(), new Uint8Array(old), "persistence"),
    /Unexpected end of array/,
    "the exact message the bench saw",
  );

  // And with the rule that replaced it, there is nothing to apply at all.
  assert.equal(settle(request)?.byteLength, undefined);
});
