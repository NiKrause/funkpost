// SPDX-License-Identifier: GPL-3.0-only
/**
 * Keeping a Meshtastic node connected, which on a phone is a job in itself.
 *
 * The link below this (meshtastic-device-link.js) is deliberately thin: it
 * turns bytes into packets. This file holds the part that is *policy* — when
 * to give up on a connection, how long to wait, what to tear down first — and
 * every clause in it was paid for on hardware:
 *
 * - **Subscribe before configure.** The config stream delivers region,
 *   channels, identity and neighbours within its first second and never
 *   replays. A watcher attached after `configure()` races it and loses on a
 *   fast machine (sixth field report).
 * - **Watch the region continuously, not once.** A node that has just rebooted
 *   — which importing a shared channel makes it do — reports its region late.
 *   A one-shot read freezes the courier at `UNSET` and it refuses to transmit
 *   (seventh field report).
 * - **Tear the old device down first.** Its `disconnect()` clears the
 *   heartbeat timer and closes the GATT. Skipping it means two connections to
 *   one radio and the "GATT operation already in progress" storm.
 * - **One generation speaks.** Events from a device that has been replaced are
 *   ignored, or the zombie watchers of every past reconnect each fire their own
 *   reconnect — and the teardown disconnect starts a fresh cycle by itself.
 * - **Back off, and do not reset on a connect that immediately drops.** The
 *   backoff only resets once the link has *stayed* up (`stableMs`), otherwise a
 *   flapping stack looks healthy after every failed attempt.
 * - **Give up.** A cap, then `gaveUp` — a stack that keeps failing
 *   `gatt.connect` cannot be cured from JavaScript, and looping forever just
 *   hides that from the user.
 * - **Not every "disconnected" is a disconnection.** The Web Bluetooth
 *   transport reports a *failed GATT operation* as `DeviceDisconnected`,
 *   reason `write-error`, and Android Chrome produces those readily: a write
 *   and a notification-driven read overlap and one loses. The link is still
 *   up; only the WritableStream is now errored, so nothing can be sent through
 *   it again. Tearing the connection down in that state converts a hiccup into
 *   a real outage, and doing so repeatedly is how a healthy radio ends up at
 *   the give-up cap. `isLinkAlive` tells the two apart, and a live link gets a
 *   **re-attach** — a fresh MeshDevice over the same open GATT — instead of a
 *   reconnect.
 *
 *   This is also why the official web client appears steadier on the same
 *   hardware: it does not reconnect at all (meshtastic/web#589 asks for the
 *   feature), so a spurious status costs it nothing — and a chat app writes
 *   rarely enough to seldom provoke one. A courier pushing multi-fragment
 *   payloads provokes them constantly.
 *
 * The transport is the caller's business: `createDevice` returns a connected
 * `MeshDevice` over Web Bluetooth in a browser, TCP or serial in Node. Nothing
 * here imports a transport.
 */

import {
  createMeshtasticDeviceLink,
  watchDeviceRegion,
  watchAirUtilTx,
  watchDeviceStatus,
  watchNodeInfo,
  watchChannels,
  watchMyNodeInfo,
  watchMeshTraffic,
} from "./meshtastic-device-link.js";

const defaultTimers = {
  setTimeout: (...args) => setTimeout(...args),
  clearTimeout: (...args) => clearTimeout(...args),
};

/** Effectively "never" — the largest interval setInterval will honour. */
const PARKED_HEARTBEAT_MS = 2_147_483_647;

/** Exponential, capped: 1 s, 2 s, 4 s, 8 s, 15 s, 15 s… */
export const defaultBackoff = (attempt) => Math.min(1000 * 2 ** (attempt - 1), 15_000);

/**
 * Connect a Meshtastic node and keep it connected.
 *
 * @param {Object} options
 * @param {() => boolean} [options.isLinkAlive] Is the underlying link still
 *   up? Over Web Bluetooth: `() => bleDevice.gatt?.connected === true`. When it
 *   says yes, a reported disconnection is treated as a broken stream over a
 *   live link and repaired by re-attaching rather than reconnecting.
 * @param {() => Promise<Object>} options.createDevice Produce a freshly
 *   connected `MeshDevice`. Called once per (re)connect, so it must be
 *   repeatable without user interaction — in a browser that means holding the
 *   `BluetoothDevice` yourself rather than reopening the chooser.
 * @param {(link: Object) => Object} [options.createCourier] Build the courier
 *   from the managed link. Supplied here rather than afterwards so the courier
 *   exists *before* `configure()` runs and cannot miss the config stream; the
 *   supervisor then feeds it region and airtime on its own.
 * @param {Object} [options.link] Options for `createMeshtasticDeviceLink`
 * @param {number} [options.heartbeatMs] Keep-alive ping (default 30 000).
 *   Browsers drop an idle GATT link after a few minutes; the official clients
 *   ping for exactly this reason.
 * @param {number} [options.maxAttempts] Reconnect attempts before `gaveUp` (5)
 * @param {number} [options.stableMs] How long a link must hold before the
 *   backoff resets (8 000)
 * @param {(attempt: number) => number} [options.backoff] Delay per attempt
 * @param {Object} [options.on] Callbacks: `region`, `airUtilTx`, `status`,
 *   `nodeInfo`, `channel`, `myNodeInfo`, `traffic`, `reconnecting`,
 *   `reconnected`, `reattached`, `gaveUp`, `error`
 * @param {Object} [options.timers] Injectable clock for tests
 * @returns {Promise<Object>} `{ link, courier, device, setChannel, reconnect, close }`
 */
export async function connectMeshtasticDevice({
  createDevice,
  isLinkAlive = null,
  createCourier = null,
  link: linkOptions = {},
  heartbeatMs = 30_000,
  maxAttempts = 5,
  maxReattaches = 20,
  stableMs = 8_000,
  backoff = defaultBackoff,
  on = {},
  timers = defaultTimers,
} = {}) {
  if (typeof createDevice !== "function") {
    throw new Error("createDevice() returning a connected MeshDevice is required");
  }

  const fire = (name, ...args) => {
    const cb = on[name];
    if (!cb) return;
    try {
      cb(...args);
    } catch (error) {
      // A throwing UI callback must not take the radio down with it.
      if (on.error && name !== "error") on.error(error);
    }
  };

  let device = await createDevice();
  const link = createMeshtasticDeviceLink({ device, destination: "broadcast", ...linkOptions });
  const courier = createCourier ? createCourier(link) : null;

  let closed = false;
  let reconnecting = false;
  let attempts = 0;
  let reattaches = 0;
  let currentDevice = null; // only THIS device's events may act
  let stableTimer = null;
  let unsubscribes = []; // this generation's watchers

  const sleep = (ms) => new Promise((resolve) => timers.setTimeout(resolve, ms));

  const releaseWatchers = () => {
    for (const off of unsubscribes) {
      try {
        off();
      } catch {
        /* a dead device's dispatcher may already be gone */
      }
    }
    unsubscribes = [];
  };

  /**
   * Point every watcher at a device, then configure it — in that order, and
   * never the other way round.
   */
  const attach = (dev) => {
    releaseWatchers();
    currentDevice = dev;
    const mine = (fn) => (value) => {
      if (dev !== currentDevice) return; // a replaced generation stays silent
      fn(value);
    };

    unsubscribes.push(
      watchDeviceRegion(
        dev,
        mine((name) => {
          if (courier) courier.setRegion(name);
          fire("region", name);
        }),
      ),
      watchAirUtilTx(
        dev,
        mine((value) => {
          if (courier) courier.reconcileNodeAirtime(value);
          fire("airUtilTx", value);
        }),
      ),
      watchNodeInfo(dev, mine((node) => fire("nodeInfo", node))),
      watchChannels(dev, mine((channel) => fire("channel", channel))),
      watchMyNodeInfo(dev, mine((info) => fire("myNodeInfo", info))),
      // Everything the node hears, before the decrypt decision — the only way
      // to tell "nobody is there" from "we cannot read them".
      watchMeshTraffic(dev, mine((packet) => fire("traffic", packet))),
      watchDeviceStatus(
        dev,
        mine((name) => {
          fire("status", name);
          if (name !== "disconnected" || closed) return;
          // Ground truth beats the report: if the link is still up, only the
          // stream died, and closing the connection would be us breaking it.
          if (isLinkAlive && isLinkAlive() && reattaches < maxReattaches) void reattach();
          else void reconnect();
        }),
      ),
    );

    dev.setHeartbeatInterval(heartbeatMs);
    Promise.resolve(dev.configure()).catch((error) => fire("error", error));
  };

  /**
   * Replace the device over a connection that never went away.
   *
   * Cheap on purpose: no `gatt.disconnect()`, so no re-pairing and no radio
   * renegotiation — `createDevice` finds the GATT already open and simply
   * re-reads its characteristics. The old device is parked rather than
   * disconnected, because `disconnect()` would close the very link we are
   * keeping; its heartbeat is pushed out of the way instead, since the library
   * offers no way to stop one.
   */
  const reattach = async () => {
    if (reconnecting || closed) return;
    reconnecting = true;
    reattaches += 1;
    const dying = currentDevice;
    currentDevice = null;
    releaseWatchers();
    try {
      dying?.setHeartbeatInterval(PARKED_HEARTBEAT_MS);
    } catch {
      /* best effort — it is being replaced anyway */
    }
    try {
      device = await createDevice();
      attach(device);
      link.rebind(device);
      reconnecting = false;
      fire("reattached", reattaches);
    } catch (error) {
      // The link was not as alive as it claimed. Fall back to the real thing.
      reconnecting = false;
      fire("error", error);
      if (!closed) void reconnect();
    }
  };

  const reconnect = async () => {
    if (reconnecting || closed) return;
    reconnecting = true;
    if (stableTimer) {
      timers.clearTimeout(stableTimer);
      stableTimer = null;
    }

    // Silence the dying generation, then close it — before anything new opens.
    const dying = currentDevice;
    currentDevice = null;
    releaseWatchers();
    try {
      await dying?.disconnect();
    } catch {
      /* best effort — we are replacing it anyway */
    }

    attempts += 1;
    if (attempts > maxAttempts) {
      reconnecting = false;
      fire("gaveUp", attempts - 1);
      return;
    }
    fire("reconnecting", attempts);
    await sleep(backoff(attempts));
    if (closed) {
      reconnecting = false;
      return;
    }

    try {
      device = await createDevice();
      attach(device);
      link.rebind(device);
      reconnecting = false;
      fire("reconnected", attempts);
      // Healthy only once it has *stayed* up. A connect that drops again at
      // once keeps climbing toward the cap instead of resetting to attempt 1.
      stableTimer = timers.setTimeout(() => {
        stableTimer = null;
        attempts = 0;
      }, stableMs);
    } catch (error) {
      reconnecting = false;
      fire("error", error);
      if (!closed) void reconnect();
    }
  };

  attach(device);

  return {
    link,
    courier,
    /** The live `MeshDevice` — a getter, because reconnecting replaces it. */
    get device() {
      return device;
    },
    /** Switch the transmit channel index. */
    setChannel(index) {
      link.setChannel(index);
    },
    /** Force a reconnect cycle now — a *Retry* button, or a manual recovery. */
    reconnect() {
      return reconnect();
    },
    /** Stop supervising. Nothing reconnects after this. */
    close() {
      if (closed) return;
      closed = true;
      if (stableTimer) {
        timers.clearTimeout(stableTimer);
        stableTimer = null;
      }
      releaseWatchers();
      currentDevice = null;
    },
  };
}
