// SPDX-License-Identifier: GPL-3.0-only
/**
 * The goodput gate, on hardware (plan step S5 in issue #1).
 *
 * Two Meshtastic nodes, reachable over TCP (WiFi-enabled nodes or
 * `meshtasticd`), one hop apart on a quiet channel. This script runs the real
 * courier — framing, ARQ, pacing — between them and prints the numbers the
 * design gates on: per-payload latency, sustained goodput, retransmit rounds,
 * and estimated airtime against the wall clock.
 *
 *   NODE_A=192.168.1.20 NODE_B=192.168.1.21 npm run bench:goodput
 *
 * Optional: SIZE (payload bytes, default 700 ≈ one OrbitDB entry),
 * COUNT (payloads, default 5), REGION (default EU_868), PRESET (default
 * LONG_FAST), MTU (default 200).
 *
 * The Web Bluetooth path adds the phone leg; this bench isolates the radio,
 * which is the part no CI can simulate. Compare the printed airtime estimate
 * with the wall clock: the difference is what recalibrates lib/pacing.js.
 */

import { MeshDevice } from "@meshtastic/core";
import { createMeshtasticCourier } from "../lib/meshtastic-courier.js";
import { createMeshtasticDeviceLink, watchDeviceRegion } from "../lib/links/meshtastic-device-link.js";
import { estimateAirtimeMs } from "../lib/pacing.js";

const env = (name, fallback = undefined) => process.env[name] ?? fallback;

const hostA = env("NODE_A");
const hostB = env("NODE_B");
if (!hostA || !hostB) {
  console.error(
    "Usage: NODE_A=<ip[:port]> NODE_B=<ip[:port]> npm run bench:goodput\n" +
      "Both nodes must be reachable over TCP (WiFi nodes or meshtasticd).",
  );
  process.exit(1);
}

const SIZE = Number(env("SIZE", 700));
const COUNT = Number(env("COUNT", 5));
const REGION = env("REGION", "EU_868");
const PRESET = env("PRESET", "LONG_FAST");
const MTU = Number(env("MTU", 200));

async function connect(label, host) {
  const { TransportNode } = await import("@meshtastic/transport-node").catch(() => {
    console.error("Missing dev dependency @meshtastic/transport-node — npm install first.");
    process.exit(1);
  });
  const [hostname, port] = host.split(":");
  const transport = await TransportNode.create(hostname, port ? Number(port) : undefined);
  const device = new MeshDevice(transport);
  watchDeviceRegion(device, (region) =>
    console.log(`[${label}] reports region ${region}${region !== REGION ? ` (bench uses ${REGION})` : ""}`),
  );
  await device.configure();
  console.log(`[${label}] connected to ${host}`);
  return device;
}

const deviceA = await connect("A", hostA);
const deviceB = await connect("B", hostB);

const courierA = createMeshtasticCourier({
  link: createMeshtasticDeviceLink({ device: deviceA, mtu: MTU }),
  region: REGION,
  preset: PRESET,
});
const courierB = createMeshtasticCourier({
  link: createMeshtasticDeviceLink({ device: deviceB, mtu: MTU }),
  region: REGION,
  preset: PRESET,
});

let received = 0;
courierB.onPayload((payload) => {
  received++;
  console.log(`[B] payload ${received}/${COUNT} received (${payload.length} B)`);
});

const payload = Uint8Array.from({ length: SIZE }, (_, i) => i & 0xff);
const latencies = [];
const startedAt = Date.now();

for (let i = 0; i < COUNT; i++) {
  const t0 = Date.now();
  await courierA.send(payload);
  const latency = Date.now() - t0;
  latencies.push(latency);
  console.log(`[A] payload ${i + 1}/${COUNT} delivered+acked in ${(latency / 1000).toFixed(1)} s`);
}

const wallMs = Date.now() - startedAt;
const { framesTx, retransmitRounds, airtimeSpentMs } = courierA.stats;
const frames = Math.ceil(SIZE / (MTU - 9));
const estimatedMs = COUNT * frames * estimateAirtimeMs(MTU, PRESET);

console.log("\n— goodput gate —");
console.log(`payloads          ${COUNT} × ${SIZE} B, mtu ${MTU}, ${PRESET}, ${REGION}`);
console.log(`latency           min ${Math.min(...latencies)} ms · max ${Math.max(...latencies)} ms`);
console.log(`goodput           ${(((COUNT * SIZE) / wallMs) * 1000).toFixed(1)} B/s over ${(wallMs / 1000).toFixed(1)} s`);
console.log(`frames tx         ${framesTx} (retransmit rounds: ${retransmitRounds})`);
console.log(`airtime estimate  ${(airtimeSpentMs / 1000).toFixed(1)} s spent of model ${(estimatedMs / 1000).toFixed(1)} s`);
console.log(`budget remaining  ${(courierA.budget().remainingAirtimeMs / 1000).toFixed(0)} s of airtime this hour`);
console.log("\nRecord these numbers in issue #1 — they are the gate.");

process.exit(received === COUNT ? 0 : 2);
