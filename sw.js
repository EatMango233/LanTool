/* ==========================================
 * sw.js — Service Worker
 * 缓存策略：Cache First + Network Fallback
 * CDN 资源不缓存；更新时跳过等待并提示刷新
 * ========================================== */
const CACHE_NAME = 'lantoool-v10'

const PRECACHE = [
  './',
  './index.html',
  './manifest.json',
  './style/main.css',
  './js/app.js',
  './js/device.js',
  './js/trust.js',
  './js/relay.js',
  './js/webrtc.js',
  './js/chat.js',
  './js/file.js',
  './js/clipboard.js',
  './js/voice.js',
  './js/history.js',
  './js/pwa.js',
  './js/utils.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
]

/* 安装：预缓存核心资源 */
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  )
})

/* 激活：清理旧缓存，立即接管 */
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

/* 请求处理：HTML 主文档网络优先（部署后必拿到最新页面）；
 * 其余同源静态资源 Cache First + Network Fallback；CDN 不缓存 */
self.addEventListener('fetch', (e) => {
  const req = e.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return // CDN 不缓存
  if (req.url.includes('chrome-extension')) return

  // 主文档导航：网络优先，失败回退缓存（保证新部署立即生效）
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const clone = res.clone()
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone))
          }
          return res
        })
        .catch(() => caches.match(req))
    )
    return
  }

  e.respondWith(
    caches.match(req).then((cached) => {
      const fetched = fetch(req).then((res) => {
        // 成功响应且为同源文件 → 存入缓存
        if (res && res.ok) {
          const clone = res.clone()
          caches.open(CACHE_NAME).then((cache) => cache.put(req, clone))
        }
        return res
      })
      return cached || fetched
    })
  )
})