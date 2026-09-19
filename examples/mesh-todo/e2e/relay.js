// SPDX-License-Identifier: GPL-3.0-only
/**
 * A relay for the tests, in place of the deployed ones.
 *
 * Two browser pages cannot listen, so each reserves a slot here and is
 * reachable through it. Reservations carry no data or time limit
 * (`applyDefaultLimit: false`), so OrbitDB can sync over the relayed
 * connection and the test does not hang on whether WebRTC came up.
 */
import { createLibp2p } from "libp2p";
import { webSockets } from "@libp2p/websockets";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { identify } from "@libp2p/identify";
import { ping } from "@libp2p/ping";
import { gossipsub } from "@libp2p/gossipsub";
import { circuitRelayServer } from "@libp2p/circuit-relay-v2";
import { pubsubPeerDiscovery } from "@libp2p/pubsub-peer-discovery";
import { relayPrivateKey, relayPort } from "./relay-key.js";
import { PUBSUB_TOPICS } from "../src/pubsub-topics.js";

const relay = await createLibp2p({
  privateKey: relayPrivateKey,
  addresses: { listen: [`/ip4/127.0.0.1/tcp/${relayPort}/ws`] },
  transports: [webSockets()],
  connectionEncrypters: [noise()],
  streamMuxers: [yamux()],
  // Subscribed to the discovery topic, exactly as the deployed relays are:
  // gossipsub only carries a topic it has joined, so without this the two
  // pages meet here and never hear of each other.
  peerDiscovery: [
    pubsubPeerDiscovery({
      interval: 3000,
      topics: PUBSUB_TOPICS,
      listenOnly: false,
    }),
  ],
  services: {
    identify: identify(),
    // Browsers ping the relay to keep the reservation warm; a relay without
    // it answers "protocol not supported" every few seconds.
    ping: ping(),
    pubsub: gossipsub({ allowPublishToZeroTopicPeers: true }),
    relay: circuitRelayServer({
      reservations: { maxReservations: 64, applyDefaultLimit: false },
    }),
  },
});

for (const address of relay.getMultiaddrs()) {
  console.log(`relay listening on ${address.toString()}`);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    relay.stop().then(() => process.exit(0));
  });
}
