<!-- SPDX-License-Identifier: GPL-3.0-only -->

# Neighbours

None of these is affiliated with funkpost. They are here because they answer
the questions this project keeps being asked — *has anyone done this?*, *is
Meshtastic the only option?*, *who else is on the air near you?* — and because
a list of neighbours is cheaper to maintain than an argument about novelty.

## The same courier pattern, applied to money

Small signed payloads over a Meshtastic mesh, which is exactly what fits
through this pipe:

- **[btcmesh](https://github.com/eddieoz/btcmesh)** — signed Bitcoin
  transactions over a Meshtastic mesh to a relay that broadcasts them.
- **[darkwire](https://github.com/cyb3r17/darkwire)** — a Bitcoin 2025
  hackathon project: an end-to-end Bitcoin transaction over LoRa, with no
  internet anywhere on the sender's side.

Living proof of the shape rather than of this implementation: both carry one
signed thing at a time, and neither tries to replicate a database.

## The wider scene

Front doors of their own, and worth reading before assuming this stack is the
way:

- **[Reticulum](https://reticulum.network/)** — the cryptography-first mesh
  stack; runs over LoRa, packet radio, Wi-Fi and everything in between. Where
  funkpost bolts addressing and reliability on top of Meshtastic's broadcast,
  Reticulum has them by design.
- **[MeshCore](https://meshcore.co.uk/)** — a leaner LoRa mesh firmware
  building its own community alongside Meshtastic.
- **[qaul](https://qaul.net/)** — a messenger for internet shutdowns; devices
  connect directly over Bluetooth and Wi-Fi, no radio licence and no node.

## Within radio range

The communities this project's test channel shares the air with, and the
directory for everywhere else:

- **[Munich Mesh](https://munichmesh.de/)**
- **[Berlin Chaos Mesh](https://potatomesh.net/)**
- **[MeshHessen](https://meshhessen.de/)**
- **[Meshtastic local groups](https://meshtastic.org/docs/community/local-groups/)**

Being in range of a community mesh is a reason to read
[bench etiquette](bench-etiquette.md) before transmitting: the 868 MHz band is
250 kHz wide and shared with all of them.

---

← [funkpost](../README.md) · [bench etiquette](bench-etiquette.md) ·
[why a separate repository](why-separate-repository.md)
