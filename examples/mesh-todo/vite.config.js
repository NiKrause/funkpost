// SPDX-License-Identifier: GPL-3.0-only
import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { nodePolyfills } from "vite-plugin-node-polyfills";

export default defineConfig({
  // @orbitdb/core imports node's `events`, @meshtastic/core's logger pulls
  // `os`/`path`/`util` — the same builtins the official Meshtastic web
  // client polyfills for the browser.
  plugins: [svelte(), nodePolyfills({ include: ["events", "os", "path", "util", "buffer", "process"] })],
  server: {
    port: 5199,
    // The library is a file:../.. symlink; let the dev server follow it.
    fs: { allow: ["../.."] },
  },
});
