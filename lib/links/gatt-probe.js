// SPDX-License-Identifier: GPL-3.0-only
/**
 * Which GATT operations overlap, and which one fails.
 *
 * Measured in the field on two Android phones (issue #153): 502 of 925 log
 * lines were `GATT operation already in progress`, present from the first
 * second of a connection and in windows with no reconnect at all. So the
 * storm is not the consequence of the reconnect machinery — something starts
 * two Bluetooth operations at once, and Android Chrome reports the loser as a
 * failure, which the Meshtastic transport in turn reports as a disconnection.
 *
 * Knowing *that* it happens is not enough to fix it. This says **what runs
 * while what else runs**, which is the thing a queue would have to serialise.
 *
 * It wraps the Web Bluetooth characteristic methods rather than the Meshtastic
 * library, because the overlap is only visible where the operations actually
 * are — the library starts them from several places (configure, its own
 * heartbeat, every watcher) and no single one of them can see the others.
 *
 * Deliberately quiet: an overlap or a failure is reported, a well-behaved
 * operation is not. A phone in the field publishes every log line over the
 * network, so a line per operation would drown the run it is measuring.
 *
 * Off unless asked for (`?gatt=1`). Patching a browser prototype is not
 * something an app should do while nobody is watching.
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
 * @param {(line: string) => void} report one line per overlap or failure
 * @param {Object} [options]
 * @param {Object} [options.target] prototype to patch; the browser's by default
 * @param {() => number} [options.now] clock, for tests
 * @returns {() => void} stop measuring and put the originals back
 */
export function measureGattOverlap(report, { target = null, now = null } = {}) {
  const proto = target ?? globalThis.BluetoothRemoteGATTCharacteristic?.prototype ?? null;
  if (!proto) return () => {};
  const clock = now ?? (() => performance.now());

  /** id → what it is and when it started, for naming the other side of a clash. */
  const running = new Map();
  let seq = 0;
  const restore = [];

  for (const name of OPERATIONS) {
    const original = proto[name];
    if (typeof original !== "function") continue;
    restore.push([name, original]);

    proto[name] = function patched(...args) {
      const id = ++seq;
      const started = clock();

      if (running.size > 0) {
        // The whole point: not "something overlapped" but which two things.
        const others = [...running.values()]
          .map((o) => `${o.name} (${Math.round(started - o.started)}ms)`)
          .join(", ");
        report(`⇄ ${name} starts while running: ${others}`);
      }
      running.set(id, { name, started });

      const settle = (error) => {
        running.delete(id);
        if (error) {
          report(`✗ ${name} after ${Math.round(clock() - started)}ms: ${error?.message ?? error}`);
        }
      };

      let result;
      try {
        result = original.apply(this, args);
      } catch (error) {
        // A synchronous throw never reaches a .catch, and this is where the
        // "already in progress" rejection is raised on some builds.
        settle(error);
        throw error;
      }
      return Promise.resolve(result).then(
        (value) => {
          settle(null);
          return value;
        },
        (error) => {
          settle(error);
          throw error;
        },
      );
    };
  }

  return () => {
    for (const [name, original] of restore) proto[name] = original;
    running.clear();
  };
}
