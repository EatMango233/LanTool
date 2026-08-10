/* ==========================================
 * chat.js — 文字聊天
 * 双向实时收发，消息存入 IndexedDB（永久保留）
 * ========================================== */
import { bus, toast } from './utils.js'
import { sendMsg, getPeerState } from './webrtc.js'
import { addMessage, getMessages } from './history.js'
import { displayName } from './trust.js'

/* 发送文字消息（Enter 触发） */
export function sendText(perm, text) {
  text = (text || '').trim()
  if (!text) return null
  if (getPeerState(perm) !== 'connected') {
    toast('目标设备不在线', 'warn')
    return null
  }
  const ok = sendMsg(perm, { t: 'chat', text })
  if (!ok) {
    toast('发送失败：连接不可用', 'error')
    return null
  }
  // 本地记录
  const record = { peerId: perm, direction: 'send', type: 'text', content: text, timestamp: Date.now() }
  addMessage(record)
  bus.emit('chat-add', record)
  bus.emit('conversation-updated', perm)
  return record
}

/* 加载某设备全部消息 */
export async function loadMessages(perm) {
  return getMessages(perm)
}

/* 接收文本消息（webrtc 'message' 事件入口，由 app 统一挂载） */
export function handleIncomingChat(payload) {
  const { perm, msg } = payload
  if (!msg || msg.t !== 'chat') return false
  const record = { peerId: perm, direction: 'receive', type: 'text', content: msg.text, timestamp: msg.ts || Date.now() }
  addMessage(record)
  bus.emit('chat-add', record)
  bus.emit('conversation-updated', perm)
  bus.emit('new-message', { perm, record }) // 触发未读提示/震动
  return true
}

/* 删除某设备全部聊天记录 */
export async function clearConversation(perm) {
  const { clearMessages } = await import('./history.js')
  await clearMessages(perm)
  bus.emit('conversation-cleared', perm)
}