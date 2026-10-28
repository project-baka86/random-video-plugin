import plugin from '../../lib/plugins/plugin.js'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { VideoStore, normalizeBvid } from './lib/store.js'
import { getVideoInfo, getPlayUrl, openVideoStream } from './lib/bilibili.js'

/**
 * 抽象视频插件
 * 指令：#来个抽象视频, #添加抽象视频 [BV号]
 * 存储：videolist.json（与随机视频分发 API 共用同一份数据）
 *
 * 零第三方依赖：B 站解析复用 lib/bilibili.js（Node 18+ 全局 fetch，含 412 风控降级）。
 */

// 与 API 共用同一个列表文件，支持 VIDEO_DATA_FILE 环境变量覆盖
const store = new VideoStore()
const dirPath = store.dir

// 单个视频大小上限，与 API 的 MAX_VIDEO_MB 默认值保持一致
const MAX_VIDEO_MB = Number(process.env.MAX_VIDEO_MB) || 50

class RandomVideo extends plugin {
  constructor() {
    super({
      name: '抽象视频',
      dsc: '随机抽取并发送B站抽象视频',
      event: 'message',
      priority: 5000,
      rule: [
        {
          reg: '^#添加抽象视频.*$',
          fnc: 'addVideo'
        },
        {
          reg: '^#来个抽象视频$',
          fnc: 'randomVideo'
        }
      ]
    })

    // 初始化目录和文件（VideoStore 构造函数已完成，此处兜底）
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true })
    }
  }

  /**
   * 获取视频列表
   */
  getList() {
    return store.list()
  }

  /**
   * 保存视频列表
   */
  saveList(list) {
    try {
      store.save(list)
    } catch (e) {
      logger.error('[抽象视频] 保存列表失败', e)
    }
  }

  /**
   * 添加视频
   */
  async addVideo(e) {
    const bvid = normalizeBvid(e.msg)

    if (!bvid) {
      return e.reply('请提供正确的BV号，例如：#添加抽象视频BV1xxxx')
    }

    if (store.has(bvid)) {
      return e.reply('该视频已在列表中')
    }

    try {
      const data = await getVideoInfo(bvid)
      const newItem = {
        added_by: e.sender.nickname || e.user_id,
        qq: e.user_id,
        time: new Date().toLocaleString(),
        bvid: bvid,
        group_id: e.group_id || '私聊',
        title: data.title
      }

      store.add(newItem)
      return e.reply(`[抽象视频] 添加成功！\n标题：${data.title}\nBV号：${bvid}`)
    } catch (err) {
      logger.error('[抽象视频] 验证视频出错', err)
      if (err?.status === 404) {
        return e.reply(`视频验证失败：${err.message}`)
      }
      return e.reply('验证视频时发生错误')
    }
  }

  /**
   * 随机播放视频
   */
  async randomVideo(e) {
    e.reply('稍等哦，我正在给你找个抽象小视频', false, { recallMsg: 5 })
    let list = this.getList()
    if (list.length === 0) {
      return e.reply('当前列表为空，请先使用 #添加抽象视频 [BV号] 添加视频')
    }

    const pickAndSend = async (retryCount = 0) => {
      if (retryCount >= 5 || list.length === 0) {
        return e.reply('连续尝试抽取失败或视频过大，请检查列表')
      }

      const index = Math.floor(Math.random() * list.length)
      const item = list[index]
      const { bvid } = item

      try {
        // 1. 解析视频信息（失效视频自动移除）
        let info
        try {
          info = await getVideoInfo(bvid)
        } catch (err) {
          if (err?.status === 404) {
            logger.info(`[抽象视频] 视频 ${bvid} 已失效，自动移除`)
            list.splice(index, 1)
            this.saveList(list)
          } else {
            logger.info(`[抽象视频] 视频 ${bvid} 解析失败：${err?.message ?? err}`)
          }
          return pickAndSend(retryCount + 1)
        }

        // 2. 获取播放地址 (qn=32 为 480P)
        const play = await getPlayUrl(bvid, info.cid)

        // 3. 检查大小限制
        if (play.size > MAX_VIDEO_MB * 1024 * 1024) {
          logger.info(
            `[抽象视频] 视频 ${bvid} 过大 (${(play.size / 1024 / 1024).toFixed(2)}MB)，自动拦截并删除`
          )
          list.splice(index, 1)
          this.saveList(list)
          return pickAndSend(retryCount + 1)
        }

        // 4. 下载到临时文件
        const tempFile = path.join(dirPath, `${bvid}_${Date.now()}.mp4`)
        const upstream = await openVideoStream(play.url, { timeout: 60000 })
        if (!upstream.ok || !upstream.body) {
          upstream.abort?.()
          logger.info(`[抽象视频] 视频 ${bvid} 源站返回 HTTP ${upstream.status}`)
          return pickAndSend(retryCount + 1)
        }

        try {
          await pipeline(Readable.fromWeb(upstream.body), fs.createWriteStream(tempFile))
        } finally {
          upstream.abort?.()
        }

        try {
          // 发送视频
          await e.reply(segment.video(tempFile))
        } catch (sendErr) {
          logger.error('[抽象视频] 发送视频失败', sendErr)
          await e.reply('视频发送失败')
        }

        // 清理临时文件
        if (fs.existsSync(tempFile)) {
          fs.unlinkSync(tempFile)
        }
      } catch (err) {
        logger.error(`[抽象视频] 处理视频 ${bvid} 时出错`, err)
        return pickAndSend(retryCount + 1)
      }
    }

    await pickAndSend()
  }
}

export const apps = { RandomVideo }
