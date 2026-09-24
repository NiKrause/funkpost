// SPDX-License-Identifier: GPL-3.0-only
/**
 * Listen to the field-log topic and write what two phones say into one file.
 *
 * A field test happens where the phones are and the laptop is not. Neither
 * phone can hand over a file from a field, so mesh-todo shouts each log line
 * on a pubsub topic when its "send the log" switch is on, and this joins the
 * same mesh and writes everything down — both devices, one timeline, in the
 * order it arrived here.
 *
 * Not live or nothing any more: a phone keeps the lines nobody heard and sends
 * them in front of the next one that gets through, marked `late` and carrying
 * the time it was written. That is what makes an offline run — the list
 * travelling over LoRa alone — readable here afterwards. A line published
 * while no phone has the switch on is still gone, which is why this prints the
 * moment it is subscribed rather than making you wonder.
 *
 *   node scripts/watch-field-log.mjs                    # relays from relays.js
 *   node scripts/watch-field-log.mjs --out run-3.ndjson
 *   RELAY_ADDRS=/dns4/…/p2p/12D3… node scripts/watch-field-log.mjs
 *
 * One line of NDJSON per message, exactly as the phone sent it, plus `heard`
 * — when it reached here, which is not when it happened.
 */
import { createLibp2p } from "libp2p";
import { webSockets } from "@libp2p/websockets";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { identify } from "@libp2p/identify";
import { gossipsub } from "@libp2p/gossipsub";
import { bootstrap } from "@libp2p/bootstrap";
import { pubsubPeerDiscovery } from "@libp2p/pubsub-peer-discovery";
import { circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import { webRTC } from "@libp2p/webrtc";
import { appendFileSync } from "node:fs";

const FIELD_LOG_TOPIC = "funkpost/field-log/1";
const DISCOVERY_TOPIC = "todo._peer-discovery._p2p._pubsub";

const argOf = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const out = argOf("--out", null);
const relays = (process.env.RELAY_ADDRS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (relays.length === 0) {
  // The app resolves these from Aleph; here they are an argument, so this
  // script needs no network before it starts and says what it is missing.
  console.error(
    "No relay given. Pass RELAY_ADDRS=/dns4/…/p2p/12D3… — the same one the phones use\n" +
      "(mesh-todo prints it under the node panel, and VITE_RELAY_ADDRS sets it there).",
  );
  process.exit(1);
}

const node = await createLibp2p({
  // Being connected to the relay is not being in the mesh. A circuit relay
  // brokers connections; it does not forward the payloads of a topic it has
  // not subscribed to — measured: two of these, both connected to the same
  // relay, published to 0 recipients for as long as they only had the relay.
  // Phones reach each other by finding one another over the relay and then
  // dialling direct over WebRTC, and gossip flows on that direct connection.
  // So this listens the way a phone does: a circuit address to be found at,
  // and WebRTC to be dialled on. Without both, this hears nothing, quietly.
  addresses: { listen: ["/p2p-circuit", "/webrtc"] },
  transports: [
    webSockets(),
    webRTC({
      rtcConfiguration: {
        iceServers: [
          { urls: "stun:stun.l.google.com:19302" },
          { urls: "stun:global.stun.twilio.com:3478" },
        ],
      },
    }),
    circuitRelayTransport(),
  ],
  connectionEncrypters: [noise()],
  streamMuxers: [yamux()],
  connectionGater: { denyDialMultiaddr: () => false },
  peerDiscovery: [
    bootstrap({ list: relays, timeout: 30_000, tagName: "bootstrap", tagValue: 50 }),
    pubsubPeerDiscovery({ interval: 3000, topics: [DISCOVERY_TOPIC], listenOnly: false }),
  ],
  services: {
    // A busy relay announces one protocol per database it holds open, and
    // libp2p rejects an identify response over 8192 bytes whole — so the
    // default limit makes a working relay unrecognisable.
    identify: identify({ maxMessageSize: 65_536 }),
    pubsub: gossipsub({ allowPublishToZeroTopicPeers: true }),
  },
});

node.services.pubsub.subscribe(FIELD_LOG_TOPIC);
node.services.pubsub.addEventListener("message", (event) => {
  if (event.detail.topic !== FIELD_LOG_TOPIC) return;
  const heard = new Date().toISOString();
  const raw = new TextDecoder().decode(event.detail.data);
  let line;
  try {
    line = { ...JSON.parse(raw), heard };
  } catch {
    line = { heard, raw };
  }
  const device = line.dev ?? "?";
  // A replayed line carries the time it was written, not the time it arrived —
  // say so, or a run that was offline for ten minutes reads as ten minutes of
  // traffic that never happened.
  const when = line.late ? `${line.at} (nachgereicht)` : (line.at ?? heard);
  process.stdout.write(`${when}  [${device}]  ${line.text ?? raw}\n`);
  if (out) appendFileSync(out, JSON.stringify(line) + "\n");
});

node.addEventListener("peer:connect", (event) => {
  console.error(`· connected to ${event.detail.toString().slice(0, 16)}…`);
});

// Connected is not subscribed, and the difference is the whole failure mode:
// a relay connection prints reassuringly and carries nothing. Say which one
// this is, and say it again when it changes, so a silent run is legible.
let onTopic = 0;
setInterval(() => {
  const now = node.services.pubsub.getSubscribers(FIELD_LOG_TOPIC).length;
  if (now === onTopic) return;
  console.error(
    now === 0
      ? "· nobody on the topic — a relay connection alone carries nothing; a phone has to be reachable and shouting"
      : `· in the mesh with ${now} peer${now === 1 ? "" : "s"} on ${FIELD_LOG_TOPIC}`,
  );
  onTopic = now;
}, 2000).unref?.();

console.error(`listening on ${FIELD_LOG_TOPIC} as ${node.peerId.toString().slice(0, 16)}…`);
console.error(`relay: ${relays.join(", ")}`);
if (out) console.error(`writing to ${out}`);
console.error("(phones must have 'send the log' switched on — nothing is stored, so start this first)");
console.error("waiting to be found — this takes a few seconds after the relay reservation");

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    void node.stop().finally(() => process.exit(0));
  });
}
