// SPDX-License-Identifier: GPL-3.0-only
/**
 * Everyone else, and where they have been.
 *
 * One entry per device heard, each with a trail — because the question in a
 * wood is never "where is Anna" but "where was Anna last, and which way was
 * she going". A single dot answers neither.
 *
 * Kept out of the component for the usual reason: this is the part with
 * decisions in it, and a decision deserves a test that needs no browser.
 *
 * **Names live here and never go on the air.** A device is four random-looking
 * bytes, which is unusable at a kerb and worse in a wood; a nickname somebody
 * types costs nothing to carry because it is not carried. The air stays as
 * anonymous as it was, and the screen becomes readable.
 */

/** Points per peer. A long walk should not grow without end on a phone. */
const TRAIL_LIMIT = 500;

/**
 * @param {Object} [options]
 * @param {number} [options.trailLimit] points kept per peer, oldest dropped
 * @param {() => number} [options.now] injectable clock, as everywhere here
 */
export function createPeers({ trailLimit = TRAIL_LIMIT, now = Date.now } = {}) {
  /** @type {Map<string, Object>} id → peer, insertion order is first-heard */
  const peers = new Map();

  const make = (id) => ({
    id,
    /** What somebody called them on this device, and nowhere else. */
    name: "",
    /** Drawn unless somebody says otherwise. Everyone is on by default. */
    shown: true,
    points: [],
    lastAt: null,
    state: "ok",
    accuracy: null,
  });

  const peer = (id) => {
    if (!peers.has(id)) peers.set(id, make(id));
    return peers.get(id);
  };

  return {
    /**
     * A beacon arrived.
     *
     * A repeat of the same place is still news — it says the device is alive
     * and has not moved — so `lastAt` always advances, but the trail only
     * grows when the position actually changed. Otherwise a stationary device
     * fills the trail with one dot drawn five hundred times, and the map draws
     * a line of length zero over and over.
     */
    heard({ from, pos, accuracy = null, state = "ok", at = now() }) {
      const entry = peer(from);
      const last = entry.points.at(-1);
      entry.lastAt = at;
      entry.state = state;
      entry.accuracy = accuracy;
      if (!last || last.lat !== pos.lat || last.lon !== pos.lon) {
        entry.points.push({ lat: pos.lat, lon: pos.lon, at, accuracy, state });
        while (entry.points.length > trailLimit) entry.points.shift();
      }
      return entry;
    },

    /** Newest first: in a wood, who was heard just now is the live question. */
    list() {
      return [...peers.values()]
        .map((p) => ({ ...p, points: p.points.map((q) => ({ ...q })) }))
        .sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0));
    },

    /** Only the ones somebody still wants drawn. */
    shown() {
      return this.list().filter((p) => p.shown && p.points.length > 0);
    },

    name(id, name) {
      peer(id).name = name;
    },

    show(id, shown) {
      peer(id).shown = !!shown;
    },

    /** Everything a page should keep across a reload — names and switches. */
    preferences() {
      return [...peers.values()]
        .filter((p) => p.name || !p.shown)
        .map((p) => ({ id: p.id, name: p.name, shown: p.shown }));
    },

    /** Put those back, before anything has been heard. */
    restore(preferences = []) {
      for (const { id, name = "", shown = true } of preferences) {
        const entry = peer(id);
        entry.name = name;
        entry.shown = shown;
      }
    },

    forget(id) {
      peers.delete(id);
    },

    clear() {
      peers.clear();
    },

    summary() {
      const all = [...peers.values()];
      return {
        heard: all.length,
        shown: all.filter((p) => p.shown).length,
        moving: all.filter((p) => p.points.length > 1).length,
      };
    },
  };
}
