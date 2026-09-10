# 造路狂奔 / Boltbound

一款以道具使用、搭建和陷阱交互为核心的多人联机派对游戏，重点打磨人物与场景、机关之间的互动。当前版本采用选件、搭建、闯关的回合流程，每局进行 5 回合，按累计分数决出胜者；后续开发围绕陷阱与道具的组合体验展开。

电脑版及浏览器版名称为「造路狂奔」，微信小游戏名称为 **Boltbound**。两端共用游戏场景、地图配置、放置规则和房间服务；Windows 安装包是网页游戏的本地服务与启动器，不需要 Steam。

> 本文按当前源码说明功能与限制。网页与手机浏览器可以互相语音；微信原生小游戏使用另一条语音通道，目前不能与浏览器互相通话。共享游戏房间不等于共享语音频道。

仓库中的完整源码位于 [jima/](jima/)。开发、测试和打包命令在该子目录执行；仓库根目录保留本说明与安装包。

## 当前分支的作用

**分支：`feature/multiplayer-sync`**

**联机服务：房间、状态同步与回合管理。** 负责让同一房间的玩家看到一致的搭建、道具使用和陷阱交互结果，并保证回合流转、断线恢复和结算可靠。

### 开发重点

- 维护房间创建与加入、房主权限、人数限制、离开房间和断线重连。
- 同步建造结果、角色运动、道具目标与效果、机关破坏、死亡和结算状态，处理重复请求和过期操作。
- 维护回合阶段、计时、服务端规则校验与语音信令，排查网络延迟和多人状态不一致。
- 配合动画负责人同步人物动作状态、朝向、机关触发事件和时间信息，处理延迟、重连及重复事件造成的动画不同步。

### 主要代码范围

| 文件或目录 | 负责内容 |
| --- | --- |
| [jima/server/index.js](jima/server/index.js) | 房间、Socket.IO 事件、回合、道具与结算 |
| [jima/server/raceValidation.js](jima/server/raceValidation.js) | 运动、传送及终点状态校验 |
| [jima/server/bombLogic.js](jima/server/bombLogic.js) | 爆破范围与零件移除结果 |
| [jima/server/voiceService.js](jima/server/voiceService.js) | 浏览器和微信语音服务 |
| [jima/shared/itemTargets.js](jima/shared/itemTargets.js) | 客户端与服务端共同使用的目标状态判定 |

### 协作边界与交付

新增或修改联机事件时，先与玩法、界面分支对齐字段、触发时机和错误反馈。玩法分支负责交互规则与物理表现，本分支负责相应的服务端校验和同步，双方保持同一套规则。

人物与场景动画的设计和播放表现由 feature/ui-platform 主责。本分支提供一致的状态、触发事件与时间依据，配合验证远端角色和机关动画；逐帧动画由客户端播放，伤害和死亡等有效结果以游戏状态判定为准。

提供涉及的协议或状态变化说明，并运行相关房间、竞速安全与语音协议测试；复现多人问题时记录人数、操作顺序和网络条件。

### 四个协作分支的分工

| 分支 | 主要作用 |
| --- | --- |
| [feature/gameplay-traps](https://github.com/BRONZE084/Boltbound/tree/feature/gameplay-traps) | 核心玩法：搭建、道具与陷阱交互 |
| [feature/multiplayer-sync](https://github.com/BRONZE084/Boltbound/tree/feature/multiplayer-sync) | 联机服务：房间、状态同步与回合管理 |
| [feature/ui-platform](https://github.com/BRONZE084/Boltbound/tree/feature/ui-platform) | 界面、动画与平台：人物和场景动画、操作反馈与多端适配 |
| [chore/testing-integration](https://github.com/BRONZE084/Boltbound/tree/chore/testing-integration) | 测试与整合：问题复现、回归验证和构建 |

`main` 用于接收团队审阅并验证通过的整合结果。以上是各分支的职责约定；下面保留当前版本的玩法、操作和运行说明。

## 目录

- [当前分支的作用](#当前分支的作用)
- [快速开始](#快速开始)
- [玩法与计分](#玩法与计分)
- [操作说明](#操作说明)
- [地图与放置规则](#地图与放置规则)
- [机关与主动道具](#机关与主动道具)
- [设置与声音](#设置与声音)
- [技术架构与目录](#技术架构与目录)
- [服务端配置](#服务端配置)
- [微信小游戏接入](#微信小游戏接入)
- [构建与发布](#构建与发布)
- [测试与验证](#测试与验证)
- [部署与异地联机](#部署与异地联机)
- [常见问题](#常见问题)
- [维护约定与已知边界](#维护约定与已知边界)

## 快速开始

### 直接游玩 Windows 安装版

仓库根目录提供 [ZaoluRace-Setup.exe](ZaoluRace-Setup.exe)；自行打包的输出位于 `jima/release/ZaoluRace-Setup.exe`。安装包包含网页资源、房间服务、Node.js 运行时和公网隧道客户端，无需玩家另装开发环境。

1. 安装后打开桌面的 `Zaolu Race`。
2. 启动器打开本机游戏，并建立异地联机入口。
3. 等启动器显示公网入口就绪，复制当前链接给朋友。
4. 房主创建房间，其他玩家打开同一个入口，输入 5 位房间码加入。
5. 至少 2 人时由房主开始；独自试玩可选择单人练习。

默认安装位置为 `%LOCALAPPDATA%\ZaoluRace`，会创建桌面与开始菜单快捷方式，以及当前用户的卸载项。启动器本地服务地址为 `http://127.0.0.1:32145/`。

主机电脑及游戏服务必须保持运行。公网隧道重新建立后地址可能变化，以启动器当前显示的链接为准。源码仓库不保证附带已生成的安装包，打包方式见[构建与发布](#构建与发布)。

### 从源码开发运行

| 用途 | 环境要求 |
| --- | --- |
| 网页开发与房间服务 | Node.js、npm；安装完整开发依赖 |
| Node.js 版本 | 当前 Vite 依赖要求 `^20.19.0` 或 `>=22.12.0`；不能仅按 `package.json` 的宽泛 `>=20` 判断 |
| 微信素材生成 | Microsoft Edge；非默认位置可设置 `EDGE_PATH` |
| 真实浏览器回归 | Microsoft Edge 和项目声明的 Playwright 开发依赖 |
| Windows 安装包 | Windows、PowerShell、.NET Framework C# 编译器、IExpress，以及已准备好的 cloudflared 文件 |
| 微信预览与发布 | 微信开发者工具；真机与发布还需要正式 AppID 和相应后台配置 |

以下命令均在源码根目录 `jima/` 执行。首次从仓库根目录进入 `jima` 后，后续命令保持在该目录运行。文中的环境变量示例使用 PowerShell。

```powershell
cd jima
node --version
npm --version
npm ci
npm run dev
```

打开 `http://localhost:5173`。`npm run dev` 同时启动两个进程：

| 进程 | 默认地址 | 作用 |
| --- | --- | --- |
| Vite | `http://localhost:5173` | 网页、热更新；代理 `/socket.io` |
| Node.js 房间服务 | `http://localhost:3001` | 房间、回合、道具、语音信令与健康检查 |

也可在两个终端分别执行 `npm run dev:server` 和 `npm run dev:web`。

开发代理固定指向 `127.0.0.1:3001`。若当前终端已有其他 `PORT` 设置，先调整为 `3001`；修改后端端口时，也要同步修改 [vite.config.js](jima/vite.config.js)。前端 `5173` 开启了严格端口检查，被占用时不会自动换端口。

同一局域网可访问 `http://主机局域网IP:5173`，需要网络互通及主机防火墙允许访问。手机不能用自己的 `localhost` 访问电脑。普通局域网 HTTP 可用于玩法调试，但通常不能获取手机浏览器麦克风；语音测试请使用有效 HTTPS 入口。

## 玩法与计分

### 房间与回合

- 联机房间支持 2 至 4 人，使用 5 位房间码。
- 单人练习会加入机器人「扳手阿零」，并自动开始。
- 一局共 5 回合。房主可发起开始及重赛，断线时支持房主迁移。
- 每轮已放置的零件继续留在地图上；炸弹移除的零件不会在下一轮恢复。重赛才重置地图和分数。

| 阶段 | 默认时长 | 规则 |
| --- | --- | --- |
| 选件 | 12 秒 | 每人从自己的 3 个选项中选 1 个；超时选择第一个 |
| 同时建造 | 25 秒 | 选零件的玩家可放置 1 件或跳过；选主动道具则自动装备并完成建造决定 |
| 竞速加载 | 最多 5 秒 | 等待客户端准备好场景 |
| 起跑倒计时 | 2.5 秒 | 倒计时结束后允许竞速与使用道具 |
| 竞速 | 最多 45 秒 | 跑向终点，死亡后本轮不复活 |
| 回合结算 | 5 秒 | 展示本轮结果，进入下一轮或整局结果 |

全员提前选好、建好或加载完成时，相应阶段会提前推进。所有当前在线参赛者及机器人均已完赛或死亡后，竞速可提前结算。建造超时不会替真人自动放置零件。

### 分数

| 结果 | 本轮得分 |
| --- | ---: |
| 完赛，且本轮不止一人完赛 | 2 |
| 本轮唯一完赛者 | 3 |
| 死亡或超时未完赛 | 0 |

到达先后会记录名次，但不按第一、第二、第三名递减给分。5 回合总分最高者获胜，可并列。

## 操作说明

### 竞速操作

| 操作 | 键盘 | 鼠标或触屏 |
| --- | --- | --- |
| 左右移动 | `A` / `D` 或 `←` / `→` | 左右方向按钮 |
| 跳跃 | `W`、`↑` 或空格 | 跳跃按钮 |
| 二段跳 | 起跳后松开，再按一次跳跃 | 起跳后松开，再点一次跳跃 |
| 使用主动道具 | `Q` | 道具使用按钮 |
| 选择攻击目标 | 目标选择期间按 `1` 至 `4` | 点击可选头像或目标列表 |
| 取消目标选择 | `Esc` | 取消按钮 |

每次离地最多有一次额外空中跳跃，蹬墙与二段跳共用这次空中机会。长按跳跃不是自动连续二段跳；快速的两次独立按下会排队逐帧处理。跳跃背包增强跳跃力度，不增加跳跃次数。

### 建造操作

1. 选中本轮分配的零件，移动鼠标或拖动预览调整位置。
2. 使用旋转按钮或空格键，每次旋转 90 度。
3. 在画布内的有效位置松开鼠标或触摸即可提交；也保留勾选确认按钮。
4. 不想放置时点击跳过。本轮选了主动道具则无需放置。

空格在建造阶段用于旋转，在竞速阶段用于跳跃。当前实现不以 `R` 作为建造旋转键。

## 地图与放置规则

### 基础地图

逻辑世界为固定的 `1600 x 900` 单屏地图，相机不跟随人物移动。起点在左上，终点在右下；当前只有三座基础平台，不是五级阶梯，也没有贯穿底部的可站立地板。落入下方空白并越过死亡边界后，本轮失败。

下表坐标为平台中心，尺寸单位为逻辑像素：

| 平台 | 中心坐标 | 宽 x 高 |
| --- | --- | --- |
| 左上起点平台 | `(170, 196)` | `300 x 32` |
| 中间平台 | `(760, 436)` | `340 x 32` |
| 右下终点平台 | `(1440, 676)` | `320 x 32` |

出生基点为 `(80, 142)`，多人按槽位错开。终点区域中心为 `(1510, 595)`。配置来源为 [shared/gameConfig.js](jima/shared/gameConfig.js)；其中 `groundY` 是放置范围相关参数，不代表一块实心地板。

### 为什么某处不能放置

客户端预览与服务端提交共用 [shared/placementRules.js](jima/shared/placementRules.js)。服务端仍会重新校验，不以预览颜色作为最终依据。

- 零件吸附到 20 像素网格，且必须是自己本轮获得的零件。
- 服务端允许的中心范围为 `80 <= x <= 1520`、`160 <= y <= 772`，具体零件还受完整尺寸和作用范围约束。因此地图最上方并不是自由建造区。
- 出生区、终点区、当前阻挡放置的角色，以及已有零件需要保留空间。
- 上轮死亡角色不再阻挡建造；隐藏的尸体不应继续占据放置位置。
- 移动路障检查整段移动轨迹，传送门检查出口；部分机关还检查风力、射线或弹射作用范围，而不只是图标外框。
- 黑洞对出生区、终点区和角色的保护检查使用实体范围，但完整吸引范围仍不能越过地图边界。
- 与基础平台的重叠规则按零件类型区分：横梁、方箱、弹簧、尖刺与其余机关不同，不能简单理解为所有图形重叠都禁止。

遇到红色预览时，可尝试旋转、平移一格或检查完整作用范围。放置判定是有意保留的游戏规则，不是所有空白像素都可放置。

## 机关与主动道具

选件池共有 23 种选项：14 种地图零件、9 种竞速主动道具。名称和参数集中在 [shared/gameConfig.js](jima/shared/gameConfig.js)，以下为当前默认值。

### 14 种地图零件

所有零件均支持 90 度旋转；下表尺寸为未旋转时的逻辑尺寸。

| ID | 名称 | 尺寸 | 作用 |
| --- | --- | --- | --- |
| `beam` | 横梁 | `160 x 40` | 静态实体平台，可用于接路 |
| `crate` | 方箱 | `80 x 80` | 静态实体障碍 |
| `spring` | 弹簧 | `80 x 40` | 从有效接触面沿朝向弹射角色 |
| `spikes` | 尖刺 | `80 x 40` | 接触危险区域死亡 |
| `fan` | 风机 | `80 x 80` | 定向吹风，作用距离 320、宽度 160，远处风力衰减 |
| `barrier` | 移动路障 | `160 x 40` | 往返移动，幅度为中心两侧各 120，周期 2.8 秒 |
| `blackhole` | 黑洞 | `100 x 100` | 半径 190 内吸引，核心半径 34 内致死；不是实体平台 |
| `portal` | 传送门 | `80 x 120` | 按放置顺序两两配对；剩余单门沿自身朝向传送 280 |
| `conveyor` | 传送带 | `160 x 40` | 接触后沿带面方向加速 |
| `ice` | 冰面 | `160 x 40` | 降低水平阻力和加速度，容易滑行 |
| `saw` | 电锯 | `96 x 96` | 接触半径 46 的刀刃区域死亡 |
| `cannon` | 炮台 | `100 x 80` | 射程 640，每 2.6 秒一轮，开火前预警 0.5 秒 |
| `laser` | 激光器 | `80 x 120` | 射程 680，每 3 秒一轮，预警 0.9 秒、激活 0.65 秒 |
| `bumper` | 弹力保险杠 | `96 x 96` | 进入触发范围后从中心向外弹射 |

传送门按 `0-1`、`2-3` 等顺序配对。配对门从另一门的朝向出口离开，传送冷却为 700 毫秒；奇数个门中的最后一扇仍可单独使用。

### 9 种主动道具

每轮装备的主动道具只能成功使用一次，必须在起跑后、自己仍处于竞速状态时使用。

| ID | 名称 | 持续时间 | 作用 |
| --- | --- | --- | --- |
| `turbo` | 涡轮增压 | 7 秒 | 提升自身移动速度与加速度 |
| `jumpjet` | 跳跃背包 | 8 秒 | 增强自身跳跃与蹬墙力度 |
| `shield` | 防护盾 | 3.5 秒 | 清除并抵挡敌方主动道具的负面效果 |
| `grip` | 强力抓地 | 9 秒 | 增强抓地，并克制冰面滑行 |
| `slow` | 减速胶 | 4.5 秒 | 降低指定玩家的移动速度与加速度 |
| `gravity` | 重力锤 | 4.5 秒 | 增加指定玩家的下落重力，并削弱跳跃 |
| `reverse` | 反向器 | 3.5 秒 | 对调指定玩家的左右操作 |
| `fog` | 烟雾罐 | 5 秒 | 遮挡指定玩家周围以外的视野 |
| `bomb` | 爆破炸弹 | 瞬时 | 清除自身周围半径 220 内玩家放置的零件 |

防护盾不是全局无敌：它不抵挡尖刺、电锯、炮弹、激光、黑洞核心或坠落死亡。

重力锤等攻击道具的目标必须是其他在线、未死亡、未完赛的竞速玩家。对方有护盾、已有负面效果或处于效果结束后的 1.5 秒免疫期时，不是有效目标。选择窗口为 6 秒，取消或超时不消费道具；「没有目标」不表示道具未实现。

炸弹以服务端最后认可的角色位置为中心，只拆除玩家放置的零件，包括自己的零件，不炸毁三座基础平台，也不直接伤害玩家。炸中成对传送门的一扇时会连同另一扇移除，避免留下不一致的配对。实现见 [server/bombLogic.js](jima/server/bombLogic.js)。

## 设置与声音

### 游戏设置

设置菜单提供音乐、音效、麦克风、扬声器和画质控制。浏览器还可调语音播放音量，并请求横屏全屏。设置保存在本地，不会随房间同步给其他人；每次重新进入时麦克风仍默认关闭。

| 项目 | 浏览器版 | 微信小游戏 |
| --- | --- | --- |
| 音乐及音效 | 各自开关、音量 | 各自开关、音量 |
| 默认音量 | 音乐 45%，音效 75% | 音乐 45%，音效 75% |
| 麦克风 / 扬声器 | 默认关麦、开扬声器 | 默认关麦、开扬声器 |
| 语音音量 | 独立音量，默认 80% | 使用原生语音及设备音量 |
| 性能画质 | `1200 x 675` | `960 x 540` |
| 平衡画质 | `1600 x 900`，默认 | `1280 x 720`，默认 |
| 清晰画质 | `2000 x 1125` | `1600 x 900` |

画质改变渲染分辨率，不改变地图的 `1600 x 900` 逻辑尺寸、物理参数或可见路线。

手机浏览器优先尝试系统横屏与全屏；不支持旋转接口时使用兼容横屏。兼容模式只是旋转页面呈现，不会更改 Android 的系统旋转锁定设置。微信小游戏工程本身配置为横屏。

### 背景音乐与音效

项目包含一首循环背景音乐和 13 类游戏音效，由 [scripts/generate-audio-assets.mjs](jima/scripts/generate-audio-assets.mjs) 生成 WAV，资源清单见 [shared/audioAssets.js](jima/shared/audioAssets.js)。

```powershell
npm run generate:audio
npm run test:audio
```

浏览器或小游戏可能要求先发生一次点击、触摸等用户操作才能播放声音。音乐、音效和语音是独立通道：打开麦克风不等于打开背景音乐，关闭背景音乐也不会关闭队友语音。

### 语音互通与说话提示

| 组合 | 同房游戏 | 直接语音互通 |
| --- | --- | --- |
| 电脑浏览器与手机浏览器 | 支持，连接同一房间服务 | 支持，均使用浏览器 WebRTC |
| 两个微信小游戏客户端 | 支持 | 原生语音配置完成后支持 |
| 浏览器与微信小游戏 | 支持，连接同一房间服务 | 当前不支持，两套语音频道独立 |

浏览器语音使用实际音频轨道分析自己及队友的活动强度，语音栏和房间列表、比赛比分头像处可显示说话状态。活动条是相对强度提示，不是校准后的分贝仪。

微信原生回调只提供当前发言成员，不提供连续音量数值。客户端通过受房间约束的服务端映射获得对应 `playerId`，从而在自己与队友头像处显示二值的「正在说话」状态，不伪造音量百分比或分贝。隐藏、断线、离开及语音中断后会清理活动状态，不自动重开麦克风。

如需浏览器与微信小游戏跨通道通话，需要将两端接入统一且支持这两个环境的 RTC 方案；仅更换房间码、域名或 TURN 配置不能实现。配置细节见[实时语音部署](jima/docs/VOICE.md)。

## 技术架构与目录

### 技术栈与职责

| 层 | 技术与职责 |
| --- | --- |
| 游戏场景 | Phaser 3 Arcade Physics；本地角色物理、输入、机关、碰撞和渲染 |
| 浏览器界面 | JavaScript ES Modules、HTML、CSS、Lucide 图标 |
| 构建 | Vite；微信输出单个 IIFE bundle |
| 房间服务 | Node.js、Express 5、Socket.IO 4；阶段、计时、选件、建造、道具、分数与重连 |
| 共享逻辑 | 地图、零件参数、放置规则、目标选择、音频及美术清单 |
| 浏览器语音 | WebRTC；服务端提供同房信令与限时 TURN 凭证 |
| 微信适配 | 原生 Canvas、`wx.*`、Socket.IO 协议传输适配、原生 VoIP |
| Windows 分发 | C# 启动器、PowerShell 安装脚本、随包 Node.js 与 cloudflared |

客户端约每 50 毫秒上报运动，其他玩家通过插值显示，角色之间没有实体碰撞。服务端对位移时间、运动预算、传送出口和终点进行校验，必要时发送位置纠正，但不完整重演 Phaser 物理及所有机关碰撞。

房间数据保存在进程内存中，没有数据库持久化。默认断线恢复宽限为 120 秒，使用恢复令牌续接；服务器重启会丢失房间，不能靠房间码找回旧对局。

### 主要目录

```text
jima/
  index.html                 浏览器页面与设置面板
  package.json               依赖、开发、构建和测试命令
  package-lock.json          依赖锁文件
  vite.config.js             网页构建和开发代理
  vite.wechat.config.js      微信 IIFE 构建
  shared/                    两端共享配置、放置规则、资源清单
  server/                    房间、竞速校验、炸弹与语音服务
  src/
    main.js                  浏览器入口及界面状态
    style.css                浏览器布局与响应式样式
    game/BoltboundScene.js   共用游戏场景
    audio/                   共用音频逻辑与浏览器音频后端
    orientation/             浏览器横屏与兼容模式
    settings/                浏览器设置存储和画质档位
    voice/                   浏览器 WebRTC 适配器
    wechat/                  微信入口、UI、网络、设置和语音适配
  public/assets/             SVG 美术源文件及音频资源
  wechat-minigame/           可导入开发者工具的小游戏工程
  installer/                Windows 启动器、安装和卸载脚本
  scripts/                  构建、校验、回归测试和联机脚本
  docs/                     平台同步及语音专项文档
  dist/                     生成的浏览器生产构建
  release/                  生成的 Windows 安装包
  artifacts/                生成的构建指纹等校验资料
  output/                   测试与调试输出
  .runtime/                 本机隧道程序、运行状态和日志
```

重点入口：[游戏配置](jima/shared/gameConfig.js)、[放置规则](jima/shared/placementRules.js)、[游戏场景](jima/src/game/BoltboundScene.js)、[房间服务](jima/server/index.js)、[竞速校验](jima/server/raceValidation.js)、[语音服务](jima/server/voiceService.js)。

## 服务端配置

服务读取进程环境变量；当前没有自动加载 `.env` 的依赖或代码。仅创建 `.env` 文件不会生效，请在启动前通过终端或服务管理器注入配置。配置变更后需要重启相关服务，重启也会清空内存房间。

### 基础配置

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | 监听地址；只允许本机访问可设为 `127.0.0.1` |
| `PORT` | `3001` | Node 服务端口；`npm run online` 默认另用 `3000` |
| `GAME_TIMERS` | 未设置 | 设为 `short` 会启用测试用短回合，不用于正常游戏 |
| `NODE_ENV` | 未设置 | 测试脚本会设为 `test`；部署可设为 `production` |
| `GAME_TEST_DRAFT_CHOICES` | 未设置 | 仅 `NODE_ENV=test` 时用于固定选件，逗号分隔的有效 ID |

正常生产启动示例：

```powershell
npm ci
npm run build:desktop
$env:NODE_ENV = 'production'
$env:HOST = '0.0.0.0'
$env:PORT = '3000'
npm start
```

打开 `http://localhost:3000`，健康检查为 `http://localhost:3000/health`。必须先构建再启动：服务仅在启动时发现 `dist/index.html` 才挂载网页静态资源。

### 浏览器语音

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `VOICE_WEB_ENABLED` | `true` | 浏览器语音开关，`0` / `false` / `off` / `no` 关闭 |
| `VOICE_STUN_URLS` | `stun:stun.cloudflare.com:3478` | 多个地址以逗号分隔 |
| `VOICE_TURN_URLS` | 空 | TURN 地址，可逗号分隔 |
| `VOICE_TURN_SECRET` | 空 | 服务端保存的 coturn REST 共享密钥 |
| `VOICE_TURN_TTL_SECONDS` | `3600` | 临时凭证有效期，限制在 `300` 至 `86400` 秒 |

只有 TURN 地址与密钥同时有效时才启用 TURN。示例中的域名和密钥是占位符，必须替换为自己的服务配置：

```powershell
$env:VOICE_WEB_ENABLED = 'true'
$env:VOICE_STUN_URLS = 'stun:stun.cloudflare.com:3478'
$env:VOICE_TURN_URLS = 'turns:turn.example.com:5349'
$env:VOICE_TURN_SECRET = 'replace-with-your-server-only-secret'
$env:VOICE_TURN_TTL_SECONDS = '3600'
npm start
```

TURN 服务器需启用 coturn REST `use-auth-secret`，其 `static-auth-secret` 与 `VOICE_TURN_SECRET` 一致。游戏向已绑定房间的玩家签发限时 HMAC-SHA1 凭证，不向前端发送管理密钥；旧的静态 `VOICE_TURN_USERNAME` / `VOICE_TURN_CREDENTIAL` 不受支持。

没有 TURN 时会提示 `无TURN`，部分网络仍可直连，但不保证跨运营商、复杂 NAT 或企业网可通话。公网浏览器语音使用 HTTPS/WSS；网页能打开、房间能连接并不代表 WebRTC 音频网络也畅通。

### 微信原生语音

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `WX_MINIGAME_APP_ID` | 空 | 正式小游戏 AppID，需与客户端工程一致 |
| `WX_MINIGAME_SECRET` | 空 | 仅服务端保存的 AppSecret |
| `WX_VOIP_ENABLED` | `false` | 是否启用微信语音 |
| `WX_VOIP_APPROVED` | `false` | 后台实时语音能力已获批准 |
| `WX_VOIP_PRIVACY_CONFIGURED` | `false` | 已完成相应隐私与麦克风用途配置 |

三个开关接受 `true`、`1`、`yes` 或 `on`。这些变量只是告诉服务端配置状态，不会替你申请能力、完成审批或取得用户授权。

```powershell
$env:WX_MINIGAME_APP_ID = 'wx_your_real_app_id'
$env:WX_MINIGAME_SECRET = 'replace-with-your-server-only-app-secret'
$env:WX_VOIP_ENABLED = 'true'
$env:WX_VOIP_APPROVED = 'true'
$env:WX_VOIP_PRIVACY_CONFIGURED = 'true'
npm start
```

服务端用 `wx.login` 临时代码换取会话信息并生成房间语音签名。AppSecret、`session_key` 和 TURN 共享密钥不得放进前端、小游戏 `config.js`、日志或版本库。

## 微信小游戏接入

工程是原生 Canvas **小游戏**，不是普通小程序的 `web-view` 包装。浏览器页面修改与微信 UI 修改有各自入口，不能只修改网页 HTML 就认为微信界面也已更新。

### 构建与本地预览

```powershell
npm run build:wechat
npm run dev:server
```

1. 微信开发者工具导入 `wechat-minigame/`，项目类型选择小游戏。
2. [project.config.json](jima/wechat-minigame/project.config.json) 当前的 `touristappid` 用于本地预览，不可用于正式发布或真实 VoIP。
3. [config.js](jima/wechat-minigame/config.js) 默认 `serverUrl` 为 `http://127.0.0.1:3001`，`socketPath` 为 `/socket.io/`，仅适合电脑上的模拟器。
4. 工程加载顺序为适配器、`config.js`、`dist/game.bundle.js`，由 [game.js](jima/wechat-minigame/game.js) 管理。

构建会生成并同步音频，将 SVG 按需转换为 PNG，校验尺寸和透明背景，并输出单个游戏 bundle。当前资源清单包含 29 张 PNG 和 14 个 WAV；素材调整时以共享清单与构建校验为准。

```powershell
# 仅生成和同步素材，包含图片与音频，不重建游戏 bundle
npm run build:wechat:assets

# 校验已经生成的小游戏工程
npm run check:wechat
```

微信图片转换器支持自定义 Edge 路径：

```powershell
$env:EDGE_PATH = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
npm run build:wechat
```

### 真机与正式发布

1. 使用正式小游戏 AppID 替换 `touristappid`，公众平台上的产品名称使用 `Boltbound`。
2. 将 `config.js` 的 `serverUrl` 改为自己的固定 HTTPS 域名，对应 WebSocket 使用 WSS。
3. 配置后台合法服务器域名、有效证书和可访问的房间服务。
4. 需要语音时完成能力申请、隐私声明、麦克风授权及上面的 `WX_*` 服务端配置。
5. 保持 `voice.enabled: true`；真实设备发布保持 `voice.requireRealDevice: true`。
6. 在真机验证创建房间、加入、断线恢复、横屏、声音、道具及完整一局，再走平台上传和审核流程。

`urlCheck: false` 只是开发者工具调试设置，不能代替真机域名配置。手机上的 `127.0.0.1` 指手机自身，不能连接开发电脑。临时变化的公网隧道域名不适合作为正式发布域名。

详细工程与适配器说明见 [wechat-minigame/README.md](jima/wechat-minigame/README.md)。

## 构建与发布

### 常用命令

| 命令 | 行为与输出 |
| --- | --- |
| `npm run build` | 等同于 `build:desktop`，只构建浏览器 `dist/` |
| `npm run build:desktop` | Vite 浏览器生产构建 |
| `npm run build:wechat` | 同步小游戏资源并构建 `wechat-minigame/dist/game.bundle.js` |
| `npm run build:all` | 生成音频、执行 `check:all`、构建两端、写入同步指纹 |
| `npm run release:wechat` | 当前等同于 `build:all`；不自动上传微信后台 |
| `npm run release:desktop` | Windows 安装包脚本；内部也会执行 `build:all` |
| `npm run release:all` | 双端构建、二段跳及语音浏览器回归、Windows 打包、最终双端校验 |
| `npm run verify:all` | 检查源码、小游戏产物和构建指纹一致性；不负责重建过期产物 |

日常修改共用逻辑后：

```powershell
npm run build:all
npm run verify:all
```

正式生成两端交付物：

```powershell
npm run release:all
```

| 主要产物 | 用途 |
| --- | --- |
| `dist/` | 浏览器生产网页，由 Node 服务托管 |
| `wechat-minigame/` | 导入微信开发者工具的完整工程 |
| `release/ZaoluRace-Setup.exe` | Windows 安装包 |
| `artifacts/platform-build-manifest.json` | 双平台源码与产物同步指纹 |

### Windows 打包前提

[scripts/build-installer.ps1](jima/scripts/build-installer.ps1) 依赖 Windows 的 C# 编译器及 IExpress，并从当前环境复制 `node.exe`。它还要求 `.runtime/cloudflared-windows-amd64.exe` 已存在且 SHA-256 与脚本固定值一致；脚本不会自动下载该文件。

打包会暂存 `server/`、`shared/`、`dist/`，通过 `npm ci --omit=dev --ignore-scripts` 安装生产依赖，再打入运行时和启动器。因此打包机器需要可用的 npm 缓存或网络，接收安装包的玩家不需要自行执行 npm。

> `release/` 是构建产物专用目录。当前安装包脚本在成功发布新安装包后，会删除该目录中的其他所有条目；请勿在这里存放人工资料或需要保留的旧版本。`.installer-build/` 也会被重建，并在成功后默认清理。

需要保留打包中间目录用于调试时，可直接给脚本传 `-KeepWorkDirectory`。安装包只是分发形式，不是 Electron 客户端，不会自动把服务部署到云主机，也不会替你完成微信上传审核。

平台同步约定见 [docs/PLATFORM_SYNC.md](jima/docs/PLATFORM_SYNC.md)。

## 测试与验证

| 命令 | 主要覆盖 |
| --- | --- |
| `npm run check` | 共享、服务端和客户端 JavaScript 语法 |
| `npm run test:placement` | 放置安全规则、黑洞边界、死亡角色不阻挡建造 |
| `npm run test:race-security` | 炸弹逻辑、运动与终点校验、竞速协议 |
| `npm run test:voice` | 两端语音适配器、真实房间信令协议、微信发言者映射及异常回调处理 |
| `npm run test:settings-targets` | 道具目标、设置状态及 HUD 布局约束 |
| `npm run test:audio` | WAV 资源、音频状态、两端设置与布局 |
| `npm run test:scene` | 横屏模式、远端角色平滑、场景交互 |
| `npm run check:all` | 上述源码检查与测试，再做源码级平台同步校验 |
| `npm run check:wechat` | 小游戏壳、资源与 bundle 校验 |
| `npm run test:double-jump:browser` | Edge 中的键盘及触屏二段跳回归 |
| `npm run test:voice:browser` | Edge 中的双客户端语音、强度提示、自动播放恢复及移动布局回归 |
| `npm run verify:all` | 源码检查、小游戏检查、已有双端构建指纹检查 |

`check:all` 和 `verify:all` 不包含两个真实浏览器回归；`release:all` 包含。单独执行真实浏览器测试时，先生成最新网页：

```powershell
npm run build:desktop
npm run test:double-jump:browser
npm run test:voice:browser
```

这两个脚本自行启动本地测试服务和无头 Edge，不要求连接现有线上房间。语音浏览器回归使用模拟麦克风音频，不需要真实麦克风。浏览器测试通过 Playwright 的 `msedge` 通道启动，和图片转换器不同，不读取 `EDGE_PATH`。

二段跳回归默认使用 `32264` 端口；指定独立构建目录进行检查时还会使用 `32265`，执行前应确保所需端口空闲。语音浏览器回归选择空闲本地端口。

`test:voice` 包含真实本地房间服务的协议测试，但不是实际微信设备 VoIP 通话测试。自动化通过不能代替 Android、iOS、不同运营商网络及正式微信 AppID 的真机验收。

## 部署与异地联机

### 自有 Node.js 主机

网页和 Socket.IO 由同一个 Node 进程提供。部署时至少需要 `package.json`、锁文件、`server/`、`shared/`、已生成的 `dist/` 及生产依赖；不要只上传静态网页就期待房间服务能运行。

运行主机可安装生产依赖后启动：

```powershell
npm ci --omit=dev
$env:NODE_ENV = 'production'
$env:PORT = '3000'
npm start
```

上面的流程假设已经从构建机器部署了 `dist/`。仅安装生产依赖后不能在该目录直接运行 Vite 构建。

反向代理应将网页和 `/socket.io/` 转发到同一个房间服务，并支持 WebSocket 升级及长连接。公网语音入口使用有效 HTTPS/WSS；根据网络情况部署 TURN。健康检查可请求：

```powershell
Invoke-RestMethod http://localhost:3000/health
```

正常响应包含 `ok`、`app`、`rooms` 和 `now`。`ok: true` 只能说明 Node HTTP 服务可用，不代表公网隧道、麦克风或 TURN 已验证正常。

`vite preview` 仅用于构建预览，会继承当前开发配置中的房间代理，但仍需另行启动 `3001` 端口的房间服务。正式部署使用上述 Node 服务，不以预览服务器代替生产服务。

### 本地临时公网入口

已准备 `.runtime/cloudflared-windows-amd64.exe` 时，可使用 Windows 常驻脚本：

```powershell
npm run build:desktop
npm run online
```

`npm run online` 默认管理 `3000` 端口的房间服务及临时 Cloudflare 隧道。它不下载 cloudflared，也不执行网页构建。端口有其他用途时，直接指定一个空闲端口：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/keep-online-cloudflare.ps1 -Port 3002
```

终端出现 `Public URL: https://...trycloudflare.com` 后使用当前地址，也可在另一个终端读取：

```powershell
Get-Content .runtime/public-url.txt
```

所有玩家必须连接同一台房间服务。两个各自独立运行的安装版服务不会仅凭相同房间码自动互联。

脚本会周期检查本机服务和隧道状态，但不是已注册的 Windows 系统服务。保持终端、主机和网络运行；隧道重启可能更换域名，旧页面需要重新打开当前入口。浏览器 HTTPS 临时入口适合试玩，不等于稳定的正式发布域名。

| 日志与状态位置 | 内容 |
| --- | --- |
| `.runtime/public-url.txt` | 当前临时公网地址 |
| `.runtime/online-supervisor.pid` | 常驻脚本进程标识 |
| `.runtime/server.stdout.log` / `.runtime/server.stderr.log` | 房间服务输出与错误 |
| `.runtime/tunnel.stdout.log` / `.runtime/tunnel.stderr.log` | 隧道输出与错误 |

以上路径属于源码版 `online` 脚本；安装版的状态以启动器为准。不要将临时 URL、PID 或日志作为源码配置提交。

## 常见问题

### 页面能打开，但创建或加入房间失败

先检查 `/health` 和浏览器里的 Socket.IO 连接。开发模式确认后端在 `3001`，生产模式确认同源 `/socket.io/` 能转发。所有人需要使用同一个服务入口；房间数据不会跨服务器共享，重启服务器后旧房间码失效。

### 听不到背景音乐或音效

先点一次页面或触屏按钮，检查设置里的音乐、音效开关及各自音量，再检查系统和浏览器标签页是否静音。确认已生成并构建音频资源；只打开扬声器语音按钮不会修复缺失的音乐文件。

### 麦克风开了，但队友听不到

确认系统授权、浏览器授权、麦克风输入设备及对方扬声器都正常，并看自己的活动条是否响应。手机访问普通 HTTP 局域网地址时可能无法录音，改用有效 HTTPS。出现 `无TURN` 且跨网络不通时，检查 TURN 配置；HTTPS 隧道不会自动提供 TURN 中继。

断线、切后台或重新加入后，需要再次明确开启语音。浏览器和微信原生小游戏不能跨通道互相听见，这不是音量设置问题。

### 为什么自己或队友头像没有显示说话

先确认对方已进入语音并开麦，有实际音频活动。浏览器按真实音频轨道显示强度；微信按原生发言回调及同房身份映射显示说话状态，不显示精确音量。机器人没有真人麦克风活动，静音、离线或未加入语音也不应显示正在说话。

### Android 手机不能旋转

点击进入横屏或设置中的横屏全屏。系统或内置浏览器拒绝旋转时会进入兼容横屏，可重试系统横屏或退出兼容模式。兼容模式不能解除手机系统的旋转锁；建议同时检查系统自动旋转设置，并尝试独立浏览器。

### 二段跳没有触发

需要两次独立的按下，中间松开跳跃键或触屏按钮。需要仍处在竞速阶段；死亡、回合结束或打开阻断操作的界面时不会跳。完赛后在本轮竞速结束前仍能移动和跳跃，但不能再次使用主动道具。一次离地只有一次额外空中机会，蹬墙消耗后不能再额外跳一次。确认页面已刷新到最新构建。

### 重力锤显示没有目标

起跑前不可使用。起跑后，只有其他在线且仍在竞速的玩家可选；死亡、完赛、护盾、已有负面状态或短暂免疫都会使目标不可选。等待有效目标出现，不需要先把重力锤放到地图上。

### 明明空着，为什么放置预览还是红色

检查的是完整放置规则，可能包括地图上边界、保护区、活动轨迹、传送出口或作用范围，不只看零件图片有没有压住东西。上轮尸体不阻挡，但活着的角色和已有机关仍可能阻挡。先旋转或移动一格；详细规则见[地图与放置规则](#地图与放置规则)。

### 护盾为什么挡不住机关，炸弹为什么不炸平台

护盾只抵挡主动道具负面效果，不是碰撞无敌。炸弹只移除玩家放置的零件，三座基础平台和玩家角色不在其破坏范围内，这是当前道具设计。

### 看其他玩家卡顿或突然被纠正位置

先区分本地帧率和网络抖动：自己的移动也卡时降低画质；仅其他玩家卡时检查网络、主机负载与隧道稳定性。远端角色采用插值，但无法消除严重丢包；服务端运动校验触发时也可能纠正角色位置。

### 微信构建失败、Edge 找不到或双端指纹不一致

确认已安装完整开发依赖。素材转换失败时检查 Microsoft Edge 与 `EDGE_PATH`；浏览器回归则需要能通过 `msedge` 通道找到 Edge。若只是产物过期，运行 `npm run build:all` 后再执行 `npm run verify:all`，不要手改指纹文件或生成的 bundle。

## 维护约定与已知边界

### 修改入口

| 需求 | 优先修改位置 |
| --- | --- |
| 地图、回合常量、道具参数 | `shared/gameConfig.js`；部分阶段时长在 `server/index.js` |
| 放置范围、保护区、传送门关系 | `shared/placementRules.js`，同步补放置回归 |
| 角色物理、机关交互、插值与输入 | `src/game/BoltboundScene.js` |
| 房间协议、计分、道具应用 | `server/index.js`，相关 `server/*.test.js` |
| 炸弹破坏规则 | `server/bombLogic.js` 及其测试 |
| 浏览器界面 | `index.html`、`src/main.js`、`src/style.css` |
| 微信界面或原生行为 | `src/wechat/` |
| 麦克风、说话提示、语音协议 | `src/voice/`、`src/wechat/WechatVoiceChat.js`、`server/voiceService.js` |
| 音频 | `shared/audioAssets.js`、`shared/audioSettings.js`、`src/audio/` 及生成脚本 |
| 美术 | `public/assets/*.svg` 和 `shared/gameAssets.js`，微信 PNG 由构建生成 |

共用逻辑只维护一份，不复制到平台目录。不要直接修改 `dist/`、`wechat-minigame/dist/`、生成的 PNG/WAV 或构建指纹；应修改来源再构建。涉及网页和微信 UI 时分别检查两端，不要只验证一个入口。

当前边界：

- 房间在单进程内存中，没有账号系统、数据库存档或跨服务器房间目录；多实例部署需要另行设计共享状态和路由。
- 服务端有运动及协议校验，但不是完整服务端权威物理。机关碰撞和死亡主要由客户端处理，不应将它视为已经完成竞技级反作弊。
- 练习机器人沿基础平台预设路线移动，不具备完整玩家物理及动态机关避障能力。
- 微信与浏览器的语音通道尚未统一，原生接口真实可用性需通过正式账号和真机验证。
- 临时公网隧道依赖主机在线及外部网络，不提供固定地址或长期可用性保证。

### 文档与许可

- [双平台同步规则](jima/docs/PLATFORM_SYNC.md)
- [实时语音部署](jima/docs/VOICE.md)
- [微信小游戏工程说明](jima/wechat-minigame/README.md)
- [微信适配器许可证](jima/wechat-minigame/LICENSE)

`wechat-minigame/LICENSE` 对应所附适配器来源的 MIT 许可，不代表整个游戏自动采用 MIT 许可。项目当前 `package.json` 标记为 `private: true`，根目录没有统一开源许可证；对外分发或二次使用前应明确游戏代码、美术、音频和第三方依赖的授权范围。
