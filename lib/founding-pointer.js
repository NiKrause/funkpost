/**
 * The founding, off the radio.
 *
 * A peer that has never seen a database costs about two kilobytes of first
 * contact — manifest, access controller, identity, and every entry — which the
 * mesh pays for in seven frames or so, on a carrier that gives a village six
 * minutes of airtime an hour. The mesh should carry the *change*, not the
 * founding.
 *
 * So the founding goes another way. Whoever next has internet backs the
 * database up (one CAR, one CID) and beams **this message** over the radio:
 * version, tag, address, CID. Whoever receives it restores from that CID when
 * *they* next have internet — from a gateway, with no account of their own —
 * and from then on only deltas ever use the radio.
 *
 * If neither side ever touches the internet nothing changes: the mesh carries
 * the founding exactly as before. The pointer is an option, not a dependency.
 *
 * It rides the same courier as `courier-sync`, and the two cannot be confused:
 * courier-sync frames its messages behind a prefix byte (0 raw, 1 gzip) and
 * throws on anything else, while a dag-cbor map starts at 0xa0. Each side
 * drops the other's traffic without looking twice.
 */

import * as dagCbor from "@ipld/dag-cbor";

export const FOUNDING_POINTER_VERSION = 1;

const TYPE = "founding";
const TAG_LENGTH = 8;

/**
 * Encode a founding pointer.
 *
 * @param {Object} pointer
 * @param {Uint8Array} pointer.tag The database tag courier-sync addresses by
 *   (`databaseTag(address)`), so a receiver can tell which conversation this
 *   belongs to before it has the database.
 * @param {string} pointer.address The OrbitDB address the backup restores to
 * @param {string} pointer.cid The backup's metadata CID — the whole pointer:
 *   it names the CAR, and the CAR holds the blocks
 * @returns {Uint8Array} dag-cbor, ready for `courier.send`
 */
export function encodeFoundingPointer({ tag, address, cid }) {
  if (!(tag instanceof Uint8Array) || tag.length !== TAG_LENGTH) {
    throw new Error(`a founding pointer needs a ${TAG_LENGTH}-byte tag`);
  }
  if (typeof address !== "string" || address.length === 0) {
    throw new Error("a founding pointer needs the database address");
  }
  if (typeof cid !== "string" || cid.length === 0) {
    throw new Error("a founding pointer needs the backup's CID");
  }

  return dagCbor.encode({
    v: FOUNDING_POINTER_VERSION,
    t: TYPE,
    tag,
    addr: address,
    cid,
  });
}

/**
 * Read a founding pointer, or decide these bytes are not one.
 *
 * Returns `null` rather than throwing: on a shared carrier most of what
 * arrives belongs to somebody else, and that is not an error.
 *
 * @param {Uint8Array} bytes
 * @returns {{ tag: Uint8Array, address: string, cid: string } | null}
 */
export function decodeFoundingPointer(bytes) {
  let message;
  try {
    message = dagCbor.decode(bytes);
  } catch {
    return null; // courier-sync traffic, another app's, or a damaged frame
  }

  if (
    !message ||
    message.t !== TYPE ||
    message.v !== FOUNDING_POINTER_VERSION ||
    !(message.tag instanceof Uint8Array) ||
    message.tag.length !== TAG_LENGTH ||
    typeof message.addr !== "string" ||
    typeof message.cid !== "string"
  ) {
    return null;
  }

  return { tag: message.tag, address: message.addr, cid: message.cid };
}

/**
 * Does a pointer address the same database as this tag?
 *
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 * @returns {boolean}
 */
export function sameTag(a, b) {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array)) return false;
  if (a.length !== TAG_LENGTH || b.length !== TAG_LENGTH) return false;
  return a.every((byte, index) => byte === b[index]);
}
