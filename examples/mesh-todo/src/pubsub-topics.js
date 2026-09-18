// SPDX-License-Identifier: GPL-3.0-only
/**
 * Where peers announce themselves on the internet path.
 *
 * A browser cannot listen, so two of them find each other by publishing their
 * addresses on this topic and reading everyone else's. That only works if the
 * relay between them is subscribed to it as well — gossipsub carries a message
 * for a topic it has joined, and drops one for a topic it has not. The relays
 * deployed with `relay-button` join it (`todo._peer-discovery._p2p._pubsub` in
 * their config), and so does the relay the e2e suite starts; the name lives
 * here so the two cannot drift apart.
 */
export const PUBSUB_TOPICS = ["todo._peer-discovery._p2p._pubsub"];
