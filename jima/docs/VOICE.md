# 实时语音部署

造路狂奔包含两条独立语音通道：电脑版和手机浏览器使用浏览器 WebRTC，微信小游戏使用微信原生 `wx.joinVoIPChat`。电脑与手机浏览器可以互相通话；浏览器与微信原生小游戏不能互相通话，但仍可加入同一个游戏房间。

这不是房间码或 Socket.IO 的限制。微信原生 VoIP 使用 AppID、`groupId` 和微信签名加入微信托管的媒体房间，接口不提供浏览器可消费的音频轨道或 WebRTC 信令。要实现网页与微信小游戏互通，必须让两端改用同一个、明确支持这两个运行环境的 RTC 服务；不能把两套现有通道在客户端直接桥接。

## 电脑版

房间内显示麦克风和扬声器按钮。默认麦克风关闭、扬声器开启，只有玩家主动点击后才申请麦克风权限；断线恢复后不会自动重开语音或麦克风。

浏览器语音在公网部署时必须使用 HTTPS/WSS。默认 STUN 为 `stun:stun.cloudflare.com:3478`，可通过环境变量覆盖：

```text
VOICE_WEB_ENABLED=true
VOICE_STUN_URLS=stun:stun.cloudflare.com:3478
VOICE_TURN_URLS=turns:turn.example.com:5349
VOICE_TURN_SECRET=replace-with-a-server-only-coturn-secret
VOICE_TURN_TTL_SECONDS=3600
```

没有配置 TURN 时界面会明确显示 `无TURN`。STUN 只能帮助直连；对称 NAT、企业网和部分移动网络需要 TURN 才能稳定通话。TURN 服务端需启用 coturn REST `use-auth-secret`，并让 `static-auth-secret` 与 `VOICE_TURN_SECRET` 一致；游戏只向已绑定房间的玩家签发 5 分钟到 24 小时的限时 HMAC-SHA1 凭证，管理密钥不会下发。旧的静态 `VOICE_TURN_USERNAME/VOICE_TURN_CREDENTIAL` 不再接受。

浏览器语音上限为同房 4 人。服务端采用 `join` 预留、媒体成功后 `ready` 的两阶段协议，并校验房间、玩家、会话和信令目标；信令限制按房间内玩家累计，每 10 秒 120 条、单包 24 KiB，重新建立语音会话不会重置该额度。客户端分析本机及接收音频轨道的活动强度，在语音栏、房间列表和比赛比分头像处显示说话状态；相对活动强度不是校准后的分贝值。

## 微信小游戏

微信原生语音默认关闭。上线前需要正式 AppID、在微信后台开通实时语音能力、完成麦克风隐私声明，并在服务端设置：

```text
WX_MINIGAME_APP_ID=wx_your_real_app_id
WX_MINIGAME_SECRET=server-only-app-secret
WX_VOIP_ENABLED=true
WX_VOIP_APPROVED=true
WX_VOIP_PRIVACY_CONFIGURED=true
```

客户端使用 `wx.login` 的临时代码请求凭证。服务端调用微信 `jscode2session`，用返回的 `session_key` 对房间参数做 HMAC-SHA256 签名；AppSecret、`session_key` 和 openid 均不会下发客户端。

微信 `onVoIPChatSpeakersChanged` 回调只提供当前发言成员的 openId 列表，不提供连续音量或麦克风原始音频。客户端将该列表发送给自己的房间服务解析；服务端保存以随机密钥计算的 HMAC 指纹映射，只向请求者返回同房已连接真人的 `playerId`，不把原始 openId 广播给其他玩家。解析请求受房间绑定、长度和频率限制约束。

客户端据此在自己及队友头像处显示二值的正在说话状态，并保留匿名发言人数和语音活动提示，不伪造音量百分比或数值 dB。隐藏、断线、离开和通话中断都会清空活动状态与监听器，过期的映射或加入回调不能恢复旧房间状态。

开发者工具的 `touristappid` 只能显示未配置状态，不能进行真实语音通话。正式语音必须使用已开通能力的正式 AppID 在真机验证。

## 验证

```powershell
npm run test:voice
```

该命令覆盖浏览器和微信适配器 mock、发言人数与玩家身份映射、权限/静音/隐藏/中断清理、HMAC 固定向量、请求过期与限流，并启动真实房间服务执行两客户端 `join -> ready -> signal -> leave` 协议测试。

真实浏览器回归需要先构建网页并安装 Microsoft Edge：

```powershell
npm run build:desktop
npm run test:voice:browser
```

该回归自行启动本地服务，使用模拟麦克风音频检查桌面和移动布局，不需要实体麦克风。自动化通过不能代替正式 AppID、微信真机和不同运营商网络的实际通话验收。完整环境变量与启动示例见[项目 README](../../README.md#服务端配置)；服务不会自动加载 `.env` 文件。
