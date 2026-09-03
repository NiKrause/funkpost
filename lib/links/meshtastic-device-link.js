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
 * @param {boolean} [options.wantAck] Ask the mesh for per-hop acks too; the
 *   courier's own end-to-end ARQ works without them
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
  wantAck = false,
  mtu = 200,
  accept = null,
} = {}) {
  if (!device) throw new Error("A connected MeshDevice is required");

  return {
    mtu,
    async send(bytes) {
      if (bytes.length > mtu) {
        throw new Error(`frame of ${bytes.length} bytes exceeds the ${mtu}-byte MTU`);
      }
      await device.sendPacket(bytes, PRIVATE_APP_PORT, destination, channel, wantAck);
    },
    onFrame(cb) {
      return subscribe(device.events.onPrivatePacket, (packet) => {
        if (destination !== "broadcast" && packet.from !== destination) return;
        if (accept && !accept(packet)) return;
        cb(packet.data);
      });
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
