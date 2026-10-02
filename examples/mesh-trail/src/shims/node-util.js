// SPDX-License-Identifier: GPL-3.0-only
/**
 * The browser `util` polyfill, completed.
 *
 * @meshtastic/core bundles tslog's node build, which calls
 * `util.formatWithOptions` and `util.types.isNativeError`. The polyfill
 * vite-plugin-node-polyfills ships (the npm `util` package) has `format` and
 * `types`, but not those two — so the first log line after a real Bluetooth
 * pairing crashed the app on the phone, while the fake-mesh path (which never
 * imports @meshtastic/core) sailed through every test. The
 * ?probe=meshtastic-core path and its e2e spec exist so that hole stays shut.
 *
 * This override re-exports the whole polyfill and fills exactly the two
 * holes. `formatWithOptions` drops the options object — that costs
 * pretty-print niceties, not correctness. The deep import path dodges the
 * `util` alias this file itself is mounted on.
 */
import * as polyfill from "../../../../node_modules/util/util.js";

export * from "../../../../node_modules/util/util.js";

export const formatWithOptions = (_options, ...args) => polyfill.format(...args);

export const types = {
  ...(polyfill.types ?? {}),
  isNativeError: polyfill.types?.isNativeError ?? ((value) => value instanceof Error),
};

export default { ...polyfill, formatWithOptions, types };
