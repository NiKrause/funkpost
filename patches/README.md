# patches

Changes to dependencies, applied by [`patch-package`](https://github.com/ds300/patch-package)
on every install (the `prepare` script). Each one is a bug fix waiting for
upstream, kept as small as the fix, and removed when upstream ships it.

| patch | fixes | shown by |
|---|---|---|
| `@orbitdb+core+4.0.0.patch` | OrbitDB's heads exchange read each stream chunk as exactly one entry. libp2p 3 hands a reader that starts late everything buffered as one chunk, so a log with two heads failed to sync with *CBOR decode error: too many terminals* ([#107](https://github.com/NiKrause/funkpost/issues/107)). The receiver now splits on CBOR item boundaries. Nothing on the wire changes, so patched and unpatched peers still talk. | `test/orbitdb-heads-framing.test.js` |

A patch changes the dependency's own code and is offered under the
dependency's licence — OrbitDB's is MIT — so that it can go upstream as it is.
