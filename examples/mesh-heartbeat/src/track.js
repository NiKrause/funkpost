// SPDX-License-Identifier: GPL-3.0-only
/**
 * Where a beat was sent from, and whether it was answered.
 *
 * This is the whole point of mesh-heartbeat (#180): one device stays put, one
 * travels, and what comes back is not "the mesh works" but a list of places
 * with an answer or a silence against each.
 *
 * The heartbeat already carries the number that makes this worth recording.
 * Since #174 an echo names the beat it answers, and a round's beats are a
 * minute apart — so "answered on the first" and "answered on the fourth" are
 * three minutes and, on a bicycle, the better part of a kilometre. A place
 * that only answers on the fourth beat is a different place from one that
 * answers at once, and a single "reachable" flag would lose exactly that.
 *
 * Kept out of the component because it is the only part with a decision in it,
 * and a decision deserves a test that needs no browser.
 */

/** How many points to keep. A ride is long; a phone's memory is not. */
const LIMIT = 500;

/**
 * @param {Object} [options]
 * @param {number} [options.limit] points to keep, oldest dropped first
 * @param {() => number} [options.now] injectable clock, as everywhere here
 */
export function createCoverageTrack({ limit = LIMIT, now = Date.now } = {}) {
  /** @type {Array<Object>} oldest first */
  const points = [];

  /** The beat we are waiting on, if any. */
  let open = null;

  const drop = () => {
    while (points.length > limit) points.shift();
  };

  return {
    /**
     * A beat went out from here.
     *
     * `position` may be null and that is recorded rather than hidden: a node
     * without a GPS fix, or a browser that refused the permission, still
     * produces a useful "answered / not answered" — it simply cannot be put on
     * a map. Dropping the point instead would make the track look better than
     * the ride was.
     */
    sent({ n, of, position = null }) {
      const point = {
        at: now(),
        n,
        of,
        position,
        answered: null, // becomes the beat number the echo named
        answeredAt: null,
      };
      points.push(point);
      drop();
      open = point;
      return point;
    },

    /**
     * An echo came back. `n` is the beat it answers, as the wire now says.
     *
     * Matched against the open beat rather than searched for: on a carrier
     * this slow a second round cannot be in flight while the first is still
     * open, and an echo naming a beat we are not waiting on is a duplicate the
     * radio repeated. Counting it again would flatter the track.
     */
    answered({ n = null } = {}) {
      if (!open) return null;
      if (n != null && open.n !== n) return null;
      open.answered = n ?? open.n;
      open.answeredAt = now();
      const point = open;
      open = null;
      return point;
    },

    /** The round ended with nobody answering. The open beat stays a silence. */
    unanswered() {
      const point = open;
      open = null;
      return point;
    },

    /** Oldest first, the way a ride happened. */
    points: () => points.map((p) => ({ ...p })),

    /**
     * What the ride showed, in one line for the page.
     *
     * `reached` counts places that answered at all; `firstBeat` counts the
     * subset that answered immediately, which is the honest measure of a good
     * spot rather than a reachable one.
     */
    summary() {
      const answered = points.filter((p) => p.answered != null);
      return {
        sent: points.length,
        reached: answered.length,
        firstBeat: answered.filter((p) => p.answered === 1).length,
        located: points.filter((p) => p.position).length,
      };
    },

    clear() {
      points.length = 0;
      open = null;
    },
  };
}
