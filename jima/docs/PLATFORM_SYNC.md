# 双平台同步规则

本项目只有一套游戏逻辑，同时生成电脑版和微信小游戏版。微信小游戏的公开英文名固定为 **Boltbound**。

## 源码边界

| 范围 | 唯一来源 | 说明 |
| --- | --- | --- |
| 地图、道具、物理 | `shared/`、`src/game/` | 两个平台共同使用，禁止复制到平台目录 |
| 联机与回合 | `server/` | 电脑版和 Boltbound 连接同一套 Socket.IO 协议 |
| 美术源文件 | `public/assets/*.svg` | SVG 是唯一原稿；微信 PNG 由构建脚本生成 |
| 电脑版界面 | `index.html`、`src/main.js`、`src/style.css` | 只放浏览器/电脑版专用 UI |
| 微信界面 | `src/wechat/` | 只放微信 Canvas、触控和 `wx.*` 适配 |
| 微信工程壳 | `wechat-minigame/` | 可直接导入微信开发者工具，`dist/` 和 PNG 不手改 |

新增道具时，只在 `shared/gameConfig.js`、`shared/gameAssets.js`、`src/game/BoltboundScene.js` 和 `public/assets/` 添加一次。同步校验会检查配置、SVG、PNG 和两个入口，漏改会直接失败。

## 日常更新

改完游戏后统一执行：

```powershell
npm run build:all
npm run verify:all
```

输出：

- 电脑版网页：`dist/`
- 微信小游戏：`wechat-minigame/`
- 同步指纹：`artifacts/platform-build-manifest.json`

不要分别手工修改 `dist/`、`wechat-minigame/dist/` 或 `wechat-minigame/assets/`。

## 正式发布

同时更新电脑版安装包和微信工程：

```powershell
npm run release:all
```

输出：

- 电脑版安装包：`release/ZaoluRace-Setup.exe`
- 微信小游戏工程：`wechat-minigame/`

微信公众平台对应账号的线上名称必须填写 **Boltbound**。`project.config.json` 的 `projectname` 只是开发者工具本地项目名，不能代替公众平台的名称设置。发布前还需要把 `touristappid` 换成正式 AppID，并配置固定 HTTPS/WSS 合法域名。

## 发布前检查

1. `npm run verify:all` 通过。
2. 电脑版安装包能安装并进入房间。
3. 微信开发者工具能编译 `wechat-minigame/`。
4. 手机真机可创建、加入、断线恢复并完整跑一局。
5. 微信公众平台名称、头像、简介和截图都使用 Boltbound 品牌。
