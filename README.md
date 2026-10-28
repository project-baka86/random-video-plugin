# random-video-plugin

Yunzai-Bot 的 B 站抽象视频随机插件。**零第三方依赖**（只用 Node 18+ 全局 `fetch`）。

- `#添加抽象视频BV1xxxxxxxxx` — 校验并添加视频到列表
- `#来个抽象视频` — 随机抽取一个视频发到群里（超过 50MB 自动拦截并移除）

上传时会自动标注**时间 / 群聊 / 上传者**：

- 添加成功的回复会列出这三项；重复添加时会显示此前是谁、在哪个群、什么时候加的；
- 随机发出的视频消息会带一行 `来源：上传者(QQ)｜群名(群号)｜时间`；
- 这些字段（`time`/`time_iso`/`group_id`/`group_name`/`qq`/`added_by`）一并写入
  `videolist.json`，API 侧可直接读取。

加载插件后会在插件目录自动生成 `videolist.json` 存储 BV 号，可用环境变量
`VIDEO_DATA_FILE` 覆盖存储位置。

## 目录结构

```
.
├── index.js        # 插件本体
├── lib/
│   ├── store.js    # videolist.json 读写（原子写入、损坏自愈、BV 号规范化）
│   └── bilibili.js # B 站 view/playurl/视频流封装（含 412 风控降级，与 API 共用）
└── package.json
```

`lib/bilibili.js` 会依次尝试多组请求头（`ua+referer` → `ua+referer+origin` → 仅 `referer`），
遇到 B 站 412/403 风控自动切换并记住可用组合；机房 IP 也能正常解析。
可选环境变量 `BILI_UA` / `BILI_COOKIE`（如 `SESSDATA=...`）进一步降低风控概率。

## 安装

把整个仓库放到 Yunzai 的 `plugins/randomvideo/` 目录下即可，无需安装任何依赖：

```bash
git clone https://github.com/project-baka86/random-video-plugin.git \
  <Yunzai根目录>/plugins/randomvideo
```

或直接在 `plugins/` 下解压本仓库。重启 / 重载 Yunzai 后生效。

## 配套的视频分发 API

本仓库的 `videolist.json` 与分发 API 共用同一份数据。API（多实例上报、Hub 分发、
bot 端解析保存、302 直链 + Hub 代理）在另一个公开仓库：

**https://github.com/project-baka86/random-video-api**

部署 API 时把 `VIDEO_DATA_FILE` 指向本插件的 `videolist.json`，两者即共用同一份列表。
