// SPDX-License-Identifier: GPL-3.0-only
/**
 * The relay the tests meet on: a libp2p node on this machine, keyed from a
 * fixed seed so its address is known before it starts — the page is built with
 * that address in VITE_RELAY_ADDRS, and never looks at the registry or the net.
 *
 * The seed is not a secret: the relay listens on 127.0.0.1, holds nothing, and
 * lives for the length of a test run.
 */
import { generateKeyPairFromSeed } from "@libp2p/crypto/keys";
import { peerIdFromPrivateKey } from "@libp2p/peer-id";
import { createHash } from "node:crypto";

const seed = createHash("sha256").update("mesh-todo e2e relay").digest();

export const relayPrivateKey = await generateKeyPairFromSeed("Ed25519", seed);
export const relayPeerId = peerIdFromPrivateKey(relayPrivateKey).toString();
export const relayPort = Number(process.env.RELAY_PORT || 9192);
export const relayAddr = `/ip4/127.0.0.1/tcp/${relayPort}/ws/p2p/${relayPeerId}`;
