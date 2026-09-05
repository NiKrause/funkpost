// SPDX-License-Identifier: GPL-3.0-only
/**
 * The real link: frames over a Meshtastic node's private application port.
 *
 * Wraps a connected `MeshDevice` from @meshtastic/core — over Web Bluetooth
 * in the browser (@meshtastic/transport-web-bluetooth), over TCP/serial in
 * Node for the bench. This file is deliberately thin: everything with
 * behaviour worth testing (framing, ARQ, pacing) lives above the link, and
 * physics lives below it.
 */

import { Protobuf } from "@meshtastic/core";

export const PRIVATE_APP_PORT = Protobuf.Portnums.PortNum.PRIVATE_APP;

// Routing errors that mean "no acknowledgement was heard", not "not
// delivered". On a broadcast the firmware's ack is unreliable — MAX_RETRANSMIT
// / TIMEOUT / NO_RESPONSE fire constantly on a busy public channel even when
// the packet did cross. They must NOT fail the frame: our own STATUS-driven
// ARQ is the delivery authority, and letting one of these abort the whole
// multi-frame payload (as it did — "gave up after 1 round: MAX_RETRANSMIT")
// throws away every fragment that got through. Swallow them; let the ARQ
// retransmit only what the receiver's STATUS actually reports missing.
const SOFT_ROUTING_ERRORS = new Set([
  3, // TIMEOUT
  5, // MAX_RETRANSMIT
  8, // NO_RESPONSE
]);

/**
 * Name a routing error code — `5` becomes `"MAX_RETRANSMIT"`. The firmware
 * enum is the single source of truth; an app that hand-copies the table gets
 * to keep both halves when the firmware adds a code.
 *
 * @param {number} code
 * @returns {string|null} the name, `"routing <n>"` for a code this firmware
 *   build does not know, or null if `code` is not a number
 */
export function routingErrorName(code) {
  if (typeof code !== "number") return null;
  const name = Protobuf.Mesh.Routing_Error[code];
  return typeof name === "string" ? name : `routing ${code}`;
}

/**
 * Turn anything this stack throws or rejects with into one readable line.
 *
 * Worth having in the library because the shapes are Meshtastic's own, and one
 * of them is a trap: the send queue rejects a firmware refusal as a plain
 * `{ id, error: number }` object with **no `.message`**, so the obvious
 * `${err}` prints `"[object Object]"` — which is what hid the real cause on
 * the bench for an evening. Browser error *events* wrap the real thing in
 * `.reason`, so that is unwrapped too.
 *
 * @param {unknown} value An Error, a queue rejection, an ErrorEvent, anything
 * @returns {string}
 */
export function describeMeshtasticError(value) {
  if (value == null) return String(value);
  if (value instanceof Error) return value.message || value.name || "Error";
  if (typeof value === "object") {
    if ("reason" in value && value.reason != null) return describeMeshtasticError(value.reason);
    if (typeof value.error === "number") {
      const name = routingErrorName(value.error);
      return value.id != null ? `${name} (packet ${value.id})` : name;
    }
    try {
      return JSON.stringify(value);
    } catch {
      return Object.prototype.toString.call(value);
    }
  }
  return String(value);
}

/** ste-simple-events returns an unsubscribe fn from subscribe(); older
 * versions want unsubscribe(handler). Cope with both. */
function subscribe(dispatcher, handler) {
  const maybeUnsub = dispatcher.subscribe(handler);
  if (typeof maybeUnsub === "function") return maybeUnsub;
  return () => {
    if (typeof dispatcher.unsubscribe === "function") dispatcher.unsubscribe(handler);
    else if (typeof dispatcher.unsub === "function") dispatcher.unsub(handler);
  };
}

/**
 * @param {Object} options
 * @param {Object} options.device A connected MeshDevice
 * @param {number|"broadcast"} [options.destination] Peer node number for a
 *   direct link; "broadcast" floods the channel (discovery, guest topologies)
 * @param {number} [options.channel] Channel index, default 0 (primary)
 * @param {boolean} [options.wantAck] Default true — not for the mesh's sake
 *   (the courier has its own end-to-end ARQ) but for the client library's:
 *   its packet queue completes a send only on a routing ACK, and a broadcast
 *   earns the firmware's implicit ACK only when wantAck is set. Without it,
 *   every send hangs and times out after 60 s — the third field report.
 * @param {number} [options.mtu] Max frame bytes; ~233 fits a Meshtastic
 *   application payload, 200 leaves margin
 * @param {(meta: { from: number, to: number, channel: number }) => boolean} [options.accept]
 *   Extra filter on incoming packets
 * @returns {{ mtu: number, send: Function, onFrame: Function }}
 */
export function createMeshtasticDeviceLink({
  device,
  destination = "broadcast",
  channel = 0,
  wantAck = true,
  mtu = 200,
  accept = null,
} = {}) {
  if (!device) throw new Error("A connected MeshDevice is required");

  let txChannel = channel;
  // The device is mutable so the link survives a reconnect: a phone's BLE
  // stack drops the GATT link under load (a write and a notification-read
  // overlap and one fails with "GATT Operation failed"), often without the
  // connection truly being gone. rebind() points the link at a freshly
  // reconnected MeshDevice and re-subscribes the frame listeners, so the
  // courier above keeps working across the swap.
  let current = device;
  const frameCbs = new Set();
  let unsubDevice = null;

  const subscribeFrames = (dev) =>
    subscribe(dev.events.onPrivatePacket, (packet) => {
      if (destination !== "broadcast" && packet.from !== destination) return;
      if (accept && !accept(packet)) return;
      for (const cb of frameCbs) cb(packet.data);
    });

  return {
    mtu,
    /** The channel index transmissions currently use. */
    get channel() {
      return txChannel;
    },
    /** Point the link at a reconnected device and re-subscribe frame listeners. */
    rebind(newDevice) {
      if (unsubDevice) unsubDevice();
      current = newDevice;
      unsubDevice = frameCbs.size > 0 ? subscribeFrames(current) : null;
    },
    /**
     * Switch the transmit channel. Reception needs no counterpart — the node
     * decodes every channel it holds a key for; only transmission must pick
     * the slot both sides share. (The fifth field report: a shared key
     * sitting at index 3 helps nobody while the courier transmits on 0.)
     */
    setChannel(index) {
      txChannel = index;
    },
    async send(bytes) {
      if (bytes.length > mtu) {
        throw new Error(`frame of ${bytes.length} bytes exceeds the ${mtu}-byte MTU`);
      }
      try {
        // wantResponse stays false: a broadcast that asks every receiver to
        // respond is an API default trap, not a feature.
        await current.sendPacket(bytes, PRIVATE_APP_PORT, destination, txChannel, wantAck, false);
      } catch (refusal) {
        // @meshtastic/core's send queue throws "Packet does not exist" from
        // wait(id) when the queue item is already gone — because it was acked
        // and removed (a win, not a failure), or because the queue was cleared
        // on disconnect. Neither should fail the frame: our own STATUS-driven
        // ARQ is the real delivery authority, and a genuine disconnect surfaces
        // through the transport's status event. Swallow it.
        if (refusal instanceof Error && /packet does not exist/i.test(refusal.message)) return;
        // The queue rejects firmware refusals as a plain {id, error} object —
        // no .message, so nothing upstream could ever name the reason.
        if (refusal instanceof Error) throw refusal;
        // A "no ack heard" routing error is not a delivery failure on a
        // broadcast — swallow it and let the ARQ decide from the peer's STATUS.
        if (typeof refusal?.error === "number" && SOFT_ROUTING_ERRORS.has(refusal.error)) return;
        // Hard/config errors (NO_CHANNEL, NOT_AUTHORIZED, TOO_LARGE, …) are
        // actionable — surface them with their Routing_Error name.
        throw new Error(`radio refused the packet: ${describeMeshtasticError(refusal)}`);
      }
    },
    onFrame(cb) {
      frameCbs.add(cb);
      if (!unsubDevice) unsubDevice = subscribeFrames(current);
      return () => {
        frameCbs.delete(cb);
        if (frameCbs.size === 0 && unsubDevice) {
          unsubDevice();
          unsubDevice = null;
        }
      };
    },
  };
}

/**
 * Report the node's LoRa region as a firmware region name ("EU_868", …) the
 * moment its config arrives — the courier's pacing and the app's honesty
 * both key off it. "UNSET" is delivered as "UNSET": the courier refuses to
 * transmit through an unconfigured node by default.
 *
 * @param {Object} device A MeshDevice
 * @param {(region: string) => void} cb
 * @returns {() => void} unsubscribe
 */
export function watchDeviceRegion(device, cb) {
  return subscribe(device.events.onConfigPacket, (config) => {
    const variant = config?.payloadVariant;
    if (!variant || variant.case !== "lora") return;
    const code = variant.value?.region ?? 0;
    const name = Protobuf.Config.Config_LoRaConfig_RegionCode[code];
    cb(typeof name === "string" ? name : "UNSET");
  });
}

/**
 * Report the node's measured transmit airtime utilisation (percent of the
 * last hour) from device telemetry — the ground truth the token bucket
 * estimates, straight from the enforcer.
 *
 * @param {Object} device A MeshDevice
 * @param {(airUtilTx: number) => void} cb
 * @returns {() => void} unsubscribe
 */
export function watchAirUtilTx(device, cb) {
  return subscribe(device.events.onTelemetryPacket, (packet) => {
    const variant = packet?.data?.variant;
    if (!variant || variant.case !== "deviceMetrics") return;
    const value = variant.value?.airUtilTx;
    if (typeof value === "number") cb(value);
  });
}

const DEVICE_STATUS_NAMES = {
  1: "restarting",
  2: "disconnected",
  3: "connecting",
  4: "reconnecting",
  5: "connected",
  6: "configuring",
  7: "configured",
};

/**
 * Report the device's connection status by name ("configured",
 * "disconnected", ...). The Web Bluetooth transport fires "disconnected" on
 * gattserverdisconnected — the browser or OS dropping an idle GATT link is
 * the quiet killer of a bench session, and the app should say so instead of
 * letting the next send fail mysteriously.
 *
 * @param {Object} device A MeshDevice
 * @param {(name: string, status: number) => void} cb
 * @returns {() => void} unsubscribe
 */
export function watchDeviceStatus(device, cb) {
  return subscribe(device.events.onDeviceStatus, (status) => {
    cb(DEVICE_STATUS_NAMES[status] ?? String(status), status);
  });
}

/**
 * Report every NodeInfo the node has heard — the mesh's population, one
 * neighbour at a time. On a public channel this is the whole community mesh;
 * the demo renders it so "who can hear this?" is a visible fact rather than
 * a doctrine footnote.
 *
 * @param {Object} device A MeshDevice
 * @param {(node: Object) => void} cb Receives the NodeInfo protobuf
 *   (num, user.{id,longName,shortName}, snr, lastHeard, hopsAway, viaMqtt, …)
 * @returns {() => void} unsubscribe
 */
export function watchNodeInfo(device, cb) {
  return subscribe(device.events.onNodeInfoPacket, cb);
}

/**
 * Report the node's channel table as it arrives during configuration. The
 * demo fingerprints the PRIMARY channel's key so two phones can compare at a
 * glance — the fourth field report was two nodes hearing each other
 * perfectly and decrypting nothing, because channel 0 differed.
 *
 * @param {Object} device A MeshDevice
 * @param {(channel: Object) => void} cb Receives Protobuf.Channel.Channel
 *   ({ index, role, settings: { name, psk, … } }; role 1 = PRIMARY)
 * @returns {() => void} unsubscribe
 */
export function watchChannels(device, cb) {
  return subscribe(device.events.onChannelPacket, cb);
}

/**
 * Report this node's own identity (myNodeNum) — so a bench screen can say
 * who it is, and a peer can find it in the neighbours list.
 *
 * @param {Object} device A MeshDevice
 * @param {(info: Object) => void} cb Receives Protobuf.Mesh.MyNodeInfo
 * @returns {() => void} unsubscribe
 */
export function watchMyNodeInfo(device, cb) {
  return subscribe(device.events.onMyNodeInfo, cb);
}
