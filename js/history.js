/* ==========================================
 * history.js — 聊天记录 + 传输历史 (IndexedDB)
 * 数据库：LanToolDB v1
 *  表1 messages：按 peerId 分组的全部消息
 *  表2 history：文件传输/网页推送/剪贴板同步等操作记录
 * ========================================== */

const DB_NAME = 'LanToolDB'
const DB_VERSION = 1

let dbPromise = null

/* 打开数据库（懒加载，单例） */
function openDB() {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = (e) => {
      const db = e.target.result
      if (!db.objectStoreNames.contains('messages')) {
        const store = db.createObjectStore('messages', { keyPath: 'id', autoIncrement: true })
        store.createIndex('peerId', 'peerId', { unique: false })
        store.createIndex('timestamp', 'timestamp', { unique: false })
      }
      if (!db.objectStoreNames.contains('history')) {
        const store = db.createObjectStore('history', { keyPath: 'id', autoIncrement: true })
        store.createIndex('peerId', 'peerId', { unique: false })
        store.createIndex('timestamp', 'timestamp', { unique: false })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

/* 通用事务执行 */
function tx(storeName, mode, fn) {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(storeName, mode)
        const store = t.objectStore(storeName)
        const result = fn(store)
        t.oncomplete = () => resolve(result && result.result !== undefined ? result.result : result)
        t.onerror = () => reject(t.error)
        t.onabort = () => reject(t.error)
      })
  )
}

/* ================= messages 表 ================= */

/* 新增一条消息 {peerId, direction, type, content, timestamp} */
export function addMessage(msg) {
  return tx('messages', 'readwrite', (store) => {
    store.add({
      peerId: msg.peerId,
      direction: msg.direction, // send | receive
      type: msg.type, // text | file | iframe | clipboard
      content: msg.content,
      timestamp: msg.timestamp || Date.now(),
    })
  })
}

/* 读取某个设备的全部消息（按时间排序） */
export async function getMessages(peerId) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const t = db.transaction('messages', 'readonly')
    const store = t.objectStore('messages')
    const idx = store.index('peerId')
    const req = idx.getAll(peerId)
    req.onsuccess = () => resolve(req.result.sort((a, b) => a.timestamp - b.timestamp))
    req.onerror = () => reject(req.error)
  })
}

/* 删除某个设备的全部消息 */
export async function clearMessages(peerId) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const t = db.transaction('messages', 'readwrite')
    const store = t.objectStore('messages')
    const idx = store.index('peerId')
    const req = idx.openKeyCursor(peerId)
    req.onsuccess = (e) => {
      const cur = e.target.result
      if (cur) {
        store.delete(cur.primaryKey)
        cur.continue()
      }
    }
    t.oncomplete = resolve
    t.onerror = () => reject(t.error)
  })
}

/* ================= history 表 ================= */

/* 新增一条传输/操作历史 */
export function addHistory(record) {
  return tx('history', 'readwrite', (store) => {
    store.add({
      peerId: record.peerId,
      peerName: record.peerName,
      action: record.action, // file_transfer | iframe_push | clipboard_sync | voice_call
      detail: record.detail,
      status: record.status, // success | failed
      timestamp: record.timestamp || Date.now(),
    })
  })
}

/* 读取全部历史（按时间倒序） */
export async function getAllHistory(limit = 200) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const t = db.transaction('history', 'readonly')
    const store = t.objectStore('history')
    const req = store.getAll()
    req.onsuccess = () => {
      const list = req.result.sort((a, b) => b.timestamp - a.timestamp)
      resolve(limit ? list.slice(0, limit) : list)
    }
    req.onerror = () => reject(req.error)
  })
}