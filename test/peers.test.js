// SPDX-License-Identifier: GPL-3.0-only
/**
 * Everyone else, and where they have been.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createPeers } from "../examples/mesh-trail/src/peers.js";

const A = { lat: 48.406, lon: 12.761 };
const B = { lat: 48.408, lon: 12.763 };

describe("the people on the map", () => {
  test("a trail, not a dot: two fixes are a direction", () => {
    const peers = createPeers();
    peers.heard({ from: "aaaa", pos: A, at: 1 });
    peers.heard({ from: "aaaa", pos: B, at: 2 });
    const [peer] = peers.list();
    assert.equal(peer.points.length, 2);
    assert.deepEqual(
      peer.points.map((p) => p.at),
      [1, 2],
      "oldest first, the way a walk happened",
    );
  });

  test("standing still is still news, but it is not a new point", () => {
    // Otherwise a device on a windowsill fills the trail with one place drawn
    // five hundred times, and the map draws a line of length zero over and over.
    const peers = createPeers();
    peers.heard({ from: "aaaa", pos: A, at: 1 });
    peers.heard({ from: "aaaa", pos: A, at: 2 });
    peers.heard({ from: "aaaa", pos: A, at: 3 });
    const [peer] = peers.list();
    assert.equal(peer.points.length, 1, "one place");
    assert.equal(peer.lastAt, 3, "and still alive at 3");
  });

  test("newest first, because that is the live question", () => {
    const peers = createPeers();
    peers.heard({ from: "slow", pos: A, at: 10 });
    peers.heard({ from: "quick", pos: B, at: 20 });
    assert.deepEqual(
      peers.list().map((p) => p.id),
      ["quick", "slow"],
    );
  });

  test("everyone is drawn until somebody says otherwise", () => {
    const peers = createPeers();
    peers.heard({ from: "aaaa", pos: A, at: 1 });
    peers.heard({ from: "bbbb", pos: B, at: 2 });
    assert.equal(peers.shown().length, 2, "default is on");
    peers.show("aaaa", false);
    assert.deepEqual(
      peers.shown().map((p) => p.id),
      ["bbbb"],
    );
  });

  test("a peer heard but never placed is not drawn", () => {
    // `shown()` feeds the map, and a map cannot draw a device with no place.
    const peers = createPeers();
    peers.name("cccc", "Anna"); // named from a saved preference, never heard
    assert.equal(peers.shown().length, 0);
    assert.equal(peers.list().length, 1, "it is still in the list, with its name");
  });

  test("names and switches survive a reload; trails do not have to", () => {
    const peers = createPeers();
    peers.heard({ from: "aaaa", pos: A, at: 1 });
    peers.heard({ from: "bbbb", pos: B, at: 2 });
    peers.name("aaaa", "Anna");
    peers.show("bbbb", false);

    const kept = peers.preferences();
    assert.deepEqual(kept.sort((x, y) => x.id.localeCompare(y.id)), [
      { id: "aaaa", name: "Anna", shown: true },
      { id: "bbbb", name: "", shown: false },
    ]);
    // A peer with no name and nothing switched off is not worth storing.
    peers.heard({ from: "cccc", pos: A, at: 3 });
    assert.equal(peers.preferences().length, 2);

    const fresh = createPeers();
    fresh.restore(kept);
    fresh.heard({ from: "aaaa", pos: A, at: 9 });
    assert.equal(fresh.list()[0].name, "Anna");
    assert.equal(fresh.list().find((p) => p.id === "bbbb").shown, false);
  });

  test("a long walk does not grow without end", () => {
    const peers = createPeers({ trailLimit: 3 });
    for (let i = 0; i < 6; i += 1) peers.heard({ from: "aaaa", pos: { lat: 48 + i / 1000, lon: 12 }, at: i });
    const [peer] = peers.list();
    assert.equal(peer.points.length, 3);
    assert.deepEqual(
      peer.points.map((p) => p.at),
      [3, 4, 5],
      "the oldest go first",
    );
  });

  test("the list hands out copies, so a screen cannot edit the record", () => {
    const peers = createPeers();
    peers.heard({ from: "aaaa", pos: A, at: 1 });
    peers.list()[0].points[0].lat = 0;
    assert.equal(peers.list()[0].points[0].lat, A.lat);
  });
});
