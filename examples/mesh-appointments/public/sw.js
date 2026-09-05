// SPDX-License-Identifier: GPL-3.0-only
/**
 * Keeping the app shell so a calendar link still opens without a network.
 *
 * The `.ics` a customer downloads carries a link back to this page. Tapping it
 * months later, in a village with no signal, must still work — and the only
 * thing that needs the network is the page itself. Everything the link then
 * *does* travels over the radio.
 *
 * Runtime caching, deliberately, rather than a precache manifest: whatever the
 * app fetches is kept, so the second visit is offline-capable. Being honest
 * about what that fixes and what it does not:
 *
 * - Somebody who has opened this app before — which is everybody who booked
 *   through it — can open their link with no network at all.
 * - A stranger tapping a cold link on a device that has never loaded the page
 *   still needs the network once. No service worker can change that, which is
 *   why the QR code at the counter is the offline-native path.
 *
 * Stale-while-revalidate: the cached copy answers immediately and a fresh one
 * is fetched in the background, so an offline device is never blocked on a
 * request that cannot succeed, and an online one still picks up a new deploy.
 *
 * One trap worth naming, because it costs an afternoon: the Cache API honours
 * `Vary` by default, and plenty of servers answer with `Vary: Origin`. A stored
 * entry then fails to match a later request for the very same URL, the lookup
 * silently misses, and the page is blank offline while the cache visibly holds
 * exactly what it wanted. Every match here passes `ignoreVary`.
 */

const CACHE = "funkpost-termine-v1";

self.addEventListener("install", (event) => {
  // Take the shell now, so the very first reload is already covered.
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.add("./")).catch(() => {}),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // never our business

  // A navigation carries no fragment, so `#/b/…` arrives as a plain request
  // for the app root — which is exactly what we cached.
  const key = request.mode === "navigate" ? new Request("./", { credentials: "same-origin" }) : request;

  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const hit = await cache.match(key, { ignoreVary: true });
      const fresh = fetch(request)
        .then((response) => {
          if (response.ok) cache.put(key, response.clone());
          return response;
        })
        .catch(() => null);
      // Cached answer wins on speed; the network refreshes it for next time.
      return hit ?? (await fresh) ?? new Response("offline", { status: 503 });
    }),
  );
});
