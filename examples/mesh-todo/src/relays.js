// SPDX-License-Identifier: GPL-3.0-only
/**
 * Which relays the internet path meets on.
 *
 * A browser cannot listen, so two of them find each other through a relay. The
 * addresses are not written down here: a relay deployed with `relay-button`
 * posts a signed `relay-bootstrap-v2` record to a public Aleph channel naming
 * the addresses it is reachable at, and this reads that channel. No account
 * and no key — reading Aleph is open, signing is not.
 *
 * `VITE_RELAY_ADDRS` overrides it, comma-separated, which is how the tests use
 * a relay on the test machine and never touch the network.
 */
import {
  fetchAlephBootstrapPosts,
  filterRelayBootstrapPostsByProfile,
  selectCurrentRelayBootstrapPosts,
  isBrowserDialableMultiaddr,
  dedupeMultiaddrs,
} from "@le-space/aleph-bootstrap";

// Only relays this app can use: an OrbitDB app that dials a `uc-go-peer` relay
// never forms a shared circuit. A live relay republishes every 6 hours, so two
// missed cadences means the machine behind the record is gone — records are
// never withdrawn, because the key that signed one dies with the machine.
const PROFILE = "orbitdb-relay";
const MAX_AGE_MS = 13 * 60 * 60 * 1000;

const fromEnv = (import.meta.env.VITE_RELAY_ADDRS || "")
  .split(",")
  .map((addr) => addr.trim())
  .filter(Boolean);

/** Where the addresses came from, for the page to say so. */
export const relaySource = fromEnv.length > 0 ? "VITE_RELAY_ADDRS" : `Aleph (${PROFILE})`;

let discovery = null;

/**
 * Every relay currently registered under the profile — one record per relay,
 * addresses a browser can dial.
 *
 * One record *per relay* rather than the package's one per `registrationId`:
 * the relays of a profile share that id, so the one-line version hands back
 * whichever registered last, and there is no second chance if that one is
 * unreachable from here.
 *
 * @returns {Promise<string[]>}
 */
export async function relayMultiaddrs() {
  if (fromEnv.length > 0) return fromEnv;

  discovery ??= (async () => {
    const posts = filterRelayBootstrapPostsByProfile(
      await fetchAlephBootstrapPosts({ pagination: 100 }),
      PROFILE,
    );

    const byRelay = new Map();
    for (const post of posts) {
      const peerId = post.content?.peerId;
      if (!peerId) continue;
      byRelay.set(peerId, [...(byRelay.get(peerId) ?? []), post]);
    }

    const addresses = [];
    for (const relayPosts of byRelay.values()) {
      const [current] = selectCurrentRelayBootstrapPosts(relayPosts, { maxAgeMs: MAX_AGE_MS });
      if (!current?.content) continue;
      addresses.push(
        ...(current.content.multiaddrs ?? []).filter((addr) => isBrowserDialableMultiaddr(addr)),
      );
    }

    return dedupeMultiaddrs(addresses);
  })().catch(() => []); // no registry reachable is "no relays", not a crash

  return discovery;
}
