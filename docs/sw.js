// 오프라인 캐시. 고친 뒤 VERSION을 올리면 기기에서 다음에 열 때 새 판으로 바뀐다 (js/main.js의 VERSION과 같게).
const VERSION = 'v6';
const CACHE = 'liveshoot-' + VERSION;
const FILES = ['./', 'index.html', 'app.css', 'manifest.webmanifest', 'js/main.js', 'js/gl.js', 'js/store.js', 'js/curve.js', 'js/export.js', 'js/geometry.js', 'js/exif.js', 'js/raw.js', 'js/profiles.js', 'hdr-test.html',
  'vendor/libraw/index.js', 'vendor/libraw/worker.js', 'vendor/libraw/libraw.js', 'vendor/libraw/libraw.wasm',
  'icons/icon.svg', 'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

// 같은 사이트 파일만: 네트워크 먼저(서버에 최신 여부를 늘 확인), 안 되면 캐시
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' }).then((r) => {
      const copy = r.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
      return r;
    }).catch(() => caches.match(e.request).then((r) => r || caches.match('index.html')))
  );
});
