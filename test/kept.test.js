// SPDX-License-Identifier: GPL-3.0-only
/**
 * Settings a device keeps, and the order they are decided in.
 *
 * The order is the part worth a test. A link carrying `?role=office` is
 * somebody being explicit now; a value kept from last week must not win over
 * it, or a shared link stops meaning what its sender meant.
 */
import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { kept, keep, chosen } from "../examples/radio/kept.js";

/** A localStorage that behaves, and one that refuses — both are real. */
function store(refusing = false) {
  const map = new Map();
  return {
    getItem: (k) => {
      if (refusing) throw new Error("site data blocked");
      return map.has(k) ? map.get(k) : null;
    },
    setItem: (k, v) => {
      if (refusing) throw new Error("site data blocked");
      map.set(k, v);
    },
  };
}

beforeEach(() => {
  globalThis.localStorage = store();
});

describe("keeping a setting", () => {
  test("what went in comes back, with its type", () => {
    keep("every", 5);
    keep("role", "office");
    keep("awake", true);
    assert.equal(kept("every", 2), 5);
    assert.equal(kept("role", "rider"), "office");
    assert.equal(kept("awake", false), true);
  });

  test("nothing kept is the fallback, not undefined", () => {
    assert.equal(kept("never-written", 2), 2);
    assert.equal(kept("never-written", "rider"), "rider");
  });

  test("false and zero are kept values, not missing ones", () => {
    keep("awake", false);
    keep("every", 0);
    assert.equal(kept("awake", true), false, "a switch turned off is a choice");
    assert.equal(kept("every", 2), 0, "the manual interval is a choice");
  });

  test("a browser that refuses storage forgets instead of throwing", () => {
    globalThis.localStorage = store(true);
    assert.equal(keep("every", 5), false, "it says so rather than pretending");
    assert.equal(kept("every", 2), 2);
  });

  test("rubbish in storage is not a crash", () => {
    globalThis.localStorage.setItem("every", "{not json");
    assert.equal(kept("every", 2), 2);
  });
});

describe("which choice wins", () => {
  const asRole = (raw) => (raw === "office" || raw === "rider" ? raw : undefined);

  test("the address beats what was kept", () => {
    keep("role", "rider");
    assert.equal(chosen("office", asRole, "role", "rider"), "office");
  });

  test("what was kept beats the default", () => {
    keep("role", "office");
    assert.equal(chosen(null, asRole, "role", "rider"), "office");
  });

  test("the default is the last resort", () => {
    assert.equal(chosen(null, asRole, "role", "rider"), "rider");
    assert.equal(chosen("", asRole, "role", "rider"), "rider", "an empty query is no query");
  });

  test("an address that makes no sense falls through rather than winning", () => {
    keep("role", "office");
    assert.equal(chosen("captain", asRole, "role", "rider"), "office");
  });

  test("every=0 in the address wins, because zero is a real interval", () => {
    keep("every", 5);
    // The one the e2e uses to stop a page sending on a timer: it has to beat
    // a kept 5, and `0` must not read as "nothing asked".
    assert.equal(chosen("0", Number, "every", 2), 0);
  });

  test("a query that is not a number falls through to what was kept", () => {
    keep("every", 5);
    assert.equal(chosen("soon", Number, "every", 2), 5);
  });
});
