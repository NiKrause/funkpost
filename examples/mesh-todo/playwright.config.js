// SPDX-License-Identifier: GPL-3.0-only
import { defineConfig } from "@playwright/test";
import { relayAddr, relayPort } from "./e2e/relay-key.js";

export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  retries: process.env.CI ? 1 : 0,
  use: { baseURL: "http://localhost:4173" },
  webServer: [
    {
      // The internet path needs a relay to be reachable through; this one is on
      // the test machine, so no run depends on a deployed relay or the network.
      command: "node e2e/relay.js",
      port: relayPort,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: "npm run build && npm run preview -- --port 4173 --strictPort",
      port: 4173,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      // Baked into the build: the page then never asks the registry on Aleph.
      env: { VITE_RELAY_ADDRS: relayAddr },
    },
  ],
});
