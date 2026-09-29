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
  };
}

/**
 * The browser's idea of where it is, for a node without a GPS.
 *
 * Returns an unsubscribe, like everything else that watches here.
 */
export function watchBrowserPosition(onPosition, { geolocation = null } = {}) {
  const geo = geolocation ?? globalThis.navigator?.geolocation ?? null;
  if (!geo) return () => {};
  const id = geo.watchPosition(
    (fix) =>
      onPosition({
        lat: fix.coords.latitude,
        lon: fix.coords.longitude,
        at: fix.timestamp,
        source: "browser",
      }),
    // A refused permission is not an error worth interrupting a ride for: the
    // track simply records beats without a place, and says so.
    () => {},
    { enableHighAccuracy: true, maximumAge: 15_000 },
  );
  return () => geo.clearWatch(id);
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
