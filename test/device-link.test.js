// SPDX-License-Identifier: GPL-3.0-only
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createMeshtasticDeviceLink } from "../lib/links/meshtastic-device-link.js";

// A minimal fake MeshDevice: records sends, and lets us push private packets.
function fakeDevice() {
  const listeners = new Set();
  return {
    sent: [],
    async sendPacket(bytes) {
      this.sent.push(bytes);
    },
    events: {
      onPrivatePacket: {
        subscribe(fn) {
          listeners.add(fn);
          return () => listeners.delete(fn); // ste-style unsubscribe
        },
      },
    },
    emit(data, from = 0) {
      for (const fn of listeners) fn({ from, data });
    },
    listenerCount() {
      return listeners.size;
    },
  };
}

describe("device link rebind (reconnect survival)", () => {
  test("frames keep arriving after the underlying device is swapped", () => {
    const d1 = fakeDevice();
    const link = createMeshtasticDeviceLink({ device: d1, mtu: 200 });
    const got = [];
    link.onFrame((bytes) => got.push(bytes));
    assert.equal(d1.listenerCount(), 1);

    d1.emit(new Uint8Array([1]));
    assert.deepEqual(got.map((u) => [...u]), [[1]]);

    // Reconnect: a fresh device replaces the old one.
    const d2 = fakeDevice();
    link.rebind(d2);
    assert.equal(d1.listenerCount(), 0, "old device unsubscribed");
    assert.equal(d2.listenerCount(), 1, "new device subscribed");

    d2.emit(new Uint8Array([2]));
    assert.deepEqual(got.map((u) => [...u]), [[1], [2]]);
  });

  test("send() goes to the current (rebound) device", async () => {
    const d1 = fakeDevice();
    const link = createMeshtasticDeviceLink({ device: d1, mtu: 200 });
    await link.send(new Uint8Array([9]));
    assert.equal(d1.sent.length, 1);

    const d2 = fakeDevice();
    link.rebind(d2);
    await link.send(new Uint8Array([10]));
    assert.equal(d1.sent.length, 1, "old device gets no new sends");
    assert.equal(d2.sent.length, 1, "new device receives the send");
  });
});

describe("device link routing-error handling", () => {
  // A device whose sendPacket rejects with a Meshtastic queue {id, error}.
  const rejectingDevice = (errorCode) => ({
    async sendPacket() {
      throw { id: 1, error: errorCode };
    },
    events: { onPrivatePacket: { subscribe: () => () => {} } },
  });

  test("a 'no ack heard' routing error (MAX_RETRANSMIT) is swallowed, not thrown", async () => {
    // The ARQ, not the firmware ack, is the delivery authority on a broadcast.
    const link = createMeshtasticDeviceLink({ device: rejectingDevice(5), mtu: 200 });
    await link.send(new Uint8Array([1])); // must resolve, not reject
    for (const code of [3, 8]) {
      const l = createMeshtasticDeviceLink({ device: rejectingDevice(code), mtu: 200 });
      await l.send(new Uint8Array([1]));
    }
  });

  test("a hard routing error (NO_CHANNEL) still throws, named", async () => {
    const link = createMeshtasticDeviceLink({ device: rejectingDevice(6), mtu: 200 });
    await assert.rejects(() => link.send(new Uint8Array([1])), /radio refused the packet: NO_CHANNEL/);
  });
});
