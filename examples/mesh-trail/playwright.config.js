// SPDX-License-Identifier: GPL-3.0-only
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  // 4176, not 4175: mesh-heartbeat preview-serves on that one, and with
  // `reuseExistingServer` a leftover server from its suite would have this
  // one testing the wrong app and reporting it as a failure here.
  use: { baseURL: "http://localhost:4176" },
  webServer: {
    // No relay and no second server: this demo has no database, so there is
    // nothing for an internet path to carry and nothing to bootstrap from.
    command: "npm run build && npm run preview -- --port 4176 --strictPort",
    port: 4176,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
