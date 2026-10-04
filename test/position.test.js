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
  preferFix,
  fixAgeMs,
  VAGUE_METRES,
  encodeNodePosition,
  watchBrowserPosition,
  askForPosition,
  formatPosition,
  distanceMetres,
  formatDistance,
  bearingDegrees,
  compassPoint,
} from "../examples/radio/position.js";

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
    // `accuracy` rides along now: a browser that cannot say how good a fix is
    // says null rather than leaving the field out, so a reader never has to
    // guess whether it was unknown or simply not passed on.
    assert.deepEqual(seen, [{ lat: LAT, lon: LON, at: 7, accuracy: null, source: "browser" }]);
    stop();
    assert.equal(cleared, 99);
  });

  test("no geolocation at all does not throw — but it is no longer silent", () => {
    // A desktop without it, or a page served over plain HTTP. The ride still
    // records answered and unanswered; it simply cannot be put on a map, and
    // now it says which of the two is happening.
    const trouble = [];
    const stop = watchBrowserPosition(
      () => {
        throw new Error("must not be called");
      },
      { geolocation: null, onTrouble: (t) => trouble.push(t) },
    );
    assert.equal(typeof stop, "function");
    assert.deepEqual(trouble, [{ kind: "unsupported", message: "" }]);
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

describe("what the browser is doing when there is no position", () => {
  /** A geolocation that answers however a test tells it to. */
  const fakeGeo = (behaviour) => ({
    watchPosition(ok, fail) {
      behaviour(ok, fail);
      return 7;
    },
    getCurrentPosition(ok, fail) {
      behaviour(ok, fail);
    },
    clearWatch() {},
  });

  test("a fix carries how good it is, which is the difference between GPS and a guess", () => {
    const seen = [];
    watchBrowserPosition((fix) => seen.push(fix), {
      geolocation: fakeGeo((ok) =>
        ok({ coords: { latitude: 48.4, longitude: 12.7, accuracy: 8.5 }, timestamp: 5 }),
      ),
    });
    assert.equal(seen[0].accuracy, 8.5);
    assert.equal(seen[0].source, "browser");
  });

  test("every reason the browser can give is passed on, named", () => {
    for (const [code, kind] of [
      [1, "denied"],
      [2, "unavailable"],
      [3, "searching"],
    ]) {
      const trouble = [];
      watchBrowserPosition(() => {}, {
        geolocation: fakeGeo((ok, fail) => fail({ code, message: "x" })),
        onTrouble: (t) => trouble.push(t),
      });
      assert.deepEqual(trouble, [{ kind, message: "x" }], `code ${code}`);
    }
  });

  test("no Geolocation API at all is itself an answer", () => {
    // A page served over plain HTTP has none: it is a secure-context feature,
    // and silently recording beats without places is the wrong way to say so.
    const trouble = [];
    const stop = watchBrowserPosition(() => {}, { geolocation: null, onTrouble: (t) => trouble.push(t) });
    assert.deepEqual(trouble, [{ kind: "unsupported", message: "" }]);
    assert.doesNotThrow(stop);
  });

  test("asking again from a click reports the same way", () => {
    const seen = [];
    const trouble = [];
    askForPosition((fix) => seen.push(fix), {
      geolocation: fakeGeo((ok) =>
        ok({ coords: { latitude: 1, longitude: 2, accuracy: 3 }, timestamp: 4 }),
      ),
    });
    assert.equal(seen[0].lat, 1);
    askForPosition(() => {}, {
      geolocation: fakeGeo((ok, fail) => fail({ code: 1, message: "blocked" })),
      onTrouble: (t) => trouble.push(t),
    });
    assert.equal(trouble[0].kind, "denied");
  });
});

describe("which way from here", () => {
  const HERE = { lat: 48.40639, lon: 12.76167 };

  test("north is zero and east is ninety, clockwise like a compass", () => {
    assert.equal(Math.round(bearingDegrees(HERE, { lat: 48.42, lon: HERE.lon })), 0);
    assert.equal(Math.round(bearingDegrees(HERE, { lat: HERE.lat, lon: 12.79 })), 90);
    assert.equal(Math.round(bearingDegrees(HERE, { lat: 48.39, lon: HERE.lon })), 180);
    assert.equal(Math.round(bearingDegrees(HERE, { lat: HERE.lat, lon: 12.73 })), 270);
  });

  test("a word somebody can act on without a compass rose", () => {
    assert.equal(compassPoint(0), "N");
    assert.equal(compassPoint(44), "NE");
    assert.equal(compassPoint(315), "NW");
    assert.equal(compassPoint(359), "N", "and it wraps");
    assert.equal(compassPoint(null), "");
  });

  test("nowhere to nowhere is not a direction", () => {
    assert.equal(bearingDegrees(null, HERE), null);
    assert.equal(bearingDegrees(HERE, null), null);
  });
});

describe("which fix to believe", () => {
  /**
   * A walk in the woods found this one. Two phones, two nodes, neither node
   * with a GPS: the map followed the phone perfectly until a node was
   * connected over Bluetooth, and then it stopped, for good. The node *had* a
   * position — the Meshtastic app writes the phone's into a GPS-less node —
   * and the rule at the time was "the node wins", which meant one such packet
   * locked the browser out of a map it had been drawing correctly.
   */
  const here = (over = {}) => ({ lat: LAT, lon: LON, at: 1, source: "browser", accuracy: 12, ...over });
  const node = (over = {}) => ({ lat: 50, lon: 10, at: 2, source: "node", gps: false, ...over });

  test("a node reports whether it saw a satellite, or is repeating a typed-in place", () => {
    assert.equal(decodeNodePosition(packet()).gps, false, "no locationSource means no claim");
    assert.equal(decodeNodePosition(packet({ locationSource: 1 })).gps, false, "LOC_MANUAL");
    assert.equal(decodeNodePosition(packet({ locationSource: 2 })).gps, true, "LOC_INTERNAL");
    assert.equal(decodeNodePosition(packet({ locationSource: 3 })).gps, true, "LOC_EXTERNAL");
  });

  test("a node with no GPS does not take the map away from a walking phone", () => {
    assert.equal(preferFix(here(), node()).source, "browser", "the phone keeps it");
    // …and the other order, because the node's packet often lands first.
    assert.equal(preferFix(node(), here()).source, "browser", "the phone takes it back");
  });

  test("even a node with its own satellite does not take the map off a phone that has one", () => {
    // This reversed after a second walk. Meshtastic's phone app can write the
    // phone's own position into the node — "Position übertragen" — and the
    // node then reports it as a fix from an external receiver. Asking which
    // *instrument* is better read that as a satellite and handed the map back
    // to a stale copy of the phone's own position.
    assert.equal(preferFix(here(), node({ gps: true })).source, "browser");
    assert.equal(preferFix(node({ gps: true }), here()).source, "browser");
  });

  test("the phone's position, handed back by the node, does not outrank the phone", () => {
    // The field case, in the shape it arrives: LOC_EXTERNAL is 3.
    const handedBack = decodeNodePosition(packet({ locationSource: 3 }));
    assert.equal(handedBack.gps, true, "the protocol does call it a receiver");
    assert.equal(preferFix(here(), handedBack).source, "browser");
    assert.equal(preferFix(handedBack, here()).source, "browser");
  });

  test("a node is still the answer when the browser has nothing at all", () => {
    assert.equal(preferFix(null, node({ gps: true })).source, "node");
    assert.equal(preferFix(node({ gps: true }), null).source, "node");
  });

  test("a typed-in place beats a browser that is guessing", () => {
    // A desktop locates itself from an IP address: kilometres, not metres.
    const vague = here({ accuracy: 5000 });
    // And the case the first threshold would have broken: a phone under trees.
    assert.equal(
      preferFix(here({ accuracy: 180 }), node()).source,
      "browser",
      "a forest canopy is a worse view, not a worse instrument",
    );
    assert.equal(preferFix(vague, node()).source, "node", "the office's own position");
    assert.equal(preferFix(here({ accuracy: null }), node()).source, "node", "no accuracy at all");
    assert.equal(
      preferFix(here({ accuracy: VAGUE_METRES + 1 }), node()).source,
      "node",
      "just past the line",
    );
    assert.equal(preferFix(here({ accuracy: VAGUE_METRES }), node()).source, "browser", "and on it");
  });

  test("newer from the same instrument is simply newer", () => {
    const moved = here({ lat: 49 });
    assert.equal(preferFix(here(), moved), moved);
    assert.equal(preferFix(node(), node({ lat: 51 })).lat, 51);
  });

  test("the first fix of any kind is taken", () => {
    assert.equal(preferFix(null, node()).source, "node");
    assert.equal(preferFix(null, here()).source, "browser");
    assert.equal(preferFix(here(), null).source, "browser");
    assert.equal(preferFix(null, null), null);
  });
});

describe("a third source does not get mistaken for the node", () => {
  test("two fixes that are neither from the node: the newer one", () => {
    const browser = { lat: 1, lon: 1, at: 1, source: "browser", accuracy: 10 };
    const peer = { lat: 2, lon: 2, at: 2, source: "peer" };
    assert.equal(preferFix(browser, peer).source, "peer");
    assert.equal(preferFix(peer, browser).source, "browser");
  });
});

describe("how old a fix is", () => {
  test("counted from its own time, and unknown when it has none", () => {
    assert.equal(fixAgeMs({ at: 1_000 }, 4_000), 3_000);
    assert.equal(fixAgeMs({ at: 9_000 }, 4_000), 0, "a clock that ran backwards is not a future");
    assert.equal(fixAgeMs({}, 4_000), Infinity, "no time is not a fresh one");
    assert.equal(fixAgeMs(null, 4_000), Infinity);
  });
});
