/* ==========================================
 * clipboard.js — 剪贴板同步（跨设备）
 * 需要用户手势触发读取；同步写入属于操作信任范畴
 * ========================================== */
import { bus, toast, readClipboardText, copyText } from './utils.js'
import { sendMsg, getPeerState } from './webrtc.js'
import { addHistory } from './history.js'
import { findDevice, displayName, setOperationTrusted } from './trust.js'

function displayOf(perm) {
  const d = findDevice(perm)
  return d ? displayName(d) : '设备'
}

/* 读取本机剪贴板并发往对端（须在用户点击手势中调用） */
export async function sendClipboard(perm) {
  if (getPeerState(perm) !== 'connected') {
    toast('目标设备不在线', 'warn')
    return null
  }
  let text = null
  try {
    text = await readClipboardText()
  } catch (e) {
    text = null
  }
  if (text === null) {
    toast('请在点击按钮时重试', 'warn')
    return null
  }
  if (!text.trim()) {
    toast('剪贴板为空', 'info')
    return null
  }
  const ok = sendMsg(perm, { t: 'clipboard', text })
  if (!ok) {
    toast('发送失败：连接不可用', 'error')
    return null
  }
  // 本地也显示剪贴板转储（Sky记录）
  bus.emit('chat-add', {
    peerId: perm,
    direction: 'send',
    type: 'clipboard',
    content: '剪贴板 → ' + text.slice(0, 200),
    timestamp: Date.now(),
  })
  addHistory({
    peerId: perm,
    peerName: displayOf(perm),
    action: 'clipboard_sync',
    detail: text.slice(0, 60),
    status: 'success',
  })
  return text
}

/* 接收对端剪贴板内容（写入本机剪贴板） */
export async function handleClipboard(payload) {
  const { perm, msg } = payload
  if (!msg || msg.t !== 'clipboard') return false
  const ok = await writeClipboard(msg.text)
  bus.emit('chat-add', {
    peerId: perm,
    direction: 'receive',
    type: 'clipboard',
    content: '剪贴板 ← ' + String(msg.text).slice(0, 200),
    timestamp: Date.now(),
  })
  addHistory({
    peerId: perm,
    peerName: displayOf(perm),
    action: 'clipboard_sync',
    detail: String(msg.text).slice(0, 200),
    status: ok ? 'success' : 'failed',
  })
  toast(ok ? '已同步剪贴板' : '剪贴板写入失败', ok ? 'success' : 'error')
  return true
}

/* 剪贴板写入（含降级方案） */
export async function writeClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch (e) {}
  }
  // 降级 execCommand
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.position = 'fixed'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  ta.select()
  try {
    document.execCommand('copy')
  } catch (e) {}
  document.body.removeChild(ta)
  return true
}