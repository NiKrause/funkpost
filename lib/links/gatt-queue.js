// SPDX-License-Identifier: GPL-3.0-only
/**
 * One Bluetooth operation at a time, because the browser allows exactly that.
 *
 * Measured in the field (issue #153, then the probe in `gatt-probe.js`): 139
 * overlapping GATT operations in one short run, and in **every single one** the
 * blocking operation was a `readValue`. The connection sequence reads the
 * node's configuration without awaiting each read:
 *
 *   ⇄ readValue starts while running: readValue (2ms)
 *   ⇄ readValue starts while running: readValue (9ms), readValue (7ms)
 *   ⇄ readValue starts while running: readValue (18ms), (16ms), (9ms)
 *   …nine deep…
 *   ✗ readValue after 66ms: GATT operation already in progress.
 *
 * Android Chrome then fails the loser, the Meshtastic transport reports a
 * failed operation as a disconnection, and the supervisor spends its budget
 * repairing a link that was never broken. Everything downstream of this is a
 * symptom, which is why none of the reconnect fixes moved the error rate.
 *
 * This is a queue, not a fix of the caller: the operations come from several
 * places inside the Meshtastic library — configure, its own heartbeat, every
 * watcher — and no single call site can see the others. The browser's own
 * methods are the one place they all pass through.
 *
 * What it does not do: it does not make a slow read faster, and a caller that
 * waits on operation fifty now waits for the forty-nine before it. That is the
 * honest cost of a radio that can only do one thing at a time — and it is what
 * was happening anyway, except that the failures were being retried blindly.
 */

/** The methods that actually talk to the radio. */
const OPERATIONS = [
  "writeValue",
  "writeValueWithResponse",
  "writeValueWithoutResponse",
  "readValue",
  "startNotifications",
  "stopNotifications",
];

/**
 * @param {Object} [options]
 * @param {Object} [options.target] prototype to patch; the browser's by default
 * @returns {() => void} stop queueing and put the originals back
 */
export function serialiseGattOperations({ target = null } = {}) {
  const proto = target ?? globalThis.BluetoothRemoteGATTCharacteristic?.prototype ?? null;
  if (!proto) return () => {};

  /** The end of the queue: everything new waits for this to settle. */
  let tail = Promise.resolve();
  const restore = [];

  for (const name of OPERATIONS) {
    const original = proto[name];
    if (typeof original !== "function") continue;
    restore.push([name, original]);

    proto[name] = function queued(...args) {
      // Both arms run it: a predecessor that failed has still finished, and
      // stopping the queue at the first error would turn one failed read into
      // a dead connection.
      const start = () => original.apply(this, args);
      const previous = tail;

      // The queue advances on a gate of its own rather than on the operation's
      // promise. Chaining `tail = run.then(…)` would attach a rejection
      // handler to `run`, which tells the browser the failure was dealt with —
      // and the unhandled rejections it then stops reporting are exactly how
      // this bug was found. The caller's promise must stay as unhandled as it
      // was without the queue.
      let opened;
      tail = new Promise((resolve) => (opened = resolve));

      return previous.then(start, start).then(
        (value) => {
          opened();
          return value;
        },
        (error) => {
          opened();
          throw error;
        },
      );
    };
  }

  return () => {
    for (const [name, original] of restore) proto[name] = original;
    tail = Promise.resolve();
  };
}
