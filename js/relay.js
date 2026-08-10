/* ==========================================
 * relay.js — LocalSend 公共服务器信令中继（跨设备自动发现）
 *
 * 借 wss://public.localsend.org/v1/ws 做「设备发现 + SDP 中转」，
 * 数据面仍走 LanTool 自有 DataChannel P2P 协议。
 *
 * 服务器按公网 IP 分组：同一公网 IP（同一家庭/办公室 NAT 出口）
 * 下的设备互相可见，不同公网 IP 互不可见 → 等效"NAT 穿透版局域网发现"。
 *
 * 消息协议（已核对 localsend server + web 源码）：
 *   连接:   wss://…/ws?d=<urlsafe_no_pad_base64(JSON{alias,version,deviceType,token})>
 *   服务器→客户端: HELLO{client,peers} / JOIN{peer} / LEFT{peerId} /
 *                 OFFER{peer,sessionId,sdp} / ANSWER{peer,sessionId,sdp} / ERROR{code}
 *   客户端→服务器: {type:OFFER|ANSWER, sessionId, target, sdp} / {type:UPDATE, info}
 *   保活:   每 120s 发空字符串
 *   sdp:    服务器不解析，LanTool 自定 = urlsafe_no_pad_base64(原始 SDP)
 *   识别:   token = "LT1:"+永久ID → 仅 LanTool 设备互相可见
 * ========================================== */
import { bus, toast } from './utils.js'
import { getDeviceInfo } from './device.js'

const SERVER =
  (typeof window !== 'undefined' && window.LT_RELAY_URL) || 'wss://public.localsend.org/v1/ws'
const LT_PREFIX = 'LT1:'

/* ---------- urlsafe base64（URL_SAFE_NO_PAD） ---------- */
export function b64UrlEncode(str) {
  const bytes = new TextEncoder().encode(str)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function b64UrlDecode(s) {
  let t = s.replace(/-/g, '+').replace(/_/g, '/')
  while (t.length % 4) t += '='
  const bin = atob(t)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}

/* ---------- 连接状态 ---------- */
let ws = null
let status = '' // '' | connecting | connected | down
let reconnectAttempt = 0
let reconnectTimer = null
let keepAliveTimer = null
let stopped = false // 主动停止（ERROR/close）后不再自动重连
const my = { perm: '', name: '' }
const serverOf = new Map() // perm -> 服务器分配的 peerId(UUID)

function setStatus(s) {
  status = s
  bus.emit('relay-status', s)
}

/* 从 peer 提取 LanTool 永久ID（非 LanTool 设备返回 ''） */
function permOf(peer) {
  if (!peer || !peer.token || !peer.token.startsWith(LT_PREFIX)) return ''
  return peer.token.slice(LT_PREFIX.length)
}

/* 建立连接（幂等） */
export function connect() {
  const info = getDeviceInfo()
  my.perm = info.permanentId
  my.name = info.deviceName
  if (typeof WebSocket === 'undefined') return false
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return true
  open()
  return true
}

function open() {
  stopped = false
  setStatus('connecting')
  const dto = { alias: my.name, version: '2.3', deviceType: 'WEB', token: LT_PREFIX + my.perm }
  const url = SERVER + '?d=' + encodeURIComponent(b64UrlEncode(JSON.stringify(dto)))
  try {
    ws = new WebSocket(url)
  } catch (e) {
    fail()
    return
  }
  ws.onopen = () => {
    reconnectAttempt = 0
    setStatus('connected')
    if (keepAliveTimer) clearInterval(keepAliveTimer)
    // 每 120s 发空字符串保活（协议约定）
    keepAliveTimer = setInterval(() => {
      try {
        ws && ws.send('')
      } catch (e) {}
    }, 120000)
  }
  ws.onmessage = (e) => onMessage(e.data)
  ws.onerror = () => {}
  ws.onclose = () => {
    if (keepAliveTimer) clearInterval(keepAliveTimer)
    if (stopped) return
    scheduleReconnect()
  }
}

/* 断线指数退避重连（最多 3 次） */
function scheduleReconnect() {
  if (reconnectAttempt >= 3) {
    fail()
    return
  }
  reconnectAttempt++
  setStatus('connecting')
  clearTimeout(reconnectTimer)
  reconnectTimer = setTimeout(open, 1000 * reconnectAttempt)
}

function fail() {
  stopped = true
  setStatus('down')
  serverOf.clear()
}

/* 手动重试 */
export function retry() {
  stopped = false
  reconnectAttempt = 0
  if (ws) {
    try {
      ws.close()
    } catch (e) {}
  }
  ws = null
  open()
}

/* 主动断开（页面卸载/设置关闭时） */
export function close() {
  stopped = true
  clearTimeout(reconnectTimer)
  clearInterval(keepAliveTimer)
  if (ws) {
    try {
      ws.close()
    } catch (e) {}
  }
  ws = null
  setStatus('')
}

export function getStatus() {
  return status
}

/* 某个永久ID的设备当前是否在中继上（用于重连判定） */
export function hasPeer(perm) {
  return serverOf.has(perm)
}

/* ---------- 消息处理 ---------- */
function onMessage(raw) {
  if (!raw || !raw.trim()) return
  let msg
  try {
    msg = JSON.parse(raw)
  } catch (e) {
    return
  }
  switch (msg.type) {
    case 'HELLO':
      serverOf.clear()
      ;(msg.peers || []).forEach(addPeer)
      break
    case 'JOIN':
      addPeer(msg.peer)
      break
    case 'LEFT':
      removePeer(msg.peerId)
      break
    case 'UPDATE':
      updatePeer(msg.peer)
      break
    case 'OFFER':
      bus.emit('relay-offer', {
        peer: msg.peer,
        perm: permOf(msg.peer),
        name: msg.peer && msg.peer.alias,
        sessionId: msg.sessionId,
        sdp: decodeSdp(msg.sdp),
      })
      break
    case 'ANSWER':
      bus.emit('relay-answer', { sessionId: msg.sessionId, sdp: decodeSdp(msg.sdp) })
      break
    case 'ERROR':
      fail()
      toast('公网中继出错（' + (msg.code || '?') + '），已停止重连', 'warn')
      break
  }
}

function addPeer(peer) {
  const perm = permOf(peer)
  if (!perm || perm === my.perm) return
  serverOf.set(perm, peer.id)
  bus.emit('relay-peer-join', { perm, name: peer.alias, serverId: peer.id })
}

function removePeer(peerId) {
  for (const [perm, id] of serverOf) {
    if (id === peerId) {
      serverOf.delete(perm)
      bus.emit('relay-peer-left', perm)
      return
    }
  }
}

function updatePeer(peer) {
  const perm = permOf(peer)
  if (!perm || perm === my.perm) return
  serverOf.set(perm, peer.id)
  bus.emit('relay-peer-join', { perm, name: peer.alias, serverId: peer.id })
}

/* ---------- 发送 ---------- */
export function sendOffer(perm, sessionId, sdp) {
  const target = serverOf.get(perm)
  if (!target) return false
  send({ type: 'OFFER', sessionId, target, sdp: encodeSdp(sdp) })
  return true
}

export function sendAnswer(perm, sessionId, sdp) {
  const target = serverOf.get(perm)
  if (!target) return false
  send({ type: 'ANSWER', sessionId, target, sdp: encodeSdp(sdp) })
  return true
}

/* 改名后同步到中继（协议 UPDATE 消息） */
export function updateName(name) {
  my.name = name
  send({
    type: 'UPDATE',
    info: { alias: name, version: '2.3', deviceType: 'WEB', token: LT_PREFIX + my.perm },
  })
}

function send(obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return
  try {
    ws.send(JSON.stringify(obj))
  } catch (e) {}
}

/* ---------- SDP 编解码（服务器不解析，自定） ---------- */
function encodeSdp(sdp) {
  return b64UrlEncode(sdp)
}

function decodeSdp(s) {
  try {
    return b64UrlDecode(s)
  } catch (e) {
    return ''
  }
}
