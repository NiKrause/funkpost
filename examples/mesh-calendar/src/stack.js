// SPDX-License-Identifier: GPL-3.0-only
/**
 * Wires the appointment demo:
 *
 *   shop rules ──► Yjs provider  ─┐
 *                                  ├─► funkpost courier ──► Meshtastic node
 *   bookings   ──► claim sync    ─┘                          (or a fake mesh)
 *
 * Two protocols share one courier, which is the whole point of the byte
 * courier being byte-shaped: the Yjs provider tags its messages 0x00–0x02 and
 * the claim sync 0x10–0x12, and each ignores what it does not recognise.
 *
 * Nothing here reaches the internet. The page is static files; every booking
 * travels over the radio or not at all.
 */

import * as Y from "yjs";
import {
  createMeshtasticCourier,
  connectMeshtasticDevice,
  describeMeshtasticError,
} from "@le-space/funkpost";
import { createYjsProvider } from "@le-space/funkpost/yjs";
import { createClaimLog } from "./domain/claimlog.js";
import { attachPersistence } from "./domain/persistence.js";
import { createClaimSync } from "./domain/claimsync.js";
import { createBookingBook } from "./domain/booking.js";
import { DEFAULT_SHOP } from "./domain/slots.js";
import { epochDay, parseISODate, toISODate } from "./domain/time.js";
import { createBroadcastChannelLink } from "./fake-bc-link.js";

const MESHTASTIC_BLE_SERVICE = "6ba1b218-15a8-461f-9fa8-5dcae273eafd";

/**
 * Today, as the shop's wall calendar has it. Pinnable with `?today=` so the
 * e2e suite is not a different test every morning.
 */
export function todayISO(tz = DEFAULT_SHOP.tz, pinned = null) {
  if (pinned) return pinned;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  return parts;
}

/** The window everything is computed against: today, forward. */
export function horizonFor(fromISO, days) {
  return { fromDay: epochDay(parseISODate(fromISO)), days };
}

/**
 * Build the local state and put back whatever this device already knew.
 *
 * No radio yet — the user has to act for that, because Web Bluetooth demands a
 * gesture. But the book itself should survive a reload without asking the mesh
 * to send it all again, which on a duty-cycled link is not free.
 */
export async function createStack({ room, days = DEFAULT_SHOP.horizonDays, pinnedToday = null, onError }) {
  const doc = new Y.Doc();
  const log = createClaimLog();
  const store = await attachPersistence({ room, doc, log, Y, onError });
  return { doc, log, days, pinnedToday, store, restored: store.restored };
}

/**
 * Connect the radio and start both protocols on it.
 *
 * `mode.kind === "bc"` uses a BroadcastChannel as a fake mesh — two browser
 * tabs play salon and customer with no hardware at all.
 */
export async function connectCourier({ stack, mode, onEvent, onChange, onStatus, onRegion, onChannel, onMyNodeInfo, onTraffic, onError, onReconnecting, onReconnected, onGaveUp }) {
  const { doc, log, days, pinnedToday } = stack;
  // Recomputed per call, not frozen at load: a salon tablet left running over
  // a night would otherwise keep a horizon that starts yesterday, and quietly
  // stop agreeing with everyone else about which days exist.
  const horizon = () => horizonFor(todayISO(DEFAULT_SHOP.tz, pinnedToday), days);

  const start = (courier, kind, region) => {
    // Rules over Yjs: a handful of stable writers, where merge earns its keep.
    const provider = createYjsProvider({ doc, courier, coalesceMs: 400, onEvent });
    // Bookings over the claim log: a greeting that does not grow with the
    // number of customers, and a horizon that forgets. See issue #45.
    const sync = createClaimSync({ log, courier, horizon, onEvent, onChange });
    const book = createBookingBook({ doc, log, sync });
    return { courier, provider, sync, book, kind, region };
  };

  if (mode.kind === "bc") {
    const link = createBroadcastChannelLink({ room: mode.room, loss: mode.loss });
    const courier = createMeshtasticCourier({
      link,
      region: "EU_868",
      preset: mode.preset,
      onEvent,
    });
    return {
      ...start(courier, "BroadcastChannel (Mesh-Attrappe)", "EU_868"),
      device: null,
      setTxChannel: () => {},
      close: () => courier.close(),
    };
  }

  const [{ TransportWebBluetooth }, { MeshDevice }] = await Promise.all([
    import("@meshtastic/transport-web-bluetooth"),
    import("@meshtastic/core"),
  ]);
  // Hold the BluetoothDevice ourselves so the supervisor can reconnect to it
  // without reopening the chooser.
  const bleDevice = await navigator.bluetooth.requestDevice({
    filters: [{ services: [MESHTASTIC_BLE_SERVICE] }],
  });

  let started = null;
  const managed = await connectMeshtasticDevice({
    createDevice: async () =>
      new MeshDevice(await TransportWebBluetooth.createFromDevice(bleDevice)),
    // The transport reports a failed GATT write as a disconnection, and
    // Android Chrome produces those readily. This is the ground truth that
    // stops us closing a connection that never actually dropped.
    isLinkAlive: () => bleDevice.gatt?.connected === true,
    createCourier: (link) =>
      createMeshtasticCourier({
        link,
        region: "UNSET", // the node reports the real one live
        onEvent,
        minFrameGapMs: 150,
        maxRounds: 12,
      }),
    on: {
      region: (name) => {
        if (onRegion) onRegion(name);
        // A node reports its region a moment AFTER it connects, and until then
        // the courier refuses to transmit — correctly, since it does not yet
        // know the local airtime law. Anything attempted in that window was
        // dropped, so re-greet as soon as the region lands rather than leaving
        // the user staring at a book that never filled.
        if (name && name !== "UNSET" && started) {
          started.sync.resync();
          started.provider.resync();
        }
      },
      status: onStatus,
      // Which channels the node holds a key for, and which one we transmit on.
      // Two nodes that hear each other perfectly and decrypt nothing is the
      // classic field failure, and it is invisible without this.
      channel: onChannel,
      myNodeInfo: onMyNodeInfo,
      traffic: onTraffic,
      reconnecting: onReconnecting,
      reconnected: () => {
        // Re-greet: one digest and one state vector, and whatever the drop
        // interrupted comes back.
        started?.sync.resync();
        started?.provider.resync();
        if (onReconnected) onReconnected();
      },
      reattached: () => {
        // The stream was replaced over a link that never dropped; re-greet so
        // whatever was in flight when it broke comes back.
        started?.sync.resync();
        started?.provider.resync();
        if (onReconnected) onReconnected("reattached");
      },
      gaveUp: onGaveUp,
      error: (e) => onError && onError(describeMeshtasticError(e)),
    },
  });

  started = start(managed.courier, "Meshtastic-Knoten (Web Bluetooth)", "UNSET");
  return {
    ...started,
    get device() {
      return managed.device;
    },
    setTxChannel: (index) => {
      managed.setChannel(index);
      // A channel switch changes who can hear us, so it is a fresh start, not
      // a setting. Whoever was heard on the old channel is not there any more,
      // and waiting out a heartbeat — up to five minutes on the slow cadence —
      // would look exactly like the switch having failed.
      started?.sync.forgetPeers();
      started?.sync.resync();
      started?.provider.resync();
    },
    close: () => managed.close(),
  };
}

/** Offer a generated file to the browser. Blob, not a server. */
export function downloadFile(filename, text, type = "text/calendar;charset=utf-8") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export { toISODate, parseISODate };
