// SPDX-License-Identifier: GPL-3.0-only
/**
 * Every demo that connects a radio gets one Bluetooth operation at a time.
 *
 * mesh-todo paid for this twice — once to find it (#153) and once to learn
 * that a flag nobody sets is not a fix (#160) — and then kept it to itself.
 * mesh-calendar and mesh-heartbeat connect the same radio through the same
 * shared connector (#182) and had none of it: on Android Chrome the
 * connection sequence's unawaited reads race, the loser fails, the transport
 * reports a failed operation as a disconnection, and the link appears to drop
 * and reconnect forever.
 *
 * The wiring is what these tests are about. The queue itself is covered by
 * gatt-queue.test.js; what was missing was the call.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyGattQueue, connectCourier } from "@le-space/funkpost-radio";

/** A stand-in for the browser's characteristic prototype. */
function stubPrototype() {
  return {
    readValue: function readValue() {},
    writeValue: function writeValue() {},
    startNotifications: function startNotifications() {},
  };
}

test("patches the browser's own methods, and puts them back", () => {
  const proto = stubPrototype();
  const original = proto.readValue;

  const stop = applyGattQueue({ target: proto });
  assert.ok(stop, "it applied");
  assert.notEqual(proto.readValue, original, "readValue goes through the queue");

  stop();
  assert.equal(proto.readValue, original, "and comes back afterwards");
});

test("never patches twice — a queue wrapping a queue is not a queue", () => {
  const proto = stubPrototype();
  const stop = applyGattQueue({ target: proto });
  const queued = proto.readValue;

  const second = applyGattQueue({ target: stubPrototype() });
  assert.equal(second, null, "the second caller is told it was already on");
  assert.equal(proto.readValue, queued, "and nothing was wrapped again");

  stop();
});

test("?gattq=0 leaves the browser alone", () => {
  const proto = stubPrototype();
  const original = proto.readValue;

  assert.equal(applyGattQueue({ target: proto, search: "?gattq=0" }), null);
  assert.equal(proto.readValue, original);

  // …and the way out does not stick: a reload without it queues again.
  const stop = applyGattQueue({ target: proto, search: "?every=2" });
  assert.ok(stop);
  stop();
});

test("connecting a radio applies it, without the page asking", async () => {
  // The failure this pins: `startNotifications` is the transport's first act,
  // and a page whose subscribe lost the race transmits perfectly and never
  // hears an answer.
  const proto = stubPrototype();
  const original = proto.startNotifications;
  globalThis.BluetoothRemoteGATTCharacteristic = { prototype: proto };

  const sentinel = new Error("no chooser in a test");
  // `navigator` is a getter-only global in current Node, so it is defined over
  // rather than assigned — and put back at the end.
  const hadNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      bluetooth: {
        requestDevice: () => {
          throw sentinel;
        },
      },
    },
  });

  let told = false;
  await assert.rejects(
    connectCourier({ mode: { kind: "ble" }, onGattQueue: () => (told = true) }),
    (e) => e === sentinel,
    "the stub chooser is as far as this gets",
  );

  assert.notEqual(proto.startNotifications, original, "the queue was applied on the way");
  assert.ok(told, "and the page is told, so a field log can show it");

  delete globalThis.BluetoothRemoteGATTCharacteristic;
  if (hadNavigator) Object.defineProperty(globalThis, "navigator", hadNavigator);
  else delete globalThis.navigator;
});
