// SPDX-License-Identifier: GPL-3.0-only
/**
 * The "change or cancel" link, with no server behind it.
 *
 * Calendly's link resolves against a backend. Ours cannot: the whole premise is
 * that there is no IP path to the salon. What makes it work anyway is the
 * **fragment**:
 *
 *     https://…/mesh-calendar/#/b/<shopId>/<bookingId>/<token>
 *                             ^ everything from here never leaves the browser
 *
 * A fragment is not sent to the server — not in the request line, not in a
 * header, not in a referrer. So the capability token is not disclosed to the
 * host serving the page, to a CDN, or to anything in between. Opening the link
 * fetches **static files only**; the change itself then travels over the mesh,
 * signed with the key the token derives.
 *
 * The caveat, stated plainly because it is this design's sharpest edge: the
 * *link* needs the app, and the app arrives over HTTPS the first time. Once
 * installed as a PWA it works offline; a stranger tapping a cold link needs one
 * moment of internet to fetch the page, after which the booking itself is pure
 * radio. The QR code at the counter is the offline-native path, and should be
 * the primary one.
 */

import { toBase64Url, fromBase64Url, TOKEN_BYTES } from "./capability.js";

/**
 * Where the app is deployed. Every `.ics` ever downloaded points at whatever
 * this said at the time, and a calendar entry from last spring must still lead
 * somewhere useful — so a path this appears in can be *left*, never *deleted*.
 *
 * It moved once, from `/termine/`, and `/termine/` still stands as a redirect
 * that carries the fragment across (see the Pages workflow). Anything that
 * replaces this constant owes the old path the same courtesy.
 */
export const DEFAULT_BASE = "https://nikrause.github.io/funkpost/mesh-calendar/";

const SAFE_SEGMENT = /^[A-Za-z0-9._~-]{1,64}$/;

/**
 * Build the link that goes into the calendar note.
 *
 * @param {Object} parts
 * @param {string} parts.shopId
 * @param {string} parts.bookingId
 * @param {Uint8Array} parts.token The capability seed — never sent to a server
 * @param {string} [parts.base]
 * @returns {string}
 */
export function bookingLink({ shopId, bookingId, token, base = DEFAULT_BASE }) {
  if (!SAFE_SEGMENT.test(shopId)) throw new Error(`shop id is not URL-safe: ${shopId}`);
  if (!SAFE_SEGMENT.test(bookingId)) throw new Error(`booking id is not URL-safe: ${bookingId}`);
  if (!(token instanceof Uint8Array) || token.length !== TOKEN_BYTES) {
    throw new Error(`a capability token is ${TOKEN_BYTES} bytes`);
  }
  const root = base.endsWith("/") ? base : `${base}/`;
  return `${root}#/b/${shopId}/${bookingId}/${toBase64Url(token)}`;
}

/**
 * Read a link back — from `location.hash` on load, or from a whole URL.
 *
 * Returns null rather than throwing for anything unrecognised: this parses
 * whatever a calendar app, a messaging client or a QR scanner hands over, and
 * a malformed fragment is an ordinary event, not an exception.
 *
 * @param {string} input A full URL or a bare `#/b/...` fragment
 * @returns {{ shopId: string, bookingId: string, token: Uint8Array } | null}
 */
export function parseBookingLink(input) {
  if (typeof input !== "string" || input.length === 0) return null;
  const hash = input.indexOf("#");
  const fragment = hash >= 0 ? input.slice(hash + 1) : input;

  const parts = fragment.split("/").filter((segment) => segment.length > 0);
  if (parts.length !== 4 || parts[0] !== "b") return null;

  const [, shopId, bookingId, encoded] = parts;
  if (!SAFE_SEGMENT.test(shopId) || !SAFE_SEGMENT.test(bookingId)) return null;

  let token;
  try {
    token = fromBase64Url(encoded);
  } catch {
    return null;
  }
  if (token.length !== TOKEN_BYTES) return null;

  return { shopId, bookingId, token };
}

/**
 * The link a salon puts on a poster or the counter. It carries no capability —
 * it is an invitation to the shop's document, not to one booking.
 */
export function shopLink({ shopId, base = DEFAULT_BASE }) {
  if (!SAFE_SEGMENT.test(shopId)) throw new Error(`shop id is not URL-safe: ${shopId}`);
  const root = base.endsWith("/") ? base : `${base}/`;
  return `${root}#/s/${shopId}`;
}

/** @returns {{ shopId: string } | null} */
export function parseShopLink(input) {
  if (typeof input !== "string") return null;
  const hash = input.indexOf("#");
  const fragment = hash >= 0 ? input.slice(hash + 1) : input;
  const parts = fragment.split("/").filter(Boolean);
  if (parts.length !== 2 || parts[0] !== "s") return null;
  return SAFE_SEGMENT.test(parts[1]) ? { shopId: parts[1] } : null;
}
