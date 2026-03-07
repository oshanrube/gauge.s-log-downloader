// sw.js — Service Worker for Gauge.S Downloader
// Strategy: cache-first for the app shell (index.html + manifest).
// Network requests to 192.168.4.1 are always sent live (never cached).

const CACHE_NAME = 'gauges-downloader-v1';

// Files that make up the app shell
const SHELL = [
  './',
  './index.html',
  './manifest.json',
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
  const url = new URL(event.request.url);

  // Never intercept requests going to the gauge device
  if (url.hostname === '192.168.4.1') return;

  event.respondWith(
    caches.match(event.request).then(cached => {
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
      });
    })
  );
});
