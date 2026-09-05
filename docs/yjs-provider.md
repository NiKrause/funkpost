<!-- SPDX-License-Identifier: GPL-3.0-only -->

# The Yjs provider

A [Yjs](https://yjs.dev) provider that syncs a `Y.Doc` over a **byte courier**
— on a LoRa mesh through funkpost, or over any transport you already have.

Status: **built and tested** ([#36](https://github.com/NiKrause/funkpost/issues/36)
S1–S2). Convergence and coalescing are covered by
[`test/yjs-provider.test.js`](../test/yjs-provider.test.js); it has not yet run
over real hardware.

## Use it from any project

**This provider is not tied to funkpost, to LoRa, or to Meshtastic.** It talks
to a *courier*, and a courier is any object with two methods:

```js
{
  send(bytes: Uint8Array): Promise<void>,
  onPayload(cb: (bytes: Uint8Array) => void): () => void   // returns unsubscribe
}
```

That is the entire contract. funkpost's Meshtastic courier satisfies it, and so
does a WebSocket wrapper, a `BroadcastChannel`, a serial line, a WebRTC data
channel, or thirty lines of your own. The test suite proves the point by
running the provider over a bare in-memory pair with no framing, no ARQ and no
radio anywhere — *"works with any courier — nothing here is funkpost-specific"*.

```bash
npm install @le-space/funkpost yjs
```

`yjs` is an **optional peer dependency**: funkpost's core does not pull it in,
and the provider lives behind its own subpath, so projects that only want the
byte courier pay nothing for it.

```js
import * as Y from "yjs";
import { createYjsProvider } from "@le-space/funkpost/yjs";

const doc = new Y.Doc();
const provider = createYjsProvider({ doc, courier });

doc.getMap("todos").set("t1", { text: "Milch kaufen", done: false });
// …and it is on its way. Every peer on the same courier converges.
```

Over a real mesh, `courier` is funkpost's:

```js
import { createMeshtasticCourier, createMeshtasticDeviceLink } from "@le-space/funkpost";

const link = createMeshtasticDeviceLink({ device });         // a connected MeshDevice
const courier = createMeshtasticCourier({ link, region: "EU_868" });
const provider = createYjsProvider({ doc, courier, coalesceMs: 400 });
```

Nothing about the provider changes between the two. That separability is the
claim the whole repository is built to test — see [ROADMAP.md](../ROADMAP.md).

## The protocol

Two messages behind a one-byte tag:

| tag | message | meaning |
|---|---|---|
| `0` | `STATE_VECTOR` | here is what I have |
| `1` | `UPDATE` | here are some changes |
| `2` | *(reserved)* | awareness — deliberately unimplemented, see below |

A Yjs update is binary, compressed, **commutative, associative and
idempotent**. That last property is why the protocol is this short: a
duplicated, reordered or replayed `UPDATE` is harmless, so there are no
sequence numbers, no per-peer session state and no handshake to tear down. It
suits a broadcast medium, where *"who is on the other side"* is not a stable
question.

Convergence:

1. A peer publishes its **state vector**.
2. Anyone holding entries that vector does not cover replies with **exactly the
   missing diff** — `Y.encodeStateAsUpdate(doc, theirVector)`, never the whole
   document.
3. A peer that *receives* a vector covering entries **it** lacks publishes its
   own vector in reply, so the pull runs in both directions.
4. Once the two vectors cover each other, neither condition fires and the
   exchange **goes quiet**. No polling, no keepalive.

Step 3 is rate-limited by `minAnnounceGapMs` so two peers meeting for the first
time cannot ping-pong.

## Airtime

Two adaptations exist purely because a duty-cycled radio bills by the byte:

- **Coalescing.** `doc.on("update")` fires per keystroke. The provider buffers
  the diffs and folds them with `Y.mergeUpdates` into **one** payload per
  `coalesceMs` window. The test asserts ten edits cost one payload — the
  difference between paying airtime per keystroke and per thought.
- **Diffs, never documents.** Step 2 above sends only what the peer is missing.

Both are why a Yjs booking or todo entry is measured in tens of bytes where the
OrbitDB plane's first-contact bundle is measured in kilobytes. The two planes'
tradeoffs are compared in [#36](https://github.com/NiKrause/funkpost/issues/36).

## Options

| option | default | what it does |
|---|---|---|
| `doc` | — | the `Y.Doc` (required) |
| `courier` | — | any `{ send, onPayload }` (required) |
| `coalesceMs` | `400` | merge local edits inside this window into one payload; `0` sends each immediately |
| `minAnnounceGapMs` | `1000` | floor between *automatic* state-vector publications; `resync()` ignores it |
| `announceOnStart` | `true` | publish a state vector on start — how a joiner asks for what it lacks |
| `timers` | real | injectable clock, for tests |
| `onEvent` | — | `sent` / `applied` / `coalesced` / `vector-rx` / `error`, for a sync pane |

Returned: `resync()`, `announce()`, `flush()`, `synced(docOrVector)`, `stats`,
`destroy()`.

`resync()` is the one to call after a reconnect — the peer re-answers with
whatever the drop interrupted, the same move the OrbitDB plane makes with
`announce()`.

## What is deliberately absent

**Awareness** (cursors, presence, "who is here"). It is built for WebSocket
cadence — many small messages per second — and on a duty-cycled link it would
spend the whole airtime budget announcing who is looking at the document,
starving the sync it is supposed to decorate. Tag `2` is reserved should a
carrier ever justify it.

**Signatures and access control.** Yjs has neither. On a shared channel the
channel key is the trust boundary; if you need signed entries and an access
controller, that is what the OrbitDB plane is for. The comparison table in
[#36](https://github.com/NiKrause/funkpost/issues/36) states the trade in full.

## Testing without hardware

The provider is testable end to end with no radio, using funkpost's in-memory
mesh — which enforces the MTU and misbehaves on request:

```js
import { createMemoryMeshPair } from "@le-space/funkpost/links/memory-mesh";

const pair = createMemoryMeshPair({ mtu: 60, lossFn: ({ seq }) => seq % 5 === 4 });
// two couriers over pair.a / pair.b, a provider on each, assert convergence
```

That is exactly how the 20 %-loss gate runs in CI.
