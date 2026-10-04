// SPDX-License-Identifier: GPL-3.0-only
/**
 * Connecting a radio, once, for every demo that needs one.
 *
 * This was written twice — mesh-todo and mesh-calendar each carried their own
 * copy, near enough identical that `txChannel` appeared 21 times in one and 20
 * in the other. That is the part of these apps with the most expensive history:
 * the GATT storm that looked like a flapping link (#153), a channel selection
 * that "fails silently when it is wrong", a region that comes back UNSET after
 * an import, the reconnect supervisor. Three copies of that is three places to
 * fix each of them.
 *
 * mesh-heartbeat (#180) is what forced the question and also answers it: it
 * needs no database at all, so whatever *it* needs is the honest shared
 * minimum rather than a seam guessed from two apps that both happen to carry
 * OrbitDB or Yjs.
 *
 * The shape is mesh-todo's, deliberately. It hands back a courier and gets out
 * of the way; mesh-calendar's version wove its Yjs provider and booking book
 * into the connector, which is why that one could not be shared.
 *
 * Plain JavaScript and no components, like `@le-space/funkpost-brand` beside
 * it: what has bugs here is the connecting, not the rendering, and every demo
 * draws its radio panel differently anyway.
 */
import {
  createMeshtasticCourier,
  connectMeshtasticDevice,
  describeMeshtasticError,
} from "@le-space/funkpost";
import { serialiseGattOperations } from "@le-space/funkpost/links/gatt-queue";
import { measureGattOverlap } from "@le-space/funkpost/links/gatt-probe";
import { createBroadcastChannelLink } from "./fake-bc-link.js";

/** The Meshtastic BLE service, which is how the chooser knows what to offer. */
export const MESHTASTIC_BLE_SERVICE = "6ba1b218-15a8-461f-9fa8-5dcae273eafd";

/**
 * One Bluetooth operation at a time — the fix that belongs to every demo.
 *
 * It was found and paid for in mesh-todo (#153, #160): Android Chrome allows a
 * single GATT operation, the Meshtastic connection sequence reads the node's
 * configuration without awaiting each read, and the loser of every race fails
 * with "GATT operation already in progress". The transport reports a failed
 * operation as a **disconnection**, so the supervisor repairs a link that
 * never broke — 121 failures a minute on one phone, measured, and a link that
 * drops continuously.
 *
 * It lived in mesh-todo's page, which is why mesh-calendar and mesh-heartbeat
 * did not have it: this module was extracted (#182) to be the one place that
 * knows how to connect a radio, and its own docstring names this storm — but
 * the call stayed behind. Any demo that reaches the Bluetooth branch now gets
 * it whether or not its page remembers to ask.
 *
 * Patched once per page, never twice: the queue wraps the browser's own
 * methods, and wrapping the wrapper would serialise a serialiser and reverse
 * the order the `?gatt=1` probe depends on. mesh-todo applies it early, before
 * that probe; the call below then finds it already on and does nothing.
 *
 * `?gattq=0` turns it off — patching a browser prototype should have a way out
 * that does not need a deploy.
 *
 * @returns {(() => void) | null} how to undo it, or null if it was already on
 *   or turned off
 */
let undoGattQueue = null;

export function applyGattQueue({ search = globalThis.location?.search ?? "", target = null } = {}) {
  if (undoGattQueue) return null;
  if (new URLSearchParams(search).get("gattq") === "0") return null;
  const restore = serialiseGattOperations({ target });
  undoGattQueue = () => {
    restore();
    undoGattQueue = null;
  };
  return undoGattQueue;
}

/**
 * What a page cannot see on a phone: the console.
 *
 * An exception in a config handler or a rejecting promise tears a connection
 * down with nothing on screen to act on, and mesh-todo's own comment for this
 * is the whole argument — *"on a phone the console is invisible"*. It lived
 * there, so the two demos most likely to be used away from a desk were the two
 * without it (#191).
 *
 * Not inside `connectCourier`: the exception worth catching can happen while
 * the page is still coming up, long before anything connects. A page calls
 * this once, with its own log, because where a line goes is the only part of
 * this a page knows.
 *
 * @param {(type: string, message: string) => void} report
 * @param {Object} [options]
 * @param {EventTarget} [options.target] what to listen on; the window by
 *   default, and an injectable one so this is testable without a browser
 * @returns {() => void} stop watching
 */
export function watchWindowErrors(report, { target = globalThis } = {}) {
  const onError = (event) => {
    const cause = event?.reason ?? event?.error ?? event?.message ?? event;
    report(event?.type ?? "error", describeMeshtasticError(cause) ?? String(cause?.message ?? cause));
  };
  target?.addEventListener?.("error", onError);
  target?.addEventListener?.("unhandledrejection", onError);
  return () => {
    target?.removeEventListener?.("error", onError);
    target?.removeEventListener?.("unhandledrejection", onError);
  };
}

/**
 * `?gatt=1`: say which Bluetooth operations overlap.
 *
 * The diagnostic that turned "the link keeps dropping" into a measurement
 * (#153), and the one wanted the first time a *new* app shows the same
 * symptom — so keeping it in the app that no longer needs it was exactly
 * backwards.
 *
 * Applied **after** the queue, deliberately: the probe has to wrap the queue
 * so the overlapping *calls* are still reported while the failures underneath
 * them disappear. Patched the other way round it reports nothing and looks
 * like everything is fine.
 *
 * @returns {(() => void) | null} how to stop it, or null if it was already on
 *   or not asked for
 */
let undoGattProbe = null;

export function stopGattQueue() {
  undoGattQueue?.();
}

export function stopGattProbe() {
  undoGattProbe?.();
}

export function applyGattProbe(report, { search = globalThis.location?.search ?? "", target = null } = {}) {
  if (undoGattProbe) return null;
  if (new URLSearchParams(search).get("gatt") !== "1") return null;
  const stop = measureGattOverlap(report, { target });
  undoGattProbe = () => {
    stop();
    undoGattProbe = null;
  };
  return undoGattProbe;
}

/**
 * What a node calls itself, in the two forms its owner can check.
 *
 * The four characters are the ones on the device's own display, so they are
 * what somebody holding two nodes can actually tell apart. The `!id` is the
 * node number in hex, which is what every other Meshtastic tool prints and
 * what a short name falls back to when nobody set one.
 *
 * "Connected" on its own is not enough in a room with two radios in it, and
 * mesh-todo has shown the `!id` since issue #12 while the newer demos said
 * nothing at all.
 *
 * @param {number|null} num the node number from `myNodeInfo`
 * @param {object|null} user the `user` of that node's entry, when it arrives
 */
export function nodeIdentity(num, user = null) {
  if (!Number.isFinite(num)) return null;
  const id = `!${(num >>> 0).toString(16).padStart(8, "0")}`;
  const short = user?.shortName?.trim();
  return {
    num,
    id,
    // The display shows four characters; a node with no short name set shows
    // the last four of its id, so that is the honest fallback rather than "?".
    shortName: short || id.slice(-4).toUpperCase(),
    longName: user?.longName?.trim() || "",
  };
}

export async function connectCourier({ mode, onEvent, onTelemetry, onStatus, onNodeInfo, onChannel, onMyNodeInfo, onRegion, onError, onReconnecting, onReconnected, onGaveUp, onGattQueue, onGattProbe, onIdentity }) {
  if (mode.kind === "bc") {
    const link = createBroadcastChannelLink({ room: mode.room, loss: mode.loss });
    // preset only changes the airtime *estimates* (and with them the ARQ's
    // patience) — e2e uses SHORT_TURBO so lossy runs heal at test pace.
    const courier = createMeshtasticCourier({
      link,
      region: "EU_868",
      preset: mode.preset,
      onEvent,
    });
    return {
      courier,
      kind: "bc", // the page words it
      region: "EU_868",
      device: null,
      setTxChannel: () => {},
      // Symmetry with the BLE branch below. Neither page calls it today, but a
      // caller should not have to know which branch it got to tear one down.
      close: () => courier.close(),
    };
  }

  // The node's own number, which arrives before its name and is needed to
  // tell its entry in the node database from everybody else's.
  let myNum = null;

  // Before anything talks to the radio: the transport's first act is to
  // subscribe for notifications, and a `startNotifications` that loses the
  // race is a device that transmits and never hears an answer.
  if (applyGattQueue() && onGattQueue) onGattQueue();
  // After the queue, never before it — see applyGattProbe.
  if (onGattProbe) applyGattProbe(onGattProbe);

  const [{ TransportWebBluetooth }, { MeshDevice }] = await Promise.all([
    import("@meshtastic/transport-web-bluetooth"),
    import("@meshtastic/core"),
  ]);
  // Request the device ourselves (rather than TransportWebBluetooth.create,
  // which hides it) so we hold the BluetoothDevice and can reconnect to it
  // later without a chooser — the supervisor needs a repeatable createDevice.
  const bleDevice = await navigator.bluetooth.requestDevice({
    filters: [{ services: [MESHTASTIC_BLE_SERVICE] }],
  });

  // Everything about surviving a phone's Bluetooth — subscribe-before-configure,
  // the generation guard, teardown-first reconnect, backoff, the stability
  // timer, the give-up cap — now lives in the library (issue #37). The courier
  // is built through the supervisor so it exists BEFORE configure() runs and
  // cannot miss the config stream; region and airtime are wired into it there.
  const managed = await connectMeshtasticDevice({
    createDevice: async () =>
      new MeshDevice(await TransportWebBluetooth.createFromDevice(bleDevice)),
    // The transport reports a failed GATT write as a disconnection, and
    // Android Chrome produces those readily. This is the ground truth that
    // stops us closing a connection that never actually dropped.
    isLinkAlive: () => bleDevice.gatt?.connected === true,
    // minFrameGapMs paces BLE writes so a multi-fragment payload (the bootstrap
    // blocks) does not burst and flood the phone's stack. maxRounds 12 (vs the
    // lib default 8): first contact is the biggest payload and the public
    // channel is lossy, so give the selective-ACK ARQ room to fill the gaps.
    createCourier: (link) =>
      createMeshtasticCourier({
        link,
        region: "UNSET", // provisional — the node reports the real one live
        onEvent,
        minFrameGapMs: 150,
        maxRounds: 12,
      }),
    on: {
      region: onRegion,
      airUtilTx: onTelemetry,
      status: onStatus,
      // Who this node is, derived here so no page has to reassemble it. The
      // number arrives first and the name later, if at all, so this fires
      // twice: once with the id, once with the four characters beside it.
      nodeInfo: (node) => {
        if (onIdentity && myNum != null && node?.num === myNum) {
          onIdentity(nodeIdentity(myNum, node.user));
        }
        if (onNodeInfo) onNodeInfo(node);
      },
      channel: onChannel,
      myNodeInfo: (info) => {
        myNum = info?.myNodeNum ?? info?.num ?? null;
        if (onIdentity) onIdentity(nodeIdentity(myNum));
        if (onMyNodeInfo) onMyNodeInfo(info);
      },
      reconnecting: onReconnecting,
      reconnected: onReconnected,
      gaveUp: onGaveUp,
      error: (e) => onError && onError(describeMeshtasticError(e)),
    },
  });

  return {
    courier: managed.courier,
    kind: "ble",
    region: "UNSET", // provisional; onRegion carries the live value
    get device() {
      return managed.device;
    },
    /** Frames the radio gave up retransmitting — see funkpost issue #73. */
    get refusals() {
      return managed.link.refusals;
    },
    setTxChannel: (index) => managed.setChannel(index),
    /**
     * Let the node go, in that order.
     *
     * The supervisor stops first: it treats a dropped link as a fault to
     * repair, and disconnecting a device it is still watching would have it
     * reconnect to the thing somebody just let go of. Then the device itself,
     * because `close()` only stops supervising — without this the radio stays
     * occupied at the operating system's level and the next app that wants it
     * finds it busy.
     */
    close: async () => {
      const device = managed.device;
      managed.close();
      try {
        await device?.disconnect();
      } catch {
        /* it is going away either way; a failure here is not news */
      }
    },
  };
}
