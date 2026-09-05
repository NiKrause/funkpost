// SPDX-License-Identifier: GPL-3.0-only
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  retries: process.env.CI ? 1 : 0,
  use: { baseURL: "http://localhost:4174" },
  webServer: {
    command: "npm run build && npm run preview -- --port 4174 --strictPort",
    port: 4174,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
