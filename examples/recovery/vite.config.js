// SPDX-License-Identifier: GPL-3.0-only
import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { nodePolyfills } from "vite-plugin-node-polyfills";

const rootPkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));

export default defineConfig({
  define: {
    __BUILD_INFO__: JSON.stringify({
      version: rootPkg.version,
      commit: (process.env.GITHUB_SHA ?? "local").slice(0, 7),
      builtAt: `${new Date().toISOString().slice(0, 16)}Z`,
    }),
  },
  base: process.env.PAGES_BASE ?? "/",
  // @orbitdb/core reaches for node's `events`; the bridge's CAR handling for
  // `buffer`. No Meshtastic here — this page never touches a radio.
  plugins: [
    svelte(),
    nodePolyfills({ include: ["events", "buffer", "process", "util"] }),
  ],
  server: { port: 5198 },
});
