// SPDX-License-Identifier: GPL-3.0-only
/**
 * Where the device is, from the node if it knows and the browser if it does not.
 *
 * The node is preferred, and the reason is not preference: it is the thing with
 * the antenna. A fix from the browser is the *phone's* idea of where it is,
 * which on a bicycle is the same place — but the node's fix needs no permission
 * dialogue, survives a locked screen, and is what a Meshtastic user already
 * expects to be the source of truth. Not every node has a GPS, which is why the
 * browser stays as a fallback rather than being removed.
 *
 * Whichever answers, the page says which — a track whose points came from two
 * different sources without saying so is a track nobody can argue with later.
 *
 * The scaling is checked rather than remembered: `@meshtastic/core` builds the
 * field as `latitudeI: Math.floor(latitude / 1e-7)`, so reading it back is a
 * multiplication by 1e-7. Get that wrong by a factor of ten and the ride is
 * plotted in the wrong country, which no test of "does it have a number" would
 * notice.
 */

/** Meshtastic stores degrees as integers scaled by 1e7. */
const SCALE = 1e-7;

/**
 * `Position.LocSource`, straight from the protocol: 0 unset, 1 typed in by
 * hand, 2 the node's own GPS, 3 a receiver wired to it.
 *
 * This matters more than it looks. A node with no GPS still reports a
 * position, because the Meshtastic app writes the phone's into it — so
 * "the node has a position" is not the same claim as "the node knows where
 * it is", and only the second one should outrank a phone that is walking.
 */
const LOC_INTERNAL = 2;
const LOC_EXTERNAL = 3;

/**
 * Past this many metres a browser fix is a guess from a Wi-Fi network or an IP
 * address rather than from the sky. A phone with a satellite lock reports
 * single or low double digits; a desktop reports thousands.
 */
export const VAGUE_METRES = 100;

/**
 * Read a node's position packet, or decide it has no fix.
 *
 * `null` rather than a throw, and `null` rather than zeros: a node that has not
 * yet seen a satellite reports 0/0, which is a real place in the Gulf of
 * Guinea. A track that quietly plots a ride there is worse than one that says
 * it does not know.
 */
export function decodeNodePosition(packet, { at = Date.now() } = {}) {
  const p = packet?.data ?? packet;
  if (!p) return null;
  const latI = p.latitudeI;
  const lonI = p.longitudeI;
  if (!Number.isFinite(latI) || !Number.isFinite(lonI)) return null;
  if (latI === 0 && lonI === 0) return null; // no fix yet, not the Atlantic
  const lat = latI * SCALE;
  const lon = lonI * SCALE;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return {
    lat,
    lon,
    // The node's own time when it has one; ours when it does not. A position
    // with a plausible age is worth more than one that claims to be now.
    at: Number.isFinite(p.time) && p.time > 0 ? p.time * 1000 : at,
    source: "node",
    // Did it see a satellite, or is it repeating a place somebody typed in?
    gps: p.locationSource === LOC_INTERNAL || p.locationSource === LOC_EXTERNAL,
  };
}

/**
 * Which of two fixes to believe, when they disagree about where "here" is.
 *
 * Both demos used to let the node win outright, and a walk in the woods found
 * what that costs: connect a node with no GPS and the map stops following the
 * phone for good. The node had a position — the Meshtastic app had written the
 * phone's into it earlier — and one such packet locked the browser out of a
 * map it had been drawing correctly a second before.
 *
 * So the question is not which source but which instrument:
 *
 * - A node that has seen a satellite wins. It is what the mesh knows about,
 *   and its fix is the one every peer is told about.
 * - A node repeating a typed-in place loses to a phone that is walking…
 * - …unless the phone is guessing too. A desktop's fix comes from an IP
 *   address and runs to kilometres, and then the typed-in place is the more
 *   accurate of the two — which is exactly the stationary device in
 *   mesh-heartbeat, sitting at a position somebody entered on purpose.
 *
 * @returns the fix to keep, which is `held` itself when nothing better arrived
 */
export function preferFix(held, next) {
  if (!held) return next ?? null;
  if (!next) return held;
  // Newer from the same instrument is simply newer.
  if (held.source === next.source) return next;

  // mesh-heartbeat also files a partner's position, under "peer". It never
  // reaches here, but a shared rule should not quietly treat one of those as
  // the node's own.
  if (held.source !== "node" && next.source !== "node") return next;

  const node = held.source === "node" ? held : next;
  const browser = held.source === "node" ? next : held;
  if (node.gps) return node;
  const guessing = !Number.isFinite(browser.accuracy) || browser.accuracy > VAGUE_METRES;
  return guessing ? node : browser;
}

/**
 * The browser's idea of where it is, for a node without a GPS.
 *
 * Returns an unsubscribe, like everything else that watches here.
 */
/**
 * How long to wait before saying "still looking" rather than nothing.
 *
 * Not a deadline: `watchPosition` keeps the watch alive after a timeout, so
 * this only buys the page something to show. It has to be generous — a phone
 * with no SIM has no assistance data, so the receiver reads the satellites'
 * own almanac and a cold fix is minutes rather than seconds.
 */
const SEARCHING_AFTER_MS = 20_000;

/**
 * The browser's own position, and — this is the part that was missing — what
 * it is doing when there is none.
 *
 * The error callback used to be empty, with a comment arguing that a refused
 * permission is not worth interrupting a ride for. That was right about not
 * interrupting and wrong about staying silent: reported from the field, the
 * page sat there with no position and no reason, through a tethered hotspot
 * and through no internet at all, and the one thing a rider could not find out
 * was whether anything was being asked of the receiver at all.
 *
 * So: `onTrouble` gets told, in the browser's own vocabulary.
 *
 * - `unsupported` — no Geolocation API here. On a page served over plain HTTP
 *   that is the whole story: it is a secure-context feature.
 * - `denied` (code 1) — the site is blocked. A gesture will not undo this; the
 *   browser's own site settings will.
 * - `unavailable` (code 2) — asked and nothing came back. Indoors without
 *   network location, this is the normal answer.
 * - `searching` (code 3) — the timeout above, which is a progress report
 *   rather than a failure. The watch continues.
 *
 * @param {(fix: Object) => void} onPosition
 * @param {Object} [options]
 * @param {Object} [options.geolocation] injectable, so this is testable
 * @param {(trouble: {kind: string, message: string}) => void} [options.onTrouble]
 * @returns {() => void} stop watching
 */
export function watchBrowserPosition(
  onPosition,
  { geolocation = null, onTrouble = () => {}, timeoutMs = SEARCHING_AFTER_MS } = {},
) {
  const geo = geolocation ?? globalThis.navigator?.geolocation ?? null;
  if (!geo) {
    onTrouble({ kind: "unsupported", message: "" });
    return () => {};
  }
  const id = geo.watchPosition(
    (fix) =>
      onPosition({
        lat: fix.coords.latitude,
        lon: fix.coords.longitude,
        at: fix.timestamp,
        // Metres, and the honest difference between a satellite fix and a
        // guess from a Wi-Fi network: one is single digits, the other is
        // hundreds. A rider measuring range needs to know which arrived.
        accuracy: Number.isFinite(fix.coords?.accuracy) ? fix.coords.accuracy : null,
        source: "browser",
      }),
    (error) => {
      const kind =
        error?.code === 1 ? "denied" : error?.code === 2 ? "unavailable" : "searching";
      onTrouble({ kind, message: error?.message ?? "" });
    },
    { enableHighAccuracy: true, maximumAge: 15_000, timeout: timeoutMs },
  );
  return () => geo.clearWatch(id);
}

/**
 * Ask once, from a click.
 *
 * Android is markedly more willing to show the permission prompt inside a
 * gesture than at page load, and a prompt that was dismissed rather than
 * answered leaves no trace a page can read — so there has to be a way to ask
 * again that does not mean reloading and losing the ride.
 */
export function askForPosition(onPosition, { geolocation = null, onTrouble = () => {} } = {}) {
  const geo = geolocation ?? globalThis.navigator?.geolocation ?? null;
  if (!geo) return onTrouble({ kind: "unsupported", message: "" });
  geo.getCurrentPosition(
    (fix) =>
      onPosition({
        lat: fix.coords.latitude,
        lon: fix.coords.longitude,
        at: fix.timestamp,
        accuracy: Number.isFinite(fix.coords?.accuracy) ? fix.coords.accuracy : null,
        source: "browser",
      }),
    (error) => {
      const kind =
        error?.code === 1 ? "denied" : error?.code === 2 ? "unavailable" : "searching";
      onTrouble({ kind, message: error?.message ?? "" });
    },
    { enableHighAccuracy: true, maximumAge: 0, timeout: 60_000 },
  );
}

/** Six decimals is about a tenth of a metre — more than a bicycle deserves. */
export const formatPosition = (p) =>
  p ? `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}` : "";

/**
 * The way back onto the wire, for the stationary device's one announcement.
 *
 * `Math.round`, where `@meshtastic/core` floors: this is a round trip through
 * our own decode, and rounding is what makes it one. The difference is a
 * centimetre, and the point is that `decode(encode(p))` is `p` rather than
 * almost.
 */
export function encodeNodePosition(position) {
  if (!position) return null;
  const { lat, lon } = position;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  const pair = [Math.round(lat / SCALE), Math.round(lon / SCALE)];
  // The same refusal as on the way in: 0/0 means "no fix" far more often than
  // it means the Gulf of Guinea, and a receiver cannot tell them apart.
  return pair[0] === 0 && pair[1] === 0 ? null : pair;
}

/**
 * How far apart two fixes are, in metres.
 *
 * Haversine on a sphere. The ellipsoid would be more correct by about a fifth
 * of a percent, which at the ranges this demo measures — hundreds of metres to
 * a few kilometres — is centimetres, and nothing here is accurate to
 * centimetres. What matters is that a point 800 m out and a point 3 km out are
 * plainly different numbers, and this gives that.
 */
export function distanceMetres(a, b) {
  if (!a || !b) return null;
  const R = 6_371_000;
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Metres under a kilometre, kilometres above it — what a rider reads at a glance. */
export const formatDistance = (m) =>
  m == null ? "" : m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(m < 10_000 ? 2 : 1)} km`;

/**
 * Which way from a to b, in degrees clockwise from north.
 *
 * For the arrow on a trail — two fixes are a direction — and for walking
 * towards somebody when the map tiles will not load, which in a wood is the
 * normal case rather than the exception.
 */
export function bearingDegrees(a, b) {
  if (!a || !b) return null;
  const toRad = Math.PI / 180;
  const φ1 = a.lat * toRad;
  const φ2 = b.lat * toRad;
  const Δλ = (b.lon - a.lon) * toRad;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (Math.atan2(y, x) / toRad + 360) % 360;
}

/** North, north-east, … — a word somebody can act on without a compass rose. */
export function compassPoint(degrees) {
  if (degrees == null) return "";
  const points = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return points[Math.round(degrees / 45) % 8];
}
