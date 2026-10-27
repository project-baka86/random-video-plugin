# random-video-plugin

Yunzai-Bot 的 B 站抽象视频随机插件。

- `#添加抽象视频BV1xxxxxxxxx` — 校验并添加视频到列表
- `#来个抽象视频` — 随机抽取一个视频发到群里（超过 50MB 自动拦截并移除）

加载插件后会在插件目录自动生成 `videolist.json` 存储 BV 号，可用环境变量
`VIDEO_DATA_FILE` 覆盖存储位置。

## 目录结构

```
.
├── index.js        # 插件本体
├── lib/store.js    # videolist.json 读写（原子写入、损坏自愈、BV 号规范化）
├── videolist.json  # 运行时生成
└── package.json
```

## 安装

把整个仓库放到 Yunzai 的 `plugins/randomvideo/` 目录下即可，无需安装依赖。

```
<Yunzai根目录>/plugins/randomvideo/
├── index.js
└── lib/store.js
```

重启 / 重载插件后生效。

## 配套的视频分发 API

本仓库的 `videolist.json` 与分发 API 共用同一份数据。API（多实例上报、Hub 分发、
bot 端解析保存）在另一个公开仓库：

**https://github.com/project-baka86/random-video-api**

部署 API 时可用 `VIDEO_DATA_FILE` 指向本插件的 `videolist.json`，即可让两者共用同一份列表。
