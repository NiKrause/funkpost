// SPDX-License-Identifier: GPL-3.0-only
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { measureGattOverlap } from "../lib/links/gatt-probe.js";

/** A clock the test moves by hand. */
function fakeClock() {
  let at = 0;
  return { now: () => at, advance: (ms) => (at += ms) };
}

/**
 * Stand-in for BluetoothRemoteGATTCharacteristic.prototype: each method
 * returns a promise the test settles when it likes, which is what makes
 * overlapping possible at all.
 */
function fakeCharacteristic() {
  const pending = [];
  const make = () => {
    let settle;
    const start = () => new Promise((resolve, reject) => pending.push({ resolve, reject }));
    return start;
  };
  return {
    proto: {
      writeValue: make(),
      readValue: make(),
      startNotifications: make(),
      untouched: () => "not one of ours",
    },
    finish: (i = 0) => pending[i]?.resolve("done"),
    fail: (i, message) => pending[i]?.reject(new Error(message)),
  };
}

describe("gatt overlap probe", () => {
  test("names both sides when one operation starts while another runs", async () => {
    const lines = [];
    const clock = fakeClock();
    const dev = fakeCharacteristic();
    const stop = measureGattOverlap((l) => lines.push(l), { target: dev.proto, now: clock.now });

    const first = dev.proto.writeValue();
    clock.advance(40);
    const second = dev.proto.readValue();

    assert.equal(lines.length, 1, "the overlap is reported once, by the one that arrived second");
    assert.match(lines[0], /readValue starts while running/);
    assert.match(lines[0], /writeValue \(40ms\)/, "and says what it collided with, and for how long");

    dev.finish(0);
    dev.finish(1);
    await Promise.all([first, second]);
    stop();
  });

  test("says nothing about an operation that had the radio to itself", async () => {
    const lines = [];
    const dev = fakeCharacteristic();
    const stop = measureGattOverlap((l) => lines.push(l), { target: dev.proto, now: fakeClock().now });

    const one = dev.proto.writeValue();
    dev.finish(0);
    await one;
    const two = dev.proto.readValue();
    dev.finish(1);
    await two;

    assert.deepEqual(lines, [], "a phone publishes every line; a quiet run must stay quiet");
    stop();
  });

  test("reports a failure with its reason and how long it took", async () => {
    const lines = [];
    const clock = fakeClock();
    const dev = fakeCharacteristic();
    const stop = measureGattOverlap((l) => lines.push(l), { target: dev.proto, now: clock.now });

    const one = dev.proto.writeValue();
    clock.advance(17);
    dev.fail(0, "GATT operation already in progress.");
    await assert.rejects(one, /already in progress/, "the caller still sees its own error");

    assert.equal(lines.length, 1);
    assert.match(lines[0], /writeValue after 17ms: GATT operation already in progress/);
    stop();
  });

  test("a finished operation stops counting as running", async () => {
    const lines = [];
    const dev = fakeCharacteristic();
    const stop = measureGattOverlap((l) => lines.push(l), { target: dev.proto, now: fakeClock().now });

    const one = dev.proto.writeValue();
    dev.finish(0);
    await one;
    const two = dev.proto.readValue(); // no overlap: the first one is done
    dev.finish(1);
    await two;

    assert.deepEqual(lines, [], "otherwise every later operation reads as a clash");
    stop();
  });

  test("puts the originals back, and leaves other methods alone", () => {
    const dev = fakeCharacteristic();
    const before = { write: dev.proto.writeValue, other: dev.proto.untouched };
    const stop = measureGattOverlap(() => {}, { target: dev.proto, now: fakeClock().now });

    assert.notEqual(dev.proto.writeValue, before.write, "it is patched while measuring");
    assert.equal(dev.proto.untouched, before.other, "and nothing else is touched");

    stop();
    assert.equal(dev.proto.writeValue, before.write, "and restored afterwards");
  });

  test("does nothing at all where there is no Bluetooth", () => {
    // Node, or a browser without Web Bluetooth: it must not throw on the way in.
    const stop = measureGattOverlap(() => {
      throw new Error("must never be called");
    });
    assert.equal(typeof stop, "function");
    stop();
  });
});
