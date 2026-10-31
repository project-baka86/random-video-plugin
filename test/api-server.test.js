import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

import { createApiServer } from '../lib/api-server.js'
import { VideoStore } from '../lib/store.js'
import { BilibiliError } from '../lib/bilibili.js'

const VALID_BVID = 'BV1xx411c7mD'
const VIDEO = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 256))
const silent = { info() {}, warn() {}, error() {} }

/** 构造一个完全离线的假 B 站。 */
function makeMockBilibili({ size = VIDEO.length } = {}) {
  return {
    async getVideoInfo(bvid) {
      if (bvid !== VALID_BVID) {
        throw new BilibiliError('视频不存在或已失效', { code: -404, status: 404 })
      }
      return { bvid, cid: 123456, title: '抽象测试视频', duration: 12, pic: 'https://example.test/cover.jpg' }
    },
    async getPlayUrl(bvid, cid) {
      return { url: `https://upstream.test/${bvid}.mp4?cid=${cid}`, size, length: 12, quality: 32, format: 'mp4' }
    },
    async openVideoStream(url) {
      if (!url.includes('upstream.test')) throw new Error(`unexpected url ${url}`)
      return {
        status: 200,
        ok: true,
        headers: new Headers({ 'content-length': String(VIDEO.length) }),
        body: Readable.toWeb(Readable.from([VIDEO])),
        abort() {}
      }
    },
    BilibiliError
  }
}

async function startServer(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rv-api-'))
  const store = new VideoStore({ file: path.join(dir, 'videolist.json') })
  const server = createApiServer({
    store,
    cacheDir: path.join(dir, 'cache'),
    bilibili: options.bilibili ?? makeMockBilibili(),
    logger: silent,
    ...options
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const close = () => new Promise((resolve) => server.close(resolve))
  return { server, base, store, dir, close }
}

const json = (res) => res.json()

async function waitForFile(file, timeout = 2000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return true
    await new Promise((r) => setTimeout(r, 25))
  }
  return fs.existsSync(file)
}

test('GET /health 返回服务状态', async () => {
  const ctx = await startServer()
  try {
    const res = await fetch(`${ctx.base}/health`)
    assert.equal(res.status, 200)
    const data = await json(res)
    assert.equal(data.ok, true)
    assert.equal(data.count, 0)
    assert.equal(data.limits.max_video_mb, 50)
    assert.equal(data.limits.max_video_minutes, 10)
  } finally {
    await ctx.close()
  }
})

test('POST /api/videos 添加视频并校验 BV 号', async () => {
  const ctx = await startServer()
  try {
    const bad = await fetch(`${ctx.base}/api/videos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bvid: 'hello' })
    })
    assert.equal(bad.status, 400)

    const res = await fetch(`${ctx.base}/api/videos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bvid: `https://www.bilibili.com/video/${VALID_BVID}` })
    })
    assert.equal(res.status, 201)
    const data = await json(res)
    assert.equal(data.added, true)
    assert.equal(data.video.bvid, VALID_BVID)
    assert.equal(data.video.title, '抽象测试视频')
    assert.equal(ctx.store.count(), 1)

    // 重复添加
    const dup = await fetch(`${ctx.base}/api/videos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bvid: VALID_BVID })
    })
    const dupData = await json(dup)
    assert.equal(dupData.added, false)
    assert.equal(dup.status, 200)

    // 不存在的视频
    const missing = await fetch(`${ctx.base}/api/videos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bvid: 'BV1zz411c7mQ' })
    })
    assert.equal(missing.status, 404)
  } finally {
    await ctx.close()
  }
})

test('POST /api/videos 记录时间/群聊/上传者元信息', async () => {
  const ctx = await startServer()
  try {
    const res = await fetch(`${ctx.base}/api/videos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bvid: VALID_BVID,
        added_by: '群友甲',
        qq: 10001,
        group_id: 123456,
        group_name: '抽象交流群',
        time: '2026-10-28 21:00:00'
      })
    })
    assert.equal(res.status, 201)
    const { video } = await json(res)
    assert.equal(video.added_by, '群友甲')
    assert.equal(video.qq, 10001)
    assert.equal(video.group_id, 123456)
    assert.equal(video.group_name, '抽象交流群')
    assert.equal(video.time, '2026-10-28 21:00:00')
    assert.ok(video.time_iso, '应记录 ISO 时间')
    // 已落盘，其他进程可见
    const stored = ctx.store.find(VALID_BVID)
    assert.equal(stored.group_name, '抽象交流群')
    assert.equal(stored.qq, 10001)
  } finally {
    await ctx.close()
  }
})

test('POST /api/videos 未提供元信息时用默认值', async () => {
  const ctx = await startServer()
  try {
    const res = await fetch(`${ctx.base}/api/videos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bvid: VALID_BVID })
    })
    const { video } = await json(res)
    assert.equal(video.added_by, 'api')
    assert.match(video.time, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    assert.ok(video.time_iso)
  } finally {
    await ctx.close()
  }
})

test('GET /api/videos 列表 / GET /api/videos/:bvid / DELETE', async () => {
  const ctx = await startServer()
  try {
    ctx.store.add({ bvid: VALID_BVID, title: '抽象测试视频' })

    const listRes = await fetch(`${ctx.base}/api/videos`)
    const list = await json(listRes)
    assert.equal(list.total, 1)
    assert.equal(list.videos[0].bvid, VALID_BVID)

    const oneRes = await fetch(`${ctx.base}/api/videos/${VALID_BVID}`)
    assert.equal(oneRes.status, 200)
    assert.equal((await json(oneRes)).video.title, '抽象测试视频')

    const delRes = await fetch(`${ctx.base}/api/videos/${VALID_BVID}`, { method: 'DELETE' })
    assert.equal(delRes.status, 200)
    assert.equal((await json(delRes)).removed, true)
    assert.equal(ctx.store.count(), 0)

    const again = await fetch(`${ctx.base}/api/videos/${VALID_BVID}`, { method: 'DELETE' })
    assert.equal(again.status, 404)
  } finally {
    await ctx.close()
  }
})

test('GET /api/random 空列表 404，有列表返回随机视频', async () => {
  const ctx = await startServer()
  try {
    const empty = await fetch(`${ctx.base}/api/random`)
    assert.equal(empty.status, 404)

    ctx.store.add({ bvid: VALID_BVID, title: '抽象测试视频' })
    const res = await fetch(`${ctx.base}/api/random`)
    assert.equal(res.status, 200)
    const data = await json(res)
    assert.equal(data.bvid, VALID_BVID)
    assert.equal(data.stream_url, `/api/video/${VALID_BVID}`)
  } finally {
    await ctx.close()
  }
})

test('GET /api/random 会自动剔除已失效视频', async () => {
  const ctx = await startServer()
  try {
    ctx.store.add({ bvid: 'BV1zz411c7mQ', title: '已失效' })
    // 唯一的视频已失效 -> 自动移除后列表为空，返回 404
    const res = await fetch(`${ctx.base}/api/random`)
    assert.equal(res.status, 404)
    assert.equal(ctx.store.has('BV1zz411c7mQ'), false)
    assert.equal(ctx.store.count(), 0)
  } finally {
    await ctx.close()
  }
})

test('GET /api/video/:bvid 流式返回完整视频并落盘缓存', async () => {
  const ctx = await startServer()
  try {
    ctx.store.add({ bvid: VALID_BVID, title: '抽象测试视频' })
    const res = await fetch(`${ctx.base}/api/video/${VALID_BVID}`)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'video/mp4')
    assert.equal(res.headers.get('content-length'), String(VIDEO.length))
    const buf = Buffer.from(await res.arrayBuffer())
    assert.equal(buf.length, VIDEO.length)
    assert.ok(buf.equals(VIDEO))

    const cacheFile = path.join(ctx.server.cacheDir, `${VALID_BVID}.mp4`)
    assert.equal(await waitForFile(cacheFile), true)
    assert.equal(fs.readFileSync(cacheFile).length, VIDEO.length)
  } finally {
    await ctx.close()
  }
})

test('GET /api/video/:bvid 支持 Range 断点续传', async () => {
  const ctx = await startServer()
  try {
    ctx.store.add({ bvid: VALID_BVID, title: '抽象测试视频' })
    const full = await fetch(`${ctx.base}/api/video/${VALID_BVID}`)
    await full.arrayBuffer()
    const cacheFile = path.join(ctx.server.cacheDir, `${VALID_BVID}.mp4`)
    assert.equal(await waitForFile(cacheFile), true)

    const ranged = await fetch(`${ctx.base}/api/video/${VALID_BVID}`, {
      headers: { Range: 'bytes=10-19' }
    })
    assert.equal(ranged.status, 206)
    assert.equal(ranged.headers.get('content-range'), `bytes 10-19/${VIDEO.length}`)
    const slice = Buffer.from(await ranged.arrayBuffer())
    assert.ok(slice.equals(VIDEO.subarray(10, 20)))

    const bad = await fetch(`${ctx.base}/api/video/${VALID_BVID}`, {
      headers: { Range: `bytes=${VIDEO.length + 10}-` }
    })
    assert.equal(bad.status, 416)
  } finally {
    await ctx.close()
  }
})

test('GET /api/video/:bvid/info 返回实时播放信息', async () => {
  const ctx = await startServer()
  try {
    ctx.store.add({ bvid: VALID_BVID, title: '抽象测试视频' })
    const res = await fetch(`${ctx.base}/api/video/${VALID_BVID}/info`)
    assert.equal(res.status, 200)
    const data = await json(res)
    assert.equal(data.cid, 123456)
    assert.equal(data.size, VIDEO.length)
    assert.equal(data.cached, false)
    assert.equal(data.stream_url, `/api/video/${VALID_BVID}`)
  } finally {
    await ctx.close()
  }
})

test('redirect=1 跳转到 B 站源地址', async () => {
  const ctx = await startServer()
  try {
    ctx.store.add({ bvid: VALID_BVID, title: '抽象测试视频' })
    const res = await fetch(`${ctx.base}/api/video/${VALID_BVID}?redirect=1`, { redirect: 'manual' })
    assert.equal(res.status, 302)
    assert.match(res.headers.get('location'), /^https:\/\/upstream\.test\//)
  } finally {
    await ctx.close()
  }
})

test('超过大小限制的视频被拒绝并移出列表', async () => {
  const big = 60 * 1024 * 1024
  const ctx = await startServer({ bilibili: makeMockBilibili({ size: big }) })
  try {
    ctx.store.add({ bvid: VALID_BVID, title: '超大视频' })
    const res = await fetch(`${ctx.base}/api/video/${VALID_BVID}`)
    assert.equal(res.status, 413)
    assert.equal(ctx.store.has(VALID_BVID), false)
  } finally {
    await ctx.close()
  }
})

test('超过时长上限的视频被拒绝，且不写入列表', async () => {
  const ctx = await startServer({ maxDurationSeconds: 10 })
  try {
    const res = await fetch(`${ctx.base}/api/videos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bvid: VALID_BVID })
    })
    assert.equal(res.status, 413)
    assert.match((await json(res)).error, /时长/)
    assert.equal(ctx.store.has(VALID_BVID), false)
  } finally {
    await ctx.close()
  }
})

test('分发 / 解析时超过时长上限的视频被移出列表', async () => {
  const ctx = await startServer({ maxDurationSeconds: 10 })
  try {
    // 旧数据（列表里已有的超长视频）：分发时拦截并清理
    ctx.store.add({ bvid: VALID_BVID, title: '超长视频' })
    const res = await fetch(`${ctx.base}/api/video/${VALID_BVID}`)
    assert.equal(res.status, 413)
    assert.equal(ctx.store.has(VALID_BVID), false)

    // prepare 同样拦截
    ctx.store.add({ bvid: VALID_BVID, title: '超长视频' })
    const prep = await fetch(`${ctx.base}/api/videos/${VALID_BVID}/prepare`, { method: 'POST' })
    assert.equal(prep.status, 413)
    assert.equal(ctx.store.has(VALID_BVID), false)
  } finally {
    await ctx.close()
  }
})

test('maxDurationSeconds=0 关闭时长限制', async () => {
  const ctx = await startServer({ maxDurationSeconds: 0 })
  try {
    const res = await fetch(`${ctx.base}/api/videos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bvid: VALID_BVID })
    })
    assert.equal(res.status, 201)
    assert.equal(ctx.store.has(VALID_BVID), true)
  } finally {
    await ctx.close()
  }
})

test('API_TOKEN 开启后 /api/* 需要鉴权，/health 不需要', async () => {
  const ctx = await startServer({ token: 'secret-token' })
  try {
    assert.equal((await fetch(`${ctx.base}/health`)).status, 200)
    assert.equal((await fetch(`${ctx.base}/api/videos`)).status, 401)
    const withHeader = await fetch(`${ctx.base}/api/videos`, {
      headers: { Authorization: 'Bearer secret-token' }
    })
    assert.equal(withHeader.status, 200)
    assert.equal((await fetch(`${ctx.base}/api/videos?token=secret-token`)).status, 200)
  } finally {
    await ctx.close()
  }
})

test('只配置 INSTANCE_TOKEN 时，下载/列表/随机同样需要令牌', async () => {
  const ctx = await startServer({ instanceToken: 'cluster-secret' })
  try {
    assert.equal((await fetch(`${ctx.base}/health`)).status, 200, '健康检查保持开放')
    assert.equal((await fetch(`${ctx.base}/api/videos`)).status, 401)

    ctx.store.add({ bvid: VALID_BVID, title: '抽象测试视频' })
    assert.equal((await fetch(`${ctx.base}/api/video/${VALID_BVID}`)).status, 401)
    assert.equal((await fetch(`${ctx.base}/api/random`)).status, 401)
    assert.equal((await fetch(`${ctx.base}/api/random?format=stream`)).status, 401)

    // X-Instance-Token（Hub 代理场景）
    const viaHeader = await fetch(`${ctx.base}/api/video/${VALID_BVID}`, {
      headers: { 'X-Instance-Token': 'cluster-secret' }
    })
    assert.equal(viaHeader.status, 200)
    await viaHeader.arrayBuffer()

    // Bearer 同样接受
    const viaBearer = await fetch(`${ctx.base}/api/videos`, {
      headers: { Authorization: 'Bearer cluster-secret' }
    })
    assert.equal(viaBearer.status, 200)
  } finally {
    await ctx.close()
  }
})

test('REQUIRE_AUTH/严格模式且未配置 token 时拒绝匿名访问', async () => {
  const ctx = await startServer({ strictAuth: true })
  try {
    assert.equal((await fetch(`${ctx.base}/health`)).status, 200, '健康检查仍放行')
    const res = await fetch(`${ctx.base}/api/videos`)
    assert.equal(res.status, 503)
    assert.match((await json(res)).error, /未配置任何 token/)
  } finally {
    await ctx.close()
  }
})

test('POST /api/videos/:bvid/prepare 解析并保存到本机缓存', async () => {
  const ctx = await startServer()
  try {
    const res = await fetch(`${ctx.base}/api/videos/${VALID_BVID}/prepare`, { method: 'POST' })
    assert.equal(res.status, 200)
    const data = await json(res)
    assert.equal(data.saved, true)
    assert.equal(data.cached, true)
    assert.equal(data.dispatched, false)
    assert.equal(data.size, VIDEO.length)

    const cacheFile = path.join(ctx.server.cacheDir, `${VALID_BVID}.mp4`)
    assert.ok(fs.existsSync(cacheFile), '应保存到缓存目录')
    assert.equal(fs.readFileSync(cacheFile).length, VIDEO.length)
    assert.equal(ctx.store.find(VALID_BVID).cached, true)

    // 解析信息显示已缓存
    const info = await json(await fetch(`${ctx.base}/api/video/${VALID_BVID}/info`))
    assert.equal(info.cached, true)

    // 失效视频解析失败
    const missing = await fetch(`${ctx.base}/api/videos/BV1zz411c7mQ/prepare`, { method: 'POST' })
    assert.equal(missing.status, 404)
  } finally {
    await ctx.close()
  }
})

test('未知路由返回 404 JSON', async () => {
  const ctx = await startServer()
  try {
    const res = await fetch(`${ctx.base}/api/nope`)
    assert.equal(res.status, 404)
    assert.ok((await json(res)).error)
  } finally {
    await ctx.close()
  }
})
