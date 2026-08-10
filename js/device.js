/* ==========================================
 * device.js — 设备身份管理
 * 永久令牌（localStorage 终身不变）+ 设备名
 * ========================================== */
const DEVICE_INFO_KEY = 'device_info'
const USER_CONFIG_KEY = 'user_config'

/* ---------- 本机信息（永久令牌 + 设备名） ---------- */
export function getDeviceInfo() {
  let info = null
  try {
    info = JSON.parse(localStorage.getItem(DEVICE_INFO_KEY))
  } catch (e) {}
  if (!info || !info.permanentId) {
    info = { permanentId: genPermanentId(), deviceName: getDefaultName() }
    saveDeviceInfo(info)
  }
  return info
}

/* 默认设备名：平台+随机后缀，避免多设备重名 */
function getDefaultName() {
  const ua = navigator.userAgent
  let name = '我的设备'
  if (/Android/i.test(ua)) name = '我的手机'
  else if (/iPhone|iPad|iPod/i.test(ua)) name = '我的手机'
  else if (/Macintosh/i.test(ua)) name = '我的 Mac'
  else if (/Windows/i.test(ua)) name = '我的电脑'
  else if (/Linux/i.test(ua)) name = '我的电脑'
  name += ' ' + Math.random().toString(36).slice(2, 5)
  return name
}

/* 生成永久令牌：crypto.randomUUID() 中 0→A、1→B */
function genPermanentId() {
  const uuid = (crypto.randomUUID && crypto.randomUUID()) || fallbackUuid()
  return uuid.replace(/0/g, 'A').replace(/1/g, 'B')
}

function fallbackUuid() {
  // 极少数浏览器不支持 randomUUID 时的降级
  const b = crypto.getRandomValues(new Uint8Array(16))
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const hex = [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
  return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20)
}

export function saveDeviceInfo(info) {
  localStorage.setItem(DEVICE_INFO_KEY, JSON.stringify(info))
}

export function getDeviceName() {
  return getDeviceInfo().deviceName
}

export function setDeviceName(name) {
  const info = getDeviceInfo()
  info.deviceName = name || '我的设备'
  saveDeviceInfo(info)
  return info.deviceName
}

/* ---------- 用户配置 ---------- */
const defaultConfig = { theme: 'system', autoAcceptKnown: true, relayEnabled: true }

export function getUserConfig() {
  try {
    const cfg = JSON.parse(localStorage.getItem(USER_CONFIG_KEY))
    return Object.assign({}, defaultConfig, cfg || {})
  } catch (e) {
    return Object.assign({}, defaultConfig)
  }
}

export function saveUserConfig(patch) {
  const cfg = getUserConfig()
  const next = Object.assign(cfg, patch)
  localStorage.setItem(USER_CONFIG_KEY, JSON.stringify(next))
  return next
}

export function setTheme(theme) {
  return saveUserConfig({ theme })
}