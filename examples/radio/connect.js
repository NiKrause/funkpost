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
import { createBroadcastChannelLink } from "./fake-bc-link.js";

/** The Meshtastic BLE service, which is how the chooser knows what to offer. */
export const MESHTASTIC_BLE_SERVICE = "6ba1b218-15a8-461f-9fa8-5dcae273eafd";

export async function connectCourier({ mode, onEvent, onTelemetry, onStatus, onNodeInfo, onChannel, onMyNodeInfo, onRegion, onError, onReconnecting, onReconnected, onGaveUp }) {
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
      nodeInfo: onNodeInfo,
      channel: onChannel,
      myNodeInfo: onMyNodeInfo,
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
    close: () => managed.close(),
  };
}
