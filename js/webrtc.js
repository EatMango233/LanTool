/* ==========================================
 * webrtc.js — WebRTC 连接管理（星型拓扑，多连接）
 *
 * 信令方案（纯前端无服务器）：
 *   同一局域网内、同一服务地址(如 http://192.168.x.x:PORT)访问的所有设备
 *   天然同源，因此直接用 BroadcastChannel 广播 + localStorage 邮箱后备
 *   完成 SDP/ICE 交换，无需任何信令服务器。
 *
 * 数据通道消息（统一 JSON，二进制直传文件分片）：
 *   {t: 'chat'|'file-*'|'clipboard'|'iframe'|'theme'|'alias'|'voice'|'ping'|'pong'}
 * ========================================== */
import { bus, uid, toast, sleep, isWebRTCSupported } from './utils.js'
import { getDeviceInfo } from './device.js'
import * as trust from './trust.js'

const SIG = {
  HELLO: 'hello',
  CONNECT: 'connect',
  CONNECT_ACK: 'connect_ack',
  RTCOFFER: 'rtc-offer',
  RTCANSWER: 'rtc-answer',
  RTCICE: 'rtc-ice',
  PROBE: 'probe',
  PROBE_ACK: 'probe_ack',
}

const ICE_CONFIG = () => ({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] })

/* ---------------- 本机身份 ---------------- */
const me = { id: '', perm: '', name: '我的设备' }

/* ---------------- 连接状态数据 ---------------- */
const connections = new Map() // sessionId -> {pc, dc, perm, name, state, recon}
const peers = new Map() // perm -> {session, name, state, dc}
const mailboxLastSeen = new Map() // sessionId -> ts（邮箱去重）
let bc = null
const probeCache = new Map() // perm -> {online, ts}
let lastProbeAt = 0

function emit(type, payload) {
  bus.emit(type, payload)
}

/* ============ 初始化 ============ */
export function initSignaling() {
  const info = getDeviceInfo()
  me.id = uid('i')
  me.perm = info.permanentId
  me.name = info.deviceName

  if (!isWebRTCSupported()) {
    toast('请使用 Chrome/Edge/Firefox')
    return false
  }

  // 主信令通道：BroadcastChannel
  if (typeof BroadcastChannel !== 'undefined') {
    bc = new BroadcastChannel('lantoool-signal-v1')
    bc.onmessage = (e) => dispatchSignal(e.data)
  }

  // 后备信令通道：localStorage 邮箱（storage 事件 + 轮询）
  installMailbox()

  // 上线宣告
  announce()
  setInterval(announce, 10000)

  // 绑定伪连接的事件总线
  bus.on('message', onPingPong)
  return true
}

export function getMyInfo() {
  return { id: me.id, perm: me.perm, name: me.name }
}

export function setMyName(name) {
  me.name = name
  announce()
}

/* ============ 信令收发 ============ */
function signal(msg) {
  msg.from = me.id
  msg.ts = Date.now()
  if (bc) {
    try { bc.postMessage(msg) } catch (e) {}
  }
  enqueueMail(msg)
  return msg
}

function signalTo(sessionId, type, extra) {
  return signal(Object.assign({ type, to: sessionId }, extra || {}))
}

/* --- localStorage 邮箱 --- */
const MB_KEY = 'lantoool-mailbox-v1'
function enqueueMail(msg) {
  try {
    const arr = JSON.parse(localStorage.getItem(MB_KEY) || '[]')
    arr.push(msg)
    if (arr.length > 400) arr.splice(0, arr.length - 400)
    localStorage.setItem(MB_KEY, JSON.stringify(arr))
  } catch (e) {}
}

function installMailbox() {
  // 存储事件触发（同一设备多标签即时同步）
  window.addEventListener('storage', (e) => {
    if (e.key !== MB_KEY) return
    drainMailbox()
  })
  // 轮询兜底（BroadcastChannel 不存在的环境）
  setInterval(drainMailbox, 400)
}

function drainMailbox() {
  try {
    const raw = localStorage.getItem(MB_KEY)
    if (!raw) return
    const arr = JSON.parse(raw)
    const now = Date.now()
    arr.forEach((m) => {
      if (!m || !m.from || m.from === me.id) return
      if (now - (m.ts || 0) > 30000) return
      if (lastSeen(m)) return
      dispatchSignal(m)
    })
  } catch (e) {}
}

/* 信令去重（同一信令经 BroadcastChannel 与邮箱各自送达一次） */
const sessionSeen = new Set()
function lastSeen(m) {
  const k = m.from + (m.ts || '') + (m.type || '')
  if (sessionSeen.has(k)) return true
  sessionSeen.add(k)
  if (sessionSeen.size > 3000) sessionSeen.clear()
  return false
}

/* ============ 信令分发（去重） ============ */
function dispatchSignal(m) {
  if (!m || !m.type || !m.from) return
  if (m.from === me.id) return
  if (m.to && m.to !== me.id) return // 点对点但目标不是我

  // 记录会话对应关系（会话ID → 设备永久ID）
  if (m.perm) peersOfSession.set(m.from, m.perm)

  switch (m.type) {
    case SIG.HELLO: // 记录注册表
      sessionInfo.set(m.from, { perm: m.perm, name: m.name })
      break
    case SIG.CONNECT:
      onConnectRequest(m)
      break
    case SIG.CONNECT_ACK:
      onConnectAck(m)
      break
    case SIG.RTCOFFER:
      onOffer(m)
      break
    case SIG.RTCANSWER:
      onAnswer(m)
      break
    case SIG.RTCICE:
      onIce(m)
      break
    case SIG.PROBE:
      if (m.perm === me.perm) {
        signalTo(m.from, SIG.PROBE_ACK, { perm: me.perm, name: me.name, probe: true })
      }
      break
    case SIG.PROBE_ACK:
      if (m.perm) probeCache.set(m.perm, { online: true, ts: Date.now() })
      break
  }
}

function announce() {
  signal({ type: SIG.HELLO, perm: me.perm, name: me.name })
}

/* ============ 会话->永久ID 映射 ============ */
const sessionInfo = new Map() // sessionId -> {perm, name}
const peersOfSession = new Map() // sessionId -> perm

export function findSessionByPerm(perm) {
  for (const [sid, p] of sessionInfo) {
    if (p.perm === perm) return sid
  }
  return null
}

/* ============ 对外：配对 API ============ */

/* ============ 手动配对（复制粘贴信令，跨设备备用） ============ */
const MANUAL_PREFIX = 'LANPAIR1:'

// 编码配对码为可复制文本（SDP 可能含非 ASCII，用 Unicode 安全 base64）
function encodePair(payload) {
  const json = JSON.stringify(payload)
  return MANUAL_PREFIX + btoa(unescape(encodeURIComponent(json)))
}

function decodePair(text) {
  if (!text || !text.startsWith(MANUAL_PREFIX)) throw new Error('bad-code')
  const raw = text.slice(MANUAL_PREFIX.length)
  const json = decodeURIComponent(escape(atob(raw)))
  return JSON.parse(json)
}

// 等待 ICE 收集完成，让全部候选并入 SDP（复制粘贴无需二次交换候选）
function iceGatherComplete(pc) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve()
    const onState = () => {
      if (pc.iceGatheringState === 'complete') {
        pc.removeEventListener('icegatheringstatechange', onState)
        resolve()
      }
    }
    pc.addEventListener('icegatheringstatechange', onState)
    setTimeout(resolve, 4000) // 兜底 4s
  })
}

/* 仅读取配对码类型（offer/answer）与模式，不产生副作用 */
export function manualPeek(code) {
  const p = decodePair(code)
  return { kind: p.kind, reconnect: !!p.reconnect }
}

/* 关闭并清理旧的 manual 会话（避免重复生成时连接泄漏） */
function cleanupManual() {
  for (const [sid, r] of peerRecs) {
    if (r.manual) {
      try { r.pc && r.pc.close() } catch (e) {}
      peerRecs.delete(sid)
    }
  }
}

/* ============ 局域网 IP 收集（B 方案） ============ */
let lanIPsCache = null
/* 创建一次性 RTCPeerConnection 收集 host 候选中的局域网 IPv4，结果缓存 */
export function getLanIPs() {
  if (lanIPsCache) return Promise.resolve(lanIPsCache)
  return new Promise((resolve) => {
    const out = new Set()
    const pc = new RTCPeerConnection({ iceServers: [] })
    let settled = false
    const finish = (ips) => {
      if (settled) return
      settled = true
      try { pc.close() } catch (e) {}
      lanIPsCache = ips
      resolve(ips)
    }
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        const m = /(\d+\.\d+\.\d+\.\d+)/.exec(e.candidate.candidate)
        if (m) out.add(m[1])
      }
      if (!e.candidate) finish([...out].filter((ip) => !ip.startsWith('127.') && !ip.startsWith('0.')))
    }
    try {
      pc.createDataChannel('lan-probe')
      pc.createOffer().then((o) => pc.setLocalDescription(o)).catch(() => finish([]))
    } catch (e) {
      finish([])
    }
    setTimeout(() => finish([...out].filter((ip) => !ip.startsWith('127.') && !ip.startsWith('0.'))), 2500)
  })
}

/* B：生成 offer 配对码。
 * 首次配对（pair）与重新连接（reconnect）均无需临时令牌：
 *   首次配对由接收方人工粘贴配对码并接受建立信任；
 *   重连时接收方校验发起方在信任列表且允许连接。 */
export async function manualOffer(opts = {}) {
  const reconnect = !!opts.reconnect
  if (!isWebRTCSupported()) throw new Error('no-webrtc')
  cleanupManual()
  const sid = 'manual-' + uid('m')
  const rec = getRec(sid, true)
  rec.manual = true
  const pc = new RTCPeerConnection(ICE_CONFIG())
  rec.pc = pc
  pcSignaling(pc, rec)
  const dc = pc.createDataChannel('lan')
  bindChan(dc, rec)
  const offer = await pc.createOffer()
  await pc.setLocalDescription(offer)
  await iceGatherComplete(pc)
  const lanIPs = await getLanIPs().catch(() => [])
  const payload = {
    kind: 'offer',
    reconnect,
    lanIPs,
    perm: me.perm,
    name: me.name,
    sdp: pc.localDescription,
  }
  if (reconnect) payload.targetPerm = opts.targetPerm || ''
  return encodePair(payload)
}

/* A：处理 offer 配对码，生成 answer 配对码。
 * 首次配对：直接应答，信任经数据通道 hello 交换永久令牌后建立；
 * 重连：校验对方在信任列表且允许连接。 */
export async function manualAccept(code) {
  const p = decodePair(code)
  if (p.kind !== 'offer') throw new Error('bad-offer')
  if (p.reconnect) {
    // 重连：发起方必须在本机信任列表且允许连接
    const dev = trust.findDevice(p.perm)
    if (!dev || dev.connectionTrusted === false) throw new Error('not-trusted')
  }
  cleanupManual()
  const sid = 'manual-' + uid('m')
  const rec = getRec(sid, true)
  rec.manual = true
  rec.perm = p.perm
  rec.name = p.name
  const pc = new RTCPeerConnection(ICE_CONFIG())
  rec.pc = pc
  pc.ondatachannel = (e) => bindChan(e.channel, rec)
  pcSignaling(pc, rec)
  await pc.setRemoteDescription(new RTCSessionDescription(p.sdp))
  const answer = await pc.createAnswer()
  await pc.setLocalDescription(answer)
  await iceGatherComplete(pc)
  return encodePair({
    kind: 'answer',
    perm: me.perm,
    name: me.name,
    sdp: pc.localDescription,
  })
}

/* B：处理 answer 配对码，完成连接 */
export async function manualApply(code) {
  const p = decodePair(code)
  if (p.kind !== 'answer') throw new Error('bad-answer')
  // 找到等待中的 manual 会话（本机发起 offer 且尚未连接）
  let rec = null
  for (const r of peerRecs.values()) {
    if (r.manual && r.pc && r.state === 'connecting' && !r.perm) {
      rec = r
      break
    }
  }
  if (!rec) throw new Error('no-session')
  rec.perm = p.perm
  rec.name = p.name
  await rec.pc.setRemoteDescription(new RTCSessionDescription(p.sdp))
  return { perm: p.perm, name: p.name }
}

/* ============ 公共服务器中继（LocalSend）辅助 ============ */
/* 构建 offer SDP（供 relay.js 转发）：建 PC+DC+iceGatherComplete，
 * rec 标记 relay=true 以复用"跳过信令通道 ICE 转发"，并记 wsSid 供回查 */
export async function buildOfferSdp() {
  const sid = 'ws-' + uid('m')
  const rec = getRec(sid, true)
  rec.relay = true
  rec.wsSid = sid
  const pc = new RTCPeerConnection(ICE_CONFIG())
  rec.pc = pc
  pcSignaling(pc, rec)
  const dc = pc.createDataChannel('lan')
  bindChan(dc, rec)
  const offer = await pc.createOffer()
  await pc.setLocalDescription(offer)
  await iceGatherComplete(pc)
  return { sessionId: sid, sdp: pc.localDescription.sdp, rec }
}

/* 构建 answer SDP（供 relay.js 转发）：peerInfo 预置 perm/name，
 * 数据通道 open 后 hello 交换仍会重新登记并触发 peer-ready */
export async function buildAnswerSdp(remoteSdp, peerInfo = {}) {
  const sid = 'ws-' + uid('m')
  const rec = getRec(sid, true)
  rec.relay = true
  rec.wsSid = sid
  rec.perm = peerInfo.perm || ''
  rec.name = peerInfo.name || ''
  const pc = new RTCPeerConnection(ICE_CONFIG())
  rec.pc = pc
  pc.ondatachannel = (e) => bindChan(e.channel, rec)
  pcSignaling(pc, rec)
  await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: remoteSdp }))
  const answer = await pc.createAnswer()
  await pc.setLocalDescription(answer)
  await iceGatherComplete(pc)
  return { sessionId: sid, sdp: pc.localDescription.sdp, rec }
}

/* 应用对方 answer（sessionId 为 offer 侧会话），完成连接 */
export async function applyAnswer(sessionId, sdp) {
  const rec = peerRecs.get(sessionId)
  if (!rec || !rec.pc) throw new Error('no-session')
  await rec.pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp }))
  return rec
}

/* 取消一个未完成的 relay 会话（防泄漏） */
export function cancelSession(sessionId) {
  const rec = peerRecs.get(sessionId)
  if (!rec || rec.state === 'connected') return
  try {
    rec.pc && rec.pc.close()
  } catch (e) {}
  peerRecs.delete(sessionId)
}

/* ============ 对外：信任直连 ============ */
let connectWaiters = new Map() // sessionId -> {resolve, timer}

export function connectTrusted(perm) {
  return new Promise((resolve, reject) => {
    // 已在线连接直接成功
    const existing = peers.get(perm)
    if (existing && existing.state === 'connected') return resolve('connected')

    const sess = findSessionByPerm(perm)
    if (!sess) return reject(new Error('offline'))

    const timer = setTimeout(() => reject(new Error('timeout')), 10000)
    connectWaiters.set(sess, { resolve, timer, perm })
    signalTo(sess, SIG.CONNECT, { perm: me.perm, name: me.name, targetPerm: perm })
  })
}

function onConnectRequest(m) {
  // 对方请求与 m.targetPerm 直连。白名单自动接受逻辑（调用方 trust.js 决定）
  bus.emit('connect-request', { sessionId: m.from, perm: m.perm, name: m.name, targetPerm: m.targetPerm })
  // 由编配层调用 acceptConnect() 或忽略
}

/* 白名单确认后调用：回复 ack 并等待 offer */
export function acceptConnect(sessionId) {
  signalTo(sessionId, SIG.CONNECT_ACK, { perm: me.perm, name: me.name })
}

function onConnectAck(m) {
  const w = connectWaiters.get(m.from)
  if (w) {
    clearTimeout(w.timer)
    connectWaiters.delete(m.from)
    w.resolve('accepted')
    // 发起连接（自己是 offerer）
    initiateOffer(m.from, w.perm, m.name)
  }
}

/* ============ RTC 信令处理 ============ */
const peerRecs = new Map() // sessionId -> {pc, dc, perm, name, state}

function getRec(sid, create) {
  let r = peerRecs.get(sid)
  if (!r && create) {
    r = { sid, pc: null, dc: null, perm: '', name: '', state: 'connecting' }
    peerRecs.set(sid, r)
  }
  return r
}

/* 发起方：创建 PC + DC + offer */
async function initiateOffer(sid, perm, name) {
  let r = peerRecs.get(sid)
  if (r && (r.pc || r.state === 'connected')) return r
  r = { sid, pc: null, dc: null, perm, name, state: 'connecting' }
  peerRecs.set(sid, r)

  const pc = new RTCPeerConnection(ICE_CONFIG())
  r.pc = pc
  r.perm = perm
  r.name = name || r.name
  pcSignaling(pc, r)
  const dc = pc.createDataChannel('lan')
  bindChan(dc, r)

  const offer = await pc.createOffer()
  await pc.setLocalDescription(offer)
  signalTo(sid, SIG.RTCOFFER, { des: pc.localDescription, perm: me.perm, name: me.name, targetPerm: r.perm })
  return r
}

async function onOffer(m) {
  const sid = m.from
  let rec = peerRecs.get(sid)
  if (!rec) {
    rec = { sid, pc: null, dc: null, perm: m.perm || m.targetPerm || '', name: m.name, state: 'connecting' }
    peerRecs.set(sid, rec)
  }
  const pc = new RTCPeerConnection(ICE_CONFIG())
  rec.pc = pc
  pc.ondatachannel = (e) => bindChan(e.channel, rec)
  pcSignaling(pc, rec)
  await pc.setRemoteDescription(new RTCSessionDescription(m.des))
  const answer = await pc.createAnswer()
  await pc.setLocalDescription(answer)
  signalTo(sid, SIG.RTCANSWER, { des: pc.localDescription, perm: me.perm, name: me.name })
}

async function onAnswer(m) {
  const r = peerRecs.get(m.from)
  if (r) await r.pc.setRemoteDescription(new RTCSessionDescription(m.des))
}

async function onIce(m) {
  const r = peerRecs.get(m.from)
  try {
    await r?.pc.addIceCandidate(new RTCIceCandidate(m.candidate))
  } catch (e) {}
}

function pcSignaling(pc, r) {
  // 手动配对 / 中继模式下不通过信令通道转发 ICE（候选已随 SDP 一并交换）
  pc.onicecandidate = (e) => {
    if (r.manual || r.relay) return
    if (e.candidate) signalTo(r.sid, SIG.RTCICE, { candidate: e.candidate, perm: me.perm })
  }
  pc.onconnectionstatechange = () => {
    if (!r) return
    if (pc.connectionState === 'connected') {
      if (!r.perm && r.peerInfo) r.perm = r.peerInfo.perm
      r.state = 'connected'
      if (r.perm) peers.set(r.perm, { sessionId: r.sid, state: 'connected', pc, dc: r.dc })
      bus.emit('peer-ready', { perm: r.perm, name: r.name })
    } else if (pc.connectionState === 'failed') {
      bus.emit('peer-fail', { perm: r.perm, sessionId: r.sid })
    } else if (pc.connectionState === 'closed' || pc.connectionState === 'disconnected') {
      if (r.perm) {
        peers.delete(r.perm)
        bus.emit('peer-close', r.perm)
      }
    }
  }
}

function bindChan(dc, r) {
  dc.binaryType = 'arraybuffer'
  r.dc = dc
  dc.onmessage = (e) => {
    if (typeof e.data === 'string') {
      let obj
      try { obj = JSON.parse(e.data) } catch (e2) { return }
      if (obj.t === 'hello') {
        // hello → 完成连接登记
        r.perm = obj.perm
        r.name = obj.name
        if (obj.perm && !peers.has(obj.perm)) {
          peers.set(obj.perm, { sessionId: r.sid, state: 'connected', perm: obj.perm, dc: r.dc })
        } else if (obj.perm) {
          const p = peers.get(obj.perm)
          if (p) p.dc = r.dc
        }
        bus.emit('peer-ready', { perm: obj.perm, name: obj.name, sessionId: r.sid })
      } else {
        // 业务消息转发给 UI 层
        bus.emit('message', { perm: r.perm, msg: obj })
      }
    } else {
      // 二进制：文件分片
      bus.emit('binary', { perm: r.perm, buf: e.data })
    }
  }
  dc.onopen = () => {
    // 数据通道打开后立即交换身份
    try {
      dc.send(JSON.stringify({ t: 'hello', perm: me.perm, name: me.name }))
    } catch (e) {}
  }
  dc.onclose = () => {
    if (r.perm) {
      peers.delete(r.perm)
      bus.emit('peer-left', r.perm)
    }
  }
}

/* ============ 对外消息发送 API ============ */
export function sendMsg(perm, obj) {
  const p = peers.get(perm)
  if (!p || !p.dc) return false
  try {
    p.dc.send(JSON.stringify(obj))
    return true
  } catch (e) {
    return false
  }
}

export function sendBinary(perm, buf) {
  const p = peers.get(perm)
  if (!p || !p.dc) return false
  try {
    p.dc.send(buf)
    return true
  } catch (e) {
    return false
  }
}

/* ============ 在线探测（3秒超时，30秒缓存） ============ */
export async function probeOnline() {
  const list = trust.getTrustList()
  const result = {}
  const now = Date.now()
  for (const dev of list) {
    const c = probeCache.get(dev.permanentId)
    if (c && now - c.ts < 30000) {
      result[dev.permanentId] = c.online
      continue
    }
    const p = peers.get(dev.permanentId)
    if (p && p.state === 'connected') {
      result[dev.permanentId] = true
      continue
    }
    // 发起探测（广播，目标匹配者回应 probe_ack）
    signal({ type: SIG.PROBE, perm: dev.permanentId })
    result[dev.permanentId] = false
  }
  // 等待 3 秒收齐回应
  await sleep(3000)
  for (const dev of list) {
    const c = probeCache.get(dev.permanentId)
    const p = peers.get(dev.permanentId)
    result[dev.permanentId] = p && p.state === 'connected' ? true : c ? c.online : false
  }
  return result
}

/* 手动刷新按钮触发（30秒缓存内不重复探测） */
export function refreshOnline() {
  const now = Date.now()
  if (now - lastProbeAt < 30000) {
    return probeAccounts()
  }
  lastProbeAt = now
  return probeOnline()
}

function probeAccounts() {
  const list = trust.getTrustList()
  const result = {}
  for (const dev of list) {
    const p = peers.get(dev.permanentId)
    result[dev.permanentId] = p && p.state === 'connected'
  }
  return Promise.resolve(result)
}

/* ============ RTT 测量（响应速度） ============ */
export function pingPeer(perm) {
  return new Promise((resolve) => {
    const p = peers.get(perm)
    if (!p || !p.dc) return resolve(null)
    const ts = Date.now()
    const handler = (payload) => {
      if (payload.perm === perm && payload.msg.t === 'pong' && payload.msg.round === ts) {
        bus.off('message', handler)
        resolve(Date.now() - ts)
      }
    }
    bus.on('message', handler)
    try {
      p.dc.send(JSON.stringify({ t: 'ping', round: ts }))
    } catch (e) {
      bus.off('message', handler)
      resolve(null)
    }
    setTimeout(() => {
      bus.off('message', handler)
      resolve(null)
    }, 3000)
  })
}

function onPingPong(payload) {
  const msg = payload.msg
  const p = peers.get(payload.perm)
  if (!p || !p.dc) return
  if (msg.t === 'ping') {
    p.dc.send(JSON.stringify({ t: 'pong', round: msg.round }))
  }
}

/* ============ 其他 ============ */
export function getPeerState(perm) {
  const p = peers.get(perm)
  if (!p) return 'offline'
  return p.state
}

export function getPeers() {
  return [...peers.values()]
}

export function disconnectAll() {
  for (const r of peerRecs.values()) {
    try { r.pc && r.pc.close() } catch (e) {}
  }
  peerRecs.clear()
  peers.clear()
}

export function disconnectPeer(perm) {
  const p = peers.get(perm)
  if (!p) return
  const r = peerRecs.get(p.sessionId)
  try { r && r.pc && r.pc.close() } catch (e) {}
}

export function setMyPerm(perm) {
  me.perm = perm
  announce()
}

export { SIG }