/* ==========================================
 * pwa.js — Service Worker 注册与更新
 * 缓存策略：Cache First + Network Fallback（见 sw.js）
 * ========================================== */

const SW_PATH = './sw.js'

/* 注册 Service Worker */
export function registerSW() {
  if (!('serviceWorker' in navigator)) return false
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register(SW_PATH)
      .then((reg) => {
        // 检测到新版本 → 提示用户刷新
        reg.addEventListener('updatefound', () => {
          const newWorker = reg.installing
          if (!newWorker) return
          newWorker.addEventListener('statechange', () => {
            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
              import('./utils.js').then((u) => u.toast('发现新版本，请刷新页面', 'info'))
            }
          })
        })
      })
      .catch(() => {})
  })
  // 激活时跳过等待
  navigator.serviceWorker.addEventListener('controllerchange', () => {})
  return true
}

/* 强制更新：通知 SW 清除旧缓存并刷新页面 */
export async function forceUpdate() {
  const reg = await navigator.serviceWorker.getRegistration()
  if (reg) {
    reg.update().catch(() => {})
  }
  location.reload()
}