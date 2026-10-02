// SPDX-License-Identifier: GPL-3.0-only
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  use: { baseURL: "http://localhost:4175" },
  webServer: {
    // No relay and no second server: this demo has no database, so there is
    // nothing for an internet path to carry and nothing to bootstrap from.
    command: "npm run build && npm run preview -- --port 4175 --strictPort",
    port: 4175,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
