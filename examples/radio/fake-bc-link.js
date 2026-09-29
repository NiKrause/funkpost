// SPDX-License-Identifier: GPL-3.0-only
/**
 * A BroadcastChannel mesh link: two browser tabs on the same origin play the
 * two phones, the channel plays the radio. Same contract as the real device
 * link — MTU enforced, delivery is fire-and-forget, optional random loss —
 * so everything above it (courier, sync, app) runs unchanged.
 *
 * ?mesh=bc[&loss=0.15][&room=name] selects it; without the parameter the app
 * uses Web Bluetooth and a real node.
 */

export function createBroadcastChannelLink({ room = "mesh-todo", mtu = 200, loss = 0 } = {}) {
  const channel = new BroadcastChannel(`mesh-todo-link:${room}`);
  const listeners = new Set();
  channel.onmessage = (event) => {
    const bytes = event.data instanceof Uint8Array ? event.data : new Uint8Array(event.data);
    for (const cb of listeners) cb(bytes);
  };
  return {
    mtu,
    async send(bytes) {
      if (bytes.length > mtu) {
        throw new Error(`frame of ${bytes.length} bytes exceeds the ${mtu}-byte MTU`);
      }
      if (loss > 0 && Math.random() < loss) return; // the radio ate it
      channel.postMessage(bytes);
    },
    onFrame(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    close() {
      channel.close();
    },
  };
}
