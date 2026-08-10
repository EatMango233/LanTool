/* ==========================================
 * app.js — Vue 3 根实例
 * 页面装配 + 事件总线编排 + 全部交互入口
 * 模板位于 index.html 中 <script type="text/x-template" id="app-tpl">
 * ========================================== */
import { createApp } from 'vue'
import { bus, toast, copyText, formatBytes, formatTime, isWebRTCSupported, ripples } from './utils.js'
import * as device from './device.js'
import * as trust from './trust.js'
import * as webrtc from './webrtc.js'
import * as relay from './relay.js'
import * as chat from './chat.js'
import * as file from './file.js'
import * as clip from './clipboard.js'
import * as voice from './voice.js'
import { getAllHistory } from './history.js'
import { registerSW } from './pwa.js'

// 从 index.html 的 #app-tpl 读取渲染模板
const tpl = document.getElementById('app-tpl')
if (!tpl) {
  document.getElementById('app').innerHTML = '<div style="padding:32px;color:#B3261E">找不到模板 #app-tpl</div>'
  throw new Error('template #app-tpl not found')
}

const app = createApp({
  /* 渲染模板取自 #app-tpl */
  template: tpl.innerHTML,
  data() {
    return {
      theme: 'system', // system|light|dark
      myName: '',
      myPerm: '',
      detecting: false,
      devices: [],
      curPerm: '',
      messages: [],
      draft: '',
      rttMap: {},
      statusText: '',
      // 对话框状态
      pairingShow: false,
      pairInfo: null, // {sessionId, name, via, relaySdp}
      manualShow: false,
      manualBusy: false,
      manualMode: 'pair',
      manualTarget: null,
      manualCodeOut: '',
      manualCodeIn: '',
      qrScanShow: false,
      showFileAuth: false,
      fileAuthInfo: null, // {perm, fid, name, size}
      showIframeAuth: false,
      iframeAuthInfo: null, // {perm, url}
      showVoice: false,
      voiceInfo: null, // {perm}
      voiceActive: {}, // perm -> calling|active|ringing
      showAlias: false,
      aliasTarget: null, // {perm}
      aliasInput: '',
      aliasShow: true,
      showRename: false,
      renameInput: '',
      showHistory: false,
      historyList: [],
      showIframeView: false,
      iframeUrl: '',
      iframeDraft: '',
      iframeDlg: false,
      busyLabel: '',
      onlineMap: {},
      lanIPs: [],
      progress: {},
      _reconCount: {},
      relayStatus: '', // ''|connecting|connected|down
      discovered: [], // [{perm, name}] 公网中继发现、尚未配对的新设备
      // 新功能状态
      unread: {}, // perm -> 未读计数
      recState: 'idle', // idle | recording | stopping（语音消息录音）
      recSeconds: 0,
      transferShow: false, // 传输队列面板
      queueSend: [],
      queueRecv: [],
      queueDone: [],
      showSettings: false,
      settingsTheme: 'system',
      settingsAutoAccept: true,
      settingsRelay: true,
      onboardShow: false, // 首次引导
      onboardStep: 1,
      imageZoomUrl: '',
      showImageZoom: false,
      ver: 'v10', // 与 sw.js CACHE_NAME 同步，用于确认是否运行最新代码
    }
  },
  computed: {
    /* 当前会话设备显示名 */
    curName() {
      if (!this.curPerm) return ''
      const d = trust.findDevice(this.curPerm)
      return d ? trust.displayName(d) : '设备'
    },
    /* 公网中继状态文案 */
    relayLabel() {
      const m = { '': '未启动', connecting: '连接中…', connected: '已连接', down: '未连接' }
      return m[this.relayStatus] || this.relayStatus
    },
    relayDotOn() {
      return this.relayStatus === 'connected'
    },
    /* 当前页面地址（诊断：两个标签必须完全同源才能走 BroadcastChannel 信令） */
    originText() {
      return location.origin + location.pathname
    },
    /* 未读消息总数（设备卡角标 / 导航提示） */
    totalUnread() {
      let n = 0
      for (const k in this.unread) n += this.unread[k] || 0
      return n
    },
    /* 传输队列中的活动任务数（底部导航角标） */
    queueActiveCount() {
      return this.queueSend.length + this.queueRecv.length
    },
  },
  mounted() {
    this.boot()
    this.$nextTick(() => this.armRipples())
  },
  methods: {
    /* ================ 初始化 ================ */
    // 给可交互元素加上 ripple 波纹反馈
    armRipples() {
      const scope = this.$el
      if (!scope) return
      ripples('.btn, .icon-btn, .mini-btn, .name-btn, .action-btn', scope)
      ripples('.device-card', scope)
      ripples('.overlay .dlg-actions .btn', scope)
    },
    boot() {
      // 浏览器支持校验
      if (!isWebRTCSupported()) {
        toast('请使用 Chrome/Edge/Firefox')
        return
      }
      // 设备身份与配置
      const info = device.getDeviceInfo()
      this.myName = info.deviceName
      this.myPerm = info.permanentId
      const cfg = device.getUserConfig()
      this.theme = cfg.theme || 'system'
      this.applyTheme(this.theme, true)
      this.settingsAutoAccept = cfg.autoAcceptKnown !== false
      this.settingsRelay = cfg.relayEnabled !== false

      // 首次引导
      if (!localStorage.getItem('lantoool-onboard')) this.onboardShow = true
      // 申请系统通知权限（用户操作时再弹，这里仅预检查）
      if ('Notification' in window && Notification.permission === 'default') {
        // 不主动弹，等设置面板/操作时请求
      }

      // 信令初始化
      webrtc.initSignaling()
      // 公网中继（LocalSend 公共服务器）第三信令通道：跨设备自动发现
      if (this.settingsRelay) relay.connect()

      // 本机局域网 IP（B 方案）
      webrtc.getLanIPs().then((ips) => { this.lanIPs = ips })

      // 事件绑定
      this.bindBus()

      // 设备列表
      this.reloadDevices()

      // PWA
      registerSW()

      // 页面加载自动探测在线
      setTimeout(() => this.probeNow(), 500)
      // URL 配对码自动处理（需在 Vue 挂载后）
      this.$nextTick(() => this.handlePairHash())
    },

    /* ================ 手动配对（复制粘贴/扫码信令，跨设备） ================ */
    // mode: 'pair' 首次配对 | 'reconnect' 重新连接（凭信任列表校验）
    openManualPair(mode = 'pair', dev = null) {
      this.manualShow = true
      this.manualBusy = false
      this.manualMode = mode
      this.manualTarget = dev
      this.manualCodeOut = ''
      this.manualCodeIn = ''
    },
    manualClose() {
      this.manualShow = false
    },
    async genManualOffer() {
      this.manualBusy = true
      try {
        if (this.manualMode === 'reconnect') {
          // 重连：无需令牌，凭永久 ID 与信任列表校验
          const target = this.manualTarget
          if (!target) throw new Error('未指定目标设备')
          this.manualCodeOut = await webrtc.manualOffer({ reconnect: true, targetPerm: target.permanentId })
        } else {
          // 首次配对：直接生成 offer 码（无临时令牌，信任经交换永久令牌建立）
          this.manualCodeOut = await webrtc.manualOffer({})
        }
        this.renderQr(this.manualCodeOut)
        toast('配对码已生成，请复制或扫码发送给对方', 'success')
      } catch (e) {
        toast('生成失败：' + (e.message || '未知错误'), 'error')
      } finally {
        this.manualBusy = false
      }
    },
    async processManualCode() {
      const code = (this.manualCodeIn || '').trim()
      if (!code) return
      this.manualBusy = true
      try {
        const meta = webrtc.manualPeek(code)
        if (meta.kind === 'offer') {
          // 接收方：校验并生成应答码（重连模式自动走信任校验）
          this.manualCodeOut = await webrtc.manualAccept(code)
          toast(meta.reconnect ? '重连应答码已生成，请复制发回对方' : '应答码已生成，请复制发回对方', 'success')
        } else if (meta.kind === 'answer') {
          // 发起方：粘贴应答码完成连接
          const r = await webrtc.manualApply(code)
          toast((meta.reconnect ? '重连成功：' : '配对成功：') + (r.name || '设备'), 'success')
          this.manualShow = false
          this.reloadDevices()
        } else {
          toast('配对码格式不正确', 'error')
        }
      } catch (e) {
        const msg =
          e.message === 'not-trusted'
            ? '对方不在信任列表，无法重连'
            : e.message || '未知错误'
        toast('处理失败：' + msg, 'error')
      } finally {
        this.manualBusy = false
      }
    },
    /* 从 URL hash 读取配对码并自动处理（D 方案） */
    async handlePairHash() {
      const m = /^#pair=(.+)$/.exec(window.location.hash)
      if (!m) return
      const code = decodeURIComponent(m[1])
      // 处理完立即清除 hash，避免刷新重复处理
      window.history.replaceState(null, '', window.location.pathname + window.location.search)
      this.manualBusy = true
      try {
        const meta = webrtc.manualPeek(code)
        if (meta.kind === 'offer') {
          // 我作为接收方：自动应答，弹窗让用户复制应答码发回
          this.openManualPair(meta.reconnect ? 'reconnect' : 'pair')
          this.manualCodeOut = await webrtc.manualAccept(code)
          this.renderQr(this.manualCodeOut)
          this.manualCodeIn = ''
          toast('已自动接收配对码，请复制应答码发回对方', 'success')
        } else if (meta.kind === 'answer') {
          // 我是发起方：粘贴应答码完成连接
          const r = await webrtc.manualApply(code)
          toast('配对成功：' + (r.name || '设备'), 'success')
          this.manualShow = false
          this.reloadDevices()
        } else {
          toast('配对码格式不正确', 'error')
        }
      } catch (e) {
        const msg = e.message === 'not-trusted' ? '对方不在信任列表，无法重连' : (e.message || '未知错误')
        toast('URL 配对失败：' + msg, 'error')
      } finally {
        this.manualBusy = false
      }
    },
    copyManualCode() {
      copyText(this.manualCodeOut).then((ok) => toast(ok ? '已复制' : '复制失败', ok ? 'success' : 'error'))
    },
    /* 复制"含配对码的 URL 链接"（D 方案）：对方点开自动处理 */
    copyManualLink() {
      if (!this.manualCodeOut) return
      const url = location.origin + location.pathname + '#pair=' + encodeURIComponent(this.manualCodeOut)
      copyText(url).then((ok) => toast(ok ? '链接已复制，发送给对方点开即可' : '复制失败', ok ? 'success' : 'error'))
    },
    /* 生成当前配对码的 URL 形式（二维码内容与此一致，B 系统相机扫后可自动应答） */
    pairUrl(code) {
      return location.origin + location.pathname + '#pair=' + encodeURIComponent(code)
    },
    /* 把配对码渲染成二维码（qrcodejs 全局 QRCode） */
    renderQr(text) {
      this.$nextTick(() => {
        const box = this.$refs.qrOut
        if (!box) return
        box.innerHTML = ''
        if (typeof QRCode === 'undefined' || !text) return
        new QRCode(box, {
          text: this.pairUrl(text),
          width: 168,
          height: 168,
          correctLevel: QRCode.CorrectLevel.H,
        })
      })
    },
    /* 打开扫码弹窗（A 端回传应答码） */
    async openQrScan() {
      this.qrScanShow = true
      this._scanTimer = setTimeout(() => {
        this.closeQrScan()
        toast('扫码超时，请重试', 'warn')
      }, 60000)
      await this.$nextTick()
      const video = this.$refs.qrVideo
      const canvas = this.$refs.qrCanvas
      if (!video || !canvas) return
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
          audio: false,
        })
        this._scanStream = stream
        video.srcObject = stream
        await video.play()
        this._scanRaf = requestAnimationFrame(() => this.scanLoop(video, canvas))
      } catch (e) {
        this.closeQrScan()
        toast('扫码需要摄像头权限', 'error')
      }
    },
    closeQrScan() {
      if (this._scanRaf) cancelAnimationFrame(this._scanRaf)
      if (this._scanTimer) clearTimeout(this._scanTimer)
      if (this._scanStream) {
        this._scanStream.getTracks().forEach((t) => t.stop())
      }
      this._scanStream = null
      this._scanRaf = null
      this._scanTimer = null
      this.qrScanShow = false
    },
    scanLoop(video, canvas) {
      if (!this.qrScanShow) return
      if (video.readyState === video.HAVE_ENOUGH_DATA) {
        const ctx = canvas.getContext('2d')
        canvas.width = video.videoWidth
        canvas.height = video.videoHeight
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
        if (typeof jsQR !== 'undefined') {
          const qr = jsQR(imageData.data, imageData.width, imageData.height)
          if (qr && qr.data) {
            this.onQrDetected(qr.data)
            return
          }
        }
      }
      this._scanRaf = requestAnimationFrame(() => this.scanLoop(video, canvas))
    },
    /* 检测到二维码：提取配对码并自动处理 */
    onQrDetected(text) {
      let code = text
      const i = text.indexOf('#pair=')
      if (i >= 0) code = text.slice(i + '#pair='.length)
      try {
        code = decodeURIComponent(code)
      } catch (e) {}
      this.closeQrScan()
      this.manualCodeIn = code
      this.processManualCode()
    },

    /* 接受配对（公网中继发现的新设备，弹窗确认） */
    async acceptPair() {
      const info = this.pairInfo
      if (info && info.via === 'relay') {
        // 经公网中继：接受则构建 answer 回传，连接建立后 hello 交换完成信任
        try {
          const { sdp } = await webrtc.buildAnswerSdp(info.relaySdp, { perm: info.perm, name: info.name })
          relay.sendAnswer(info.perm, info.sessionId, sdp)
        } catch (e) {
          toast('连接建立失败', 'error')
        }
      }
      this.pairingClose()
    },
    pairingClose() {
      this.pairingShow = false
      this.pairInfo = null
    },

    /* ================ 事件总线 ================ */
    bindBus() {
      // 公网中继发现的新设备配对请求
      bus.on('pair-request', (info) => {
        this.pairInfo = info
        this.pairingShow = true
        this.safeVibrate()
      })
      bus.on('pair-accepted', (info) => {
        toast('配对成功：' + (info.name || '设备'), 'success')
      })
      // 直连请求（白名单自动接受）
      bus.on('connect-request', (info) => {
        const dev = trust.findDevice(info.perm)
        const cfg = device.getUserConfig()
        if (dev && dev.connectionTrusted !== false && (cfg.autoAcceptKnown || dev.connectionTrusted)) {
          webrtc.acceptConnect(info.sessionId)
          trust.touchDevice(info.perm)
          this.reloadDevices()
        }
      })
      // 连接建立
      bus.on('peer-ready', (ev) => {
        if (!ev.perm) return
        // 清理公网中继建连状态（取消防泄漏定时器）
        if (this._relayTimers && this._relayTimers[ev.perm]) {
          clearTimeout(this._relayTimers[ev.perm])
          delete this._relayTimers[ev.perm]
        }
        if (this._relayConnecting) delete this._relayConnecting[ev.perm]
        this.discovered = this.discovered.filter((d) => d.perm !== ev.perm)
        // 星型中继：向其他已连接设备广播新设备身份，向新设备回发在线列表
        this.relayBroadcast(ev.perm, ev.name)
        const d = trust.upsertDevice({
          permanentId: ev.perm,
          originalName: ev.name,
          connectionTrusted: true,
          lastSeen: Date.now(),
        })
        this.reloadDevices()
        // 若当前正处于等待连接状态则刷新会话
        if (this.curPerm === ev.perm) {
          this.loadChat(ev.perm)
          this.busyLabel = ''
        }
      })
      bus.on('peer-left', (perm) => {
        this.reloadDevices()
      })
      bus.on('peer-close', (perm) => {
        this.reloadDevices()
      })

      // ===== 公网中继（LocalSend 服务器）第三信令通道 =====
      bus.on('relay-status', (s) => {
        this.relayStatus = s
        if (s === 'down') toast('公网中继连接断开，已回退原配对方式', 'warn')
      })
      bus.on('relay-peer-join', (ev) => {
        // 过滤非 LanTool / 自己
        if (!ev.perm || ev.perm === this.myPerm) return
        const dev = trust.findDevice(ev.perm)
        if (dev && dev.connectionTrusted !== false) {
          // 信任设备：自动互联（永久ID较小方发起 offer，避免双方同时 offer）
          if (this.myPerm < ev.perm) this.offerViaRelay(ev.perm)
        } else {
          // 新设备：加入"发现的新设备"分组（去重）
          if (!this.discovered.find((d) => d.perm === ev.perm)) {
            this.discovered.push({ perm: ev.perm, name: ev.name || '' })
            this.$forceUpdate()
          }
        }
      })
      bus.on('relay-peer-left', (perm) => {
        this.discovered = this.discovered.filter((d) => d.perm !== perm)
      })
      bus.on('relay-offer', async (ev) => {
        if (!ev.perm || ev.perm === this.myPerm) return
        // 撞车（双方同时发起）：取消自己已发出的 offer，改为应答对方
        if (this._relaySid && this._relaySid[ev.perm]) {
          webrtc.cancelSession(this._relaySid[ev.perm])
          delete this._relaySid[ev.perm]
          if (this._relayTimers && this._relayTimers[ev.perm]) {
            clearTimeout(this._relayTimers[ev.perm])
            delete this._relayTimers[ev.perm]
          }
          if (this._relayConnecting) delete this._relayConnecting[ev.perm]
        }
        const dev = trust.findDevice(ev.perm)
        if (dev && dev.connectionTrusted !== false) {
          // 信任设备：自动应答
          try {
            const { sdp } = await webrtc.buildAnswerSdp(ev.sdp, { perm: ev.perm, name: ev.name })
            relay.sendAnswer(ev.perm, ev.sessionId, sdp)
          } catch (e) {}
        } else {
          // 新设备：弹确认（复用配对弹窗，标记来源为公网中继）
          this.pairInfo = {
            sessionId: ev.sessionId,
            perm: ev.perm,
            name: ev.name || '未知设备',
            via: 'relay',
            relaySdp: ev.sdp,
          }
          this.pairingShow = true
          this.safeVibrate()
        }
      })
      bus.on('relay-answer', async (ev) => {
        try {
          await webrtc.applyAnswer(ev.sessionId, ev.sdp)
        } catch (e) {}
      })

      bus.on('peer-fail', (ev) => {
        // 自动重连（最多3次）
        const n = (this._reconCount[ev.perm] || 0) + 1
        this._reconCount[ev.perm] = n
        if (n > 3) {
          delete this._reconCount[ev.perm]
          toast('连接中断，重连失败', 'error')
          return
        }
        setTimeout(() => {
          webrtc.connectTrusted(ev.perm).catch(() => {})
        }, 800 * n)
        this.reloadDevices()
      })

      // 数据消息（聊天/文件/剪贴板/推送/同步）
      bus.on('message', (payload) => this.routeMessage(payload))

      // 二进制分片 → 文件接收
      bus.on('binary', (payload) => file.handleIncomingBinary(payload))

      // 文件授权
      bus.on('file-offer', (ev) => {
        const dev = trust.findDevice(ev.perm)
        if (dev && dev.operationTrusted) {
          file.decideReceive(ev.fid, true)
        } else {
          this.fileAuthInfo = ev
          this.showFileAuth = true
          this.safeVibrate()
        }
      })
      bus.on('file-send-fail', (ev) => {
        toast('文件发送失败：' + (ev.reason || '未知'), 'error')
      })
      bus.on('file-received', (ev) => {
        toast('文件已接收：' + ev.name, 'success')
      })

      // 语音来电
      bus.on('voice-incoming', (ev) => {
        this.voiceInfo = ev
        this.showVoice = true
        this.safeVibrate()
      })
      bus.on('voice-call', (ev) => {
        this.voiceActive[ev.perm] = ev.status
        if (ev.status === 'ended' || ev.status === 'rejected') {
          delete this.voiceActive[ev.perm]
        }
        this.$forceUpdate()
      })

      // 传输进度（文件）
      bus.on('file-start', (ev) => {
        this.setProgress(ev.perm, { direction: 'out', name: ev.name, got: 0, total: 1 })
      })
      bus.on('file-recv-start', (ev) => {
        this.setProgress(ev.perm, { direction: 'in', name: ev.name, got: 0, total: 1 })
      })
      bus.on('file-progress', (ev) => {
        this.setProgress(ev.perm, { direction: 'out', name: ev.name, got: ev.sent, total: ev.total })
      })
      bus.on('file-recv-progress', (ev) => {
        this.setProgress(ev.perm, { direction: 'in', name: ev.name, got: ev.got, total: ev.total })
      })
      bus.on('file-send-done', (ev) => {
        this.clearProgress(ev.perm)
      })
      bus.on('file-recv-done', (ev) => {
        this.clearProgress(ev.perm)
      })
      bus.on('chat-add', (m) => {
        if (!m) return
        if (m.peerId === this.curPerm) {
          this.messages.push(m)
          this.scrollChat()
        } else if (m.direction === 'receive') {
          // 非当前会话收到消息 → 未读计数 + 通知
          this.bumpUnread(m.peerId)
        }
      })
      // 传输队列变化 → 刷新队列（含导航角标）
      bus.on('queue-update', () => {
        this.refreshQueue()
      })
    },

    /* 星型中继扩散：广播新设备身份 + 回发在线列表（C 方案） */
    relayBroadcast(perm, name) {
      const list = this.devices.filter((d) => d.status === 'connected' && d.permanentId !== perm)
      const payload = list.map((d) => ({ perm: d.permanentId, name: d.originalName || '' }))
      // 向新设备回发在线列表
      webrtc.sendMsg(perm, { t: 'peer-list', peers: payload })
      // 向其他已连接设备广播新设备身份
      for (const d of list) {
        webrtc.sendMsg(d.permanentId, { t: 'relay-peer', perm, name })
      }
    },

    /* 收到聊天类型消息（chat）入库 */
    recvChat(perm, msg) {
      const rec = {
        peerId: perm,
        direction: 'receive',
        type: 'text',
        content: msg.text,
        timestamp: msg.ts || Date.now(),
      }
      import('./history.js').then((h) => h.addMessage(rec))
      bus.emit('chat-add', rec)
    },

    /* ================ 消息路由 ================ */
    routeMessage(payload) {
      const { perm, msg } = payload
      if (!msg || !msg.t) return
      switch (true) {
        case msg.t === 'chat':
          this.recvChat(perm, msg)
          break
        case msg.t.startsWith('file-'):
          file.handleIncomingMessage(payload)
          break
        case msg.t === 'clipboard':
          clip.handleClipboard(payload)
          break
        case msg.t === 'iframe':
          this.recvIframe(perm, msg)
          break
        case msg.t === 'theme':
          this.applyTheme(msg.theme, false)
          break
        case msg.t === 'name':
          { const d = trust.findDevice(perm); if (d) { d.originalName = msg.name; this.reloadDevices() } }
          break
        case msg.t === 'alias':
          this.recvAlias(payload)
          break
        case msg.t === 'ghost':
          this.recvGhost(payload)
          break
        case msg.t === 'relay-peer':
          this.autoTrustConnect(msg.perm, msg.name)
          break
        case msg.t === 'peer-list':
          for (const p of msg.peers || []) this.autoTrustConnect(p.perm, p.name)
          break
        case msg.t === 'voice':
          voice.handleVoiceMessage(payload)
          break
      }
    },

    /* 收到中继广播：自动加入信任列表并尝试连接（循环防护：已连接/自己跳过） */
    autoTrustConnect(perm, name) {
      if (!perm || perm === this.myPerm) return
      if (webrtc.getPeerState(perm) !== 'offline') return
      if (!trust.findDevice(perm)) {
        trust.upsertDevice({
          permanentId: perm,
          originalName: name || '',
          connectionTrusted: true,
          lastSeen: Date.now(),
        })
      }
      this.reloadDevices()
      webrtc.connectTrusted(perm).catch(() => {})
    },

    /* ================ 公网中继建连编排 ================ */
    /* 经公网中继发起 offer：buildOfferSdp → sendOffer；20s 未连上自动清理防泄漏 */
    async offerViaRelay(perm) {
      if (!perm || webrtc.getPeerState(perm) !== 'offline') return
      if (this._relayConnecting && this._relayConnecting[perm]) return
      this._relayConnecting = this._relayConnecting || {}
      this._relayConnecting[perm] = true
      try {
        const { sessionId, sdp } = await webrtc.buildOfferSdp()
        this._relaySid = this._relaySid || {}
        this._relaySid[perm] = sessionId
        if (!relay.sendOffer(perm, sessionId, sdp)) {
          webrtc.cancelSession(sessionId)
          delete this._relayConnecting[perm]
          delete this._relaySid[perm]
          return
        }
        this._relayTimers = this._relayTimers || {}
        this._relayTimers[perm] = setTimeout(() => {
          webrtc.cancelSession(sessionId)
          if (this._relaySid && this._relaySid[perm] === sessionId) delete this._relaySid[perm]
          delete this._relayConnecting[perm]
        }, 20000)
      } catch (e) {
        delete this._relayConnecting[perm]
      }
    },
    /* 用户点击"发现的新设备 → 配对"：发起连接 */
    pairDiscovered(dev) {
      if (!dev || !dev.perm) return
      this.offerViaRelay(dev.perm)
    },
    /* 公网中继手动重连（状态 down 时兜底） */
    relayNow() {
      relay.retry()
    },

    recvIframe(perm, msg) {
      // 对端授权回执：本端不再内嵌（避免重页面拖垮标签页），仅提示
      if (msg.act === 'allow') {
        toast('对方已接收网页推送', 'info')
        return
      }
      const dev = trust.findDevice(perm)
      if (dev && dev.operationTrusted) {
        this.openIframeView(perm, msg.url)
      } else {
        this.iframeAuthInfo = { perm, url: msg.url }
        this.showIframeAuth = true
        this.safeVibrate()
      }
    },
    recvAlias(payload) {
      const { perm, msg } = payload
      const dev = trust.findDevice(perm)
      if (dev) {
        trust.setAlias(perm, msg.alias || '')
        trust.setShowOriginal(perm, msg.show === false ? false : true)
        this.reloadDevices()
        toast('对方已为你命名：' + msg.alias, 'info')
      }
    },
    recvGhost(payload) {
      const { perm, msg } = payload
      if (msg.text) {
        // 尝试解析并直接切换会话
        try {
          let body = msg.text.replace(/^LanSync:\s*/, '')
          let info = null
          try {
            info = JSON.parse(body)
          } catch (e) {
            info = JSON.parse(decodeURIComponent(body))
          }
          if (info && info.cur && info.cur !== this.myPerm) {
            this.curPerm = info.cur
            this.loadChat(info.cur)
            const d = trust.findDevice(info.cur)
            toast('幽灵同步：已切换至 ' + (d ? trust.displayName(d) : info.name), 'success')
          }
        } catch (e) {}
      }
    },

    /* ================ 未读 + 通知 ================ */
    bumpUnread(perm) {
      if (!perm) return
      this.unread[perm] = (this.unread[perm] || 0) + 1
      this.playBeep()
      if (typeof document !== 'undefined' && !document.hasFocus()) {
        this.notify('LanTool 新消息', '来自 ' + (this.devName(perm) || '设备') + ' 的消息')
      }
      this.$forceUpdate()
    },
    clearUnread(perm) {
      if (perm && this.unread[perm]) {
        this.unread[perm] = 0
        this.$forceUpdate()
      }
    },
    devName(perm) {
      const d = trust.findDevice(perm)
      return d ? trust.displayName(d) : ''
    },
    /* 请求系统通知权限（设置面板手动触发） */
    requestNotifyPermission() {
      if (!('Notification' in window)) {
        toast('当前浏览器不支持系统通知', 'warn')
        return
      }
      Notification.requestPermission().then((p) => {
        toast(p === 'granted' ? '系统通知已开启' : '系统通知未授权', p === 'granted' ? 'success' : 'warn')
      })
    },
    notify(title, body) {
      try {
        if ('Notification' in window && Notification.permission === 'granted') {
          new Notification(title, { body, icon: './icons/icon-192.png' })
        }
      } catch (e) {}
    },
    playBeep() {
      try {
        const Ctx = window.AudioContext || window.webkitAudioContext
        if (!Ctx) return
        const ctx = new Ctx()
        const o = ctx.createOscillator()
        const g = ctx.createGain()
        o.type = 'sine'
        o.frequency.value = 880
        g.gain.setValueAtTime(0.08, ctx.currentTime)
        o.connect(g)
        g.connect(ctx.destination)
        o.start()
        o.stop(ctx.currentTime + 0.15)
        o.onended = () => ctx.close()
      } catch (e) {}
    },

    /* ================ 语音消息（录音 → 文件传输） ================ */
    async startVoiceRec() {
      if (this.recState === 'recording') return
      if (!this.curPerm) {
        toast('请先选择设备', 'warn')
        return
      }
      try {
        this._recStream = await navigator.mediaDevices.getUserMedia({ audio: true })
        const supported = typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported('audio/webm')
        const mime = supported ? 'audio/webm' : ''
        this._mediaRec = new MediaRecorder(this._recStream, mime ? { mimeType: mime } : undefined)
        this._recChunks = []
        this._mediaRec.ondataavailable = (e) => {
          if (e.data && e.data.size) this._recChunks.push(e.data)
        }
        this._mediaRec.onstop = () => this.sendVoiceMsg()
        this._mediaRec.start()
        this.recState = 'recording'
        this.recSeconds = 0
        this._recTimer = setInterval(() => { this.recSeconds++ }, 1000)
      } catch (e) {
        toast('语音消息需要麦克风权限', 'warn')
      }
    },
    stopVoiceRec() {
      if (this.recState !== 'recording') return
      clearInterval(this._recTimer)
      this.recState = 'stopping'
      try {
        this._mediaRec && this._mediaRec.stop()
      } catch (e) {}
      if (this._recStream) {
        this._recStream.getTracks().forEach((t) => t.stop())
      }
    },
    sendVoiceMsg() {
      const blob = new Blob(this._recChunks || [], { type: 'audio/webm' })
      this._recChunks = []
      this.recState = 'idle'
      this.recSeconds = 0
      if (!blob.size || !this.curPerm) {
        toast('录音内容为空', 'warn')
        return
      }
      const name = '语音-' + this.myName + '-' + Date.now().toString().slice(-6) + '.webm'
      const f = new File([blob], name, { type: 'audio/webm' })
      file.sendFiles(this.curPerm, [f])
    },
    recTimeLabel() {
      const s = this.recSeconds
      return (s < 60 ? '0' : '') + Math.floor(s / 60) + ':' + (s % 60 < 10 ? '0' : '') + (s % 60)
    },

    /* ================ 传输队列 ================ */
    openTransfers() {
      this.transferShow = true
      this.refreshQueue()
    },
    refreshQueue() {
      const q = file.getQueues()
      this.queueSend = q.send
      this.queueRecv = q.recv
      // 从快照中剔除 File/Blob 引用（避免放入 Vue 响应式代理）
      this.queueDone = q.recent.map((r) => {
        const { file, ...rest } = r
        return rest
      })
      this.$forceUpdate()
    },
    retryFile(fid) {
      file.retrySend(fid)
      this.refreshQueue()
    },
    cancelFile(fid) {
      file.cancelSend(fid)
      this.refreshQueue()
    },
    qStateLabel(s) {
      const m = { 'waiting-auth': '等待授权', sending: '传输中', receiving: '接收中', done: '完成', failed: '失败' }
      return m[s] || s
    },
    qBarPct(item) {
      if (!item || !item.chunks) return 0
      return Math.min(100, Math.round((item.got / item.chunks) * 100))
    },

    /* ================ 设置面板 ================ */
    openSettings() {
      const cfg = device.getUserConfig()
      this.settingsTheme = cfg.theme || 'system'
      this.settingsAutoAccept = cfg.autoAcceptKnown !== false
      this.settingsRelay = cfg.relayEnabled !== false
      this.showSettings = true
    },
    setSettingsTheme(t) {
      this.settingsTheme = t
      this.applyTheme(t, false)
    },
    toggleAutoAccept() {
      device.saveUserConfig({ autoAcceptKnown: this.settingsAutoAccept })
      toast(this.settingsAutoAccept ? '已开启：信任设备自动接受连接' : '已关闭：信任设备连接需确认', 'success')
    },
    toggleRelaySetting() {
      device.saveUserConfig({ relayEnabled: this.settingsRelay })
      if (this.settingsRelay) {
        relay.connect()
      } else {
        relay.close()
        this.relayStatus = ''
      }
      toast(this.settingsRelay ? '公网中继已开启' : '公网中继已关闭', 'success')
    },
    async clearConversationData() {
      if (!this.curPerm) {
        toast('请先选择设备', 'warn')
        return
      }
      await chat.clearConversation(this.curPerm)
      this.messages = []
      toast('当前会话记录已清空', 'success')
    },
    clearTrustData() {
      trust.saveTrustList([])
      this.reloadDevices()
      toast('信任列表已清空', 'success')
    },
    clearAllData() {
      try {
        indexedDB.deleteDatabase('LanToolDB')
      } catch (e) {}
      this.clearTrustData()
      localStorage.removeItem('lantoool-onboard')
      toast('数据已清空（本机身份保留）', 'success')
    },

    /* ================ 首次引导 ================ */
    onboardNext() {
      if (this.onboardStep < 3) this.onboardStep++
      else this.closeOnboard()
    },
    closeOnboard() {
      this.onboardShow = false
      localStorage.setItem('lantoool-onboard', '1')
    },

    /* ================ 图片放大预览 ================ */
    zoomImage(url) {
      if (!url) return
      this.imageZoomUrl = url
      this.showImageZoom = true
    },

    /* ================ 底部导航 ================ */
    navAct(name) {
      switch (name) {
        case 'file':
          this.triggerFile()
          break
        case 'transfers':
          this.openTransfers()
          break
        case 'voice':
          this.toggleVoice()
          break
        case 'history':
          this.openHistory()
          break
        case 'settings':
          this.openSettings()
          break
      }
    },

    /* 发送消息（消息入库与气泡由 chat.js 与 bus 'chat-add' 完成） */
    sendChat() {
      if (!this.curPerm) {
        toast('请先选择设备', 'warn')
        return
      }
      const text = this.draft.trim()
      if (!text) return
      const rec = chat.sendText(this.curPerm, text)
      if (rec) {
        this.draft = ''
        this.scrollChat()
      }
    },
    onKeydown(e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        this.sendChat()
      }
    },

    scrollChat() {
      this.$nextTick(() => {
        const el = this.$refs.chatbox
        if (el) el.scrollTop = el.scrollHeight
      })
    },

    loadChat(perm) {
      chat.loadMessages(perm).then((list) => {
        // 图片/语音的 blob: 预览 URL 刷新后失效，降级为文件说明消息
        this.messages = list.map((m) => {
          if ((m.type === 'image' || m.type === 'audio') && typeof m.content === 'string' && m.content.indexOf('blob:') === 0) {
            return Object.assign({}, m, {
              type: 'file',
              content: (m.type === 'image' ? '已接收图片：' : '已接收语音：') + (m.extra && m.extra.name ? m.extra.name : '') + '（文件已保存到下载目录）',
            })
          }
          return m
        })
        this.scrollChat()
      })
    },

    /* ================ 设备操作 ================ */
    reloadDevices() {
      const list = trust.getTrustList()
      this.devices = list.map((d) => {
        const st = webrtc.getPeerState(d.permanentId)
        return Object.assign({}, d, {
          display: trust.displayName(d),
          status: st,
          online: this.isOnline(d.permanentId),
          lastSeen: d.lastSeen,
        })
      })
      // 新渲染的设备卡补上波纹
      this.$nextTick(() => ripples('.device-card', this.$el))
    },
    isOnline(perm) {
      const st = webrtc.getPeerState(perm)
      if (st === 'connected' || st === 'connecting') return true
      // 探测结果也参与在线判断（同浏览器内 BroadcastChannel 探测有效）
      return !!this.onlineMap[perm]
    },
    // 文件授权（总是允许）
    alwaysAllowFile() {
      if (!this.fileAuthInfo) return
      const dev = trust.findDevice(this.fileAuthInfo.perm)
      if (dev) trust.setOperationTrusted(dev.permanentId, true)
      this.allowFileOnce()
    },
    // 文件授权（允许本次）
    allowFileOnce() {
      if (!this.fileAuthInfo) return
      file.decideReceive(this.fileAuthInfo.fid, true)
      this.showFileAuth = false
      this.fileAuthInfo = null
    },
    // 文件授权（拒绝）
    refuseFile() {
      if (this.fileAuthInfo) file.decideReceive(this.fileAuthInfo.fid, false)
      this.showFileAuth = false
      this.fileAuthInfo = null
    },
    // iframe 授权（总是允许）
    alwaysAllowIframe() {
      if (!this.iframeAuthInfo) return
      const dev = trust.findDevice(this.iframeAuthInfo.perm)
      if (dev) trust.setOperationTrusted(dev.permanentId, true)
      this.allowIframeOnce()
    },
    // iframe 授权（允许本次）
    allowIframeOnce() {
      const info = this.iframeAuthInfo
      if (!info) return
      // 本机打开网页，并通知发送方同步显示
      this.openIframeView(info.perm, info.url)
      webrtc.sendMsg(info.perm, { t: 'iframe', act: 'allow', url: info.url })
      this.recordIframeHistory(info.perm, info.url)
      this.showIframeAuth = false
      this.iframeAuthInfo = null
    },
    // iframe 授权（拒绝）
    refuseIframe() {
      const info = this.iframeAuthInfo
      if (!info) return
      webrtc.sendMsg(info.perm, { t: 'iframe', act: 'deny' })
      this.showIframeAuth = false
      this.iframeAuthInfo = null
    },
    // 记录网页推送历史
    recordIframeHistory(perm, url) {
      const d = trust.findDevice(perm)
      import('./history.js').then((h) =>
        h.addHistory({
          peerId: perm,
          peerName: d ? trust.displayName(d) : '设备',
          action: 'iframe_push',
          detail: url,
          status: 'success',
        })
      )
    },
    async selectDevice(d) {
      this.curPerm = d.permanentId
      this.messages = []
      this.loadChat(d.permanentId)
      this.clearUnread(d.permanentId)
      this.scrollChat()
      // 未连接则尝试连接
      if (webrtc.getPeerState(d.permanentId) === 'offline') {
        this.busyLabel = '正在连接…'
        try {
          await webrtc.connectTrusted(d.permanentId)
          toast('已连接', 'success')
        } catch (e) {
          // 跨设备无法自动信令，提示走手动重连
          toast('目标设备不在线，可使用卡片上 ↻ 重新连接', 'warn')
        } finally {
          this.busyLabel = ''
        }
      }
      // 测响应速度（显示在设备卡上）
      webrtc.pingPeer(d.permanentId).then((ms) => {
        if (ms != null) this.$set(this.rttMap, d.permanentId, ms)
      })
    },
    /* 长按卡牌 → 别名编辑 */
    pressStart(dev) {
      clearTimeout(this._pressTimer)
      this._pressTimer = setTimeout(() => {
        this.aliasTarget = dev
        this.aliasInput = dev.alias || ''
        this.aliasShow = dev.showOriginal !== false
        this.showAlias = true
      }, 550)
    },
    pressEnd() {
      clearTimeout(this._pressTimer)
    },
    saveAlias() {
      const perm = this.aliasTarget && this.aliasTarget.permanentId
      if (!perm) return
      trust.setAlias(perm, this.aliasInput.trim())
      trust.setShowOriginal(perm, this.aliasShow)
      // 双向同步别名给对方
      webrtc.sendMsg(perm, { t: 'alias', perm: this.myPerm, alias: this.aliasInput.trim(), show: this.aliasShow })
      this.reloadDevices()
      this.showAlias = false
      toast('别名已保存并同步', 'success')
    },

    /* 信任开关（连接共享/操作信任） */
    toggleConnectionTrust(dev) {
      trust.setConnectionTrusted(dev.permanentId, !dev.connectionTrusted)
      this.reloadDevices()
    },
    toggleOperationTrust(dev) {
      trust.setOperationTrusted(dev.permanentId, !dev.operationTrusted)
      this.reloadDevices()
    },
    removeDevice(dev) {
      trust.removeDevice(dev.permanentId)
      if (this.curPerm === dev.permanentId) {
        this.curPerm = ''
        this.messages = []
      }
      this.reloadDevices()
    },

    /* ================ 在线探测 ================ */
    probeNow() {
      if (this.detecting) return
      this.detecting = true
      webrtc
        .probeOnline()
        .then((map) => {
          this.onlineMap = map
          this.reloadDevices()
        })
        .finally(() => {
          this.detecting = false
        })
    },

    /* ================ 文件 ================ */
    // 点击"传文件"按钮
    triggerFile() {
      this.$refs.fileInput && this.$refs.fileInput.click()
    },
    // 进度百分比
    barPct(p) {
      if (!p || !p.total) return 0
      return Math.min(100, Math.round((p.got / p.total) * 100))
    },
    setProgress(perm, p) {
      this.progress[perm] = p
      this.$forceUpdate()
    },
    clearProgress(perm) {
      delete this.progress[perm]
      this.$forceUpdate()
    },
    // 键盘弹出时把输入框滚动到可视区域
    scrollInputIntoView() {
      const el = this.$refs.chatbox
      if (el) setTimeout(() => el.scrollIntoView({ block: 'nearest' }), 350)
    },
    onFilePicked(e) {
      const files = Array.from(e.target.files || [])
      if (files.length && this.curPerm) {
        file.sendFiles(this.curPerm, files)
      } else if (files.length) {
        toast('请先选择设备', 'warn')
      }
      e.target.value = ''
    },
    /* ================ iframe 推送 ================ */
    openIframeDlg() {
      this.iframeDraft = ''
      this.iframeDlg = true
    },
    submitIframe() {
      const url = this.iframeDraft.trim()
      if (!url) {
        toast('请输入网页地址', 'warn')
        return
      }
      const norm = url.startsWith('http') ? url : 'https://' + url
      if (!this.curPerm) {
        toast('请先选择设备', 'warn')
        return
      }
      const d = trust.findDevice(this.curPerm)
      webrtc.sendMsg(this.curPerm, {
        t: 'iframe',
        url: norm,
      })
      this.iframeDlg = false
      const d2 = trust.findDevice(this.curPerm)
      import('./history.js').then((h) =>
        h.addHistory({
          peerId: this.curPerm,
          peerName: d2 ? trust.displayName(d2) : '设备',
          action: 'iframe_push',
          detail: norm,
          status: 'success',
        })
      )
      // 本端不内嵌 iframe：避免重页面拖垮本机 LanTool 标签页，仅提示已发送
      toast('网页推送已发送，对方确认后打开', 'info')
    },
    openIframeView(perm, url) {
      this.iframeUrl = url
      this.showIframeView = true
    },
    // 网页推送兜底：用系统浏览器新窗口打开，避免重页面拖垮本机标签页
    openIframeNewTab() {
      if (this.iframeUrl) window.open(this.iframeUrl, '_blank', 'noopener')
    },

    /* ================ 剪贴板 ================ */
    async syncClipboard() {
      if (!this.curPerm) {
        toast('请先选择设备', 'warn')
        return
      }
      await clip.sendClipboard(this.curPerm)
    },

    /* ================ 语音 ================ */
    toggleVoice() {
      if (!this.curPerm) {
        toast('请先选择设备', 'warn')
        return
      }
      const st = this.voiceActive[this.curPerm]
      if (st && (st === 'calling' || st === 'active' || st === 'ringing')) {
        voice.endVoiceCall(this.curPerm)
      } else {
        voice.startVoiceCall(this.curPerm).then((ok) => {
          if (!ok) this.voiceActive[this.curPerm] = 'none'
        })
      }
    },
    voiceLabel() {
      const st = this.voiceActive[this.curPerm]
      if (st === 'active') return '挂断'
      if (st === 'calling' || st === 'ringing') return '取消'
      return '语音'
    },
    acceptVoice() {
      const perm = this.voiceInfo && this.voiceInfo.perm
      if (perm) voice.acceptVoice(perm)
      this.showVoice = false
      this.voiceInfo = null
    },
    rejectVoice() {
      const perm = this.voiceInfo && this.voiceInfo.perm
      if (perm) voice.rejectVoice(perm)
      this.showVoice = false
      this.voiceInfo = null
    },

    /* ================ 幽灵同步 ================ */
    ghostSync() {
      if (!this.curPerm) {
        toast('请先选择当前会话设备', 'warn')
        return
      }
      const info = {
        perm: this.myPerm,
        name: this.myName,
        cur: this.curPerm,
      }
      const text = 'LanSync: ' + JSON.stringify(info)
      webrtc.getPeers().forEach((p) => {
        webrtc.sendMsg(p.perm, { t: 'ghost', text })
      })
      copyText(text)
      toast('幽灵同步已发送并复制', 'success')
    },

    /* ================ 主题 ================ */
    cycleTheme() {
      const order = ['system', 'light', 'dark']
      const idx = order.indexOf(this.theme)
      this.applyTheme(order[(idx + 1) % 3], false)
    },
    applyTheme(t, silent) {
      this.theme = t
      if (t === 'system') {
        const dark = window.matchMedia('(prefers-color-scheme: dark)').matches
        document.documentElement.setAttribute('data-dark', dark ? '1' : '0')
      } else {
        document.documentElement.setAttribute('data-dark', t === 'dark' ? '1' : '0')
      }
      if (!silent) {
        // 广播给已连接设备使其跟随
        webrtc.getPeers().forEach((p) => webrtc.sendMsg(p.perm, { t: 'theme', theme: t }))
        device.setTheme(t)
      }
      if (!silent) toast('主题已切换', 'success')
    },

    /* ============ 历史记录 ============ */
    openHistory() {
      getAllHistory().then((list) => {
        this.historyList = list
        this.showHistory = true
      })
    },
    fmtTime(ts) {
      return formatTime(ts)
    },
    fmtSize(b) {
      return formatBytes(b)
    },

    /* ============ 本机名 ============ */
    renameMe() {
      this.showRename = true
      this.renameInput = this.myName
    },
    saveName() {
      const name = this.renameInput.trim()
      if (!name) return
      device.setDeviceName(name)
      this.myName = name
      webrtc.setMyName(name)
      // 公网中继同步新名称
      relay.updateName(name)
      // 通知所有已连接设备
      webrtc.getPeers().forEach((p) => webrtc.sendMsg(p.perm, { t: 'name', name }))
      this.showRename = false
      toast('设备名已更新', 'success')
    },

    /* 设备卡/界面辅助 */
    safeVibrate() {
      if (navigator.vibrate) navigator.vibrate(200)
    },
    chatTime(ts) {
      return formatTime(ts)
    },
    snip(s) {
      return s && s.length > 60 ? s.slice(0, 60) + '…' : s
    },
  },
})

app.mount('#app')