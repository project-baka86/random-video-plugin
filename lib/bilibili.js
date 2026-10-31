/**
 * B 站接口封装（零依赖，使用 Node 18+ 全局 fetch）。
 * 插件与 API 共用，避免两边各写一份解析逻辑。
 *
 * 风控说明：部分机房 IP 使用浏览器 UA 访问 B 站接口会被返回 412，
 * 因此这里维护多组请求头，遇到 412/403 自动切换，并记住可用的那一组。
 * 可用环境变量覆盖：
 *   BILI_UA      自定义 User-Agent（留空则使用内置浏览器 UA）
 *   BILI_COOKIE  携带 Cookie（如 SESSDATA=...，可显著降低风控概率）
 */

import { Readable } from 'node:stream'

export const BILI_REFERER = 'https://www.bilibili.com'

export const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36'

export const VIEW_API = 'https://api.bilibili.com/x/web-interface/view'
export const PLAY_API = 'https://api.bilibili.com/x/player/playurl'

const configuredUA = process.env.BILI_UA || DEFAULT_UA
const configuredCookie = process.env.BILI_COOKIE || ''

/** 依次尝试的请求头组合，最后一组不发送 UA。 */
export const HEADER_PROFILES = [
  { name: 'ua+referer', headers: { 'User-Agent': configuredUA, Referer: BILI_REFERER } },
  {
    name: 'ua+referer+origin',
    headers: { 'User-Agent': configuredUA, Referer: BILI_REFERER, Origin: BILI_REFERER }
  },
  { name: 'referer', headers: { Referer: BILI_REFERER } }
]

// 记住最近一次成功的请求头组合，后续请求直接复用
let activeProfile = 0

/** 兼容旧代码：默认请求头（插件的 axios 调用仍在用）。 */
export const BILI_HEADER = { ...HEADER_PROFILES[0].headers }

/** @returns {number} 当前生效的请求头组合下标 */
export function getActiveProfile() {
  return activeProfile
}

function buildHeaders(profile, extra = {}) {
  return {
    Accept: 'application/json, text/plain, */*',
    ...(configuredCookie ? { Cookie: configuredCookie } : {}),
    ...profile.headers,
    ...extra
  }
}

/** 业务/网络错误统一封装，status 用于给 HTTP 层映射状态码。 */
export class BilibiliError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: number, status?: number, cause?: unknown }} [options]
   */
  constructor(message, options = {}) {
    super(message)
    this.name = 'BilibiliError'
    this.code = options.code ?? null
    this.status = options.status ?? 502
    if (options.cause) this.cause = options.cause
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const isRiskControl = (status) => status === 412 || status === 403

/**
 * 把 fetch 响应体统一成 Node 可读流。
 *
 * 原生 fetch 的 `body` 是 WHATWG ReadableStream；但 Yunzai 等环境会把全局 fetch
 * 换成 node-fetch，此时 `body` 是 Node 的 Readable（PassThrough）。
 * 直接 `Readable.fromWeb(body)` 会在后者报 ERR_INVALID_ARG_TYPE，故两种都要兼容。
 *
 * @param {any} body
 * @returns {import('node:stream').Readable|null}
 */
export function toNodeStream(body) {
  if (!body) return null
  if (typeof body.pipe === 'function') return body
  return Readable.fromWeb(body)
}

/** 丢弃一个不再消费的响应体（中止下载、释放连接）。 */
export function discardBody(body) {
  try {
    body?.cancel?.()
  } catch {
    /* ignore */
  }
  try {
    body?.destroy?.()
  } catch {
    /* ignore */
  }
}

/**
 * 带超时的 GET + JSON 解析，遇到风控自动切换请求头组合。
 * @returns {Promise<any>}
 */
async function getJson(url, { timeout = 10000, fetchImpl = fetch, retries = 1 } = {}) {
  let lastErr
  for (let offset = 0; offset < HEADER_PROFILES.length; offset++) {
    const index = (activeProfile + offset) % HEADER_PROFILES.length
    const profile = HEADER_PROFILES[index]
    for (let attempt = 0; attempt <= retries; attempt++) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeout)
      try {
        const res = await fetchImpl(url, { headers: buildHeaders(profile), signal: controller.signal })
        if (isRiskControl(res.status)) {
          lastErr = new BilibiliError(`B站接口风控 HTTP ${res.status}`, { status: 502, code: res.status })
          break // 立即换下一组请求头
        }
        if (!res.ok) {
          throw new BilibiliError(`B站接口返回 HTTP ${res.status}`, { status: 502, code: res.status })
        }
        const data = await res.json()
        activeProfile = index
        return data
      } catch (err) {
        lastErr = err
        if (err?.name === 'AbortError') {
          lastErr = new BilibiliError(`请求 B站接口超时（${timeout}ms）`, { status: 504, cause: err })
        } else if (err instanceof BilibiliError) {
          break // 业务/HTTP 错误换下一组请求头再试
        }
        if (attempt < retries) {
          await sleep(300 * (attempt + 1))
          continue
        }
      } finally {
        clearTimeout(timer)
      }
    }
  }
  throw lastErr instanceof BilibiliError
    ? lastErr
    : new BilibiliError(`请求 B站接口失败：${lastErr?.message ?? lastErr}`, { status: 502, cause: lastErr })
}

/**
 * 获取视频信息（校验 BV 号是否有效）。
 * @param {string} bvid
 * @returns {Promise<{ bvid: string, aid: number, cid: number, title: string, duration: number, pic: string, owner: object }>}
 */
export async function getVideoInfo(bvid, options = {}) {
  const data = await getJson(`${VIEW_API}?bvid=${encodeURIComponent(bvid)}`, options)
  if (data?.code !== 0) {
    throw new BilibiliError(data?.message || '视频不存在或已失效', {
      code: data?.code,
      status: 404
    })
  }
  return data.data
}

/**
 * 获取播放地址（qn=32 即 480P，html5 平台不需要登录）。
 * @param {string} bvid
 * @param {number|string} cid
 * @returns {Promise<{ url: string, size: number, length: number, quality: number, format: string }>}
 */
export async function getPlayUrl(bvid, cid, options = {}) {
  const query = `bvid=${encodeURIComponent(bvid)}&cid=${encodeURIComponent(cid)}&qn=32&type=mp4&platform=html5&high_quality=1`
  const data = await getJson(`${PLAY_API}?${query}`, options)
  if (data?.code !== 0) {
    throw new BilibiliError(data?.message || '无法解析播放地址', { code: data?.code, status: 502 })
  }
  const durl = data?.data?.durl?.[0]
  if (!durl?.url) {
    throw new BilibiliError('播放地址为空', { code: data?.code, status: 502 })
  }
  return {
    url: durl.url,
    size: Number(durl.size) || 0,
    length: Number(durl.length) || 0,
    quality: data?.data?.quality ?? 32,
    format: data?.data?.format ?? 'mp4'
  }
}

/**
 * 打开视频上游流；调用方负责消费 body，结束后调用 abort() 释放定时器。
 * CDN 对请求头不敏感，这里复用当前可用的请求头组合，并在风控时切换。
 * @param {string} url durl 播放地址
 * @returns {Promise<{ status: number, ok: boolean, headers: Headers, body: ReadableStream|null, abort: () => void }>}
 */
export async function openVideoStream(url, options = {}) {
  const { timeout = 15000, range } = options
  const extra = { ...(options.headers || {}) }
  if (range) extra.Range = range

  let lastErr
  for (let offset = 0; offset < HEADER_PROFILES.length; offset++) {
    const index = (activeProfile + offset) % HEADER_PROFILES.length
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)
    try {
      const res = await fetch(url, { headers: buildHeaders(HEADER_PROFILES[index], extra), signal: controller.signal })
      clearTimeout(timer) // 已拿到响应头，后续下载不再受这个超时限制
      if (isRiskControl(res.status)) {
        lastErr = new BilibiliError(`视频源风控 HTTP ${res.status}`, { status: 502, code: res.status })
        discardBody(res.body)
        continue
      }
      activeProfile = index
      return {
        status: res.status,
        ok: res.ok,
        headers: res.headers,
        body: res.body,
        abort: () => {
          clearTimeout(timer)
          controller.abort()
        }
      }
    } catch (err) {
      clearTimeout(timer)
      if (err?.name === 'AbortError') {
        throw new BilibiliError(`连接视频源超时（${timeout}ms）`, { status: 504, cause: err })
      }
      lastErr = new BilibiliError(`连接视频源失败：${err?.message ?? err}`, { status: 502, cause: err })
    }
  }
  throw lastErr
}

/** 默认实现集合，便于在测试中整体替换。 */
const bilibili = { getVideoInfo, getPlayUrl, openVideoStream, BilibiliError, BILI_HEADER }
export default bilibili
