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
    // Version · commit · build time, shown in the footer — so a phone can
    // always tell which deploy it is talking to.
    __BUILD_INFO__: JSON.stringify({
      version: rootPkg.version,
      commit: (process.env.GITHUB_SHA ?? "local").slice(0, 7),
      builtAt: `${new Date().toISOString().slice(0, 16)}Z`,
    }),
  },
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
