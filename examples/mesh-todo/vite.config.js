// SPDX-License-Identifier: GPL-3.0-only
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { nodePolyfills } from "vite-plugin-node-polyfills";

export default defineConfig({
  // GitHub Pages serves the demo under /funkpost/; local dev stays at /.
  base: process.env.PAGES_BASE ?? "/",
  // @orbitdb/core imports node's `events`, @meshtastic/core's logger pulls
  // `os`/`path`/`util` — the same builtins the official Meshtastic web
  // client polyfills for the browser.
  plugins: [
    svelte(),
    nodePolyfills({
      include: ["events", "os", "path", "util", "buffer", "process"],
      overrides: {
        // The stock polyfill lacks formatWithOptions/types.isNativeError,
        // which @meshtastic/core's logger calls — see the shim.
        util: fileURLToPath(new URL("./src/shims/node-util.js", import.meta.url)),
      },
    }),
  ],
  server: {
    port: 5199,
    // The library is a file:../.. symlink; let the dev server follow it.
    fs: { allow: ["../.."] },
  },
});
