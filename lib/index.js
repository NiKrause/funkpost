// SPDX-License-Identifier: GPL-3.0-only
/**
 * Meshtastic courier for libp2p-webrtc-qr signalling and the OrbitDB data
 * plane. Design threads: issue #1 (data plane) and
 * libp2p-webrtc-qr#161 (signalling courier).
 *
 * The **Yjs provider** is deliberately NOT re-exported here:
 *
 *     import { createYjsProvider } from "@le-space/funkpost/yjs";
 *
 * It lives behind its own subpath so that `yjs` stays an optional peer
 * dependency — projects that only want the byte courier pay nothing for it.
 * It also works with any `{ send, onPayload }` courier, not just this one.
 * See docs/yjs-provider.md.
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
  watchModemPreset,
  watchAirUtilTx,
  watchDeviceStatus,
  watchNodeInfo,
  watchChannels,
  watchMyNodeInfo,
  watchMeshTraffic,
  routingErrorName,
  describeMeshtasticError,
  PRIVATE_APP_PORT,
} from "./links/meshtastic-device-link.js";
export {
  connectMeshtasticDevice,
  defaultBackoff,
} from "./links/meshtastic-supervisor.js";
export { createMemoryMeshPair } from "./links/memory-mesh.js";
