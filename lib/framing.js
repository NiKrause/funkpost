// SPDX-License-Identifier: GPL-3.0-only
/**
 * Framing for discrete-message couriers: split a payload into fragments that
 * fit a mesh packet, survive loss, reordering and duplication, and reassemble
 * on the far side.
 *
 * This is the mesh-sized version of the seam libp2p-webrtc-qr's audio channel
 * framed first (payload id + index/total) — with a second frame type the
 * radio needs and a speaker does not: a STATUS frame carrying the receiver's
 * bitmap, so the sender retransmits exactly the fragments that are missing.
 *
 * Wire format, big-endian:
 *   DATA:   [ ver·type (1) | msgId (4) | idx (2) | total (2) | chunk … ]
 *   STATUS: [ ver·type (1) | msgId (4) | total (2) | bitmap (ceil(total/8)) ]
 * ver·type: high nibble protocol version (1), low nibble frame type.
 */

export const FRAMING_VERSION = 1;
export const DATA_HEADER_BYTES = 9;
export const STATUS_HEADER_BYTES = 7;

const TYPE_DATA = 0;
const TYPE_STATUS = 1;
const MAX_TOTAL = 0xffff;

/** Random 32-bit message id. */
export function randomMessageId() {
  const buf = new Uint8Array(4);
  globalThis.crypto.getRandomValues(buf);
  return ((buf[0] << 24) | (buf[1] << 16) | (buf[2] << 8) | buf[3]) >>> 0;
}

function writeHeader(frame, type, msgId) {
  frame[0] = ((FRAMING_VERSION & 0x0f) << 4) | (type & 0x0f);
  frame[1] = (msgId >>> 24) & 0xff;
  frame[2] = (msgId >>> 16) & 0xff;
  frame[3] = (msgId >>> 8) & 0xff;
  frame[4] = msgId & 0xff;
}

/**
 * Split a payload into DATA frames no longer than `mtu` bytes each.
 * @param {Uint8Array} payload
 * @param {{ mtu: number, msgId?: number }} options
 * @returns {{ msgId: number, total: number, frames: Array<Uint8Array> }}
 */
export function fragmentPayload(payload, { mtu, msgId = randomMessageId() } = {}) {
  if (!(payload instanceof Uint8Array)) throw new Error("payload must be a Uint8Array");
  if (!Number.isInteger(mtu) || mtu <= DATA_HEADER_BYTES) {
    throw new Error(`mtu must exceed the ${DATA_HEADER_BYTES}-byte DATA header`);
  }
  const chunkSize = mtu - DATA_HEADER_BYTES;
  const total = Math.max(1, Math.ceil(payload.length / chunkSize));
  if (total > MAX_TOTAL) throw new Error(`payload needs ${total} fragments; max is ${MAX_TOTAL}`);

  const frames = [];
  for (let idx = 0; idx < total; idx++) {
    const chunk = payload.subarray(idx * chunkSize, Math.min((idx + 1) * chunkSize, payload.length));
    const frame = new Uint8Array(DATA_HEADER_BYTES + chunk.length);
    writeHeader(frame, TYPE_DATA, msgId);
    frame[5] = (idx >>> 8) & 0xff;
    frame[6] = idx & 0xff;
    frame[7] = (total >>> 8) & 0xff;
    frame[8] = total & 0xff;
    frame.set(chunk, DATA_HEADER_BYTES);
    frames.push(frame);
  }
  return { msgId, total, frames };
}

/**
 * Encode a STATUS frame: the receiver's map of which fragments have arrived.
 * @param {number} msgId
 * @param {number} total
 * @param {Set<number>} received Fragment indexes seen so far
 * @returns {Uint8Array}
 */
export function encodeStatus(msgId, total, received) {
  const bitmapBytes = Math.ceil(total / 8);
  const frame = new Uint8Array(STATUS_HEADER_BYTES + bitmapBytes);
  writeHeader(frame, TYPE_STATUS, msgId);
  frame[5] = (total >>> 8) & 0xff;
  frame[6] = total & 0xff;
  for (const idx of received) {
    if (idx >= 0 && idx < total) frame[STATUS_HEADER_BYTES + (idx >> 3)] |= 1 << (idx & 7);
  }
  return frame;
}

/**
 * Decode any frame. Returns null for bytes that are not ours (wrong version,
 * malformed, truncated) — a shared radio channel carries other traffic.
 * @param {Uint8Array} bytes
 * @returns {{ type: "data", msgId, idx, total, chunk } | { type: "status", msgId, total, received: Set<number> } | null}
 */
export function decodeFrame(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 1) return null;
  if (bytes[0] >>> 4 !== FRAMING_VERSION) return null;
  const type = bytes[0] & 0x0f;
  if (bytes.length < 5) return null;
  const msgId = ((bytes[1] << 24) | (bytes[2] << 16) | (bytes[3] << 8) | bytes[4]) >>> 0;

  if (type === TYPE_DATA) {
    if (bytes.length < DATA_HEADER_BYTES) return null;
    const idx = (bytes[5] << 8) | bytes[6];
    const total = (bytes[7] << 8) | bytes[8];
    if (total < 1 || idx >= total) return null;
    return { type: "data", msgId, idx, total, chunk: bytes.subarray(DATA_HEADER_BYTES) };
  }

  if (type === TYPE_STATUS) {
    if (bytes.length < STATUS_HEADER_BYTES) return null;
    const total = (bytes[5] << 8) | bytes[6];
    if (total < 1 || bytes.length < STATUS_HEADER_BYTES + Math.ceil(total / 8)) return null;
    const received = new Set();
    for (let idx = 0; idx < total; idx++) {
      if (bytes[STATUS_HEADER_BYTES + (idx >> 3)] & (1 << (idx & 7))) received.add(idx);
    }
    return { type: "status", msgId, total, received };
  }

  return null;
}

/**
 * Reassembles DATA frames into payloads. Keeps completed message ids for a
 * while, so a retransmitted fragment of an already-delivered message is
 * answered (kind "duplicate-complete") instead of delivered twice — the
 * courier replies with a full STATUS, which is the acknowledgement that got
 * lost the first time.
 *
 * @param {{ ttlMs?: number, now?: () => number }} [options]
 */
export function createReassembler({ ttlMs = 5 * 60_000, now = Date.now } = {}) {
  const pending = new Map(); // msgId -> { total, chunks: Map<idx, Uint8Array>, touched }
  const completed = new Map(); // msgId -> { total, touched }

  const prune = () => {
    const cutoff = now() - ttlMs;
    for (const [id, state] of pending) if (state.touched < cutoff) pending.delete(id);
    for (const [id, state] of completed) if (state.touched < cutoff) completed.delete(id);
  };

  return {
    /**
     * @param {{ msgId, idx, total, chunk }} frame A decoded DATA frame
     * @returns {{ kind: "complete", msgId, total, payload: Uint8Array }
     *   | { kind: "duplicate-complete", msgId, total }
     *   | { kind: "partial", msgId, total, received: Set<number> }}
     */
    push(frame) {
      prune();
      const { msgId, idx, total, chunk } = frame;

      const done = completed.get(msgId);
      if (done) {
        done.touched = now();
        return { kind: "duplicate-complete", msgId, total: done.total };
      }

      let state = pending.get(msgId);
      if (!state || state.total !== total) {
        state = { total, chunks: new Map(), touched: now() };
        pending.set(msgId, state);
      }
      state.touched = now();
      if (!state.chunks.has(idx)) state.chunks.set(idx, chunk);

      if (state.chunks.size < total) {
        return { kind: "partial", msgId, total, received: new Set(state.chunks.keys()) };
      }

      let length = 0;
      for (const part of state.chunks.values()) length += part.length;
      const payload = new Uint8Array(length);
      let offset = 0;
      for (let i = 0; i < total; i++) {
        const part = state.chunks.get(i);
        payload.set(part, offset);
        offset += part.length;
      }
      pending.delete(msgId);
      completed.set(msgId, { total, touched: now() });
      return { kind: "complete", msgId, total, payload };
    },

    /** Received-so-far map for a pending message, for gap-timeout STATUS frames. */
    received(msgId) {
      const state = pending.get(msgId);
      return state ? { total: state.total, received: new Set(state.chunks.keys()) } : null;
    },

    pendingIds() {
      return [...pending.keys()];
    },
  };
}
