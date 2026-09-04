// SPDX-License-Identifier: GPL-3.0-only
/**
 * Meshtastic courier for libp2p-webrtc-qr signalling and the OrbitDB data
 * plane. Design threads: issue #1 (data plane) and
 * libp2p-webrtc-qr#161 (signalling courier).
 */

export {
  createMeshtasticCourier,
} from "./meshtastic-courier.js";
export {
  fragmentPayload,
  encodeStatus,
  decodeFrame,
  createReassembler,
  randomMessageId,
  FRAMING_VERSION,
  DATA_HEADER_BYTES,
  STATUS_HEADER_BYTES,
} from "./framing.js";
export {
  createTokenBucket,
  estimateAirtimeMs,
  PRESET_DATA_RATES_BPS,
} from "./pacing.js";
export { REGIONS, regionPolicy } from "./regions.js";
export {
  createMeshtasticDeviceLink,
  watchDeviceRegion,
  watchAirUtilTx,
  watchDeviceStatus,
  watchNodeInfo,
  watchChannels,
  watchMyNodeInfo,
  PRIVATE_APP_PORT,
} from "./links/meshtastic-device-link.js";
export { createMemoryMeshPair } from "./links/memory-mesh.js";
