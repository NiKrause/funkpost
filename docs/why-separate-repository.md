<!-- SPDX-License-Identifier: GPL-3.0-only -->

# Why this is a separate repository

Status: **settled — a licence decision, and a one-way door**

## Why this is a separate repository

**Licence, not taste.** [`@meshtastic/core`](https://www.npmjs.com/package/@meshtastic/core)
and `@meshtastic/transport-web-bluetooth` are **GPL-3.0-only**.
`@le-space/libp2p-webrtc-qr` is **Apache-2.0 OR MIT**, and a permissive library
that pulled GPL-3.0 into its consumers' builds would be misrepresenting its own
licence — the optional-peer-dependency pattern it uses for `ggwave` works
because ggwave is MIT.

So this repository is **GPL-3.0**, and it depends on the permissive packages
rather than the other way round. Permissive flows into copyleft; the reverse is
what fails. The split is recorded from the other side as roadmap items 18–19
in [the main repository's ROADMAP](https://github.com/NiKrause/libp2p-webrtc-qr/blob/main/ROADMAP.md).

One consequence stated in advance, because it is a one-way door: anything that
turns out to belong in a permissive package — the carrier-neutral framing, the
sync seam — has to be written **there** and used from here. Designing it here
and wanting it back later does not work. That is why `courier-sync` lives in
orbitdb-storacha-bridge and this repository only implements its courier
contract.

---

← [funkpost](../README.md) · [ROADMAP](../ROADMAP.md)
