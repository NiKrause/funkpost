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
 * A row carries a place when the message did. The device that moves says where
 * it is on the **first beat of each round** — fifteen bytes a round rather
 * than fifteen a beat, which is what makes this affordable on a carrier
 * rationed by law — so the rows in between have none, and say so rather than
 * repeating the last one. A place that is actually a guess is worse than a
 * dash: it would put a mark on a spot that was never measured.
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
    heard({ type = "beat", from = null, n = null, bytes = null, position = null } = {}) {
      const row = {
        at: now(),
        type,
        from,
        n,
        bytes,
        position,
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
        located: beats.filter((r) => r.position).length,
      };
    },

    clear() {
      rows.length = 0;
    },
  };
}
