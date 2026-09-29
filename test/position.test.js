// SPDX-License-Identifier: GPL-3.0-only
/**
 * Reading a position, for mesh-heartbeat (#180).
 *
 * The scale is the part worth a test. `@meshtastic/core` writes the field as
 * `latitudeI: Math.floor(latitude / 1e-7)`, so reading it back is a
 * multiplication — and a factor of ten either way plots the ride in the wrong
 * country while still looking like a number.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  decodeNodePosition,
  watchBrowserPosition,
  formatPosition,
} from "../examples/mesh-heartbeat/src/position.js";

// Eggenfelden, where the bench is.
const LAT = 48.40639;
const LON = 12.76167;
const packet = (over = {}) => ({
  data: {
    latitudeI: Math.floor(LAT / 1e-7),
    longitudeI: Math.floor(LON / 1e-7),
    time: 1_790_000_000,
    ...over,
  },
});

describe("reading a node's position", () => {
  test("degrees come back where they went in", () => {
    const p = decodeNodePosition(packet());
    assert.ok(Math.abs(p.lat - LAT) < 1e-6, `lat was ${p.lat}`);
    assert.ok(Math.abs(p.lon - LON) < 1e-6, `lon was ${p.lon}`);
    assert.equal(p.source, "node");
  });

  test("the node's own time is preferred, in milliseconds", () => {
    const p = decodeNodePosition(packet(), { at: 1 });
    assert.equal(p.at, 1_790_000_000_000, "seconds on the wire, ms here");
    const noTime = decodeNodePosition(packet({ time: 0 }), { at: 4242 });
    assert.equal(noTime.at, 4242, "ours when the node has none");
  });

  test("no fix is null, not the Gulf of Guinea", () => {
    // A node that has not seen a satellite reports 0/0, which is a real place.
    // Plotting a ride there quietly is worse than admitting we do not know.
    assert.equal(decodeNodePosition(packet({ latitudeI: 0, longitudeI: 0 })), null);
  });

  test("nonsense is null rather than a point somewhere impossible", () => {
    for (const bad of [
      { latitudeI: undefined },
      { longitudeI: null },
      { latitudeI: 91 / 1e-7 },
      { longitudeI: -181 / 1e-7 },
    ]) {
      assert.equal(decodeNodePosition(packet(bad)), null, JSON.stringify(bad));
    }
    assert.equal(decodeNodePosition(null), null);
    assert.equal(decodeNodePosition(undefined), null);
  });

  test("a packet that is already the payload is read too", () => {
    // `onPositionPacket` hands over metadata with `.data`; a caller that has
    // already unwrapped it should not have to wrap it again.
    const bare = decodeNodePosition(packet().data);
    assert.ok(Math.abs(bare.lat - LAT) < 1e-6);
  });
});

describe("the browser fallback", () => {
  test("a fix is passed on, and clearing is returned", () => {
    let cleared = null;
    const seen = [];
    const geo = {
      watchPosition: (ok) => {
        ok({ coords: { latitude: LAT, longitude: LON }, timestamp: 7 });
        return 99;
      },
      clearWatch: (id) => (cleared = id),
    };
    const stop = watchBrowserPosition((p) => seen.push(p), { geolocation: geo });
    assert.deepEqual(seen, [{ lat: LAT, lon: LON, at: 7, source: "browser" }]);
    stop();
    assert.equal(cleared, 99);
  });

  test("no geolocation at all is not an error", () => {
    // A desktop without it, or a refused permission. The ride still records
    // answered and unanswered; it simply cannot be put on a map.
    const stop = watchBrowserPosition(() => {
      throw new Error("must not be called");
    }, { geolocation: null });
    assert.equal(typeof stop, "function");
    stop();
  });
});

describe("formatting", () => {
  test("five decimals, and nothing for nothing", () => {
    assert.equal(formatPosition({ lat: LAT, lon: LON }), "48.40639, 12.76167");
    assert.equal(formatPosition(null), "");
  });
});
