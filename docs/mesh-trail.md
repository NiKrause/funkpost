<!-- SPDX-License-Identifier: GPL-3.0-only -->

# mesh-trail: everyone on one map

**[Demo](https://nikrause.github.io/funkpost/mesh-trail/)**

A walk with radios. Each device says where it is on a schedule, every other
device hears it and draws the trail, and two fixes are a direction. No database
anywhere: positions are the whole payload, and nothing is replicated.

## The group size is a parameter

New here, and it shapes everything else. A beacon is **49 bytes** with a good
fix, about half a second of air at `LONG_FAST`. Per device at one a minute that
is well under 1 % duty cycle — the law is nowhere near binding. The **channel**
is what binds:

| | every minute | every 2 min | every 5 min |
|---|---|---|---|
| 2 people | 20 % | 10 % | 4 % |
| 5 people | 49 % | 25 % | 10 % |
| 10 people | **98 %** | 49 % | 20 % |

Of what this carrier was measured to move —
[~500 bytes a minute](field-notes.md#a-list-over-the-radio-with-nobodys-internet-on)
— and LoRa has no collision avoidance, so an ALOHA-shaped channel loses
messages to collisions long before it is full. **The interval follows the group
size**, and the page shows what the choice costs, counted from the devices
actually heard rather than a number somebody guessed at.

Past about half the carrier it says so, because the fix is a longer interval
and there is no other one.

## Fire and forget

No ARQ, no retransmission, no acknowledgement. Two reasons, and the second is
the one that matters in a group:

- a position that missed is **replaced by the next one**, which beats resending
  a place somebody has already walked away from;
- a reliability layer multiplies traffic by the number of listeners, which is
  exactly the wrong direction when the listeners are the problem.

The wire is dag-cbor behind no prefix byte, like the heartbeat and the founding
pointer, so courier-sync drops it unread — and there is a test that each
protocol refuses the other's post, because a group out walking may well have a
mesh-todo phone on the same channel asking whether anyone is there.

`accuracy` rides along because a dot from a satellite fix and one from a Wi-Fi
guess are hundreds of metres apart, and somebody walking towards it deserves to
know which it is.

## Sending is off until somebody turns it on

This is a page that broadcasts a **live position**, which is a different thing
from a beat. On the published test channel the key is on a web page, so anyone
who has read it can watch a walk happen. The page says that, and will not
transmit until it has been acknowledged.

Listening asks nobody's permission and is the default: a device that only
listens is a perfectly good member of a walk.

## Names and identity

A device is **four random bytes** on the air — no name, no model, nothing
derived from hardware — and whatever somebody typed on this phone. The second
never leaves it: nicknames are local, which is what makes the list readable at
a kerb and costs nothing to carry, because it is not carried.

The identity is **kept across sessions**, deliberately: a walk that reloads a
phone should not turn that person into a stranger with a fresh trail. The cost
is worth stating — a stable identifier on a shared channel is something an
observer can follow across days.

With the fake mesh it is per tab instead, because two tabs share
`localStorage` and must still be two people. mesh-todo settled the same
question the same way.

## The map

Each device gets a colour; a trail fades towards its older end, so which end is
*now* is visible without reading timestamps. The head of each trail carries the
name, and this device is a ring rather than a dot so it does not read as one
more walker.

OpenStreetMap raster tiles with the attribution the licence asks for, loaded
through a dynamic import. **In a wood the tiles do not come**, and the trails,
distances and directions are drawn from numbers the device already holds — the
page says which of the two is happening.

## Running one

**In a browser first.** `?mesh=bc` replaces the radio with a
`BroadcastChannel`, so two tabs play two walkers. Other parameters: `every=`
picks the interval (`0` = only on the button), `group=` separates two walks
that share a channel, `loss=` drops frames on purpose, `channel=` preselects
one by name, `log=1` shows the field log.

**Outdoors**, the things that cost a run: tick *keep the screen awake*, wait
until *Where this is* shows a place with an accuracy **before** setting off,
and compare the channel fingerprint on every device — a mismatch is silent and
looks exactly like being out of range.

## What it has not shown yet

- **A walk.** Everything here has run in a browser over a fake mesh.
- **Bearing and distance to one person**, for when the tiles will not load.
- **A check-in button** outside the schedule: *ok · wait · come · help*.
- **A fox hunt**: one device beacons rarely, the rest go looking.

---

← [funkpost](../README.md) · [mesh-heartbeat](mesh-heartbeat.md) ·
[bench etiquette](bench-etiquette.md) · [field notes](field-notes.md)
