// SPDX-License-Identifier: GPL-3.0-only
import { mount } from "svelte";
import App from "./App.svelte";

const CACHE = "funkpost-mesh-todo-v1";

/**
 * Put the shell in the cache from the page, not from the worker.
 *
 * On a first visit the scripts and styles are fetched *before* any service
 * worker controls the page, so its fetch handler never sees them and they are
 * never cached — and the next visit, offline, fails on the very first asset.
 * The page knows exactly what it loaded, so it stores that itself.
 */
async function keepTheShell() {
  try {
    const cache = await caches.open(CACHE);
    const root = new URL(import.meta.env.BASE_URL, location.origin).href;
    const assets = performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .filter((url) => url.startsWith(location.origin) && /\.(js|css|webmanifest)(\?|$)/.test(url));
    await cache.addAll([...new Set([root, ...assets])]);
    // Say so, once it is actually true. A service worker becomes the page's
    // controller well before the shell is stored, so "controlled" is not the
    // same as "will open offline" — and only the second one is worth claiming.
    document.documentElement.dataset.offlineReady = "true";
  } catch {
    // A browser that refuses the Cache API simply has no offline shell. That
    // is not worth an error on a customer's screen.
  }
}

async function installShell() {
  try {
    await navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, {
      scope: import.meta.env.BASE_URL,
    });
    await keepTheShell();
  } catch {
    /* no offline shell; everything else still works */
  }
}

// Production only: a service worker in front of the dev server just fights hot
// reload. Waiting for `load` is not enough on its own — this file is a module,
// and by the time it runs the event has usually already fired, so the listener
// would never be called and the worker would never register.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  if (document.readyState === "complete") installShell();
  else window.addEventListener("load", installShell, { once: true });
}

mount(App, { target: document.getElementById("app") });
