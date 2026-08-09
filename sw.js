// sw.js — Service Worker for Gauge.S Downloader
// Strategy: cache-first for the app shell (index.html + manifest + icons).
// Network requests to 192.168.4.1 are always sent live (never cached).
//
// NOTE: keep APP_VERSION in sync with the one in index.html.
// Bumping it invalidates the old cache so users pick up shell updates.

const APP_VERSION = '1.8.0';
const CACHE_NAME = `gauges-downloader-v${APP_VERSION}`;

// Files that make up the app shell
const SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
];

// ── Install: pre-cache the app shell ────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL))
  );
  // Activate immediately without waiting for old tabs to close
  self.skipWaiting();
});

// ── Activate: remove stale caches ───────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_NAME)
          .map(k => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// ── Fetch: cache-first for app shell; bypass cache for device requests ───────
self.addEventListener('fetch', event => {
  // Only handle GET — DELETE/POST to the device must never be intercepted
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // Never intercept cross-origin requests — the gauge device can live at
  // any address (AP mode 192.168.4.1, hotspot, etc.), so only handle our
  // own origin (the cached app shell).
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(event.request, { ignoreSearch: true }).then(cached => {
      if (cached) return cached;

      // Not in cache — try network, then update cache for same-origin resources
      return fetch(event.request).then(response => {
        if (
          response.ok &&
          url.origin === self.location.origin
        ) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => {
        // Offline and not cached: fall back to the app shell for navigations
        if (event.request.mode === 'navigate') {
          return caches.match('./index.html');
        }
        return Response.error();
      });
    })
  );
});
