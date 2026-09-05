<!-- SPDX-License-Identifier: GPL-3.0-only -->

# Roadmap

funkpost carries bytes over a LoRa mesh. Above it sit **data planes** — ways of
turning an application's state into those bytes — and the point of the project
is that the plane and the courier are separable. There are two planes now:

```
  app
  ────────────────────────────────────────────────────────────
  data plane:   courier-sync (OrbitDB)   │   y-funkpost (Yjs)
                        #1               │        #36
  ────────────────────────────────────────────────────────────
  funkpost byte courier — framing · selective-ACK ARQ · duty-cycle pacing
  ────────────────────────────────────────────────────────────
  link — Web Bluetooth → Meshtastic node  │  in-memory mesh (tests)
```

The courier does not change when a plane is added. That is the claim this
roadmap is built to keep testing.

## Where things stand

| | Thread | State |
|---|---|---|
| **#1** | OrbitDB data plane | **First over-the-air replication 2026-09-04** — two desktop browsers, two nodes, no IP path. Open: first-contact reliability on a busy public channel, and the phone Bluetooth lottery. |
| **#36** | Yjs data plane | Designed, not started. No LoRa/Meshtastic Yjs provider exists anywhere — this would be the first. |
| **#37** | Hoist demo scaffolding into the lib | Designed, not started. Half the field bugs from #1 live in the demo's reconnect supervisor; a second app must not re-derive them. |
| **#38** | `mesh-appointments` demo | Designed, not started. The Yjs plane's demo app: a Calendly-shaped booking book for a hairdresser, over LoRa. |

Both planes stay. OrbitDB gives signed entries, an access controller and a
verifiable hash-linked history. Yjs gives tiny, loss-tolerant, order-independent
updates and a bootstrap measured in frames rather than kilobytes. **Pick by what
the application needs to be true** — the tradeoff table lives in #36.

## Phases

Ordered so that every phase is testable when it lands, and nothing waits on
hardware that does not have to.

### P0 · Error humaniser into the lib — #37 B

The Meshtastic routing-code table and `describeError()` are duplicated in the
demo. One source of truth in the lib; the demo imports it.

*Gate:* `routingErrorName(5) === "MAX_RETRANSMIT"`; the hand-copied map is gone
from `App.svelte`.

### P1 · Yjs provider core — #36 S1–S2

`FunkpostProvider` over `courier.send` / `courier.onPayload`, speaking stock
`y-protocols/sync`. Then the adaptations the radio forces: coalescing local
edits into one payload, echo suppression, `resync()`, awareness off by default.

*Gate:* two docs converge to an equal state vector across a 20 % frame-loss run
on the in-memory mesh, with no manual retries. A ten-keystroke burst produces
**one** payload, not ten. No hardware needed.

### P2 · Reconnect supervisor into the lib — #37 A

The device-lifecycle state machine — subscribe-before-configure, the generation
guard, teardown-first reconnect, exponential backoff, the stability timer, the
give-up cap, `link.rebind`.

*Gate:* tests against a stub `MeshDevice` with injected disconnects assert each
clause; `mesh-todo` is repointed at the lib and behaves identically.

### P3 · Appointment core — #38 A1–A3

The two-document model, the slot engine (rules → grid, never enumerations), the
busy mask, capability keypairs, and the deterministic arbitration that makes two
customers racing for one slot resolve identically on both sides **without
exchanging a packet**.

*Gate:* a property test — apply concurrent bookings in every merge order, assert
every replica computes the same winner. Then the race over the lossy in-memory
mesh: one winner, the loser told, no arbitration traffic.

### P4 · `.ics` and the serverless Calendly link — #38 A4

Generator with correct folding and escaping, `SEQUENCE`/`METHOD:CANCEL`
handling, and the fragment-routed change/cancel link whose state-changing
traffic travels only over the mesh.

*Gate:* the file imports cleanly into Apple Calendar, Google Calendar and
Thunderbird; the link round-trips to a cancel whose signature verifies.

### P5 · The two UIs — #38 A5

Customer booking flow and salon day view, the Rückfrage popup, the mode switch,
and the collapsible radio strip that keeps the transport honest.

*Gate:* Playwright e2e over the BroadcastChannel fake mesh — book → approve →
converge → download → parse.

### P6 · Deploy both demos — #38 A6

`pages.yml` builds two examples: `mesh-todo` stays at `/funkpost/`, the booking
demo lands at `/funkpost/termine/`. A service worker caches the app shell so a
link opened cold still works. **The path is a one-way door** — every `.ics` ever
downloaded points at it.

### P7 · Hardware bench — #38 A7

Two nodes, EU_868, both booking modes. Round-trip latency, measured airtime per
booking, a confirmed end-to-end booking with an `.ics` on both phones — recorded
in the README the way the first replication was.

### Running alongside: #1 reliability

Independent of the phases above, and driven by field runs rather than a
schedule: first-contact bootstrap on a congested channel, and how reliably a
full sync survives repeated BLE drops on a given phone. The standing
recommendation for any real bench is a **private Meshtastic channel** — it
removes the congestion that causes most of it.

## Principles these phases are testing

- **The courier does not learn about its payloads.** Adding a second data plane
  must require zero changes to framing, ARQ or pacing. If P1 forces a change
  down there, the seam was wrong and that is the finding.
- **Transmit rules, not enumerations.** Availability is a couple of hundred
  bytes of rules; a slot grid is thousands of entries. The difference is the
  whole demo.
- **Convergence is not agreement.** A CRDT that merges two bookings for one slot
  has not solved the double-booking; it has only made both replicas agree that
  it happened. The arbitration in P3 is where the actual answer lives.
- **Say what does not work.** The `.ics` link needs the app shell, and the app
  shell arrives over HTTP the first time. A public channel broadcasts every
  booking to every neighbour. Both are written down, in the UI and in the docs,
  rather than discovered by whoever runs it.
