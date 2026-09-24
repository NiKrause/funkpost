// SPDX-License-Identifier: GPL-3.0-only
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { serialiseGattOperations } from "../lib/links/gatt-queue.js";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const execFile = promisify(execFileCb);

/**
 * Stand-in for the browser's characteristic: every call is recorded and stays
 * pending until the test settles it, which is what makes overlap observable.
 */
function fakeCharacteristic() {
  const calls = [];
  const method = (name) =>
    function (...args) {
      return new Promise((resolve, reject) => {
        calls.push({ name, args, resolve, reject, self: this });
      });
    };
  return {
    proto: {
      writeValue: method("writeValue"),
      readValue: method("readValue"),
      untouched: () => "not ours",
    },
    calls,
    /** How many have been started but not settled — i.e. actually concurrent. */
    inFlight: () => calls.filter((c) => !c.done).length,
    settle: (i, value = "ok") => {
      calls[i].done = true;
      calls[i].resolve(value);
    },
    reject: (i, message) => {
      calls[i].done = true;
      calls[i].reject(new Error(message));
    },
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("gatt queue", () => {
  test("a second operation does not start until the first has finished", async () => {
    const dev = fakeCharacteristic();
    const stop = serialiseGattOperations({ target: dev.proto });

    const a = dev.proto.readValue("first");
    const b = dev.proto.readValue("second");
    await tick();

    assert.equal(dev.calls.length, 1, "only the first one reached the radio");
    assert.equal(dev.calls[0].args[0], "first");

    dev.settle(0);
    await a;
    await tick();

    assert.equal(dev.calls.length, 2, "and the second goes once the first is done");
    assert.equal(dev.calls[1].args[0], "second");
    dev.settle(1);
    await b;
    stop();
  });

  test("the queue is shared across methods, since the radio is", async () => {
    const dev = fakeCharacteristic();
    const stop = serialiseGattOperations({ target: dev.proto });

    const a = dev.proto.readValue();
    const b = dev.proto.writeValue();
    await tick();

    assert.equal(dev.calls.length, 1, "a write must wait for a read as well");
    dev.settle(0);
    await a;
    await tick();
    assert.equal(dev.calls.length, 2);
    dev.settle(1);
    await b;
    stop();
  });

  test("one failure does not stop everything behind it", async () => {
    const dev = fakeCharacteristic();
    const stop = serialiseGattOperations({ target: dev.proto });

    const a = dev.proto.readValue("doomed");
    const b = dev.proto.readValue("after");
    await tick();

    dev.reject(0, "GATT operation failed for unknown reason.");
    await assert.rejects(a, /unknown reason/, "the caller still sees its own error");
    await tick();

    assert.equal(dev.calls.length, 2, "a dead read must not take the connection with it");
    dev.settle(1);
    assert.equal(await b, "ok");
    stop();
  });

  test("the caller gets its own result, and `this` survives", async () => {
    const dev = fakeCharacteristic();
    const stop = serialiseGattOperations({ target: dev.proto });
    const characteristic = Object.create(dev.proto);

    const a = characteristic.readValue();
    await tick();
    assert.equal(dev.calls[0].self, characteristic, "called on the characteristic, not the prototype");
    dev.settle(0, "the value");
    assert.equal(await a, "the value");
    stop();
  });

  test("nothing runs concurrently, however many are queued", async () => {
    const dev = fakeCharacteristic();
    const stop = serialiseGattOperations({ target: dev.proto });

    const all = Array.from({ length: 9 }, (_, i) => dev.proto.readValue(i));
    await tick();
    assert.equal(dev.inFlight(), 1, "nine deep is exactly what the field log showed");

    for (let i = 0; i < 9; i++) {
      dev.settle(i);
      await tick();
      assert.ok(dev.inFlight() <= 1, `still one at a time after ${i + 1}`);
    }
    await Promise.all(all);
    assert.equal(dev.calls.length, 9, "and all of them ran");
    stop();
  });

  test("a failure nobody handles is still reported as unhandled", async () => {
    // The queue must not quietly handle the caller's rejection. The Meshtastic
    // library does not await many of these, and the `unhandledrejection`
    // events they raise are what made the storm visible at all — a queue that
    // swallows them would hide the next bug like this one.
    //
    // In a child process, because an unhandled rejection inside the test
    // runner is a test failure: the very thing this asserts must happen.
    const script = `
      import { serialiseGattOperations } from "${pathToFileURL(resolve("lib/links/gatt-queue.js"))}";
      const proto = { readValue: () => Promise.reject(new Error("boom")) };
      serialiseGattOperations({ target: proto });
      proto.readValue();               // as the library calls it: not awaited
      process.on("unhandledRejection", (e) => {
        console.log("UNHANDLED:" + e.message);
        process.exit(0);
      });
      setTimeout(() => { console.log("SWALLOWED"); process.exit(0); }, 300);
    `;
    const { stdout } = await execFile(process.execPath, ["--input-type=module", "-e", script]);
    assert.match(stdout.trim(), /^UNHANDLED:boom$/, "the browser must still see the failure");
  });

  test("puts the originals back, and leaves other methods alone", () => {
    const dev = fakeCharacteristic();
    const before = { read: dev.proto.readValue, other: dev.proto.untouched };
    const stop = serialiseGattOperations({ target: dev.proto });
    assert.notEqual(dev.proto.readValue, before.read);
    assert.equal(dev.proto.untouched, before.other);
    stop();
    assert.equal(dev.proto.readValue, before.read);
  });

  test("does nothing where there is no Bluetooth", () => {
    const stop = serialiseGattOperations();
    assert.equal(typeof stop, "function");
    stop();
  });
});
