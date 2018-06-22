self.addEventListener('install', function(e) {
 e.waitUntil(
   caches.open('video-store').then(function(cache) {
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

self.addEventListener('fetch', function(e) {
  console.log(e.request.url);
  e.respondWith(
    caches.match(e.request).then(function(response) {
      return response || fetch(e.request);
    })
  );
});