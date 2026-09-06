// SPDX-License-Identifier: GPL-3.0-only
/**
 * The capability key behind the "change or cancel" link.
 *
 * The `.ics` a customer downloads carries a link with a token in its fragment.
 * The naive design makes that token a *password* — know it, cancel the booking
 * — which on a shared broadcast channel is worthless: every neighbour in radio
 * range watched the booking go past and could replay it.
 *
 * So the token is a **seed**, not a secret to be shown. It derives an Ed25519
 * key pair; the booking carries only the public half, and a cancellation must
 * be *signed*. Overhearing a booking therefore proves nothing and grants
 * nothing. The token itself never crosses the air — it lives in the URL
 * fragment, which browsers do not send anywhere.
 *
 * What this does **not** do: make a public channel private. Everyone still
 * *sees* the booking. Confidentiality needs a private Meshtastic channel, and
 * the UI says so.
 *
 * Pure WebCrypto, so the same code runs in the browser and in Node ≥ 20.
 */

/** The fixed ASN.1 wrapper that turns a raw 32-byte Ed25519 seed into PKCS#8. */
const PKCS8_ED25519_PREFIX = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

const ALGORITHM = { name: "Ed25519" };
const subtle = () => globalThis.crypto.subtle;

export const TOKEN_BYTES = 32;
export const SIGNATURE_BYTES = 64;
export const PUBLIC_KEY_BYTES = 32;

/** URL-safe base64, so a token survives being pasted into a calendar note. */
export function toBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(text) {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/** A fresh capability token. This is the only secret in the system. */
export function newToken() {
  return globalThis.crypto.getRandomValues(new Uint8Array(TOKEN_BYTES));
}

/**
 * Derive the key pair a token stands for. Deterministic: the same token always
 * yields the same keys, which is what lets the link work months later on a
 * device that has never seen the booking.
 *
 * @param {Uint8Array} token
 * @returns {Promise<{ publicKey: Uint8Array, sign: (bytes: Uint8Array) => Promise<Uint8Array> }>}
 */
export async function keysFromToken(token) {
  if (!(token instanceof Uint8Array) || token.length !== TOKEN_BYTES) {
    throw new Error(`a capability token is ${TOKEN_BYTES} bytes`);
  }
  const pkcs8 = new Uint8Array(PKCS8_ED25519_PREFIX.length + TOKEN_BYTES);
  pkcs8.set(PKCS8_ED25519_PREFIX, 0);
  pkcs8.set(token, PKCS8_ED25519_PREFIX.length);

  // Extractable, because the public half is read back out of the JWK — the one
  // portable way to get it without a Node-only crypto import.
  const privateKey = await subtle().importKey("pkcs8", pkcs8, ALGORITHM, true, ["sign"]);
  const jwk = await subtle().exportKey("jwk", privateKey);
  const publicKey = fromBase64Url(jwk.x);

  return {
    publicKey,
    async sign(bytes) {
      return new Uint8Array(await subtle().sign(ALGORITHM, privateKey, bytes));
    },
  };
}

/**
 * The exact bytes a signature covers. Canonical and unambiguous on purpose:
 * the booking id, the action and the timestamp are joined with a separator
 * that cannot appear in an id, so no two different actions can produce the
 * same message.
 */
export function actionMessage({ bookingId, action, at }) {
  return new TextEncoder().encode(`funkpost/v1\n${action}\n${bookingId}\n${at}`);
}

/**
 * @param {Uint8Array} publicKey The key stored on the booking
 * @param {Uint8Array} signature
 * @param {Object} action `{ bookingId, action, at }`
 * @returns {Promise<boolean>} never throws — a malformed key or signature is
 *   simply not a valid one, and a verifier that throws is a denial of service
 */
export async function verifyAction(publicKey, signature, action) {
  try {
    if (!(publicKey instanceof Uint8Array) || publicKey.length !== PUBLIC_KEY_BYTES) return false;
    if (!(signature instanceof Uint8Array) || signature.length !== SIGNATURE_BYTES) return false;
    const key = await subtle().importKey("raw", publicKey, ALGORITHM, false, ["verify"]);
    return await subtle().verify(ALGORITHM, key, signature, actionMessage(action));
  } catch {
    return false;
  }
}

/**
 * Keep only the cancellations that are genuinely signed by the booking's own
 * key. Everything downstream — arbitration especially — trusts what it is
 * handed, so this is where that trust is earned.
 *
 * @param {Iterable<Object>} requests bookings carrying `publicKey`
 * @param {Map<string, Object>} cancels id → `{ at, sig }`
 * @returns {Promise<Map<string, Object>>} the verified subset
 */
export async function verifiedCancels(requests, cancels) {
  const keys = new Map([...requests].map((r) => [r.id, r.publicKey]));
  const out = new Map();
  for (const [bookingId, cancel] of cancels) {
    const publicKey = keys.get(bookingId);
    if (!publicKey) continue; // a cancellation for a booking nobody has
    const ok = await verifyAction(publicKey, cancel.sig, {
      bookingId,
      action: "cancel",
      at: cancel.at,
    });
    if (ok) out.set(bookingId, cancel);
  }
  return out;
}
