/* Cuckoo 工作台 Service Worker
 * 缓存策略：
 *  - 页面导航：network-first（保证更新及时），离线回退缓存的 index.html
 *  - 同源静态资源（manifest/icon）：cache-first
 *  - 跨域请求（用户配置的 API）：完全不缓存
 * 发新版本时递增 CACHE 版本号即可清空旧缓存。
 */
const CACHE = 'cuckoo-v12';
const ASSETS = ['./', './index.html', './manifest.webmanifest', './icon.svg'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.origin !== location.origin) return; // API 请求不拦截

  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then(res => {
          const cp = res.clone();
          caches.open(CACHE).then(c => c.put('./index.html', cp));
          return res;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  e.respondWith(
    caches.match(req).then(hit => hit ||
      fetch(req).then(res => {
        if (res.ok) {
          const cp = res.clone();
          caches.open(CACHE).then(c => c.put(req, cp));
        }
        return res;
      }).catch(() => caches.match('./index.html'))
    )
  );
});
