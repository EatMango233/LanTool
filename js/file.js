/* ==========================================
 * file.js — 文件传输（分片 + 并发滑动窗口）
 * 每片 64KB，最大并发 16 片在途，不设文件大小上限
 *
 * 协议：
 *   控制消息（JSON）：file-meta / file-grant / file-deny /
 *                      file-chunk-ack / file-done / file-nak
 *   数据消息（二进制头 14 字节）：
 *     [0-1]  固定魔数 0x4C 0x54 ("LT")
 *     [2-9]  fid（8 位 ASCII）
 *     [10-13] 分片索引 u32 LE
 *     [14..] 分片原始字节
 *
 * 可靠性：
 *   发送端 sentAt 记录每片发出时间，watchTimer 每秒巡检，
 *   超 5s 未 ACK 重发（单片最多 3 次）；接收端收尾前检测
 *   缺口回发 file-nak 触发补传（会话内断点续传）。
 * ========================================== */
import { bus, toast, uid, formatBytes } from './utils.js'
import { sendMsg, sendBinary, getPeerState } from './webrtc.js'
import { addMessage, addHistory } from './history.js'
import { displayName, findDevice } from './trust.js'

export const CHUNK_SIZE = 64 * 1024
export const MAX_INFLIGHT = 16
export const LARGE_FILE = 100 * 1024 * 1024

const ACK_TIMEOUT = 5000 // 单片未 ACK 超时（毫秒）
const MAX_RETRIES = 3 // 单片最大重发次数

/* ---------- 任务表 ---------- */
const sendJobs = new Map() // fid -> job
const recvJobs = new Map() // fid -> job
const recent = [] // 已结束任务快照（供队列展示，上限 20）

function genFid() {
  // 8 位 ASCII 文件 ID（避免易混淆字符）
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789'
  let s = ''
  for (let i = 0; i < 8; i++) s += chars[Math.floor(Math.random() * chars.length)]
  return s
}

/* 二进制分片帧：魔数(2B) + fid(8B) + idx(u32 LE) + 数据 */
function frame(fid, idx, data) {
  const head = new ArrayBuffer(14)
  const dv = new DataView(head)
  dv.setUint8(0, 0x4c)
  dv.setUint8(1, 0x54)
  for (let i = 0; i < 8; i++) dv.setUint8(2 + i, fid.charCodeAt(i))
  dv.setUint32(10, idx, true)
  const out = new Uint8Array(head.byteLength + data.byteLength)
  out.set(new Uint8Array(head), 0)
  out.set(new Uint8Array(data), head.byteLength)
  return out.buffer
}

function parseFrame(buf) {
  const u8 = new Uint8Array(buf)
  if (u8.length < 14 || u8[0] !== 0x4c || u8[1] !== 0x54) return null
  let fid = ''
  for (let i = 0; i < 8; i++) fid += String.fromCharCode(u8[2 + i])
  const dv = new DataView(buf)
  const idx = dv.getUint32(10, true)
  return { fid, idx, data: u8.slice(14) }
}

function displayOf(perm) {
  const d = findDevice(perm)
  return d ? displayName(d) : '设备'
}

/* 聊天消息入库 + 上抛（与 chat.js 一致的持久化路径） */
function chatAdd(record) {
  addMessage(record)
  bus.emit('chat-add', record)
}

/* 入队结束快照（队列面板展示用） */
function pushRecent(job, state, reason) {
  recent.unshift({
    fid: job.fid,
    peer: job.peer,
    peerName: job.peerName,
    name: job.name,
    size: job.size,
    mime: job.mime,
    chunks: job.chunks,
    got: job.acked ? job.acked.size : job.received ? job.received.size : 0,
    state, // done | failed
    reason: reason || '',
    timestamp: Date.now(),
    file: job.file || null,
  })
  if (recent.length > 20) recent.pop()
}

/* 对外：队列快照（供 app 队列面板渲染） */
export function getQueues() {
  const send = []
  for (const job of sendJobs.values()) {
    send.push({
      fid: job.fid,
      peer: job.peer,
      peerName: job.peerName,
      name: job.name,
      size: job.size,
      mime: job.mime,
      chunks: job.chunks,
      got: job.acked.size,
      state: job.pending ? 'waiting-auth' : 'sending',
      reason: '',
      direction: 'send',
    })
  }
  const recv = []
  for (const job of recvJobs.values()) {
    recv.push({
      fid: job.fid,
      peer: job.peer,
      peerName: job.peerName,
      name: job.name,
      size: job.size,
      mime: job.mime,
      chunks: job.chunks,
      got: job.received.size,
      state: job.authorized ? 'receiving' : 'waiting-auth',
      reason: '',
      direction: 'recv',
    })
  }
  return { send, recv, recent: recent.slice(0, 20) }
}

/* ================= 对外：发送文件（可多选，逐个入队） ================= */
export function sendFiles(peer, files) {
  if (!Array.isArray(files) || !files.length) return
  if (getPeerState(peer) !== 'connected') {
    toast('目标设备不在线', 'warn')
    return
  }
  for (const file of files) {
    if (file.size > LARGE_FILE) toast('大文件传输可能较慢：' + formatBytes(file.size), 'warn')
    sendOne(peer, file)
  }
}

function sendOne(peer, file) {
  const job = {
    fid: genFid(),
    peer,
    peerName: displayOf(peer),
    file,
    name: file.name,
    size: file.size,
    mime: file.type || 'application/octet-stream',
    chunks: Math.max(1, Math.ceil(file.size / CHUNK_SIZE)),
    inflight: new Set(), // 在途分片索引
    nextIdx: 0,
    acked: new Set(), // 已确认分片
    sentAt: new Map(), // 分片索引 -> 发出时间戳（超时重传用）
    retries: new Map(), // 分片索引 -> 已重发次数
    pending: true, // 等待授权
    done: false,
    watchTimer: null,
    grantTimer: null,
  }
  sendJobs.set(job.fid, job)
  bus.emit('queue-update')
  // 1. 发送元信息，等授权
  sendMsg(peer, {
    t: 'file-meta',
    fid: job.fid,
    name: job.name,
    size: job.size,
    mime: job.mime,
    chunks: job.chunks,
  })
  bus.emit('file-offer-sent', { perm: peer, name: job.name, size: job.size })
  // 授权超时（30 秒内未授权则自动放弃）
  job.grantTimer = setTimeout(() => {
    if (sendJobs.has(job.fid) && job.pending) finalizeFail(job, '授权超时')
  }, 30000)
}

/* 发送失败后重试：复用文件引用重建 job（新 fid） */
export function retrySend(fid) {
  const idx = recent.findIndex((r) => r.fid === fid && r.state === 'failed' && r.file)
  if (idx < 0) return
  const item = recent[idx]
  recent.splice(idx, 1)
  if (getPeerState(item.peer) !== 'connected') {
    toast('目标设备不在线', 'warn')
    return
  }
  sendOne(item.peer, item.file)
  toast('已重新发送', 'success')
}

/* 取消一个发送中的文件 */
export function cancelSend(fid) {
  const job = sendJobs.get(fid)
  if (job && !job.done) abortSend(job, '已取消')
}

/* 发送方收到授权（file-grant）后启动窗口泵 */
function startSending(fid) {
  const job = sendJobs.get(fid)
  if (!job || job.done || !job.pending) return
  job.pending = false
  clearTimeout(job.grantTimer)
  bus.emit('file-start', { perm: job.peer, name: job.name, size: job.size })
  // 启动超时巡检：每秒检查在途分片是否超时
  job.watchTimer = setInterval(() => watch(job), 1000)
  pump(job)
  bus.emit('queue-update')
}

function pump(job) {
  if (job.done) return
  // 并发窗口：最多 MAX_INFLIGHT 片在途
  while (job.inflight.size < MAX_INFLIGHT && job.nextIdx < job.chunks && !job.done) {
    const idx = job.nextIdx++
    job.inflight.add(idx)
    sendChunk(job, idx)
  }
}

async function sendChunk(job, idx) {
  try {
    const start = idx * CHUNK_SIZE
    const end = Math.min(start + CHUNK_SIZE, job.size)
    const buf = await job.file.slice(start, end).arrayBuffer()
    if (job.done) return
    const ok = sendBinary(job.peer, frame(job.fid, idx, buf))
    if (!ok) {
      // 发送中断（连接断了）
      abortSend(job, '连接中断')
      return
    }
    job.sentAt.set(idx, Date.now())
  } catch (e) {
    abortSend(job, '读取失败')
  }
}

/* 超时巡检：超过 ACK_TIMEOUT 未 ACK 的分片重发（单片最多 MAX_RETRIES 次） */
function watch(job) {
  if (job.done) return
  const now = Date.now()
  for (const [idx, ts] of job.sentAt) {
    if (now - ts < ACK_TIMEOUT) continue
    const n = (job.retries.get(idx) || 0) + 1
    if (n > MAX_RETRIES) {
      finalizeFail(job, '分片超时（' + idx + '）')
      return
    }
    job.retries.set(idx, n)
    job.sentAt.set(idx, now)
    sendChunk(job, idx)
  }
}

/* ================= 对外消息/二进制入口（app 挂载） ================= */
export function handleIncomingMessage(payload) {
  const { perm, msg } = payload
  if (!msg || typeof msg.t !== 'string' || !msg.t.startsWith('file-')) return
  switch (msg.t) {
    case 'file-meta':
      onFileMeta(perm, msg)
      break
    case 'file-grant':
      // 收到对端授权 → 开始传输
      startSending(msg.fid)
      break
    case 'file-deny':
      onDeny(perm, msg)
      break
    case 'file-chunk-ack':
      onChunkAck(perm, msg)
      break
    case 'file-nak':
      onNak(perm, msg)
      break
  }
}

export function handleIncomingBinary(payload) {
  const { perm, buf } = payload
  const fr = parseFrame(buf)
  if (!fr) return
  const job = recvJobs.get(fr.fid)
  if (!job || job.perm !== perm || job.done) return
  if (!job.authorized) {
    // 未授权就收到数据 → 拒绝
    sendMsg(perm, { t: 'file-deny', fid: job.fid })
    recvJobs.delete(job.fid)
    bus.emit('queue-update')
    return
  }
  if (job.received.has(fr.idx)) {
    // 重复分片：仍然 ack 保持发送方窗口推进
    sendMsg(perm, { t: 'file-chunk-ack', fid: job.fid, idx: fr.idx })
    return
  }
  job.received.set(fr.idx, fr.data)
  sendMsg(perm, { t: 'file-chunk-ack', fid: job.fid, idx: fr.idx })
  bus.emit('file-recv-progress', {
    perm: job.perm,
    name: job.name,
    got: job.received.size,
    total: job.chunks,
  })
  bus.emit('queue-update')
  maybeFinalizeRecv(job)
}

/* 接收端：收到元信息 → 等 app 授权 */
function onFileMeta(perm, msg) {
  if (recvJobs.has(msg.fid)) return
  const job = {
    fid: msg.fid,
    perm,
    peerName: displayOf(perm),
    name: msg.name,
    size: msg.size,
    mime: msg.mime || 'application/octet-stream',
    chunks: msg.chunks,
    received: new Map(),
    authorized: false,
    done: false,
    nakSent: false,
  }
  recvJobs.set(msg.fid, job)
  bus.emit('queue-update')
  bus.emit('file-offer', {
    perm,
    fid: msg.fid,
    name: msg.name,
    size: msg.size,
    mime: job.mime,
  })
}

/* 授权决策（app 调用）：允许本次 || 总是允许 || 拒绝 */
export function decideReceive(fid, allow) {
  const job = recvJobs.get(fid)
  if (!job || job.done) return
  if (!allow) {
    job.done = true
    recvJobs.delete(fid)
    sendMsg(job.perm, { t: 'file-deny', fid })
    pushRecent(job, 'failed', '已拒绝')
    bus.emit('queue-update')
    history(job, 'failed', '已拒绝')
  } else {
    job.authorized = true
    sendMsg(job.perm, { t: 'file-grant', fid })
    bus.emit('file-recv-start', { perm: job.perm, name: job.name, size: job.size })
    bus.emit('queue-update')
  }
}

/* 收齐分片前检查缺口：有缺口则回发 file-nak 补传（会话内断点续传） */
function maybeFinalizeRecv(job) {
  if (job.done || job.received.size < job.chunks) return
  const missing = []
  for (let i = 0; i < job.chunks; i++) {
    if (!job.received.has(i)) missing.push(i)
  }
  if (missing.length && !job.nakSent) {
    job.nakSent = true
    sendMsg(job.perm, { t: 'file-nak', fid: job.fid, missing })
    return
  }
  if (!missing.length) finalizeRecv(job)
}

/* 收齐分片 → 组块 → 触发下载 */
function finalizeRecv(job) {
  if (job.done) return
  job.done = true
  recvJobs.delete(job.fid)
  const parts = []
  for (let i = 0; i < job.chunks; i++) parts.push(job.received.get(i))
  const blob = new Blob(parts, { type: job.mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = job.name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 60000)
  history(job, 'success')
  bus.emit('file-received', { perm: job.perm, name: job.name, size: job.size })
  bus.emit('file-recv-done', { perm: job.perm, name: job.name })
  pushRecent(job, 'done')
  bus.emit('queue-update')
  // 图片/语音/文件消息：图片与语音生成 objectURL 供会话内预览
  const isImage = job.mime.indexOf('image/') === 0
  const isAudio = job.mime.indexOf('audio/') === 0
  let type = 'file'
  let content = '已接收文件：' + job.name + '（' + formatBytes(job.size) + '）'
  if (isImage || isAudio) {
    type = isImage ? 'image' : 'audio'
    content = url // 会话内预览 URL（不持久化）
  }
  chatAdd({
    peerId: job.perm,
    direction: 'receive',
    type,
    content,
    extra: { name: job.name, size: job.size, mime: job.mime },
    timestamp: Date.now(),
  })
}

/* ---------- 发送方收尾 ---------- */
function onChunkAck(perm, msg) {
  const job = sendJobs.get(msg.fid)
  if (!job || job.peer !== perm || job.done) return
  job.inflight.delete(msg.idx)
  job.acked.add(msg.idx)
  job.sentAt.delete(msg.idx)
  job.retries.delete(msg.idx)
  bus.emit('file-progress', {
    perm: job.peer,
    name: job.name,
    sent: job.acked.size,
    total: job.chunks,
  })
  bus.emit('queue-update')
  if (job.acked.size >= job.chunks) {
    sendMsg(job.peer, { t: 'file-done', fid: job.fid })
    finalizeSend(job)
  } else {
    pump(job)
  }
}

/* 接收端缺口补传请求 */
function onNak(perm, msg) {
  const job = sendJobs.get(msg.fid)
  if (!job || job.peer !== perm || job.done) return
  for (const idx of msg.missing || []) {
    if (job.acked.has(idx)) continue
    job.inflight.add(idx)
    sendChunk(job, idx)
  }
}

function finalizeSend(job) {
  if (job.done) return
  job.done = true
  clearTimeout(job.grantTimer)
  clearInterval(job.watchTimer)
  sendJobs.delete(job.fid)
  pushRecent(job, 'done')
  bus.emit('queue-update')
  history(job, 'success')
  bus.emit('file-send-done', { perm: job.peer, name: job.name, size: job.size })
  chatAdd({
    peerId: job.peer,
    direction: 'send',
    type: 'file',
    content: '已发送文件：' + job.name + '（' + formatBytes(job.size) + '）',
    timestamp: Date.now(),
  })
}

function onDeny(perm, msg) {
  const job = sendJobs.get(msg.fid)
  if (job && job.peer === perm) finalizeFail(job, '对方拒绝')
}

function abortSend(job, reason) {
  if (job.done) return
  finalizeFail(job, reason)
}

function finalizeFail(job, reason) {
  if (job.done) return
  job.done = true
  clearTimeout(job.grantTimer)
  clearInterval(job.watchTimer)
  sendJobs.delete(job.fid)
  pushRecent(job, 'failed', reason)
  bus.emit('queue-update')
  history(job, 'failed', reason)
  bus.emit('file-send-fail', { perm: job.peer, name: job.name, reason })
  chatAdd({
    peerId: job.peer,
    direction: 'send',
    type: 'file',
    content: '发送失败：' + job.name + (reason ? '（' + reason + '）' : ''),
    timestamp: Date.now(),
  })
}

function history(job, status, detail) {
  addHistory({
    peerId: job.peer,
    peerName: job.peerName,
    action: 'file_transfer',
    detail: job.name + ' (' + formatBytes(job.size) + ')' + (detail ? ' · ' + detail : ''),
    status,
  })
}
