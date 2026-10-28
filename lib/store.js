import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * 插件根目录（本文件位于 <plugin>/lib/）
 * 插件与 API 共用同一个 videolist.json，保证两边看到同一份视频列表。
 */
export const PLUGIN_DIR = path.resolve(__dirname, '..')

/** 默认数据文件：<plugin>/videolist.json */
export const DEFAULT_DATA_FILE = path.join(PLUGIN_DIR, 'videolist.json')

const BVID_RE = /BV[0-9A-Za-z]{10}/i

/**
 * 从任意文本中提取并规范化 BV 号。
 * @param {unknown} input
 * @returns {string|null} 形如 BV1xx411c7mD，取不到返回 null
 */
export function normalizeBvid(input) {
  if (typeof input !== 'string') return null
  const match = BVID_RE.exec(input.trim())
  if (!match) return null
  // 统一把前缀转为大写，避免用户输入 bv1xx 被 B 站拒绝
  return `BV${match[0].slice(2)}`
}

/**
 * 解析数据文件位置，优先级：显式传入 > 环境变量 VIDEO_DATA_FILE > 默认路径。
 * @param {string} [explicit]
 * @returns {string} 绝对路径
 */
export function resolveDataFile(explicit) {
  const file = explicit || process.env.VIDEO_DATA_FILE || DEFAULT_DATA_FILE
  return path.resolve(file)
}

const pad = (n) => String(n).padStart(2, '0')

/**
 * 格式化成服务器本地时间：YYYY-MM-DD HH:mm:ss。
 * @param {Date|string|number} [value]
 * @returns {string}
 */
export function formatLocalTime(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  )
}

/**
 * 组装一条记录的上传来源标注：上传者 / 群聊 / 时间。
 * 兼容字段不全的旧记录，缺什么就跳过什么。
 * @param {Record<string, any>} item
 * @param {{ prefix?: string }} [options]
 * @returns {string} 如「来源：昵称(10001)｜群名(123456)｜2026-10-28 21:00:00」，无信息时返回 ''
 */
export function describeSource(item, options = {}) {
  if (!item || typeof item !== 'object') return ''
  const prefix = options.prefix ?? '来源'
  const who = item.added_by
    ? `${item.added_by}${item.qq ? `(${item.qq})` : ''}`
    : item.qq
      ? `QQ ${item.qq}`
      : ''
  const group = item.group_name
    ? `${item.group_name}${item.group_id ? `(${item.group_id})` : ''}`
    : item.group_id
      ? String(item.group_id) === '私聊'
        ? '私聊'
        : `群 ${item.group_id}`
      : ''
  const when = item.time || (item.time_iso ? formatLocalTime(item.time_iso) : '')
  const parts = [who, group, when].filter(Boolean)
  return parts.length ? `${prefix}：${parts.join('｜')}` : ''
}

/**
 * 基于 JSON 文件的视频列表存储。
 * 写入采用「临时文件 + rename」原子替换，避免并发写坏文件。
 */
export class VideoStore {
  /** @param {{ file?: string }} [options] */
  constructor(options = {}) {
    this.file = resolveDataFile(options.file)
    this.ensure()
  }

  get dir() {
    return path.dirname(this.file)
  }

  ensure() {
    if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true })
    if (!fs.existsSync(this.file)) fs.writeFileSync(this.file, '[]', 'utf-8')
  }

  /** @returns {Array<Record<string, any>>} */
  list() {
    try {
      if (!fs.existsSync(this.file)) return []
      const content = fs.readFileSync(this.file, 'utf-8')
      const data = JSON.parse(content || '[]')
      return Array.isArray(data) ? data : []
    } catch (err) {
      // 文件损坏时不要把异常抛给调用方，返回空列表并在控制台提示
      console.error('[randomvideo] 读取视频列表失败:', err.message)
      return []
    }
  }

  /** @param {Array<Record<string, any>>} list */
  save(list) {
    const items = Array.isArray(list) ? list : []
    const tmp = `${this.file}.tmp-${process.pid}-${Date.now()}`
    fs.writeFileSync(tmp, JSON.stringify(items, null, 2), 'utf-8')
    fs.renameSync(tmp, this.file)
    return items
  }

  /** @param {unknown} bvid */
  find(bvid) {
    const normalized = normalizeBvid(String(bvid ?? '')) || String(bvid ?? '')
    return this.list().find((item) => item.bvid === normalized) || null
  }

  /** @param {unknown} bvid */
  has(bvid) {
    return this.find(bvid) !== null
  }

  /**
   * 添加一条记录；已存在则返回 added:false，不覆盖原数据。
   * @param {Record<string, any>} item 必须包含 bvid
   * @returns {{ added: boolean, item: Record<string, any> }}
   */
  add(item) {
    const bvid = normalizeBvid(item?.bvid)
    if (!bvid) throw new Error('无效的 BV 号')
    const list = this.list()
    const exists = list.find((v) => v.bvid === bvid)
    if (exists) return { added: false, item: exists }
    const record = { ...item, bvid }
    list.push(record)
    this.save(list)
    return { added: true, item: record }
  }

  /**
   * 删除一条记录。
   * @param {unknown} bvid
   * @returns {boolean} 是否真的删除了
   */
  remove(bvid) {
    const normalized = normalizeBvid(String(bvid ?? '')) || String(bvid ?? '')
    const list = this.list()
    const next = list.filter((item) => item.bvid !== normalized)
    if (next.length === list.length) return false
    this.save(next)
    return true
  }

  /** 用同一 bvid 的新字段覆盖旧记录，不存在则追加。 */
  upsert(bvid, patch = {}) {
    const normalized = normalizeBvid(String(bvid ?? ''))
    if (!normalized) throw new Error('无效的 BV 号')
    const list = this.list()
    const index = list.findIndex((item) => item.bvid === normalized)
    if (index === -1) {
      list.push({ bvid: normalized, ...patch })
      this.save(list)
      return { added: true, item: list[list.length - 1] }
    }
    list[index] = { ...list[index], ...patch, bvid: normalized }
    this.save(list)
    return { added: false, item: list[index] }
  }

  count() {
    return this.list().length
  }
}

export default VideoStore
