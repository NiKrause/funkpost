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
  encodeNodePosition,
  watchBrowserPosition,
  formatPosition,
  distanceMetres,
  formatDistance,
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

/**
 * The way back onto the wire, and what two positions add up to.
 *
 * The scale rests on the raw-integer cases here and nowhere else. It cannot
 * rest on the page: both ends of the link scale with the same constant, so an
 * error of a factor of ten cancels itself out between encode and decode and
 * the distance on screen still reads right. Verified by breaking it — the e2e
 * suite stayed green with `SCALE` at 1e-6.
 */
describe("putting a position back on the wire", () => {
  test("the integers are the ones Meshtastic writes, not ten times them", () => {
    const pair = encodeNodePosition({ lat: 48.40639, lon: 12.76167 });
    // Spelled out rather than derived from SCALE: a test that computes the
    // expected value the same way the code does agrees with any scale at all.
    assert.deepEqual(pair, [484063900, 127616700]);
  });

  test("a round trip is the place it started at", () => {
    const here = { lat: 48.40639, lon: 12.76167 };
    const there = decodeNodePosition({
      latitudeI: encodeNodePosition(here)[0],
      longitudeI: encodeNodePosition(here)[1],
    });
    assert.equal(there.lat.toFixed(5), here.lat.toFixed(5));
    assert.equal(there.lon.toFixed(5), here.lon.toFixed(5));
  });

  test("nothing, nonsense and the null island all come back null", () => {
    assert.equal(encodeNodePosition(null), null);
    assert.equal(encodeNodePosition({ lat: 0, lon: 0 }), null);
    assert.equal(encodeNodePosition({ lat: 91, lon: 0 }), null);
    assert.equal(encodeNodePosition({ lat: NaN, lon: 12 }), null);
  });
});

describe("how far apart two fixes are", () => {
  // Eggenfelden to Landshut. 0.131° of latitude is 14.5 km; 0.610° of
  // longitude at this latitude is 45.0 km — 47.3 km together, which is what
  // the numbers below have to come out at.
  const EGGENFELDEN = { lat: 48.40639, lon: 12.76167 };
  const LANDSHUT = { lat: 48.53718, lon: 12.15165 };

  test("a known pair comes out at the known distance", () => {
    const m = distanceMetres(EGGENFELDEN, LANDSHUT);
    assert.ok(m > 47_000 && m < 47_500, `${Math.round(m)} m`);
  });

  test("a step of a thousandth of a degree north is about 111 m", () => {
    const m = distanceMetres(EGGENFELDEN, { ...EGGENFELDEN, lat: EGGENFELDEN.lat + 0.001 });
    assert.ok(m > 110 && m < 112, `${m.toFixed(1)} m`);
  });

  test("nowhere to nowhere is null, and a place to itself is zero", () => {
    assert.equal(distanceMetres(null, EGGENFELDEN), null);
    assert.equal(distanceMetres(EGGENFELDEN, null), null);
    assert.equal(distanceMetres(EGGENFELDEN, EGGENFELDEN), 0);
  });

  test("metres below a kilometre, kilometres above it", () => {
    assert.equal(formatDistance(0), "0 m");
    assert.equal(formatDistance(842.4), "842 m");
    assert.equal(formatDistance(1234), "1.23 km");
    assert.equal(formatDistance(44_500), "44.5 km");
    assert.equal(formatDistance(null), "");
  });
});
