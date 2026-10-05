/* Only this app's files/caches are handled. An update waits until old game windows close. */
importScripts('./offline-assets.js');
const PREFIX = 'burrow-brawl:' + self.registration.scope + ':';
const CACHE = PREFIX + self.BB_OFFLINE.version;
const urls = self.BB_OFFLINE.assets.map(p => new URL(p, self.registration.scope).href);
const known = new Set(urls);
const entry = new URL('./burrow-brawl.html', self.registration.scope).href;

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    try {
      await cache.addAll(urls.map(url => new Request(url, { cache: 'reload' })));
    } catch (error) {
      await caches.delete(CACHE); // A partial download is never reported as offline-ready.
      throw error;
    }
  })());
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    await Promise.all((await caches.keys()).filter(k => k.startsWith(PREFIX) && k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});
self.addEventListener('message', event => {
  if (!['BB_OFFLINE_STATUS', 'BB_OFFLINE_REPAIR'].includes(event.data?.type)) return;
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    if (event.data.type === 'BB_OFFLINE_REPAIR') {
      try { await cache.addAll(urls.map(url => new Request(url, { cache: 'reload' }))); }
      catch { event.source?.postMessage({ type: 'BB_OFFLINE_REPAIR_FAILED' }); return; }
    }
    const complete = (await Promise.all(urls.map(url => cache.match(url)))).every(Boolean);
    event.source?.postMessage({ type: complete ? 'BB_OFFLINE_READY' : 'BB_OFFLINE_INCOMPLETE', version: self.BB_OFFLINE.version, bytes: self.BB_OFFLINE.bytes, files: urls.length });
  })());
});
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url); url.search = ''; url.hash = '';
  if (url.origin !== self.location.origin) return;
  // The directory entry and launcher query strings work offline as well.
  const key = url.href === self.registration.scope ? entry : url.href;
  if (!known.has(key)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(key);
    return hit || fetch(req);
  })());
});
