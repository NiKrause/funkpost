// SPDX-License-Identifier: GPL-3.0-only
/**
 * Wall-clock time in the shop's zone, and the instants it maps to.
 *
 * A salon's opening hours are wall time — "Thursday, 09:00" — but a booking is
 * an *instant*, and the two only agree until the clocks change. Everything
 * here exists so that a slot on the last Sunday in March is the same second
 * for the customer and for the salon.
 *
 * No dependency: `Intl.DateTimeFormat` already knows every zone's rules, and
 * asking it what the wall clock said at a given instant is enough to invert
 * the mapping.
 */

const FORMATTERS = new Map();

const formatterFor = (tz) => {
  let dtf = FORMATTERS.get(tz);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    FORMATTERS.set(tz, dtf);
  }
  return dtf;
};

/** What the wall clock in `tz` read at this instant. */
export function wallAt(utcMs, tz) {
  const parts = Object.fromEntries(
    formatterFor(tz)
      .formatToParts(new Date(utcMs))
      .map((p) => [p.type, p.value]),
  );
  // Some engines render midnight as hour "24" under hour12:false.
  const hour = Number(parts.hour) % 24;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour,
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

/** The zone's offset from UTC at this instant, in milliseconds. */
export function tzOffsetMs(utcMs, tz) {
  const w = wallAt(utcMs, tz);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - utcMs;
}

/**
 * The instant at which the wall clock in `tz` reads exactly this.
 *
 * Returns **null** when that wall time does not exist — the hour skipped by a
 * spring-forward transition. A salon whose hours start at 02:30 has no 02:30
 * on that Sunday, and inventing one would book a customer into a second that
 * never happens. Callers drop those slots.
 *
 * Where a wall time happens *twice* (autumn), the earlier instant is chosen.
 */
export function utcFromWall({ year, month, day, hour, minute = 0 }, tz) {
  const target = Date.UTC(year, month - 1, day, hour, minute, 0);
  // Guess with the offset at the target read as if it were UTC, then correct
  // once with the offset actually in force at the guess — that second pass is
  // what gets transition days right.
  let utc = target - tzOffsetMs(target, tz);
  utc = target - tzOffsetMs(utc, tz);

  const back = wallAt(utc, tz);
  if (
    back.year !== year ||
    back.month !== month ||
    back.day !== day ||
    back.hour !== hour ||
    back.minute !== minute
  ) {
    return null; // the clock skipped this wall time
  }
  return utc;
}

/** `"2026-09-10"` → `{ year, month, day }`. */
export function parseISODate(iso) {
  const [year, month, day] = iso.split("-").map(Number);
  if (!year || !month || !day) throw new Error(`not an ISO date: ${iso}`);
  return { year, month, day };
}

/** `{ year, month, day }` → `"2026-09-10"`. */
export function toISODate({ year, month, day }) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Whole days since 1970-01-01, for a civil date — the mask's anchor. */
export function epochDay({ year, month, day }) {
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

/** The inverse of {@link epochDay}. */
export function dateFromEpochDay(days) {
  const d = new Date(days * 86_400_000);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/**
 * `count` consecutive civil dates from `fromISO`, each with its weekday
 * (0 = Sunday). Civil arithmetic, deliberately: adding a day to a date is not
 * adding 86 400 000 ms to an instant on the days when it is 23 or 25 hours.
 */
export function civilDays(fromISO, count) {
  const { year, month, day } = parseISODate(fromISO);
  const out = [];
  for (let i = 0; i < count; i++) {
    const at = new Date(Date.UTC(year, month - 1, day + i));
    const date = {
      year: at.getUTCFullYear(),
      month: at.getUTCMonth() + 1,
      day: at.getUTCDate(),
    };
    out.push({ ...date, weekday: at.getUTCDay(), iso: toISODate(date) });
  }
  return out;
}

/** `"09:30"` → `{ hour: 9, minute: 30 }`. */
export function parseTimeOfDay(text) {
  const [hour, minute] = text.split(":").map(Number);
  if (Number.isNaN(hour) || Number.isNaN(minute)) throw new Error(`not a time: ${text}`);
  return { hour, minute };
}

/** Minutes since midnight, for comparing opening windows. */
export const minutesOfDay = ({ hour, minute }) => hour * 60 + minute;
