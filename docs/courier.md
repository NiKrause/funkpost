<!-- SPDX-License-Identifier: GPL-3.0-only -->

# The byte courier

Status: **built and tested — it carries both planes and knows about neither**

## Shared underneath: the byte courier

One transport, two planes. Everything here is radio-free and fully tested:

- [`lib/framing.js`](../lib/framing.js) — fragments sized to a mesh packet
  (`id · idx/total`), plus a STATUS frame carrying the receiver's bitmap
- [`lib/meshtastic-courier.js`](../lib/meshtastic-courier.js) — selective-ACK ARQ
  over any link: retransmits exactly the missing fragments, bounded rounds;
  `send()` resolves on transmission by default (a broadcast into an empty
  room must not hang) and on acknowledgement with `awaitDelivery: true`
- [`lib/pacing.js`](../lib/pacing.js) — airtime estimates per modem preset and a
  token bucket that paces transmissions to the regional duty cycle, so the
  firmware never has to refuse and ARQ never mistakes legal throttling for loss
- [`lib/regions.js`](../lib/regions.js) — jurisdictions as data: one row per
  firmware region with its airtime budget and legal framework; a node with
  region `UNSET` is refused, not transmitted through
- [`lib/links/meshtastic-device-link.js`](../lib/links/meshtastic-device-link.js) —
  the thin binding to a real node: `@meshtastic/core` over the private
  application port, plus region and airtime-utilisation watchers
- [`lib/links/memory-mesh.js`](../lib/links/memory-mesh.js) — the radio's test
  double: MTU-enforcing, lossy, duplicating, jittering

## The topology (both planes)

```
phone ↔ BLE ↔ its own node ↔ LoRa ↔ peer node ↔ BLE ↔ phone / tablet
```

A browser reaches a Meshtastic node over Web Bluetooth
([`@meshtastic/transport-web-bluetooth`](https://meshtastic.org/docs/development/js/),
the only transport that fits a phone). One BLE client per node is a firmware
rule, so each side brings its own. Chrome/Edge on Android and desktop; no iOS,
no Firefox; the page must be foreground with the screen on.

---

← [funkpost](../README.md) · [ROADMAP](../ROADMAP.md)
