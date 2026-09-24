// SPDX-License-Identifier: GPL-3.0-only
/**
 * Keep the lines nobody heard, and hand them over when somebody does.
 *
 * The field log is pubsub: a line published while no watcher is subscribed is
 * gone. That was the right trade while the interesting runs happened online —
 * but the interesting run is the one with the internet switched off, where the
 * list travels over LoRa alone and the watcher hears nothing at all. Exactly
 * the test worth watching was the test that could not be watched.
 *
 * So a line that reached nobody is kept here, and goes out in front of the
 * next line that does reach somebody, with the timestamp it was written at and
 * a `late` flag, so a reader can tell a replay from live traffic.
 *
 * A ring, not a log: a phone that runs offline for an hour must not fill its
 * storage, and the oldest lines of a long silence are the least interesting —
 * whatever went wrong is still being written when the network comes back.
 *
 * Cleared when the switch goes off, because these lines carry channel names
 * and node numbers, and somebody who turns the log off means it.
 */

const KEY = "mesh-todo:field-log-backlog";
const LIMIT = 400;

/**
 * @param {Object} [options]
 * @param {Storage} [options.store] where to keep it; localStorage by default
 * @param {number} [options.limit] how many lines to keep at most
 */
export function createFieldLogBuffer({ store = null, limit = LIMIT } = {}) {
  const storage = store ?? (typeof localStorage === "undefined" ? null : localStorage);

  const read = () => {
    if (!storage) return [];
    try {
      const kept = JSON.parse(storage.getItem(KEY) ?? "[]");
      return Array.isArray(kept) ? kept : [];
    } catch {
      return []; // blocked, full, or somebody else's data: start over
    }
  };

  const write = (lines) => {
    if (!storage) return;
    try {
      storage.setItem(KEY, JSON.stringify(lines));
    } catch {
      // Quota, private mode, blocked storage. A diagnostic that breaks the app
      // it is watching is worse than a diagnostic that loses a line.
    }
  };

  return {
    /** Nobody heard this one. Keep it, dropping the oldest if need be. */
    keep(line) {
      const lines = read();
      lines.push(line);
      write(lines.slice(-limit));
    },

    /**
     * Everything kept, oldest first, and forget it — the caller is about to
     * send it. Taking rather than peeking, so a failed send cannot loop:
     * whatever does not go out now is simply kept again by the next call.
     */
    take() {
      const lines = read();
      if (lines.length > 0) write([]);
      return lines;
    },

    /** How many are waiting, for a page that wants to say so. */
    get size() {
      return read().length;
    },

    /** The switch went off, or the run is over. */
    clear() {
      if (!storage) return;
      try {
        storage.removeItem(KEY);
      } catch {
        // as above
      }
    },
  };
}
