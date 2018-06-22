var cacheStoreName = "video-store";

self.addEventListener('install', function(e) {
 e.waitUntil(
   caches.open(cacheStoreName).then(function(cache) {
     return cache.addAll([
       '/a2hs/',
       '/a2hs/index.html',
       '/a2hs/style.css',
       '/a2hs/jquery-3.2.1.slim.min.js',
       '/a2hs/GPUFluid-1.3.js'
     ]);
   })
 );
});

// Fetching content using Service Worker
self.addEventListener('fetch', function(e) {
  e.respondWith(
    caches.match(e.request).then(function(r) {
      console.log('[Service Worker] Fetching resource: '+e.request.url);
      return r || fetch(e.request).then(function(response) {
        return caches.open(cacheStoreName).then(function(cache) {
          console.log('[Service Worker] Caching new resource: '+e.request.url);
          cache.put(e.request, response.clone());
          return response;
        });
      });
    })
  );
});


self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', () => self.clients.claim());