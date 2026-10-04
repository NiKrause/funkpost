// SPDX-License-Identifier: GPL-3.0-only
/**
 * Settings a device keeps between launches.
 *
 * Small on purpose: read a value, write a value, and never throw. A browser
 * that refuses storage — a private window, a phone with site data blocked —
 * simply forgets, and a page that crashed over that would be worse than one
 * that asks again.
 *
 * Only what the person chose about *this device* belongs here. Anything the
 * address says wins over anything kept: a link with `?role=office` in it is
 * somebody being explicit now, and a value from last week must not override
 * it. That is the same order `startingLang()` uses for the language, and it is
 * what makes a shared link behave the way its sender expects.
 *
 * Deliberately not here: whether this device is transmitting. mesh-trail's
 * suite asserts that sending is off until somebody turns it on, and a page
 * that starts putting a position on the air because of a choice made on a
 * different day is not a page anybody asked for.
 */

/**
 * @param {string} key
 * @param {unknown} fallback returned when nothing is kept, or storage refuses
 */
export function kept(key, fallback) {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    if (raw == null) return fallback;
    const value = JSON.parse(raw);
    return value === null || value === undefined ? fallback : value;
  } catch {
    return fallback;
  }
}

/** @returns {boolean} whether it was actually written */
export function keep(key, value) {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/**
 * The address first, then what was kept, then the default.
 *
 * @param {string|null} fromQuery the raw query value, or null when absent
 * @param {(raw: string) => unknown} parse turns that raw value into one
 * @param {string} key where the kept value lives
 * @param {unknown} fallback when there is neither
 */
export function chosen(fromQuery, parse, key, fallback) {
  // `URLSearchParams.get` returns a string or null, and the only falsy string
  // is the empty one — which is a parameter with nothing after the `=`, and
  // that is not somebody asking for anything. So this one test is the whole
  // check; spelling out `!= null && !== ""` only looked more careful.
  if (fromQuery) {
    const asked = parse(fromQuery);
    if (asked !== undefined && asked !== null && !Number.isNaN(asked)) return asked;
  }
  return kept(key, fallback);
}
