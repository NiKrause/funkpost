// SPDX-License-Identifier: GPL-3.0-only
/**
 * Keeping the screen awake, which is keeping the radio reachable.
 *
 * Not a convenience: **Web Bluetooth pauses when the screen locks.** The node
 * stays connected and the page simply stops being able to talk to it — in a
 * pocket, on a bicycle, nobody notices until the run is over and the log has a
 * hole in it.
 *
 * Every demo had this, 70–100 % identical. The 30 % that differed was which
 * words it logged, which is the page's business and is why this takes an event
 * rather than a logger.
 *
 * Two things that are easy to get wrong and are handled here:
 *
 * - **a lock is dropped when the page is hidden**, and the browser does not
 *   give it back on return. Somebody switching to a map and back has silently
 *   lost it, so `reacquireIfWanted` exists and a page calls it on
 *   `visibilitychange`;
 * - **a refusal is normal.** Some browsers have no wake lock, some refuse it
 *   without a gesture. That is not an error worth stopping for — the switch
 *   goes back off and the page says why.
 */

/**
 * @param {Object} [options]
 * @param {(event: Object) => void} [options.onEvent] `on`, `off`, `refused`,
 *   `dropped` — the last one is the browser taking it away while it was still
 *   wanted, which mesh-calendar was alone in noticing and is now everyone's
 * @param {Object} [options.wakeLock] injectable, so this is testable
 */
export function createWakeLock({ onEvent = () => {}, wakeLock = null } = {}) {
  const api = wakeLock ?? globalThis.navigator?.wakeLock ?? null;
  let sentinel = null;
  /** What somebody asked for, which outlives any one sentinel. */
  let wanted = false;

  const emit = (event) => {
    try {
      onEvent(event);
    } catch {
      /* a page's own log must not take the screen down with it */
    }
  };

  async function acquire() {
    if (!api) {
      wanted = false;
      emit({ kind: "refused", reason: "no wake lock in this browser" });
      return false;
    }
    try {
      sentinel = await api.request("screen");
      sentinel?.addEventListener?.("release", () => {
        sentinel = null;
        // Taken away rather than given back: that is the browser hiding the
        // page, and the only moment a page could notice.
        if (wanted) emit({ kind: "dropped" });
      });
      emit({ kind: "on" });
      return true;
    } catch (e) {
      wanted = false;
      sentinel = null;
      emit({ kind: "refused", reason: e?.message ?? String(e) });
      return false;
    }
  }

  return {
    /** What was asked for, not whether a sentinel happens to be alive. */
    wanted: () => wanted,
    held: () => sentinel != null,

    async set(on) {
      wanted = !!on;
      if (wanted) return acquire();
      await sentinel?.release?.();
      sentinel = null;
      emit({ kind: "off" });
      return false;
    },

    async toggle() {
      return this.set(!wanted);
    },

    /**
     * The page came back. A lock the browser dropped while it was hidden is
     * not given back on its own, and nothing tells the page it is gone.
     */
    async reacquireIfWanted(visible = true) {
      if (!wanted || !visible || sentinel) return false;
      return acquire();
    },

    release() {
      sentinel?.release?.();
      sentinel = null;
    },
  };
}
