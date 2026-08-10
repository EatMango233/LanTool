/* ==========================================
 * utils.js — 通用工具函数
 * 所有模块共享：格式化、事件总线、DOM 辅助
 * ========================================== */

/* 字节数格式化：B / KB / MB / GB */
export function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B'
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = bytes
  let u = -1
  do {
    v = v / 1024
    u++
  } while (v >= 1024 && u < units.length - 1)
  return v.toFixed(1) + ' ' + units[u]
}

/* 时间戳格式化：HH:mm:ss 或 MM-DD HH:mm */
export function formatTime(ts) {
  const d = new Date(ts)
  const pad = (n) => (n < 10 ? '0' + n : '' + n)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) {
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())
  }
  return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
}

/* 生成唯一 ID */
export function uid(prefix) {
  return (prefix || 'id') + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8)
}

/* 简单防抖 */
export function debounce(fn, wait) {
  let timer = null
  return function (...args) {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => fn.apply(this, args), wait)
  }
}

/* 数字钳制 */
export function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v))
}

/* ============================================================
 * 极简事件总线：模块间解耦通信
 * bus.on(type, fn) / bus.off / bus.emit(type, payload)
 * ============================================================ */
const handlers = {}

export const bus = {
  on(type, fn) {
    if (!handlers[type]) handlers[type] = []
    handlers[type].push(fn)
  },
  off(type, fn) {
    if (!handlers[type]) return
    handlers[type] = handlers[type].filter((h) => h !== fn)
  },
  once(type, fn) {
    const wrap = (p) => {
      this.off(type, wrap)
      fn(p)
    }
    this.on(type, wrap)
  },
  emit(type, payload) {
    ;(handlers[type] || []).forEach((fn) => {
      try {
        fn(payload)
      } catch (e) {
        console.warn('[bus] handler error on', type, e)
      }
    })
  },
}

/* 一次性监听 */
export function once(type, fn) {
  const wrap = (p) => {
    bus.off(type, wrap)
    fn(p)
  }
  bus.on(type, wrap)
}

/* ------------------------------------------------------------
 * Ripple 波纹反馈（mdui / MD3 风格）
 * 在任意元素上启用：ripple(el) 后点击产生扩散圆环。
 * 内部用事件委托，仅对注册过的元素生效。
 * ------------------------------------------------------------ */
const rippleListeners = new WeakMap()

export function ripple(el, opts = {}) {
  if (!el || rippleListeners.has(el)) return
  const isBubbling = !!opts.bubbling
  // 波纹容器（绝对定位覆盖在元素之上）
  if (getComputedStyle(el).position === 'static') el.style.position = 'relative'
  el.style.overflow = 'hidden'

  const spawn = (e) => {
    const rect = el.getBoundingClientRect()
    // 取按压点，键盘/回车事件时以中心为原点
    let x = e.clientX != null ? e.clientX - rect.left : rect.width / 2
    let y = e.clientY != null ? e.clientY - rect.top : rect.height / 2
    const size = Math.max(rect.width, rect.height) * 2.2
    const w = document.createElement('span')
    w.className = 'lt-ripple'
    w.style.width = w.style.height = size + 'px'
    w.style.left = x - size / 2 + 'px'
    w.style.top = y - size / 2 + 'px'
    w.style.color = 'inherit'
    el.appendChild(w)
    // 动画结束后移除
    w.addEventListener('animationend', () => w.remove())
    if (!isBubbling) {
      // 按住不放时维持波纹，松开后淡出
      const fade = () => w.classList.add('lt-ripple-out')
      el.addEventListener('pointerup', fade, { once: true })
      el.addEventListener('pointerleave', fade, { once: true })
    }
  }

  el.addEventListener('pointerdown', spawn)
  rippleListeners.set(el, true)
}

/* 给一组元素批量启用波纹（selector 作用域可选） */
export function ripples(selector, scope = document) {
  ;(scope.querySelectorAll(selector) || []).forEach((el) => ripple(el))
}

/* ---------------- Toast 轻提示（底部弹出，自动消失） ----------------
 * 不依赖 Varlet CDN，纯手写最小实现，保证离线也可用 */
let toastEl = null
let toastTimer = null

export function toast(msg, type = 'info') {
  if (!toastEl) {
    toastEl = document.createElement('div')
    toastEl.className = 'lt-toast'
    document.body.appendChild(toastEl)
  }
  toastEl.textContent = msg
  toastEl.className = 'lt-toast ' + type
  toastEl.style.display = 'block'
  requestAnimationFrame(() => toastEl.classList.add('show'))
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    toastEl.classList.remove('show')
    setTimeout(() => (toastEl.style.display = 'none'), 300)
  }, 3000)
}

/* ---------------- 剪贴板读写（需用户手势） ---------------- */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch (e) {
    // 降级方案
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    try {
      document.execCommand('copy')
      document.body.removeChild(ta)
      return true
    } catch (e2) {
      document.body.removeChild(ta)
      return false
    }
  }
}

export async function readClipboardText() {
  try {
    return await navigator.clipboard.readText()
  } catch (e) {
    // 无权限时返回 null，由调用方提示
    return null
  }
}

export function isWebRTCSupported() {
  return typeof RTCPeerConnection !== 'undefined'
}

/* 数组 buffer 转 utf8 字符串（用于二进制辅助调试） */
export function bufToStr(buf) {
  return new TextDecoder('utf-8').decode(buf)
}

export async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/* 生成存储键函数：统一 localStorage 读写封装 */
export function lsGet(key, fallback) {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : fallback
  } catch (e) {
    return fallback
  }
}

export function lsSet(key, value) {
  localStorage.setItem(key, JSON.stringify(value))
}