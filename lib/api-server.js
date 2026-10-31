import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'

import defaultBilibili, { BilibiliError, toNodeStream, discardBody } from './bilibili.js'
import { VideoStore, PLUGIN_DIR, normalizeBvid, formatLocalTime } from './store.js'

const MB = 1024 * 1024
const DEFAULT_MAX_BYTES = 50 * MB
const DEFAULT_MAX_DURATION_SECONDS = 10 * 60
const DEFAULT_CACHE_DIR = path.join(PLUGIN_DIR, 'cache')
const VALID_STRATEGIES = new Set(['local-first', 'remote-first', 'random', 'round-robin', 'cached-first'])

/**
 * 从请求体 / 查询串提取上传元信息：时间、群聊、上传者。
 * 字段兼容多种命名，缺省则用当前时间与 'api'。
 */
function buildUploadMeta(body = {}, searchParams) {
  const now = new Date()
  const pick = (key) => body[key] ?? searchParams?.get(key) ?? null
  return {
    added_by: body.added_by || body.user || body.nickname || body.uploader || 'api',
    qq: pick('qq') ?? pick('user_id'),
    group_id: pick('group_id'),
    group_name: pick('group_name'),
    time: typeof body.time === 'string' && body.time ? body.time : formatLocalTime(now),
    time_iso: typeof body.time_iso === 'string' && body.time_iso ? body.time_iso : now.toISOString()
  }
}

/** 业务错误，携带要返回的 HTTP 状态码。 */
export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    Object.assign(this, extra)
  }
}

const silentLogger = { info() {}, warn() {}, error() {} }

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...extraHeaders
  })
  res.end(body)
}

function sendError(res, err, logger) {
  const status = err instanceof HttpError ? err.status : err instanceof BilibiliError ? err.status : 500
  const message =
    err instanceof HttpError || err instanceof BilibiliError ? err.message : '服务器内部错误'
  if (status >= 500) logger.error('[randomvideo-api]', err?.stack || err?.message || err)
  if (res.headersSent) {
    res.destroy()
    return
  }
  sendJson(res, status, { error: message, code: err?.code ?? undefined })
}

async function readJsonBody(req, limit = MB) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new HttpError(413, '请求体过大')
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  const raw = Buffer.concat(chunks).toString('utf-8').trim()
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') throw new Error('not an object')
    return parsed
  } catch {
    throw new HttpError(400, '请求体必须是合法的 JSON 对象')
  }
}

/** 支持 Range 的本地文件响应。 */
function serveFile(req, res, filePath, contentType = 'video/mp4') {
  const stat = fs.statSync(filePath)
  const size = stat.size
  const commonHeaders = {
    'Content-Type': contentType,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=3600'
  }

  const range = req.headers.range
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
    if (match) {
      const hasStart = match[1] !== ''
      const hasEnd = match[2] !== ''
      let start
      let end
      if (!hasStart && hasEnd) {
        const suffix = Number(match[2])
        start = Math.max(0, size - suffix)
        end = size - 1
      } else {
        start = Number(match[1])
        end = hasEnd ? Math.min(Number(match[2]), size - 1) : size - 1
      }
      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}` })
        return res.end()
      }
      res.writeHead(206, {
        ...commonHeaders,
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Content-Length': String(end - start + 1)
      })
      fs.createReadStream(filePath, { start, end }).pipe(res)
      return
    }
  }

  res.writeHead(200, { ...commonHeaders, 'Content-Length': String(size) })
  fs.createReadStream(filePath).pipe(res)
}

function shuffle(list) {
  const copy = [...list]
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
  }
  return copy
}

/**
 * 创建分发 API 服务（不自动监听，由调用方 server.listen）。
 *
 * 单机模式：不传 registry，行为与之前一致。
 * 多实例模式：作为 Hub 时传 registry（接收实例上报、聚合目录、选点分发）；
 *            作为实例时配置 hubUrl 由 reporter 上报（本服务仍可独立对外提供视频）。
 *
 * @param {object} [options]
 * @param {VideoStore} [options.store]
 * @param {typeof defaultBilibili} [options.bilibili]
 * @param {import('./registry.js').InstanceRegistry} [options.registry] 传入即启用 Hub 能力
 * @param {string} [options.instanceId] 本实例 id，默认 INSTANCE_ID 或 local
 * @param {string} [options.instanceUrl] 本实例对外地址，用于返回直链
 * @param {string} [options.instanceName]
 * @param {string} [options.instanceToken] 集群令牌 INSTANCE_TOKEN
 * @param {'redirect'|'proxy'} [options.delivery] 默认分发方式，默认 redirect
 * @param {string} [options.strategy] 选点策略，默认 local-first
 * @param {string} [options.cacheDir]
 * @param {number} [options.maxBytes]
 * @param {string} [options.token] API_TOKEN
 * @param {string} [options.corsOrigin]
 * @param {object} [options.logger]
 * @returns {http.Server}
 */
export function createApiServer(options = {}) {
  const store = options.store ?? new VideoStore()
  const bilibili = options.bilibili ?? defaultBilibili
  const registry = options.registry ?? null
  const hubEnabled = options.hubEnabled ?? Boolean(registry)
  const cacheDir = path.resolve(options.cacheDir ?? process.env.CACHE_DIR ?? DEFAULT_CACHE_DIR)
  const maxBytes = Number(options.maxBytes ?? process.env.MAX_VIDEO_MB * MB) || DEFAULT_MAX_BYTES
  const maxDurationSeconds =
    options.maxDurationSeconds ??
    (process.env.MAX_VIDEO_MINUTES
      ? Number(process.env.MAX_VIDEO_MINUTES) * 60
      : DEFAULT_MAX_DURATION_SECONDS)
  const token = options.token ?? process.env.API_TOKEN ?? ''
  const instanceToken = options.instanceToken ?? process.env.INSTANCE_TOKEN ?? ''
  const instanceId = options.instanceId ?? process.env.INSTANCE_ID ?? 'local'
  const instanceName = options.instanceName ?? options.name ?? instanceId
  const instanceUrl = String(options.instanceUrl ?? process.env.INSTANCE_URL ?? '').replace(/\/+$/, '')
  const defaultDelivery = (
    options.delivery ??
    process.env.DEFAULT_DELIVERY ??
    'redirect'
  ).toLowerCase()
  // Hub 默认把流量分发给实例（remote-first），单机默认本地优先
  const requestedStrategy = String(
    options.strategy ?? process.env.DISTRIBUTE_STRATEGY ?? (registry ? 'remote-first' : 'local-first')
  ).toLowerCase()
  const strategy = VALID_STRATEGIES.has(requestedStrategy) ? requestedStrategy : 'local-first'
  const corsOrigin = options.corsOrigin ?? process.env.CORS_ORIGIN ?? '*'
  const role = options.role ?? (hubEnabled ? 'hub' : 'standalone')
  // REQUIRE_AUTH=1 时，未配置任何 token 直接拒绝匿名访问（而不是放行）
  const strictAuth = options.strictAuth ?? /^(1|true|yes|on)$/i.test(String(process.env.REQUIRE_AUTH ?? ''))
  // 是否允许本机解析（调 B 站拿地址）。默认 Hub 不解析，交给 bot 实例解析并保存。
  const boolEnv = (name) => {
    const raw = process.env[name]
    return raw === undefined ? undefined : /^(1|true|yes|on)$/i.test(String(raw))
  }
  const localParse = options.localParse ?? boolEnv('LOCAL_PARSE') ?? role !== 'hub'
  // Hub 收到未知的 bvid 时，是否自动派发给实例解析并保存
  const autoParse = options.autoParse ?? boolEnv('AUTO_PARSE') ?? true
  const logger = options.logger ?? console
  let roundRobinCursor = 0
  let warnedOpenCluster = false

  if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true })

  const cachePath = (bvid) => path.join(cacheDir, `${bvid}.mp4`)

  /** 从请求中提取凭据（Bearer / ?token= / X-Instance-Token）。 */
  const readCredentials = (req, url) => {
    const header = req.headers.authorization || ''
    const bearer = header.startsWith('Bearer ') ? header.slice(7) : ''
    return {
      clusterHeader: req.headers['x-instance-token'] || '',
      bearer,
      queryToken: url.searchParams.get('token') || '',
      hasAnyToken: Boolean(token || instanceToken)
    }
  }

  /**
   * 下载/列表等公开接口鉴权。
   * 只要配置了 API_TOKEN 或 INSTANCE_TOKEN，就必须携带其一；
   * 只有「一个 token 都没配」才放行（除非 REQUIRE_AUTH 强制拒绝）。
   */
  const checkAuth = (req, url) => {
    const { clusterHeader, bearer, queryToken, hasAnyToken } = readCredentials(req, url)
    if (instanceToken && clusterHeader === instanceToken) return
    if (token && (bearer === token || queryToken === token)) return
    if (instanceToken && (bearer === instanceToken || queryToken === instanceToken)) return
    if (!hasAnyToken && !strictAuth) return
    if (!hasAnyToken) {
      throw new HttpError(503, '服务未配置任何 token，已按 REQUIRE_AUTH 拒绝匿名访问')
    }
    throw new HttpError(401, '未授权：缺少或错误的 token')
  }

  /**
   * 实例上报/注册表接口鉴权：只认集群凭据。
   * 未配置任何 token 时放行并告警（除非 REQUIRE_AUTH）。
   */
  const checkClusterAuth = (req, url) => {
    const { clusterHeader, bearer, queryToken, hasAnyToken } = readCredentials(req, url)
    if (instanceToken && clusterHeader === instanceToken) return
    if (token && bearer === token) return
    if (token && queryToken === token) return
    if (instanceToken && bearer === instanceToken) return
    if (instanceToken && queryToken === instanceToken) return
    if (!hasAnyToken && !strictAuth) {
      if (!warnedOpenCluster) {
        warnedOpenCluster = true
        logger.warn?.(
          '[randomvideo-api] 未配置 INSTANCE_TOKEN/API_TOKEN，实例上报接口处于开放状态（生产环境请配置 INSTANCE_TOKEN 或 REQUIRE_AUTH=1）'
        )
      }
      return
    }
    if (!hasAnyToken) {
      throw new HttpError(503, '服务未配置任何 token，已按 REQUIRE_AUTH 拒绝实例上报')
    }
    throw new HttpError(401, '未授权：实例上报需要集群令牌')
  }

  /** 解析本地可播放信息，并同步最新标题。 */
  const resolvePlay = async (bvid) => {
    const info = await bilibili.getVideoInfo(bvid)
    const play = await bilibili.getPlayUrl(bvid, info.cid)
    if (info.title) {
      try {
        store.upsert(bvid, { title: info.title })
      } catch {
        /* 列表里没有该 bvid 也不影响播放 */
      }
    }
    return { info, play }
  }

  /** 时长超限则拒绝（remove=true 时同时移出列表）；maxDurationSeconds<=0 表示不限制。 */
  const enforceDuration = (info, bvid, { remove = true } = {}) => {
    const seconds = Number(info?.duration) || 0
    if (!(maxDurationSeconds > 0) || seconds <= maxDurationSeconds) return
    if (remove) store.remove(bvid)
    throw new HttpError(
      413,
      `视频时长 ${(seconds / 60).toFixed(1)} 分钟超过限制 ${(maxDurationSeconds / 60).toFixed(0)} 分钟${remove ? '，已从列表移除' : ''}`
    )
  }

  const ensureCached = async (bvid, play) => {
    const file = cachePath(bvid)
    if (fs.existsSync(file) && fs.statSync(file).size > 0) return file
    const tmp = `${file}.part-${process.pid}-${Date.now()}`
    const upstream = await bilibili.openVideoStream(play.url)
    if (!upstream.ok) throw new HttpError(502, `视频源返回 HTTP ${upstream.status}`)
    try {
      await pipeline(toNodeStream(upstream.body), fs.createWriteStream(tmp))
      const size = fs.statSync(tmp).size
      if (size > maxBytes) throw new HttpError(413, `视频超过大小限制（${maxBytes / MB}MB）`)
      fs.renameSync(tmp, file)
      return file
    } finally {
      upstream.abort?.()
    }
  }

  /** 边下边发，并在完成时落盘作为缓存。 */
  const streamAndCache = async (req, res, bvid, play) => {
    const upstream = await bilibili.openVideoStream(play.url)
    if (!upstream.ok) {
      discardBody(upstream.body)
      throw new HttpError(502, `视频源返回 HTTP ${upstream.status}`)
    }
    const length = play.size || Number(upstream.headers.get('content-length') || 0)
    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=3600',
      ...(length ? { 'Content-Length': String(length) } : {})
    })

    const tmp = `${cachePath(bvid)}.part-${process.pid}-${Date.now()}`
    const source = toNodeStream(upstream.body)
    const fileStream = fs.createWriteStream(tmp)
    let aborted = false
    const cleanup = () => {
      try {
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp)
      } catch {
        /* ignore */
      }
    }
    res.on('close', () => {
      if (!res.writableFinished) {
        aborted = true
        source.destroy()
        fileStream.destroy()
        upstream.abort?.()
        cleanup()
      }
    })

    source.pipe(res)
    source.pipe(fileStream)

    await new Promise((resolve, reject) => {
      let pending = 2
      const done = () => {
        if (--pending === 0) resolve()
      }
      source.on('error', reject)
      fileStream.on('error', reject)
      fileStream.on('finish', done)
      res.on('finish', done)
    })

    upstream.abort?.()
    if (!aborted) {
      try {
        const size = fs.statSync(tmp).size
        if (size > 0 && size <= maxBytes) fs.renameSync(tmp, cachePath(bvid))
        else cleanup()
      } catch {
        cleanup()
      }
    }
  }

  /** 解析（调 B 站拿地址）+ 下载 + 保存到本机缓存，返回元信息。 */
  const prepareVideo = async (bvid) => {
    const { info, play } = await resolvePlay(bvid)
    enforceDuration(info, bvid)
    if (play.size && play.size > maxBytes) {
      store.remove(bvid)
      throw new HttpError(
        413,
        `视频大小 ${(play.size / MB).toFixed(2)}MB 超过限制 ${(maxBytes / MB).toFixed(0)}MB，已从列表移除`
      )
    }
    const file = await ensureCached(bvid, play)
    const size = fs.statSync(file).size
    const { item } = store.upsert(bvid, {
      title: info.title,
      duration: info.duration,
      pic: info.pic,
      cached: true,
      saved_at: new Date().toISOString()
    })
    logger.info?.(
      `[randomvideo-api] 实例 ${instanceId} 已解析并保存 ${bvid}（${(size / MB).toFixed(2)}MB）`
    )
    return {
      bvid,
      title: info.title,
      size,
      size_mb: Number((size / MB).toFixed(2)),
      cached: true,
      saved: true,
      saved_at: item?.saved_at,
      instance_id: instanceId,
      stream_url: `/api/video/${bvid}`
    }
  }

  /**
   * 本机分发：优先读已保存的本地文件；
   * 未保存时按 localParse 决定是否在本机解析并保存（Hub 默认不解析）。
   */
  const streamLocal = async (req, res, bvid, { forceCache = false } = {}) => {
    const file = cachePath(bvid)
    if (fs.existsSync(file) && fs.statSync(file).size > 0) return serveFile(req, res, file)
    if (!localParse) {
      throw new HttpError(409, `本机未保存 ${bvid}，已配置为交由 bot 实例解析并保存`)
    }
    const { info, play } = await resolvePlay(bvid)
    enforceDuration(info, bvid)
    if (play.size && play.size > maxBytes) {
      store.remove(bvid)
      throw new HttpError(
        413,
        `视频大小 ${(play.size / MB).toFixed(2)}MB 超过限制 ${(maxBytes / MB).toFixed(0)}MB，已从列表移除`
      )
    }
    if (forceCache || req.headers.range) {
      const saved = await ensureCached(bvid, play)
      return serveFile(req, res, saved)
    }
    return streamAndCache(req, res, bvid, play)
  }

  /** 从其他实例反向代理流量（支持 Range 透传）。 */
  const proxyRemote = async (req, res, provider, bvid) => {
    const headers = {}
    if (instanceToken) headers['X-Instance-Token'] = instanceToken
    if (token) headers.Authorization = `Bearer ${token}`
    if (req.headers.range) headers.Range = req.headers.range
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15_000)
    let upstream
    try {
      upstream = await fetch(provider.streamUrl, { headers, signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }
    if (!upstream.ok) {
      discardBody(upstream.body)
      throw new HttpError(502, `实例 ${provider.id} 返回 HTTP ${upstream.status}`)
    }
    const out = {}
    for (const key of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      const value = upstream.headers.get(key)
      if (value) out[key] = value
    }
    if (!out['content-type']) out['Content-Type'] = 'video/mp4'
    res.writeHead(upstream.status, out)
    await pipeline(toNodeStream(upstream.body), res)
  }

  /**
   * Hub 选取一个健康实例来解析/保存视频：
   * 优先已上报该视频的实例，否则任意健康实例（round-robin 分摊压力）。
   */
  const pickParseProvider = (bvid) => {
    if (!registry) return null
    const owners = registry.providers(bvid)
    const pool = owners.length
      ? owners
      : registry.list({ healthyOnly: true }).map((inst) => ({
          kind: 'remote',
          id: inst.id,
          name: inst.name,
          url: inst.url,
          cached: false,
          streamUrl: `${inst.url}/api/video/${bvid}`
        }))
    if (!pool.length) return null
    return pool[roundRobinCursor++ % pool.length]
  }

  /** 调用实例的解析接口，让 bot 端解析（调 B 站）并保存到本地。 */
  const dispatchPrepare = async (provider, bvid) => {
    const headers = { 'Content-Type': 'application/json' }
    if (instanceToken) headers['X-Instance-Token'] = instanceToken
    if (token) headers.Authorization = `Bearer ${token}`
    const controller = new AbortController()
    const timeout = Number(process.env.PREPARE_TIMEOUT_MS) || 300_000
    const timer = setTimeout(() => controller.abort(), timeout)
    let upstream
    try {
      upstream = await fetch(`${provider.url}/api/videos/${bvid}/prepare`, {
        method: 'POST',
        headers,
        body: '{}',
        signal: controller.signal
      })
    } catch (err) {
      throw new HttpError(502, `派发给实例 ${provider.id} 失败：${err.message}`)
    } finally {
      clearTimeout(timer)
    }
    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '')
      throw new HttpError(
        502,
        `实例 ${provider.id} 解析失败（HTTP ${upstream.status}）${text ? `：${text.slice(0, 200)}` : ''}`
      )
    }
    return upstream.json()
  }

  /** Hub：让一个 bot 实例解析并保存视频，成功后立即更新目录里的 cached 标记。 */
  const dispatchParseToInstance = async (bvid) => {
    const provider = pickParseProvider(bvid)
    if (!provider) return null
    const result = await dispatchPrepare(provider, bvid)
    registry?.markCached?.(provider.id, bvid, true)
    logger.info?.(`[randomvideo-api] 已派发实例 ${provider.id} 解析并保存 ${bvid}`)
    return { provider, result }
  }

  /** 收集某 bvid 的可选来源：本机（已保存的本地文件）+ 上报该视频的健康实例。 */
  const candidatesFor = (bvid) => {
    const record = store.find(bvid)
    const local = {
      kind: 'local',
      id: instanceId,
      name: instanceName,
      url: instanceUrl,
      cached: fs.existsSync(cachePath(bvid)),
      title: record?.title ?? '',
      has: Boolean(record),
      streamUrl: `${instanceUrl}/api/video/${bvid}`
    }
    const remote = registry ? registry.providers(bvid) : []
    return { local, remote }
  }

  /** 按策略排出来源优先级。 */
  const orderCandidates = (local, remote) => {
    const remotes = [...remote].sort((a, b) => {
      if (a.cached !== b.cached) return Number(b.cached) - Number(a.cached)
      return (b.lastSeen ?? 0) - (a.lastSeen ?? 0)
    })
    switch (strategy) {
      case 'remote-first':
        return [...remotes, local]
      case 'random':
        return shuffle([local, ...remotes])
      case 'round-robin': {
        const all = [local, ...remotes]
        const offset = roundRobinCursor++ % all.length
        return [...all.slice(offset), ...all.slice(0, offset)]
      }
      case 'cached-first': {
        const all = [local, ...remotes]
        return all.sort((a, b) => Number(b.cached) - Number(a.cached) || Number(a.kind === 'local' ? -1 : 1))
      }
      case 'local-first':
      default:
        return [local, ...remotes]
    }
  }

  /** 解析本次请求的分发方式：显式 delivery > format=stream > 默认值。 */
  const resolveDelivery = (url, format) => {
    const explicit = url.searchParams.get('delivery')
    if (explicit === 'proxy' || explicit === 'redirect') return explicit
    if (format === 'stream') return 'proxy'
    return defaultDelivery
  }

  /**
   * 分发一个视频：redirect 直链（本地则直接出流，避免重定向到自己），
   * proxy 由本服务转发；proxy 模式下失败会自动切换到下一个实例。
   */
  const deliver = async (req, res, bvid, { delivery, forceCache = false } = {}) => {
    let { local, remote } = candidatesFor(bvid)
    // Hub 侧没有实例持有该视频时，先派发给一个 bot 实例解析并保存，再分发
    if (autoParse && registry && remote.length === 0) {
      try {
        await dispatchParseToInstance(bvid)
      } catch (err) {
        logger.warn?.(`[randomvideo-api] 自动解析 ${bvid} 失败: ${err.message}`)
      }
      ;({ local, remote } = candidatesFor(bvid))
    }
    const candidates = orderCandidates(local, remote)
    const useProxy = delivery === 'proxy' && !forceCache
    let lastErr = null
    for (const candidate of candidates) {
      try {
        if (candidate.kind === 'local') {
          await streamLocal(req, res, bvid, { forceCache })
          return
        }
        if (!useProxy) {
          res.writeHead(302, { Location: candidate.streamUrl })
          return res.end()
        }
        await proxyRemote(req, res, candidate, bvid)
        return
      } catch (err) {
        lastErr = err
        if (res.headersSent) return
        logger.warn?.(`[randomvideo-api] 分发 ${bvid} 经 ${candidate.id} 失败: ${err.message}`)
      }
    }
    throw lastErr ?? new HttpError(404, `没有可用的视频来源: ${bvid}`)
  }

  /** 全局视频池：本地列表 ∪ 健康实例上报目录。 */
  const buildRandomPool = () => {
    const pool = new Map()
    for (const item of store.list()) {
      if (!item?.bvid) continue
      pool.set(item.bvid, { bvid: item.bvid, title: item.title ?? '' })
    }
    if (registry) {
      for (const [bvid, entry] of registry.catalog()) {
        const existing = pool.get(bvid)
        pool.set(bvid, { bvid, title: existing?.title || entry.title || '' })
      }
    }
    return [...pool.values()]
  }

  /**
   * 随机取一个视频。只有本地来源时会回源校验并剔除失效视频；
   * 有实例上报则信任注册表，交给分发阶段的故障转移处理。
   */
  const pickRandomEntry = async () => {
    let lastErr = null
    for (let i = 0; i < 5; i++) {
      const pool = buildRandomPool()
      if (!pool.length) throw new HttpError(404, '视频列表为空，请先添加视频')
      const entry = pool[Math.floor(Math.random() * pool.length)]
      const hasRemote = registry ? registry.providers(entry.bvid).length > 0 : false
      // Hub 不解析：交给分发阶段的「派发给实例」逻辑处理
      if (hasRemote || !localParse) return entry
      try {
        await bilibili.getVideoInfo(entry.bvid)
        return entry
      } catch (err) {
        lastErr = err
        if (err instanceof BilibiliError && err.status === 404) {
          logger.info(`[randomvideo-api] 视频 ${entry.bvid} 已失效，自动移除`)
          store.remove(entry.bvid)
          continue
        }
        throw err
      }
    }
    throw lastErr ?? new HttpError(502, '连续抽取失败，请稍后重试')
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
    const { pathname } = url

    res.setHeader('Access-Control-Allow-Origin', corsOrigin)
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Range, X-Instance-Token')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
    res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges')
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      return res.end()
    }

    try {
      if (pathname === '/health') {
        return sendJson(res, 200, {
          ok: true,
          count: store.count(),
          instances: registry ? registry.size() : 0,
          instance_id: instanceId,
          role,
          uptime: process.uptime(),
          limits: {
            max_video_mb: Math.round(maxBytes / MB),
            max_video_minutes: maxDurationSeconds > 0 ? maxDurationSeconds / 60 : null
          }
        })
      }

      if (pathname === '/' || pathname === '/api') {
        return sendJson(res, 200, {
          name: 'random-video-api',
          instance_id: instanceId,
          hub: hubEnabled,
          local_parse: localParse,
          endpoints: {
            'GET /health': '健康检查',
            'GET /api/videos': '本机视频列表',
            'POST /api/videos': '添加视频 { bvid }（Hub 会派发给 bot 解析保存）',
            'GET /api/videos/:bvid': '单条记录',
            'DELETE /api/videos/:bvid': '删除视频',
            'POST /api/videos/:bvid/prepare': '解析+下载+保存（实例本机执行，Hub 派发给 bot）',
            'GET /api/random': '随机抽取（format=json|stream|redirect，delivery=redirect|proxy）',
            'GET /api/video/:bvid': '获取/分发视频（delivery=redirect|proxy，cache=1，redirect=1 跳源站）',
            'GET /api/video/:bvid/info': '解析信息 / 注册表信息',
            ...(hubEnabled
              ? {
                  'POST /api/instances/report': '实例心跳上报（需集群令牌）',
                  'GET /api/instances': '已注册实例列表',
                  'GET /api/instances/:id': '单个实例详情',
                  'DELETE /api/instances/:id': '注销实例',
                  'GET /api/catalog': '聚合后的全局视频目录'
                }
              : {})
          }
        })
      }

      if (!pathname.startsWith('/api/')) throw new HttpError(404, '接口不存在')
      checkAuth(req, url)

      /* ---------------- Hub：实例注册表 ---------------- */

      if (hubEnabled && pathname === '/api/instances/report' && req.method === 'POST') {
        checkClusterAuth(req, url)
        const body = await readJsonBody(req, 4 * MB)
        try {
          const result = registry.report(body)
          logger.info?.(
            `[randomvideo-api] 实例 ${result.instance.id} 上报 ${result.instance.video_count} 个视频（共 ${result.instance_count} 个实例）`
          )
          return sendJson(res, 200, result)
        } catch (err) {
          throw new HttpError(400, `上报校验失败：${err.message}`)
        }
      }

      if (hubEnabled && pathname === '/api/instances' && req.method === 'GET') {
        const instances = registry.list()
        return sendJson(res, 200, { total: instances.length, instances })
      }

      if (hubEnabled && pathname === '/api/catalog' && req.method === 'GET') {
        const catalog = registry.catalog()
        return sendJson(res, 200, {
          total: catalog.size,
          videos: [...catalog.values()].map((entry) => ({
            bvid: entry.bvid,
            title: entry.title,
            providers: entry.providers.map((p) => ({ id: p.id, name: p.name, url: p.url, cached: p.cached }))
          }))
        })
      }

      const instanceMatch = /^\/api\/instances\/([^/]+)$/.exec(pathname)
      if (hubEnabled && instanceMatch) {
        const id = decodeURIComponent(instanceMatch[1])
        if (req.method === 'GET') {
          const instance = registry.get(id)
          if (!instance) throw new HttpError(404, '实例不存在')
          return sendJson(res, 200, { instance })
        }
        if (req.method === 'DELETE') {
          if (!registry.remove(id)) throw new HttpError(404, '实例不存在')
          return sendJson(res, 200, { removed: true, id })
        }
      }

      /* ---------------- 视频列表 ---------------- */

      if (pathname === '/api/videos' && req.method === 'GET') {
        const list = store.list()
        return sendJson(res, 200, { total: list.length, videos: list })
      }

      if (pathname === '/api/videos' && req.method === 'POST') {
        const body = await readJsonBody(req)
        const bvid = normalizeBvid(body.bvid ?? body.url ?? url.searchParams.get('bvid') ?? '')
        if (!bvid) throw new HttpError(400, '请提供合法的 BV 号，例如 BV1xx411c7mD')
        if (store.has(bvid)) {
          return sendJson(res, 200, { added: false, message: '该视频已在列表中', video: store.find(bvid) })
        }

        // 上传元信息：时间 / 群聊 / 上传者
        const meta = buildUploadMeta(body, url.searchParams)

        // Hub 不解析：先登记，再把「解析+保存」派发给 bot 实例
        if (!localParse) {
          store.add({
            bvid,
            title: '',
            ...meta,
            source: 'api'
          })
          let parsed = null
          if (autoParse && registry) {
            try {
              parsed = (await dispatchParseToInstance(bvid))?.result ?? null
              if (parsed?.title) store.upsert(bvid, { title: parsed.title, cached: true })
            } catch (err) {
              logger.warn?.(`[randomvideo-api] 登记 ${bvid} 后派发解析失败: ${err.message}`)
            }
          }
          return sendJson(res, 201, { added: true, video: store.find(bvid), parsed })
        }

        const info = await bilibili.getVideoInfo(bvid)
        enforceDuration(info, bvid, { remove: false })
        const { item } = store.add({
          bvid,
          title: info.title,
          duration: info.duration,
          pic: info.pic,
          ...meta,
          source: 'api'
        })
        return sendJson(res, 201, { added: true, video: item })
      }

      const videoMatch = /^\/api\/video\/(BV[0-9A-Za-z]{10})(\/info)?$/.exec(pathname)
      if (videoMatch && req.method === 'GET') {
        const bvid = videoMatch[1]
        const remote = candidatesFor(bvid).remote
        if (videoMatch[2]) {
          // Hub 不解析：只汇报注册表/本地已保存的信息
          if (!localParse) {
            const record = store.find(bvid)
            return sendJson(res, 200, {
              bvid,
              title: record?.title ?? remote[0]?.title ?? '',
              cached: fs.existsSync(cachePath(bvid)),
              providers: remote.length,
              instances: remote.map((p) => ({ id: p.id, name: p.name, url: p.url, cached: p.cached })),
              parsed_locally: false,
              stream_url: `/api/video/${bvid}`
            })
          }
          const { info, play } = await resolvePlay(bvid)
          return sendJson(res, 200, {
            bvid,
            title: info.title,
            cid: info.cid,
            duration: info.duration,
            pic: info.pic,
            size: play.size,
            size_mb: play.size ? Number((play.size / MB).toFixed(2)) : null,
            cached: fs.existsSync(cachePath(bvid)),
            providers: remote.length,
            instances: remote.map((p) => ({ id: p.id, name: p.name, url: p.url, cached: p.cached })),
            stream_url: `/api/video/${bvid}`
          })
        }

        // 兼容旧参数：redirect=1 直接跳 B 站源地址（需要本机解析能力）
        if (url.searchParams.get('redirect') === '1') {
          if (!localParse) throw new HttpError(409, '本机不解析视频，请使用 delivery=redirect 由 bot 实例分发')
          const { play } = await resolvePlay(bvid)
          res.writeHead(302, { Location: play.url })
          return res.end()
        }

        const forceCache = url.searchParams.get('cache') === '1'
        if (forceCache) {
          if (!localParse) throw new HttpError(409, '本机不解析视频，无法在本机缓存')
          const { play } = await resolvePlay(bvid)
          const file = await ensureCached(bvid, play)
          return serveFile(req, res, file)
        }
        return await deliver(req, res, bvid, { delivery: resolveDelivery(url, 'video') })
      }

      const prepareMatch = /^\/api\/videos\/(BV[0-9A-Za-z]{10})\/prepare$/.exec(pathname)
      if (prepareMatch && req.method === 'POST') {
        const bvid = prepareMatch[1]
        // 解析 + 下载 + 保存：实例在本机完成，Hub 则派发给 bot 实例
        const forceLocal = url.searchParams.get('local') === '1'
        if (!forceLocal && hubEnabled && registry && autoParse) {
          const dispatched = await dispatchParseToInstance(bvid)
          if (dispatched) {
            return sendJson(res, 200, {
              ...dispatched.result,
              instance_id: dispatched.provider.id,
              instance_url: dispatched.provider.url,
              dispatched: true
            })
          }
          if (!localParse) throw new HttpError(502, '没有可用的健康实例来解析该视频')
        }
        if (!localParse) throw new HttpError(409, '本机未开启解析（LOCAL_PARSE=0）')
        const result = await prepareVideo(bvid)
        return sendJson(res, 200, { ...result, dispatched: false })
      }

      const recordMatch = /^\/api\/videos\/(BV[0-9A-Za-z]{10})$/.exec(pathname)
      if (recordMatch) {
        const bvid = recordMatch[1]
        if (req.method === 'GET') {
          const video = store.find(bvid)
          if (!video) throw new HttpError(404, '列表中没有该视频')
          return sendJson(res, 200, { video })
        }
        if (req.method === 'DELETE') {
          const removed = store.remove(bvid)
          if (!removed) throw new HttpError(404, '列表中没有该视频')
          return sendJson(res, 200, { removed: true, bvid })
        }
      }

      /* ---------------- 随机分发 ---------------- */

      if (pathname === '/api/random' && req.method === 'GET') {
        const format = url.searchParams.get('format') || 'json'

        if (url.searchParams.get('redirect') === '1') {
          const entry = await pickRandomEntry()
          res.writeHead(302, { Location: `/api/video/${entry.bvid}` })
          return res.end()
        }

        if (format === 'stream' || format === 'redirect') {
          let lastErr = null
          for (let i = 0; i < 5; i++) {
            const entry = await pickRandomEntry()
            try {
              const delivery = format === 'stream' ? 'proxy' : resolveDelivery(url, 'redirect')
              return await deliver(req, res, entry.bvid, { delivery })
            } catch (err) {
              lastErr = err
              if (res.headersSent) return
            }
          }
          throw lastErr ?? new HttpError(502, '连续分发失败，请稍后重试')
        }

        const entry = await pickRandomEntry()
        const { local, remote } = candidatesFor(entry.bvid)
        const ordered = orderCandidates(local, remote)
        const chosen = ordered[0]
        const delivery = resolveDelivery(url, 'json')
        return sendJson(res, 200, {
          bvid: entry.bvid,
          title: chosen?.title || entry.title,
          providers: remote.length,
          candidates: ordered.length,
          provider: chosen
            ? { kind: chosen.kind, id: chosen.id, name: chosen.name, url: chosen.url, cached: chosen.cached }
            : null,
          delivery,
          stream_url: `/api/video/${entry.bvid}`,
          direct_url: chosen && chosen.kind === 'remote' ? chosen.streamUrl : null,
          bilibili_url: `https://www.bilibili.com/video/${entry.bvid}`
        })
      }

      throw new HttpError(404, '接口不存在')
    } catch (err) {
      sendError(res, err, logger)
    }
  })

  server.cacheDir = cacheDir
  server.store = store
  server.registry = registry
  server.strategy = strategy
  server.defaultDelivery = defaultDelivery
  server.instanceId = instanceId
  server.localParse = localParse
  server.autoParse = autoParse
  return server
}

export default createApiServer
