import plugin from '../../lib/plugins/plugin.js'
import fs from 'node:fs'
import path from 'node:path'
import axios from 'axios'

/**
 * 抽象视频插件
 * 指令：#来个抽象视频, #添加抽象视频 [BV号]
 * 存储：videolist.json
 */

const _path = process.cwd()
const dirPath = path.join(_path, 'plugins', 'randomvideo')
const filePath = path.join(dirPath, 'videolist.json')

// 哔哩哔哩请求头
const BILI_HEADER = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36',
  'Referer': 'https://www.bilibili.com'
}

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

    // 初始化目录和文件
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true })
    }
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, '[]', 'utf-8')
    }
  }

  /**
   * 获取视频列表
   */
  getList() {
    try {
      if (!fs.existsSync(filePath)) return []
      const content = fs.readFileSync(filePath, 'utf-8')
      return JSON.parse(content || '[]')
    } catch (e) {
      logger.error('[抽象视频] 读取列表失败', e)
      return []
    }
  }

  /**
   * 保存视频列表
   */
  saveList(list) {
    try {
      fs.writeFileSync(filePath, JSON.stringify(list, null, 2), 'utf-8')
    } catch (e) {
      logger.error('[抽象视频] 保存列表失败', e)
    }
  }

  /**
   * 添加视频
   */
  async addVideo(e) {
    let bvid = e.msg.replace('#添加抽象视频', '').trim()
    
    if (!bvid) {
      const reg = /BV[a-zA-Z0-9]{10}/i
      const match = reg.exec(e.msg)
      if (match) {
        bvid = match[0]
      }
    }

    if (!bvid) {
      return e.reply('请提供正确的BV号，例如：#添加抽象视频BV1xxxx')
    }

    // 格式化BV号
    if (!bvid.startsWith('BV')) {
       const reg = /BV[a-zA-Z0-9]{10}/i
       const match = reg.exec(bvid)
       if (match) bvid = match[0]
       else return e.reply('BV号格式不正确')
    }

    let list = this.getList()
    if (list.find(item => item.bvid === bvid)) {
      return e.reply('该视频已在列表中')
    }

    // 验证视频是否存在 (参考 tools.js 逻辑)
    try {
      const res = await axios.get(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, { 
        headers: BILI_HEADER,
        timeout: 10000 
      })

      if (res.data.code !== 0) {
        return e.reply(`视频验证失败：${res.data.message}`)
      }

      const data = res.data.data
      const newItem = {
        added_by: e.sender.nickname || e.user_id,
        qq: e.user_id,
        time: new Date().toLocaleString(),
        bvid: bvid,
        group_id: e.group_id || '私聊',
        title: data.title
      }

      list.push(newItem)
      this.saveList(list)
      return e.reply(`[抽象视频] 添加成功！\n标题：${data.title}\nBV号：${bvid}`)
    } catch (err) {
      logger.error('[抽象视频] 验证视频出错', err)
      return e.reply('验证视频时发生错误')
    }
  }

  /**
   * 随机播放视频
   */
  async randomVideo(e) {
    e.reply("稍等哦，我正在给你找个抽象小视频",false,{ recallMsg: 5})
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
        // 1. 获取 CID
        const viewRes = await axios.get(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, { 
          headers: BILI_HEADER,
          timeout: 10000 
        })

        if (viewRes.data.code !== 0) {
          logger.info(`[抽象视频] 视频 ${bvid} 已失效，自动移除`)
          list.splice(index, 1)
          this.saveList(list)
          return pickAndSend(retryCount + 1)
        }

        const cid = viewRes.data.data.cid
        
        // 2. 获取播放地址 (qn=32 为 480P)
        const playRes = await axios.get(`https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&qn=32&type=mp4&platform=html5&high_quality=1`, { 
          headers: BILI_HEADER,
          timeout: 10000 
        })

        if (playRes.data.code !== 0 || !playRes.data.data?.durl?.[0]?.url) {
          logger.info(`[抽象视频] 视频 ${bvid} 无法解析播放地址`)
          return pickAndSend(retryCount + 1)
        }

        const durl = playRes.data.data.durl[0]
        const videoUrl = durl.url
        const fileSize = durl.size

        // 3. 检查 50MB 限制 (50MB = 52428800 Bytes)
        if (fileSize > 50 * 1024 * 1024) {
          logger.info(`[抽象视频] 视频 ${bvid} 过大 (${(fileSize / 1024 / 1024).toFixed(2)}MB)，自动拦截并删除`)
          list.splice(index, 1)
          this.saveList(list)
          return pickAndSend(retryCount + 1)
        }

        // 4. 下载并发送
        const tempFile = path.join(dirPath, `${bvid}_${Date.now()}.mp4`)
        const response = await axios({
          url: videoUrl,
          method: 'GET',
          responseType: 'stream',
          headers: BILI_HEADER,
          timeout: 60000
        })

        const writer = fs.createWriteStream(tempFile)
        response.data.pipe(writer)

        await new Promise((resolve, reject) => {
          writer.on('finish', resolve)
          writer.on('error', reject)
        })

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
