// SPDX-License-Identifier: GPL-3.0-only
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { fragmentPayload } from "../lib/framing.js";
import {
  encodeFoundingPointer,
  decodeFoundingPointer,
  sameTag,
  FOUNDING_POINTER_VERSION,
} from "../lib/founding-pointer.js";

// A real OrbitDB address and a real CID, at the lengths they actually have:
// the whole point of this message is its size, so the fixture may not be short.
const ADDRESS = "/orbitdb/zdpuB2rhHeykxLvtwpMHRPsQsUmwjYMBETL2ZVQHb9WdkN6hH";
const CID = "QmXxXxd4sCni9M7YqAv81s25PCEfHAbTxpYePWYGb2AvvN";
const TAG = Uint8Array.from([0x9a, 0x1f, 0x00, 0x7c, 0xd3, 0x44, 0xb1, 0x0e]);

describe("founding pointer", () => {
  test("crosses in one frame", () => {
    const bytes = encodeFoundingPointer({ tag: TAG, address: ADDRESS, cid: CID });

    // The gate of P9, counted rather than estimated: at the default 200-byte
    // MTU a frame carries 191 bytes of payload. First contact without a
    // pointer is ~2 KB, about seven frames.
    const { frames, total } = fragmentPayload(bytes, { mtu: 200 });
    assert.equal(total, 1, `pointer is ${bytes.length} bytes, needs ${total} frames`);
    assert.equal(frames.length, 1);
    assert.ok(bytes.length <= 191, `pointer is ${bytes.length} bytes`);
  });

  test("round-trips address, CID and tag", () => {
    const bytes = encodeFoundingPointer({ tag: TAG, address: ADDRESS, cid: CID });
    const pointer = decodeFoundingPointer(bytes);

    assert.equal(pointer.address, ADDRESS);
    assert.equal(pointer.cid, CID);
    assert.ok(sameTag(pointer.tag, TAG));
  });

  test("is not confused with courier-sync traffic, in either direction", () => {
    // courier-sync frames its messages behind a prefix byte: 0 raw, 1 gzip.
    const courierSyncRaw = Uint8Array.from([0, 0xa1, 0x61, 0x76, 0x01]);
    const courierSyncGzip = Uint8Array.from([1, 0x1f, 0x8b, 0x08, 0x00]);
    assert.equal(decodeFoundingPointer(courierSyncRaw), null);
    assert.equal(decodeFoundingPointer(courierSyncGzip), null);

    // And a pointer starts with a dag-cbor map header, which courier-sync's
    // unframe rejects as an unknown prefix.
    const pointer = encodeFoundingPointer({ tag: TAG, address: ADDRESS, cid: CID });
    assert.ok(pointer[0] >= 0xa0 && pointer[0] <= 0xbf);
  });

  test("refuses to read a pointer from another version or shape", () => {
    assert.equal(decodeFoundingPointer(Uint8Array.from([0xff, 0xff])), null);
    assert.equal(decodeFoundingPointer(new Uint8Array(0)), null);

    const wrongVersion = encodeFoundingPointer({ tag: TAG, address: ADDRESS, cid: CID });
    // Flip the version field's value byte: v is the first entry of the map.
    const index = wrongVersion.indexOf(FOUNDING_POINTER_VERSION);
    assert.ok(index > 0);
    wrongVersion[index] = FOUNDING_POINTER_VERSION + 1;
    assert.equal(decodeFoundingPointer(wrongVersion), null);
  });

  test("will not encode a pointer that cannot be acted on", () => {
    assert.throws(() => encodeFoundingPointer({ tag: TAG, address: "", cid: CID }));
    assert.throws(() => encodeFoundingPointer({ tag: TAG, address: ADDRESS, cid: "" }));
    assert.throws(() =>
      encodeFoundingPointer({ tag: new Uint8Array(4), address: ADDRESS, cid: CID }),
    );
  });
});
