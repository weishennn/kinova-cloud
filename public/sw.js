const CACHE_NAME = 'kinova-pwa-v7';
const APP_SHELL = [
  '/',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/apple-touch-icon.png',
  '/kinova-header-logo.png',
  '/kinova-logo.png',
  '/kinova-mark.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
          return null;
        })
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Never cache dynamic API routes or external cloud APIs (Google Sheets, MSAL, Gemini)
  if (
    url.pathname.startsWith('/api/') ||
    url.hostname.includes('google.com') ||
    url.hostname.includes('googleapis.com') ||
    url.hostname.includes('microsoftonline.com') ||
    url.hostname.includes('microsoft.com')
  ) {
    return;
  }

  // Only handle same-origin requests and Google Fonts
  if (
    url.origin !== self.location.origin &&
    url.hostname !== 'fonts.googleapis.com' &&
    url.hostname !== 'fonts.gstatic.com'
  ) {
    return;
  }

  // Network-first with CacheStorage fallback so updates appear immediately when online,
  // and the full Next.js app shell + static chunks open seamlessly when offline.
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response && response.status === 200) {
          const clone = response.clone();
          caches
            .open(CACHE_NAME)
            .then((cache) => cache.put(request, clone))
            .catch(() => {});
        }
        return response;
      })
      .catch(async () => {
        const exactMatch = await caches.match(request);
        if (exactMatch) return exactMatch;
        const pathMatch = await caches.match(request, { ignoreSearch: true });
        if (pathMatch) return pathMatch;
        if (request.mode === 'navigate') {
          const rootShell = await caches.match('/');
          if (rootShell) return rootShell;
        }
        return new Response('Offline', { status: 503, statusText: 'Offline' });
      })
  );
});
