// SPDX-License-Identifier: GPL-3.0-only
/**
 * An in-memory mesh link pair: the courier's test double for the radio.
 *
 * Enforces the MTU the way a real packet radio does (a frame over the limit
 * throws — a framing bug should fail loudly, not truncate silently), and
 * misbehaves on request: per-frame loss, duplication, and delivery jitter
 * that reorders frames in flight.
 */

/**
 * @param {Object} [options]
 * @param {number} [options.mtu] Max frame bytes, default 200 (a Meshtastic
 *   application payload is ~233; the margin models channel overhead)
 * @param {number} [options.delayMs] Base one-way delivery delay
 * @param {number} [options.jitterMs] Extra random delay 0..jitterMs — nonzero
 *   values reorder frames, the way multi-hop routes do
 * @param {(info: {seq: number, from: "a"|"b", bytes: Uint8Array}) => boolean} [options.lossFn]
 * @param {(info: {seq: number, from: "a"|"b", bytes: Uint8Array}) => boolean} [options.duplicateFn]
 * @returns {{ a: Object, b: Object, stats: Object, idle: () => Promise<void> }}
 */
export function createMemoryMeshPair({
  mtu = 200,
  delayMs = 2,
  jitterMs = 0,
  lossFn = null,
  duplicateFn = null,
} = {}) {
  const stats = { sent: 0, delivered: 0, dropped: 0, duplicated: 0 };
  let seq = 0;
  let inFlight = 0;
  const idleWaiters = [];

  const settle = () => {
    if (inFlight === 0) while (idleWaiters.length > 0) idleWaiters.shift()();
  };

  const makeEnd = (name) => ({ name, listeners: new Set() });
  const endA = makeEnd("a");
  const endB = makeEnd("b");

  const deliver = (remote, bytes) => {
    inFlight++;
    const delay = delayMs + (jitterMs > 0 ? Math.random() * jitterMs : 0);
    setTimeout(() => {
      stats.delivered++;
      for (const cb of remote.listeners) cb(bytes);
      inFlight--;
      settle();
    }, delay);
  };

  const makeLink = (from, local, remote) => ({
    mtu,
    async send(bytes) {
      if (!(bytes instanceof Uint8Array)) throw new Error("frame must be a Uint8Array");
      if (bytes.length > mtu) {
        throw new Error(`frame of ${bytes.length} bytes exceeds the ${mtu}-byte MTU`);
      }
      stats.sent++;
      const info = { seq: seq++, from, bytes };
      if (lossFn && lossFn(info)) {
        stats.dropped++;
        return;
      }
      deliver(remote, bytes);
      if (duplicateFn && duplicateFn(info)) {
        stats.duplicated++;
        deliver(remote, bytes);
      }
    },
    onFrame(cb) {
      local.listeners.add(cb);
      return () => local.listeners.delete(cb);
    },
  });

  return {
    a: makeLink("a", endA, endB),
    b: makeLink("b", endB, endA),
    stats,
    idle() {
      return new Promise((resolve) => {
        idleWaiters.push(resolve);
        settle();
      });
    },
  };
}
