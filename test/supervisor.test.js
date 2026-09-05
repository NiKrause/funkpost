// SPDX-License-Identifier: GPL-3.0-only
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  connectMeshtasticDevice,
  defaultBackoff,
} from "../lib/links/meshtastic-supervisor.js";
import {
  routingErrorName,
  describeMeshtasticError,
} from "../lib/links/meshtastic-device-link.js";

const settle = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

const until = async (fn, timeoutMs = 3000, stepMs = 2) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  throw new Error("condition not reached in time");
};

/** A dispatcher shaped like the one @meshtastic/core hands out. */
const dispatcher = (log, name) => {
  const handlers = new Set();
  return {
    subscribe(handler) {
      log?.push(`subscribe:${name}`);
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    emit(value) {
      for (const handler of [...handlers]) handler(value);
    },
    get size() {
      return handlers.size;
    },
  };
};

/**
 * A MeshDevice that never touches a radio — enough surface for the supervisor
 * to attach to, and enough instrumentation to assert what it did in what order.
 */
const stubDevice = (log = []) => {
  const events = {
    onDeviceStatus: dispatcher(log, "status"),
    onConfigPacket: dispatcher(log, "config"),
    onTelemetryPacket: dispatcher(log, "telemetry"),
    onNodeInfoPacket: dispatcher(log, "nodeInfo"),
    onChannelPacket: dispatcher(log, "channel"),
    onMyNodeInfo: dispatcher(log, "myNodeInfo"),
    onPrivatePacket: dispatcher(log, "private"),
  };
  const device = {
    events,
    log,
    disconnected: false,
    heartbeatMs: null,
    configured: 0,
    setHeartbeatInterval(ms) {
      device.heartbeatMs = ms;
    },
    configure() {
      log.push("configure");
      device.configured++;
      return Promise.resolve();
    },
    disconnect() {
      log.push("disconnect");
      device.disconnected = true;
      return Promise.resolve();
    },
    sendPacket() {
      return Promise.resolve();
    },
    /** Pretend the OS dropped the GATT link. */
    drop() {
      events.onDeviceStatus.emit(2); // 2 = disconnected
    },
  };
  return device;
};

/** A factory handing out fresh stubs, remembering every one it made. */
const deviceFactory = () => {
  const made = [];
  const log = [];
  return {
    made,
    log,
    create: async () => {
      const device = stubDevice(log);
      made.push(device);
      return device;
    },
  };
};

const FAST = { backoff: () => 1, stableMs: 30 };

describe("meshtastic supervisor", () => {
  test("subscribes every watcher BEFORE configure()", async () => {
    const factory = deviceFactory();
    const managed = await connectMeshtasticDevice({ createDevice: factory.create, ...FAST });

    const configureAt = factory.log.indexOf("configure");
    assert.ok(configureAt > 0, "configure() ran");
    const subscribesBefore = factory.log.slice(0, configureAt).filter((l) => l.startsWith("subscribe:"));
    const subscribesAfter = factory.log.slice(configureAt).filter((l) => l.startsWith("subscribe:"));
    assert.equal(subscribesAfter.length, 0, "no watcher may attach after configure()");
    assert.ok(subscribesBefore.length >= 6, `only ${subscribesBefore.length} watchers attached first`);

    managed.close();
  });

  test("sets the heartbeat, so an idle GATT link is not dropped", async () => {
    const factory = deviceFactory();
    const managed = await connectMeshtasticDevice({
      createDevice: factory.create,
      heartbeatMs: 12_345,
      ...FAST,
    });
    assert.equal(factory.made[0].heartbeatMs, 12_345);
    managed.close();
  });

  test("tears the old device down BEFORE opening a new one", async () => {
    const factory = deviceFactory();
    const managed = await connectMeshtasticDevice({ createDevice: factory.create, ...FAST });

    factory.made[0].drop();
    await until(() => factory.made.length === 2);

    // The order that matters: the dying device's disconnect() must complete
    // before a second connection to the same radio is opened, or the phone
    // answers with "GATT operation already in progress".
    assert.ok(factory.made[0].disconnected, "old device was disconnected");
    const disconnectAt = factory.log.indexOf("disconnect");
    const secondConfigureAt = factory.log.indexOf("configure", factory.log.indexOf("configure") + 1);
    assert.ok(disconnectAt >= 0 && disconnectAt < secondConfigureAt, "disconnect came first");

    managed.close();
  });

  test("a replaced device's events are ignored — no zombie reconnects", async () => {
    const factory = deviceFactory();
    const statuses = [];
    const managed = await connectMeshtasticDevice({
      createDevice: factory.create,
      on: { status: (name) => statuses.push(name) },
      ...FAST,
    });

    factory.made[0].drop();
    await until(() => factory.made.length === 2);
    await settle(20);

    const before = factory.made.length;
    const seen = statuses.length;
    // The zombie speaks: every past generation still holds a live dispatcher.
    factory.made[0].drop();
    factory.made[0].drop();
    await settle(30);

    assert.equal(factory.made.length, before, "a replaced device must not drive a reconnect");
    assert.equal(statuses.length, seen, "a replaced device must not report status either");

    managed.close();
  });

  test("backs off, and only resets once the link has STAYED up", async () => {
    const factory = deviceFactory();
    const attemptsSeen = [];
    const managed = await connectMeshtasticDevice({
      createDevice: factory.create,
      backoff: (attempt) => {
        attemptsSeen.push(attempt);
        return 1;
      },
      stableMs: 10_000, // never reached in this test
      on: {},
    });

    // Three drops in a row, each immediately after reconnecting: the attempt
    // counter must climb, not reset, because the link never stayed up.
    for (let i = 0; i < 3; i++) {
      const current = factory.made[factory.made.length - 1];
      current.drop();
      await until(() => factory.made.length === i + 2);
    }
    assert.deepEqual(attemptsSeen, [1, 2, 3]);

    managed.close();
  });

  test("resets the backoff after the link holds for stableMs", async () => {
    const factory = deviceFactory();
    const attemptsSeen = [];
    const managed = await connectMeshtasticDevice({
      createDevice: factory.create,
      backoff: (attempt) => {
        attemptsSeen.push(attempt);
        return 1;
      },
      stableMs: 15,
    });

    factory.made[0].drop();
    await until(() => factory.made.length === 2);
    await settle(45); // longer than stableMs — the link is called healthy

    factory.made[1].drop();
    await until(() => factory.made.length === 3);

    assert.deepEqual(attemptsSeen, [1, 1], "a stable stretch resets the counter");
    managed.close();
  });

  test("gives up at the cap instead of looping forever", async () => {
    let calls = 0;
    const gaveUp = [];
    const created = [];
    const createDevice = async () => {
      calls++;
      if (calls > 1) throw new Error("gatt.connect failed"); // the Fold, faithfully
      const device = stubDevice(created);
      created.device = device;
      return device;
    };

    const managed = await connectMeshtasticDevice({
      createDevice,
      maxAttempts: 3,
      backoff: () => 1,
      on: { gaveUp: (n) => gaveUp.push(n) },
    });

    created.device.drop();
    await until(() => gaveUp.length === 1);
    const callsAtGiveUp = calls;
    await settle(40);

    assert.equal(gaveUp[0], 3, "reports how many attempts were made");
    assert.equal(calls, callsAtGiveUp, "nothing is retried after giving up");
    managed.close();
  });

  test("rebinds the link, so frames from the NEW device still arrive", async () => {
    const factory = deviceFactory();
    const managed = await connectMeshtasticDevice({ createDevice: factory.create, ...FAST });
    const frames = [];
    managed.link.onFrame((bytes) => frames.push(bytes));

    factory.made[0].events.onPrivatePacket.emit({ from: 1, data: new Uint8Array([1]) });
    factory.made[0].drop();
    await until(() => factory.made.length === 2);
    await settle(10);

    factory.made[1].events.onPrivatePacket.emit({ from: 1, data: new Uint8Array([2]) });
    await until(() => frames.length === 2);
    assert.deepEqual([...frames[1]], [2], "the reconnected device's frames reach the courier");

    managed.close();
  });

  test("close() ends supervision — a later drop reconnects nothing", async () => {
    const factory = deviceFactory();
    const managed = await connectMeshtasticDevice({ createDevice: factory.create, ...FAST });

    managed.close();
    factory.made[0].drop();
    await settle(30);

    assert.equal(factory.made.length, 1);
  });

  test("feeds region and airtime straight into a courier it built", async () => {
    const factory = deviceFactory();
    const regions = [];
    const airtimes = [];
    const managed = await connectMeshtasticDevice({
      createDevice: factory.create,
      createCourier: () => ({
        setRegion: (name) => regions.push(name),
        reconcileNodeAirtime: (value) => airtimes.push(value),
      }),
      ...FAST,
    });

    // The config stream arrives after configure() — the race the supervisor
    // exists to win. region 3 = EU_868 in the firmware enum.
    factory.made[0].events.onConfigPacket.emit({
      payloadVariant: { case: "lora", value: { region: 3 } },
    });
    factory.made[0].events.onTelemetryPacket.emit({
      data: { variant: { case: "deviceMetrics", value: { airUtilTx: 4.5 } } },
    });

    assert.deepEqual(regions, ["EU_868"]);
    assert.deepEqual(airtimes, [4.5]);
    assert.ok(managed.courier, "the courier is returned alongside the link");

    managed.close();
  });

  test("a throwing UI callback does not take the radio down", async () => {
    const factory = deviceFactory();
    const errors = [];
    const managed = await connectMeshtasticDevice({
      createDevice: factory.create,
      on: {
        status: () => {
          throw new Error("the sync pane blew up");
        },
        error: (e) => errors.push(e),
      },
      ...FAST,
    });

    factory.made[0].events.onDeviceStatus.emit(7); // configured
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /sync pane/);

    managed.close();
  });

  test("requires a createDevice factory", async () => {
    await assert.rejects(() => connectMeshtasticDevice({}), /createDevice/);
  });

  test("defaultBackoff climbs and then holds at 15 s", () => {
    assert.deepEqual(
      [1, 2, 3, 4, 5, 6, 9].map(defaultBackoff),
      [1000, 2000, 4000, 8000, 15_000, 15_000, 15_000],
    );
  });
});

describe("meshtastic error names", () => {
  test("names routing codes from the firmware enum", () => {
    assert.equal(routingErrorName(0), "NONE");
    assert.equal(routingErrorName(5), "MAX_RETRANSMIT");
    assert.equal(routingErrorName(6), "NO_CHANNEL");
    assert.equal(routingErrorName(33), "NOT_AUTHORIZED");
  });

  test("survives a code this firmware build does not know", () => {
    assert.equal(routingErrorName(9999), "routing 9999");
    assert.equal(routingErrorName("nope"), null);
  });

  test("reads the queue rejection that has no .message", () => {
    // The shape that printed "[object Object]" and hid the cause for an evening.
    assert.equal(describeMeshtasticError({ id: 42, error: 3 }), "TIMEOUT (packet 42)");
    assert.equal(describeMeshtasticError({ error: 5 }), "MAX_RETRANSMIT");
  });

  test("unwraps a browser error event, and handles the ordinary cases", () => {
    assert.equal(describeMeshtasticError({ reason: new Error("boom") }), "boom");
    assert.equal(describeMeshtasticError({ reason: { id: 7, error: 6 } }), "NO_CHANNEL (packet 7)");
    assert.equal(describeMeshtasticError(new Error("plain")), "plain");
    assert.equal(describeMeshtasticError("a string"), "a string");
    assert.equal(describeMeshtasticError(null), "null");
    assert.equal(describeMeshtasticError({ odd: true }), '{"odd":true}');
  });

  test("does not throw on a circular object", () => {
    const circular = { a: 1 };
    circular.self = circular;
    assert.equal(typeof describeMeshtasticError(circular), "string");
  });
});
