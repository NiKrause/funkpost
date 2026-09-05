// SPDX-License-Identifier: GPL-3.0-only
/**
 * Availability as a rule, never as a list.
 *
 * This is the single most important decision in the appointment demo. A salon
 * open ten hours a day has ~840 fifteen-minute slots in three weeks; shipping
 * them as data would cost kilobytes of airtime and would have to be re-shipped
 * every time the horizon moved. Shipping the *rule* — opening hours per
 * weekday, plus exceptions — costs a couple of hundred bytes and describes any
 * horizon at all. Every device generates the identical grid from it.
 *
 * "Identical" is doing real work in that sentence: the grid is also the index
 * space for the busy mask (mask.js), so if two devices disagreed about slot
 * number 400, they would disagree about who is booked. Hence `slotGrid` is a
 * pure function of the rules, and the tests pin it across daylight-saving
 * transitions, where the naive answer is wrong twice a year.
 */

import {
  civilDays,
  utcFromWall,
  parseTimeOfDay,
  minutesOfDay,
} from "./time.js";

/** A salon that has not been configured yet — enough to render something. */
export const DEFAULT_SHOP = {
  name: "Salon Funkpost",
  location: "Marktplatz 3, Eggenfelden",
  tz: "Europe/Berlin",
  mode: "auto", // "auto" (self-confirming) | "ask" (Rückfrage)
  slotMinutes: 15,
  horizonDays: 21,
  services: [
    { id: "cut", label: "Haarschnitt & Föhnen", minutes: 45 },
    { id: "trim", label: "Herrenschnitt", minutes: 30 },
    { id: "colour", label: "Farbe & Schnitt", minutes: 90 },
  ],
  // 0 = Sunday. Windows are wall-clock time in `tz`.
  hours: {
    1: [["09:00", "18:00"]],
    2: [["09:00", "18:00"]],
    3: [], // Ruhetag
    4: [["09:00", "20:00"]],
    5: [["09:00", "18:00"]],
    6: [["09:00", "14:00"]],
  },
  closures: [], // ISO dates the salon is shut regardless of `hours`
};

/**
 * The canonical slot grid for a horizon.
 *
 * @param {Object} shop The rules (see DEFAULT_SHOP)
 * @param {Object} range
 * @param {string} range.fromISO First civil date, `"2026-09-07"`
 * @param {number} [range.days] Defaults to `shop.horizonDays`
 * @returns {Array<{ index: number, startMs: number, iso: string, minuteOfDay: number }>}
 *   Ascending, and stable: the same rules and range always produce the same
 *   list, which is what lets the busy mask be a bare array of bits.
 */
export function slotGrid(shop, { fromISO, days = shop.horizonDays }) {
  const step = shop.slotMinutes;
  const closed = new Set(shop.closures ?? []);
  const grid = [];

  for (const day of civilDays(fromISO, days)) {
    if (closed.has(day.iso)) continue;
    const windows = shop.hours?.[day.weekday] ?? [];

    for (const [openText, closeText] of windows) {
      const open = minutesOfDay(parseTimeOfDay(openText));
      const close = minutesOfDay(parseTimeOfDay(closeText));

      for (let at = open; at + step <= close; at += step) {
        const startMs = utcFromWall(
          { year: day.year, month: day.month, day: day.day, hour: Math.floor(at / 60), minute: at % 60 },
          shop.tz,
        );
        // null = the clock skipped this wall time (spring forward). The salon
        // cannot open at an hour that does not happen.
        if (startMs == null) continue;
        grid.push({ index: grid.length, startMs, iso: day.iso, minuteOfDay: at });
      }
    }
  }
  return grid;
}

/** How many grid steps a service occupies. */
export function stepsFor(shop, service) {
  return Math.ceil(service.minutes / shop.slotMinutes);
}

export const serviceById = (shop, id) => (shop.services ?? []).find((s) => s.id === id) ?? null;

/**
 * Which grid slots can actually host this service: enough consecutive free
 * steps, all inside one opening window and one day.
 *
 * A 45-minute cut needs three consecutive quarter-hours — a free 17:45 on a
 * day that closes at 18:00 is not bookable, and neither is one whose second
 * quarter-hour is already taken.
 *
 * @param {Object} shop
 * @param {Array} grid From {@link slotGrid}
 * @param {(index: number) => boolean} isBusy
 * @param {Object} service
 * @returns {Array<Object>} the subset of `grid` that is offerable
 */
export function bookableSlots(shop, grid, isBusy, service) {
  const steps = stepsFor(shop, service);
  const stepMs = shop.slotMinutes * 60_000;
  const out = [];

  for (let i = 0; i + steps <= grid.length; i++) {
    let fits = true;
    for (let k = 0; k < steps; k++) {
      const here = grid[i + k];
      // Contiguity is checked on the clock, not on the index: consecutive
      // indices can straddle a lunch break, the end of a day, or a closure.
      if (isBusy(here.index)) { fits = false; break; }
      if (k > 0 && here.startMs !== grid[i + k - 1].startMs + stepMs) { fits = false; break; }
    }
    if (fits) out.push(grid[i]);
  }
  return out;
}

/** Every grid index a booking occupies — what the mask must mark. */
export function occupiedIndices(shop, grid, startIndex, service) {
  const steps = stepsFor(shop, service);
  const out = [];
  for (let k = 0; k < steps && startIndex + k < grid.length; k++) out.push(startIndex + k);
  return out;
}
