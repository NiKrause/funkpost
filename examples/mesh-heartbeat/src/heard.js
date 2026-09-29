// SPDX-License-Identifier: GPL-3.0-only
/**
 * What the stationary device heard, and what it answered.
 *
 * The other half of the track. A ride produces two records and they are not
 * the same record: the phone knows where it was and whether an answer came
 * back; the device that stays knows what actually reached it and what it sent
 * in reply. Neither can be derived from the other, which is exactly why a
 * silence on the phone is ambiguous until both are read side by side — a beat
 * that never arrived and an answer that never made it home look identical from
 * the saddle.
 *
 * Until this existed the stationary half had a lamp showing the last thing it
 * heard and nothing else: no count, no history, and a summary line describing
 * a ride it was not on.
 *
 * What it deliberately does not have is a place per row. Only the stationary
 * device announces where it is, and only once — a rider carrying its position
 * on every beat is fifteen bytes on top of thirty-four, for the length of a
 * ride, on the one carrier here that is rationed by law. So this records what
 * arrived, and the phone records where it was standing when it sent it.
 */

/** How many rows to keep. Long enough for a ride, short enough for a phone. */
const LIMIT = 500;

/**
 * @param {Object} [options]
 * @param {number} [options.limit] rows to keep, oldest dropped first
 * @param {() => number} [options.now] injectable clock, as everywhere here
 */
export function createHeardLog({ limit = LIMIT, now = Date.now } = {}) {
  /** @type {Array<Object>} oldest first */
  const rows = [];

  return {
    /**
     * Something arrived. Beats and echoes both, and the row says which:
     * on a shared channel a stationary device hears other people's answers
     * too, and a count that mixed them would overstate what it was asked.
     */
    heard({ type = "beat", from = null, n = null, bytes = null } = {}) {
      const row = {
        at: now(),
        type,
        from,
        n,
        bytes,
        answered: false,
        answeredAt: null,
      };
      rows.push(row);
      while (rows.length > limit) rows.shift();
      return row;
    },

    /**
     * We answered one. Matched newest-first against the beat it names, because
     * the echo carries that number back — and because the same device asks
     * again every few minutes, so "the last beat from this device" is the only
     * honest target.
     */
    answered({ to = null, n = null } = {}) {
      const row = rows.findLast(
        (r) => r.type === "beat" && r.from === to && !r.answered && (n == null || r.n === n),
      );
      if (!row) return null;
      row.answered = true;
      row.answeredAt = now();
      return row;
    },

    /** Newest first, the way a screen wants it. */
    rows: () => [...rows].reverse().map((r) => ({ ...r })),

    /**
     * `heard` counts beats — the question asked of this device — and not the
     * echoes of other people's conversations that share the channel. Those are
     * counted separately, because a device that hears four echoes it did not
     * send is a device on a busy channel, and that is worth seeing.
     */
    summary() {
      const beats = rows.filter((r) => r.type === "beat");
      return {
        heard: beats.length,
        answered: beats.filter((r) => r.answered).length,
        askers: new Set(beats.map((r) => r.from).filter(Boolean)).size,
        echoes: rows.length - beats.length,
      };
    },

    clear() {
      rows.length = 0;
    },
  };
}
