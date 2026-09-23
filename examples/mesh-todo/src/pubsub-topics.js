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

/**
 * Where this app shouts its log, when asked to.
 *
 * A field test with two phones and a laptop needs the laptop to see what both
 * phones saw, and neither phone can hand over a file while it is out in a
 * field. This is pubsub rather than a database on purpose: it is live or it is
 * nothing, and nothing is an acceptable answer for a diagnostic — what matters
 * is that the run being watched is the run that is happening.
 *
 * Off unless switched on: a log carries channel names and node numbers, and a
 * relay carries it to anyone subscribed.
 */
export const FIELD_LOG_TOPIC = "funkpost/field-log/1";
