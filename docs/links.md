<!-- SPDX-License-Identifier: GPL-3.0-only -->

# The link layer: talking to a Meshtastic node

Status: **built and tested** — the supervisor against a stub device
([`test/supervisor.test.js`](../test/supervisor.test.js)), the link against the
in-memory mesh. The Bluetooth behaviour it exists to survive can only ever be
*confirmed* on hardware; see [field notes in the README](../README.md#field-notes).

Two files, deliberately split:

| file | job |
|---|---|
| `lib/links/meshtastic-device-link.js` | **mechanism** — bytes to packets on the private app port, and back |
| `lib/links/meshtastic-supervisor.js` | **policy** — keeping the node connected at all |

## Keeping a node connected

On a desktop this is a non-problem. On a phone it is most of the work: the OS
drops the GATT link under load, a write and a notification-read overlap, and
the naive fix (reconnect on disconnect) turns into a busy-loop that is worse
than the original fault.

```js
import { connectMeshtasticDevice } from "@le-space/funkpost";

const managed = await connectMeshtasticDevice({
  // Called once per (re)connect, so it must work without user interaction —
  // hold the BluetoothDevice rather than reopening the chooser.
  createDevice: async () =>
    new MeshDevice(await TransportWebBluetooth.createFromDevice(bleDevice)),

  // Built here, not afterwards, so the courier exists BEFORE configure() runs
  // and cannot miss the config stream. Region and airtime are wired into it.
  createCourier: (link) => createMeshtasticCourier({ link, region: "UNSET" }),

  on: {
    region: (name) => …,      // live, not once — see below
    airUtilTx: (percent) => …,
    status: (name) => …,
    nodeInfo: (node) => …,
    channel: (channel) => …,
    myNodeInfo: (info) => …,
    reconnecting: (attempt) => …,
    reconnected: (attempt) => …,
    gaveUp: (attempts) => …,
    error: (error) => …,
  },
});

managed.link;          // hand to a courier (or use managed.courier)
managed.device;        // a getter — reconnecting replaces the object
managed.setChannel(3); // transmit channel index
managed.reconnect();   // force a cycle: a Retry button
managed.close();       // stop supervising; nothing reconnects after this
```

The transport is never imported by the library. `createDevice` returns a
connected `MeshDevice` over Web Bluetooth in a browser, or TCP/serial in Node —
the supervisor does not care which.

### The clauses, and what each one cost

Every rule below is in the code because its absence broke a bench session.

| rule | what goes wrong without it |
|---|---|
| **Subscribe before `configure()`** | The config stream delivers region, channels, identity and neighbours in its first second and never replays. A watcher attached afterwards races it — and loses on a fast machine. |
| **Watch the region continuously** | A node that just rebooted (importing a shared channel makes it do exactly that) reports its region late. A one-shot read freezes the courier at `UNSET`, where it refuses to transmit. |
| **Tear the old device down first** | `disconnect()` clears the heartbeat timer and closes the GATT. Skip it and there are two connections to one radio: the *"GATT operation already in progress"* storm. |
| **One generation speaks** | Every past reconnect leaves live watchers behind. Without the guard each of them fires its own reconnect — and the teardown disconnect starts a fresh cycle by itself. |
| **Back off, and don't reset early** | A connect that drops again immediately looks like success. Resetting the counter there means a flapping stack retries forever at full speed. The counter only resets after the link *stays* up for `stableMs`. |
| **Give up** | A stack that keeps failing `gatt.connect` cannot be cured from JavaScript. Looping forever just hides that from the user; `gaveUp` lets the UI say so. |
| **Check before you close** | The transport reports a *failed GATT operation* as a disconnection. Closing the link then converts a hiccup into a real outage — repeatedly, until the cap. `isLinkAlive` tells the two apart. |

### Not every "disconnected" is a disconnection

The Web Bluetooth transport emits `DeviceDisconnected` with reason
`write-error` when a `writeValue` fails, and Android Chrome produces those
readily: a write and a notification-driven read overlap, and one loses. The GATT
link is still up — but the transport's `WritableStream` is now errored, so
nothing can be sent through it again.

Both halves of that matter. Ignoring the report leaves an app that can receive
and never send; acting on it by disconnecting destroys a working connection. So
a live link gets a **re-attach**: a fresh `MeshDevice` over the same open GATT,
with no `gatt.disconnect()`, no re-pairing and no radio renegotiation. The old
device is *parked* — its heartbeat pushed out to effectively never, since the
library offers no way to stop one — rather than disconnected, because
disconnecting it would close the very link being kept.

```js
connectMeshtasticDevice({
  createDevice,
  isLinkAlive: () => bleDevice.gatt?.connected === true,
});
```

Only when that predicate says the link is genuinely gone does the full teardown
run. A re-attach that fails falls through to one, and a link that keeps breaking
stops earning cheap repairs after `maxReattaches`.

This is also why the official web client looks steadier on the same hardware: it
does not reconnect at all — [meshtastic/web#589](https://github.com/meshtastic/web/issues/589)
is an open request for the feature — so a spurious report costs it nothing, and
a chat app writes rarely enough to seldom provoke one.
| **Heartbeat** | Browsers drop an idle GATT link after a few minutes. The official clients ping for this reason. |

### Options

| option | default | |
|---|---|---|
| `createDevice` | — | required; returns a connected `MeshDevice` |
| `createCourier` | — | optional `(link) => courier`; wires region + airtime automatically |
| `link` | `{}` | options for `createMeshtasticDeviceLink` |
| `heartbeatMs` | `30000` | keep-alive ping |
| `maxAttempts` | `5` | reconnects before `gaveUp` |
| `stableMs` | `8000` | how long a link must hold before the backoff resets |
| `backoff` | `defaultBackoff` | `(attempt) => ms`; the default is 1 s, 2 s, 4 s, 8 s, then 15 s |
| `timers` | real | injectable clock, for tests |

## Reading what the radio says

Meshtastic's send queue rejects a firmware refusal as a plain
`{ id, error: number }` object with **no `.message`** — so the obvious
`` `${err}` `` prints `"[object Object]"`, which is exactly what hid the real
cause for an evening on the bench.

```js
import { routingErrorName, describeMeshtasticError } from "@le-space/funkpost";

routingErrorName(5);                          // "MAX_RETRANSMIT"
describeMeshtasticError({ id: 42, error: 3 }); // "TIMEOUT (packet 42)"
describeMeshtasticError({ reason: err });      // unwraps a browser error event
```

Names come from the **firmware enum**, not a hand-copied table, so a code this
build does not know degrades to `"routing 41"` instead of `undefined`.

### `MAX_RETRANSMIT` is not a delivery failure

The link swallows `TIMEOUT`, `MAX_RETRANSMIT` and `NO_RESPONSE` rather than
failing the frame. On a broadcast these mean *"no acknowledgement was heard"* —
**not** *"the packet did not arrive"*, and on a busy public channel they fire
constantly on packets that did cross. The courier's own STATUS-driven ARQ is
the delivery authority; letting one of these abort a multi-fragment payload
throws away every fragment that got through. Hard errors (`NO_CHANNEL`,
`NOT_AUTHORIZED`, `TOO_LARGE`) still throw, named.

The full two-acknowledgements explanation is in
[the README](../README.md#deeper-four-layers-and-two-acknowledgements).

## The link itself

`createMeshtasticDeviceLink({ device, destination, channel, wantAck, mtu })`
gives the courier its `{ mtu, send, onFrame }` contract over the private
application port (256).

- **`wantAck` defaults to true** — not for the mesh's sake (the courier has its
  own end-to-end ARQ) but for the client library's: its packet queue completes
  a send only on a routing ACK, and a broadcast earns the firmware's implicit
  ACK only when `wantAck` is set. Without it every send hangs for 60 s.
- **`rebind(device)`** points the link at a reconnected device and re-subscribes
  the frame listeners, so the courier above survives the swap. The supervisor
  calls it for you.
- **`setChannel(index)`** changes only *transmission*. Reception decodes every
  channel the node holds a key for — a shared key sitting at index 3 helps
  nobody while the courier transmits on 0.

## Watchers

Each returns an unsubscribe function. The supervisor attaches all of them; use
them directly only if you are not using it.

`watchDeviceRegion` · `watchAirUtilTx` · `watchDeviceStatus` · `watchNodeInfo` ·
`watchChannels` · `watchMyNodeInfo`

`watchAirUtilTx` is worth singling out: it reports the node's **own measured**
transmit utilisation, which counts everything the radio does — beacons,
telemetry, relaying for the mesh — not just this app. The duty cycle binds the
device, so the device's number wins over any local estimate. Feeding it to
`courier.reconcileNodeAirtime()` is what makes the airtime budget survive page
reloads and multiple clients for free.

## The quietest failure in the stack

A packet the node cannot decrypt — the peer transmitting on a channel whose key
this node does not hold — is dropped inside `@meshtastic/core` with

```js
case "encrypted":
  this.log.debug("🔐 Device received encrypted data packet, ignoring.");
  break;
```

and nothing else. It never reaches a port, so `onPrivatePacket` never fires and
the app's received-frame count stays at **zero — exactly as if nobody were
there at all**.

Two very different situations with one indistinguishable symptom:

- nobody is in range, and
- somebody is in range and we cannot read a word they say.

`watchMeshTraffic(device, cb)` reports **every** packet the node hands over,
before the decrypt decision, so the two can be told apart. A screen can then say
*"12 packets heard, 12 of them unreadable"* instead of showing a silence that
means the opposite of what it looks like.

This is worth a UI element rather than a log line: it is the failure most likely
to waste an afternoon, and the fix — compare the channel key fingerprint on both
devices — is thirty seconds once you know that is the question.
