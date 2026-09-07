# Boltbound - 微信小游戏工程

`wechat-minigame` 根目录可直接导入微信开发者工具，项目类型选择“小游戏”。它是原生 Canvas 小游戏工程，不是普通小程序的 `web-view`。

微信线上公开名称固定为 `Boltbound`。实际线上名称需要在微信公众平台对应正式 AppID 的小游戏账号资料中设置；`project.config.json` 的 `projectname` 只是微信开发者工具中的本地项目名。

## 构建

在仓库根目录执行：

```powershell
npm run build:wechat
```

构建过程会完成以下工作：

1. 按需用本机 Microsoft Edge 将 `public/assets` 的 29 个 SVG 转换为同尺寸 PNG；已有资源有效且未过期时可复用。
2. 校验所有 PNG 的像素尺寸；28 个透明素材还会解码校验 Alpha 背景，场景图校验为 1600x900。
3. 生成并同步 14 个 WAV 音频资源，包括一首循环背景音乐和 13 类音效。
4. 用 `vite.wechat.config.js` 输出单个 IIFE 文件 `dist/game.bundle.js`，不拆分代码块。资源数量以共享清单与构建校验为准。

只生成/更新素材，包含 PNG 和 WAV，不重建 bundle：

```powershell
npm run build:wechat:assets
```

只校验已经生成的工程、图片、音频和 bundle：

```powershell
npm run check:wechat
```

如果 Edge 不在默认安装目录，可先设置 `EDGE_PATH` 为 `msedge.exe` 的完整路径。

## 本地模拟器

1. 运行房间服务器：`npm run dev:server`。
2. 在微信开发者工具导入本目录。
3. 当前 `project.config.json` 仍使用 `touristappid`，仅用于无正式 AppID 的模拟器预览，不能用于正式发布。
4. `config.js` 默认连接 `http://127.0.0.1:3001`，并使用 Socket.IO 路径 `/socket.io/`。

`game.js` 的加载顺序固定为：官方适配器 -> `config.js` -> `dist/game.bundle.js`。

小游戏为横屏。适配器用 `wx.getSystemInfoSync()` 的 `screenWidth/screenHeight` 设置 `window.innerWidth/innerHeight`，Canvas 的 `getBoundingClientRect()` 返回这组横屏尺寸。

## 真机与发布

真机调试和发布前需要：

1. 在微信公众平台将对应小游戏账号的公开名称设置为 `Boltbound`。
2. 把 `project.config.json` 当前的 `touristappid` 替换为已开通小游戏能力的正式 AppID。
3. 把 `config.js` 的 `serverUrl` 替换为固定的 `https://` 公网地址；WebSocket 会使用对应的 `wss://` 连接。
4. 在微信公众平台配置与该地址一致的合法服务器域名，并部署有效证书。

`urlCheck: false` 只方便开发者工具本地调试，不能绕过真机域名校验。会自动变化的临时隧道地址不适合作为小游戏发布域名。

## 微信实时语音

游戏内的“麦”和“声”按钮按需加入微信实时语音：默认麦克风关闭、扬声器开启；切到后台、离开房间或网络断开时会立即退出语音，重新回到前台不会自动打开麦克风。

微信语音和电脑版浏览器语音是两个独立频道，不能跨端互通。正式启用前必须同时完成：

1. 使用正式小游戏 AppID，`touristappid` 和开发者工具只会显示不可用原因。
2. 在微信公众平台的“游戏能力地图”申请并开通实时语音能力。
3. 配置包含麦克风用途的用户隐私保护指引，并完成 `scope.record` 授权流程。
4. 服务端配置 AppID/Secret，通过玩家的 `wx.login` 临时 code 换取 session key，并生成 `groupId`、`signature`、`nonceStr`、`timeStamp`；Secret 和 session key 不得下发到客户端。
5. 保持 `config.js` 中 `voice.enabled: true`；真机发布应保持 `requireRealDevice: true`。

客户端会明确区分未配置、未开通、未审批、未配置隐私、开发者工具不支持和服务端签名不可用，不会在这些情况下显示“已加入”。

## 官方适配器来源与修正

`js/libs/weapp-adapter.js` 基于微信官方 quickstart 的 MIT 版本：

- 仓库：`wechat-miniprogram/miniprogram-game-quickstart`
- 上游提交：`fbbf1f83dfee104c9dc922630613b47b5f21a385`
- 上游原文件 SHA-256：`7CAA110C52F39BA6AC157BFE266D260D22AD45F32AC48B4F118E519BE8D5BEC7`
- 本地兼容修正：`performance.now()` 优先调用 `wx.getPerformance().now()`，无该 API 时回退毫秒语义的 `Date.now()`
- 修正后文件 SHA-256：`AC8A170C29CD4C5209A9F6630280F0775516DE4ED1D2948ED586A68AFCBEBC90`
- 许可证：本目录 `LICENSE`（MIT，原样保留；SHA-256 `FFEF252C84EF2208C5EB1DE2ED68909AAF6E8355A8B274431A2DE031A77CDDFC`）

来源链接：<https://github.com/wechat-miniprogram/miniprogram-game-quickstart>
