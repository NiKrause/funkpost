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
| **#36** | Yjs data plane | **Built** (S1–S2) — `@le-space/funkpost/yjs`, tested to convergence under 20 % loss. Not yet run on hardware. Awareness deliberately left out. [docs](docs/yjs-provider.md) |
| **#37** | Hoist demo scaffolding into the lib | **Built** — the device supervisor and the error humaniser are library code; `mesh-todo` is a consumer. Not yet re-run on hardware. [docs](docs/links.md) |
| **#38** | `mesh-appointments` demo | **Core + calendar built** (A1–A4) — slot engine, busy mask, arbitration, capability keys, `.ics` and the serverless link. No UI, no hardware yet. [docs](docs/appointments.md) |

Both planes stay. OrbitDB gives signed entries, an access controller and a
verifiable hash-linked history. Yjs gives tiny, loss-tolerant, order-independent
updates and a bootstrap measured in frames rather than kilobytes. **Pick by what
the application needs to be true** — the tradeoff table lives in #36.

## Phases

Ordered so that every phase is testable when it lands, and nothing waits on
hardware that does not have to.

### P0 · Error humaniser into the lib — #37 B ✅

Names now come from the **firmware enum** rather than a hand-copied table, so a
code this build does not know degrades to `"routing 41"` instead of `undefined`.

*Gate met:* `routingErrorName(5) === "MAX_RETRANSMIT"`; the hand-copied map is
gone from `App.svelte`.

### P1 · Yjs provider core — #36 S1–S2 ✅

`createYjsProvider` over `courier.send` / `courier.onPayload`. Built on **core
Yjs only** — no y-protocols, no lib0 — because state vectors and diffs are the
whole vocabulary needed. Plus the adaptations the radio forces: coalescing local
edits into one payload, echo suppression, `resync()`.

Two scope notes against the original plan: **awareness was dropped**, not
deferred within S2 — it is built for WebSocket cadence and would spend the
entire duty-cycle budget announcing who is looking at the document. And the
provider takes **any** `{ send, onPayload }`, so it is reusable outside this
repository; a test runs it with no framing, ARQ or radio to keep that honest.

*Gate met:* two docs converge across a 20 % frame-loss run with no manual
retries; a ten-keystroke burst produces **one** payload. No hardware needed.

### P2 · Reconnect supervisor into the lib — #37 A ✅

`connectMeshtasticDevice` holds the device-lifecycle state machine —
subscribe-before-configure, the generation guard, teardown-first reconnect,
exponential backoff, the stability timer, the give-up cap, `link.rebind`. The
transport stays the caller's business: it asks for a `createDevice` factory and
imports no transport itself, so it works over TCP or serial too.

*Gate met:* each clause is asserted against a stub `MeshDevice` with injected
disconnects; `mesh-todo` is repointed and its BLE branch lost ~100 lines. Caveat
worth keeping visible: the e2e suite runs the BroadcastChannel fake, so the
**BLE path is unit-tested, not yet re-confirmed on hardware** — that is P7's
job, and the next field run should watch for it.

### P3 · Appointment core — #38 A1–A3 ✅

The document model, the slot engine (rules → grid, never enumerations), the busy
mask, capability keys, and the deterministic arbitration that makes two
customers racing for one slot resolve identically on both sides **without
exchanging a packet**.

Measured, rather than asserted: three weeks of availability travel as **422
bytes of rules** (516 slots would have been kilobytes), and busy time as a
**72-byte** bitmap — one frame, the same size empty or full.

*Gate met:* 200 shuffles of twelve contested claims give one identical verdict,
and so do three Yjs replicas fed the same updates in different orders. Over a
20 %-loss mesh two customers race for one slot: both sides name the same winner,
the loser is told why and offered alternatives, and the payload counter **does
not move** while arbitration happens.

Two bugs the tests caught and the code would not have shown: a `Y.Map` is not an
`instanceof Map`, so decisions were silently never read — invisible in auto mode,
which never consults them; and a comparator read the decision timestamp off the
claim instead of the decision, falling through to the id. Deterministic, but the
wrong policy.

Deliberately deferred and written down rather than forgotten: **document
compaction** (a salon books for years and Yjs keeps history) and the fact that
changing `slotMinutes` shifts the whole grid index space.

### P4 · `.ics` and the serverless Calendly link — #38 A4 ◐

Generator with folding counted in **octets** (not characters, and never
splitting a multi-byte character), TEXT escaping in the order that does not
double-escape, stable `UID` with a rising `SEQUENCE` so a change replaces rather
than duplicates, and `METHOD:CANCEL` for a withdrawal. Times in UTC, so no
`VTIMEZONE` ships. The customer's file carries the capability link; the salon's
does not.

*Gate half met:* structure is proven in CI — every line ≤ 75 octets, CRLF
throughout, a full parse-back round trip, and a real booking round-tripping to a
cancel whose signature verifies. **Import into Apple Calendar, Google Calendar
and Thunderbird is a manual check and has not been done**; until it has, treat
this phase as open.

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
