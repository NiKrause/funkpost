// SPDX-License-Identifier: GPL-3.0-only
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { nodePolyfills } from "vite-plugin-node-polyfills";

const rootPkg = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
);

export default defineConfig({
  define: {
    // Version · commit · build time, shown in the footer — so a phone in a
    // rucksack can always tell which deploy it is talking to. On a ride, that
    // is the difference between a result and an anecdote.
    __BUILD_INFO__: JSON.stringify({
      version: rootPkg.version,
      commit: (process.env.GITHUB_SHA ?? "local").slice(0, 7),
      builtAt: `${new Date().toISOString().slice(0, 16)}Z`,
    }),
  },
  build: {
    // Two pages, because a social card is read by a scraper that has no idea
    // what language anybody switched on — so German needs an address of its
    // own. `de/index.html` is generated from this one by the prebuild step.
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        de: fileURLToPath(new URL("./de/index.html", import.meta.url)),
      },
    },
  },
  // GitHub Pages serves the demo under /funkpost/; local dev stays at /.
  base: process.env.PAGES_BASE ?? "/",
  // Only what @meshtastic/core's logger reaches for. mesh-todo also polyfills
  // `events`, which @orbitdb/core wants — this demo has no database either:
  // positions are the whole payload, and nothing here is replicated.
  plugins: [
    svelte(),
    nodePolyfills({
      include: ["os", "path", "util", "buffer", "process"],
      overrides: {
        // The stock polyfill lacks formatWithOptions/types.isNativeError,
        // which @meshtastic/core's logger calls — see the shim.
        util: fileURLToPath(new URL("./src/shims/node-util.js", import.meta.url)),
      },
    }),
  ],
  server: {
    // One port per demo: a field test runs more than one of these side by
    // side, one per phone, and a collision at the kerb is a wasted trip.
    port: 5399,
    // The library is a file:../.. symlink; let the dev server follow it.
    fs: { allow: ["../.."] },
  },
});
