// SPDX-License-Identifier: GPL-3.0-only
/**
 * Listen to the field-log topic and write what two phones say into one file.
 *
 * A field test happens where the phones are and the laptop is not. Neither
 * phone can hand over a file from a field, so mesh-todo shouts each log line
 * on a pubsub topic when its "shout the log" switch is on, and this joins the
 * same mesh and writes everything down — both devices, one timeline, in the
 * order it arrived here.
 *
 * Live or nothing, deliberately: a line published while this is not running is
 * gone. That is the right trade for a diagnostic, and it is why this prints
 * the moment it is subscribed rather than making you wonder.
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
  addresses: { listen: [] },
  transports: [webSockets(), circuitRelayTransport()],
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
  process.stdout.write(`${line.at ?? heard}  [${device}]  ${line.text ?? raw}\n`);
  if (out) appendFileSync(out, JSON.stringify(line) + "\n");
});

node.addEventListener("peer:connect", (event) => {
  console.error(`· connected to ${event.detail.toString().slice(0, 16)}…`);
});

console.error(`listening on ${FIELD_LOG_TOPIC} as ${node.peerId.toString().slice(0, 16)}…`);
console.error(`relay: ${relays.join(", ")}`);
if (out) console.error(`writing to ${out}`);
console.error("(phones must have 'shout the log' switched on — nothing is stored, so start this first)");

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    void node.stop().finally(() => process.exit(0));
  });
}
