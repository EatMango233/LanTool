/* ==========================================
 * voice.js — 语音通话（1对1，仅音频）
 *
 * 语音使用独立的 RTCPeerConnection（与数据通道分开），
 * 但 SDP/ICE 交换复用现有数据通道的信令消息：
 *   {t:'voice', act:'offer'|'answer'|'ice'|'reject'|'hangup', sdp?|candidate?}
 * ========================================== */
import { bus, toast } from './utils.js'
import { sendMsg, getPeerState } from './webrtc.js'
import { addHistory } from './history.js'
import * as webrtc from './webrtc.js'

const calls = new Map() // perm -> {dir, pc, local:MediaStream, remote:MediaStream}

function audioEl(perm) {
  let el = document.getElementById('audio-' + perm)
  if (!el) {
    el = document.createElement('audio')
    el.id = 'audio-' + perm
    el.autoplay = true
    document.body.appendChild(el)
  }
  return el
}

function emitCall(perm, status) {
  bus.emit('voice-call', { perm, status })
}

/* ---------------- 发起通话 ---------------- */
export async function startVoiceCall(perm) {
  if (getPeerState(perm) !== 'connected') {
    toast('目标设备不在线', 'warn')
    return false
  }
  if (calls.has(perm)) {
    toast('当前已有通话', 'warn')
    return false
  }
  let local
  try {
    local = await navigator.mediaDevices.getUserMedia({ audio: true })
  } catch (e) {
    toast('语音通话需要麦克风权限', 'warn')
    return false
  }
  const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] })
  local.getTracks().forEach((t) => pc.addTrack(t, local))

  const call = { dir: 'caller', pc, local, remote: new MediaStream(), state: 'calling' }
  calls.set(perm, call)
  pc.ontrack = (e) => {
    call.remote.addTrack(e.track)
    audioEl(perm).srcObject = call.remote
    audioEl(perm).play().catch(() => {})
  }
  // ICE 候选 → 数据通道转发
  pc.onicecandidate = (e) => {
    if (e.candidate) sendMsg(perm, { t: 'voice', act: 'ice', candidate: e.candidate })
  }
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
      emitCall(perm, 'ended')
    }
  }
  // 发送邀请 + offer
  const offer = await pc.createOffer()
  await pc.setLocalDescription(offer)
  sendMsg(perm, { t: 'voice', act: 'invite', sdp: offer, name: webrtc.getMyInfo().deviceName || '' })
  emitCall(perm, 'calling')
  record(perm, 'voice_call', '发起语音通话', 'success')
  return true
}

/* ---------------- 对方来电：挂到 UI 弹窗，由 app 调 accept/reject ---------------- */
export function rejectVoice(perm) {
  const c = calls.get(perm)
  if (c) {
    stopCall(c)
    calls.delete(perm)
  }
  sendMsg(perm, { t: 'voice', act: 'reject' })
  emitCall(perm, 'rejected')
}

export async function acceptVoice(perm) {
  const c = calls.get(perm)
  if (!c) return false
  let local
  try {
    local = await navigator.mediaDevices.getUserMedia({ audio: true })
  } catch (e) {
    toast('语音通话需要麦克风权限', 'warn')
    sendMsg(perm, { t: 'voice', act: 'reject' })
    calls.delete(perm)
    return false
  }
  c.local = local
  // 先应用对方 offer（来电时暂存的 SDP）
  if (c.pendingOffer) {
    await c.pc.setRemoteDescription(new RTCSessionDescription(c.pendingOffer)).catch((e) => {
      toast('通话协商失败', 'error')
      return false
    })
    c.pendingOffer = null
  }
  local.getTracks().forEach((t) => c.pc.addTrack(t, local))
  const answer = await c.pc.createAnswer()
  await c.pc.setLocalDescription(answer)
  sendMsg(perm, { t: 'voice', act: 'accept', sdp: answer })
  c.state = 'active'
  emitCall(perm, 'active')
  record(perm, 'voice_call', '接听语音通话', 'success')
  return true
}

export function endVoiceCall(perm) {
  const c = calls.get(perm)
  if (c) {
    stopCall(c)
    calls.delete(perm)
  }
  sendMsg(perm, { t: 'voice', act: 'hangup' })
  emitCall(perm, 'ended')
}

function stopCall(c) {
  if (c.local && typeof c.local.getTracks === 'function') {
    const local = c.local
    local.getTracks().forEach((t) => t.stop())
  }
  if (c.pc) c.pc.close()
  if (c.remote) c.remote.getTracks().forEach((t) => t.stop())
}

/* ---------------- 数据通道消息处理 ---------------- */
export function handleVoiceMessage(payload) {
  const { perm, msg } = payload
  if (!msg || msg.t !== 'voice') return false
  if (!calls.has(perm)) {
    // 来电方已退出
    if (msg.act === 'reject' || msg.act === 'hangup') {
      emitCall(perm, 'ended')
      return true
    }
    if (msg.act !== 'invite') return true
  }
  const c = calls.get(perm)

  switch (msg.act) {
    case 'invite':
      // 待处理：先建 pc (对端)等待接听
      if (calls.has(perm)) return true
      {
        const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] })
        const call = { dir: 'callee', pc, local: null, remote: new MediaStream(), state: 'ringing' }
        calls.set(perm, call)
        pc.ontrack = (e) => {
          call.remote.addTrack(e.track)
          audioEl(perm).srcObject = call.remote
          audioEl(perm).play().catch(() => {})
        }
        pc.onicecandidate = (e) => {
          if (e.candidate) sendMsg(perm, { t: 'voice', act: 'ice', candidate: e.candidate })
        }
        // 需要先 setRemoteDescription 才能 createAnswer
        call.pendingOffer = msg.sdp
        emitCall(perm, 'ringing') // app 弹窗
        bus.emit('voice-incoming', { perm, name: msg.name || '' })
      }
      break
    case 'accept':
      // 发起方接收答案
      if (c && msg.sdp) {
        c.pc.setRemoteDescription(new RTCSessionDescription(msg.sdp)).catch((e) => {})
        c.state = 'active'
        emitCall(perm, 'active')
      }
      break
    case 'reject':
      if (c) {
        stopCall(c)
        calls.delete(perm)
      }
      emitCall(perm, 'rejected')
      toast('对方拒绝了语音通话', 'warn')
      break
    case 'hangup':
      if (c) {
        stopCall(c)
        calls.delete(perm)
      }
      emitCall(perm, 'ended')
      break
    case 'ice':
      if (c && msg.candidate) {
        c.pc.addIceCandidate(new RTCIceCandidate(msg.candidate)).catch(() => {})
      }
      break
  }
  return true
}

/* 被叫方在接受时调用 setRemote + createAnswer（acceptVoice 里补） */
function record(peerId, action, detail, status) {
  // 尽量用真实别名
  let name = '设备'
  import('./trust.js').then((t) => {
    const d = t.findDevice(peerId)
    if (d) name = t.displayName(d)
    addHistory({ peerId, peerName: name, action, detail, status })
  })
}

/* 监听总线消息，自动分流语音（app 可替代） */
export function setupVoiceBus() {
  bus.on('message', (payload) => handleVoiceMessage(payload))
}

/* 获取当前通话状态（供 UI 轮询） */
export function getCallState(perm) {
  const c = calls.get(perm)
  return c ? c.state : 'none'
}