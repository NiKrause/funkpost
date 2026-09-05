<!-- SPDX-License-Identifier: GPL-3.0-only -->

# The appointment core

Status: **built and tested** ([#38](https://github.com/NiKrause/funkpost/issues/38)
A1–A3) — the domain only. No UI yet (P5), no `.ics` yet (P4), never run on
hardware (P7). Tests: `examples/mesh-appointments/test/`.

An appointment book for a local business, on the Yjs plane. It is the demo that
proves the plane, and it was chosen because it exercises what a lossy,
duty-cycled, high-latency link is *worst* at: contention for a scarce resource
that two people want at once.

## Convergence is not agreement

Yjs will happily merge two bookings for 14:00. Both replicas end up
byte-identical and **double-booked**. The CRDT has not solved the conflict; it
has only made everyone agree that one exists.

The answer is a **pure function of the converged state**. Every replica sorts
the same claims by the same total order and reaches the same verdict on its
own:

```js
arbitrate({ mode, requests, decisions, cancels }) // → Map<id, { status, reason }>
```

Nothing is written to resolve a race, so resolving one cannot start another —
and **no packet crosses the air to do it**, which is the difference between a
design that works and one that only works in the demo. The test asserts exactly
that: after two customers race for one slot over a 20 %-loss mesh, both sides
name the same winner and the payload counter does not move.

Clock skew between two phones changes *which* of two near-simultaneous claims
wins. It never changes *whether* the two agree — a tie on the timestamp falls
through to the booking id, which is arbitrary but identical everywhere.

### The two modes differ in what outranks what

| | **auto** — Autobestätigung | **ask** — Rückfrage |
|---|---|---|
| who decides | time: earliest claim wins | the salon: a confirmation outranks any earlier request |
| salon must be reachable | no — books while the salon sleeps | yes |
| double-booking under partition | possible, resolved deterministically but **late** | impossible: only the salon writes confirmations |
| pending requests | none | do **not** block each other — an abandoned request must never hold a slot for ever |

That asymmetry is the whole argument for offering both, and it is why the mode
lives in the shop rules rather than in the code.

## Availability is a rule, never a list

The single most important decision here. A salon open ten hours a day has ~516
quarter-hour slots in three weeks; shipping them as data would cost kilobytes
of airtime and would have to be re-shipped whenever the horizon moved.

Shipping the **rule** — opening hours per weekday, plus closures — costs about
**420 bytes** and describes any horizon at all. Every device generates the
identical grid from it.

"Identical" is load-bearing: the grid is also the index space for the busy
mask, so two devices disagreeing about slot 400 would disagree about who is
booked. Hence `slotGrid` is pure, and the tests pin it across **daylight-saving
transitions**, where the naive answer is wrong twice a year:

- **Spring forward** — 02:00–02:59 does not exist. A slot there would book
  someone into a second that never happens, so `utcFromWall` returns `null` and
  the grid skips it.
- **Autumn** — 02:00–02:59 happens twice. The earlier instant is chosen, and
  the night is genuinely five hours long between 01:00 and 05:00.

No date library: `Intl.DateTimeFormat` already knows every zone's rules, and
asking it what the wall clock read at an instant is enough to invert the map.

## Busy time is a bitmap

A customer does not need to know *who* is booked at 14:00, only that it is
gone. Sending the salon's bookings would leak names to every neighbour on the
channel and cost bytes per booking; a bitmap costs one bit per slot regardless
of how full the day is.

Three weeks of quarter-hours ≈ **72 bytes** including a seven-byte header —
one LoRa frame, and the same size empty or full.

The mask is a **compaction, not the authority**: live requests travel as their
own entries and count the moment they merge. A mask whose horizon or length
disagrees with the grid we just generated is **discarded**, not trusted —
silently reading someone else's index space is how a customer gets booked into
a Ruhetag.

## The capability key

The `.ics` link carries a token in its fragment. The naive design makes that
token a *password* — know it, cancel the booking — which on a shared broadcast
channel is worthless: every neighbour in radio range watched the booking go
past and could replay it.

So the token is a **seed**, not a secret to be quoted. It derives an Ed25519
key pair; the booking carries only the public half, and a cancellation must be
**signed**. Overhearing a booking therefore proves nothing. The token never
crosses the air — it lives in the URL fragment, which browsers do not send
anywhere.

Pure WebCrypto (browser and Node ≥ 20): the seed is wrapped in the fixed PKCS#8
prefix and imported, and the public half is read back out of the JWK export.

**What this does not do:** make a public channel private. Everyone still *sees*
the booking. Confidentiality needs a private Meshtastic channel, and the UI
must say so.

## The document

Shaped to keep concurrent writers off each other's keys. Yjs has no access
control, so rather than bolt one on, each role owns a map and every entry is
keyed by booking id:

| map | written by |
|---|---|
| `shop` | the salon — the rules, including the mode |
| `requests` | the customer who owns that id |
| `decisions` | the salon |
| `cancels` | whoever holds the capability key |
| `mask` | the salon |

Two writers therefore practically never touch the same key, and the CRDT is
left doing set-union — the case it is perfect at.

Only a first name and a service id ever travel. Everything else a salon knows
about a customer belongs in a local document that is never synced.

## Open, and deliberately so

- **Document compaction.** A salon books for years and Yjs keeps history.
  Folding settled bookings into the mask and deleting them, or starting a new
  document each season — undecided, and it needs deciding before anyone runs
  this for real.
- **Changing `slotMinutes` shifts the whole index space.** A booking stores its
  own `steps` so it survives a service getting longer, but the grid itself is
  not versioned. Same conversation as compaction.
