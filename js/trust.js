/* ==========================================
 * trust.js — 信任列表管理 (localStorage)
 * key: trust_list
 * ========================================== */
import { lsGet, lsSet } from './utils.js'

const TRUST_KEY = 'trust_list'

/* 读取信任列表 */
export function getTrustList() {
  return lsGet(TRUST_KEY, [])
}

/* 保存信任列表 */
export function saveTrustList(list) {
  lsSet(TRUST_KEY, list)
}

/* 查询单个设备，找不到返回 null */
export function findDevice(permanentId) {
  if (!permanentId) return null
  return getTrustList().find((d) => d.permanentId === permanentId) || null
}

/* 新增或更新一个设备条目（首次配对成功后调用） */
export function upsertDevice(device) {
  const list = getTrustList()
  const idx = list.findIndex((d) => d.permanentId === device.permanentId)
  if (idx >= 0) {
    list[idx] = Object.assign({}, list[idx], device)
  } else {
    list.push(
      Object.assign(
        {
          permanentId: device.permanentId,
          alias: '',
          showOriginal: true,
          connectionTrusted: true,
          operationTrusted: false,
          lastSeen: Date.now(),
        },
        device
      )
    )
  }
  saveTrustList(list)
  return findDevice(device.permanentId)
}

/* 删除信任设备 */
export function removeDevice(permanentId) {
  saveTrustList(getTrustList().filter((d) => d.permanentId !== permanentId))
}

/* 更新设备的别名 */
export function setAlias(permanentId, alias) {
  const list = getTrustList()
  const d = list.find((x) => x.permanentId === permanentId)
  if (d) {
    d.alias = alias
    saveTrustList(list)
  }
}

/* 开关"是否显示原名" */
export function setShowOriginal(permanentId, show) {
  const list = getTrustList()
  const d = list.find((x) => x.permanentId === permanentId)
  if (d) {
    d.showOriginal = show
    saveTrustList(list)
  }
}

/* 设置连接信任 */
export function setConnectionTrusted(permanentId, trusted) {
  const list = getTrustList()
  const d = list.find((x) => x.permanentId === permanentId)
  if (d) {
    d.connectionTrusted = trusted
    saveTrustList(list)
  }
}

/* 设置操作信任（允许传文件/推网页/剪贴板） */
export function setOperationTrusted(permanentId, trusted) {
  const list = getTrustList()
  const d = list.find((x) => x.permanentId === permanentId)
  if (d) {
    d.operationTrusted = trusted
    saveTrustList(list)
  }
}

/* 记录最近在线时间 */
export function touchDevice(permanentId) {
  const list = getTrustList()
  const d = list.find((x) => x.permanentId === permanentId)
  if (d) {
    d.lastSeen = Date.now()
    saveTrustList(list)
  }
}

/* 获取用于界面展示的显示名（别名优先，可选附带原名） */
export function displayName(device) {
  if (!device) return ''
  if (device.alias) {
    return device.showOriginal ? device.alias + '（' + device.originalName + '）' : device.alias
  }
  return device.originalName || device.permanentId.slice(0, 8)
}