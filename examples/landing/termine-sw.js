// SPDX-License-Identifier: GPL-3.0-only
/**
 * Retires the service worker that used to run mesh-calendar at
 * `/funkpost/termine/`. Deployed as `/funkpost/termine/sw.js`.
 *
 * Without this, the move would not reach anybody who had already opened the
 * demo: their installed worker answers navigations from its cache, so they
 * would keep getting the old build at the old address and never see the
 * redirect. (It refreshes in the background, so it would heal on the *second*
 * visit — this makes it the first.)
 *
 * Browsers fetch a worker's script from the network on navigation, bypassing
 * the worker's own fetch handler, so replacing the file here is enough to get
 * this one installed.
 *
 * It deletes no caches, on purpose. Cache storage is per origin and the live
 * app deliberately kept the same cache name (see mesh-calendar/public/sw.js),
 * so clearing "the old cache" here would clear the new app's shell as well.
 * A few stale entries nobody serves are cheaper than that.
 */

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(self.registration.unregister());
});

// No fetch handler: with none, requests go straight to the network — which is
// the redirect page — even before the unregistration finishes.
