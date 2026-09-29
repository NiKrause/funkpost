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
import { createYjsProvider } from "@le-space/funkpost/yjs";
import { createClaimLog } from "./domain/claimlog.js";
import { attachPersistence } from "./domain/persistence.js";
import { createClaimSync, FORGET_GRACE_DAYS } from "./domain/claimsync.js";
import { createBookingBook } from "./domain/booking.js";
import { DEFAULT_SHOP } from "./domain/slots.js";
import { epochDay, parseISODate, toISODate } from "./domain/time.js";
import { connectCourier as connectRadio } from "@le-space/funkpost-radio";


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

  // Restore puts back everything that was on disk, including the days that
  // expired while this device was closed. Drop them now rather than waiting for
  // the first announce: a calendar reopened after a month should not hold a
  // month of dead bookings, and `onForget` clears them from disk on the way out.
  // The same boundary the sync uses, so the two cannot disagree.
  const { fromDay } = horizonFor(todayISO(DEFAULT_SHOP.tz, pinnedToday), days);
  const expired = log.forgetBefore(fromDay - FORGET_GRACE_DAYS);

  return { doc, log, days, pinnedToday, store, restored: store.restored - expired, expired };
}

/**
 * Connect the radio and start both protocols on it.
 *
 * `mode.kind === "bc"` uses a BroadcastChannel as a fake mesh — two browser
 * tabs play salon and customer with no hardware at all.
 */
/**
 * The radio, then this app's layers on top of it.
 *
 * Connecting used to live here in full, and mesh-todo carried a near-identical
 * copy — the two differed mainly in that this one wove the Yjs provider and the
 * booking book into the connector, which is exactly what made it unshareable.
 * Separated now: `@le-space/funkpost-radio` hands back a courier, and the
 * layers go on afterwards.
 */
export async function connectCourier({ stack, mode, onEvent, onChange, onTraffic, ...handlers }) {
  const { doc, log, days, pinnedToday } = stack;
  // Recomputed per call, not frozen at load: a salon tablet left running over
  // a night would otherwise keep a horizon that starts yesterday, and quietly
  // stop agreeing with everyone else about which days exist.
  const horizon = () => horizonFor(todayISO(DEFAULT_SHOP.tz, pinnedToday), days);

  // `onTraffic` is this page's name for what the shared connector calls
  // telemetry; the rest of the handlers pass through untouched.
  const radio = await connectRadio({ mode, onEvent, onTelemetry: onTraffic, ...handlers });
  const { courier } = radio;

  // Rules over Yjs: a handful of stable writers, where merge earns its keep.
  const provider = createYjsProvider({ doc, courier, coalesceMs: 400, onEvent });
  // Bookings over the claim log: a greeting that does not grow with the
  // number of customers, and a horizon that forgets. See issue #45.
  const sync = createClaimSync({ log, courier, horizon, onEvent, onChange });
  const book = createBookingBook({ doc, log, sync });

  return { ...radio, provider, sync, book };
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
