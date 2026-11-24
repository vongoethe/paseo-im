# paseo-im

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
![Channels](https://img.shields.io/badge/IM%20channels-12-blue)
![Platform](https://img.shields.io/badge/platform-Paseo-green)

把 12 个 IM 渠道接入 Paseo agent：飞书、微信、钉钉、企业微信智能机器人、企业微信自建应用、QQ、Slack、Telegram、Discord、WhatsApp、iMessage、Matrix。IM 消息进来 → 桥接到绑定的 Paseo agent → 回复以渠道原生形态送回（编辑消息 / 流式卡片 / typing / 分段文本）。

[English](./README.en.md)

参考实现：[dsh-im](https://github.com/xmanrui/dsh-im)（渠道协议事实来源，MIT）与 [paseo-telegram](https://github.com/Daaaaave/paseo-telegram)（插件组织形式模板，MIT）。

## 实机状态

| 渠道 | 状态 | 说明 |
| --- | --- | --- |
| QQ | ✅ 实机验收 | 官方 WS 长连接，断线 RESUME |
| Telegram | ✅ 实机验收 | 长轮询稳定，共享历史会话 |
| 微信 | ✅ 实机验收 | iLink 扫码配对闭环，仅私聊 |
| 其余 9 渠道 | 适配器 + 单测齐备 | 实机联调待凭据 |

通道状态/缺陷修复索引/无人工验收命令集：[docs/status.md](./docs/status.md)。

## 安装

本 fork 面向 Paseo **0.17.3 至 0.17.x**（daemon 和 App 均需满足），两个 SDK 固定为 0.17.3。`stable` 为默认分支，`main` 跟踪上游；升级流程与发布状态见 [fork 维护约定](./docs/fork-maintenance.md)。

```sh
paseo plugin add git:vongoethe/paseo-im
# 或安装本地开发目录：
paseo plugin add /absolute/path/to/paseo-im
```

或从 npm / GitHub 安装（发布为 TS 源码，安装时 `npm ci --omit=dev --ignore-scripts`）。安装后侧栏出现 **IM** 入口。

## 接入渠道

| 渠道 | 凭据 | 进度展示 | 备注 |
| --- | --- | --- | --- |
| Telegram | @BotFather Bot Token | 编辑同一条消息 + typing | 私聊直答、群聊 @/回复触发；topic 支持原生线程 |
| Slack | Bot Token (xoxb) + App Token (xapp)，需 Socket Mode | 原生流式消息 | 需 `connections:write` 等 scope |
| Discord | Developer Portal Bot Token | 编辑消息 + typing | 需开启 Message Content Intent；群首条 @ 自动建线程 |
| 飞书 | App ID + App Secret（feishu/lark 域） | cardkit 流式卡（无权限时降级直发） | 需 `im:message` 读取与 `im:resource` 上传权限 |
| 钉钉 | Client ID + Client Secret | AI Card 流式 | 需开通机器人能力；sessionWebhook 过期自动回退机器人接口 |
| QQ | AppID + AppSecret | typing | markdown 被拒自动回退纯文本；受被动回复窗口限制 |
| 企业微信（智能机器人） | Bot ID + Secret 或扫码配对 | 官方流式回复 replyStream | — |
| 企业微信自建应用 | corpId / agentId / secret / token / AESKey | 加密应答 + 主动发送 | **需要公网可达的回调基址** |
| WhatsApp | 扫码配对（Baileys 多设备协议） | 编辑消息 + composing + 已读 | 非官方协议，存在封号风险；默认自聊模式可在策略中放宽 |
| 微信 | 扫码登录 + 配对码（iLink 机器人 API） | typing（sendtyping） | 仅私聊；未公开接口，稳定性风险 |
| iMessage | 无凭据（macOS 权限） | 直接最终回复 | 仅 macOS daemon：完全磁盘访问 + Messages 自动化；Linux 显示不支持 |
| Matrix | homeserver + accessToken 或密码 | m.replace 编辑 + typing | E2EE 暂不支持 |

## 消息去向

每个连接选择默认去向，并可按会话覆盖：

- **已有 Paseo 聊天**：消息进同一 agent 与历史（可显式开启多会话共享）。
- **工作区**：每个 IM 会话在工作区新建独立 agent（提供方/模型/模式/思考等级/系统提示词可定制）。

## 访问与安全

- 私聊：所有人 或 名单用户（用户 ID 名单，按渠道 sender id 形态）。
- 群聊触发：@/回复 或 全部消息；请求权限：名单 / 群管理员 / 全员。
- 群接入：自动接入 或 审批后生效（设置页审批、可移出）。
- 机密（token/secret）存 `$PASEO_HOME/plugin-data/paseo-im/secrets/<id>.json`（0600）；连接配置不含机密，写入带乐观锁。
- 派发防重放：每条消息生成确定性 id，恢复后在 agent 时间线回查，绝不重复发送。
- 超时补发：等待超时后任务继续，完成结果补发回原会话（明确失败最多三次，结果不明确不重试）。
- agent 提问（clarification）转发到 IM，回复选项序号即可代答。

## 通用设置

图片输入限制（原图上限/模型单张/总量/张数）、附件保留时长、忙时行为（排队/插话）、结果补发等待窗口。

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/status.md](./docs/status.md) | 当前状态手册：通道状态、缺陷修复索引（commit 对照）、无人工验收命令集、待办 |
| [docs/gotchas.md](./docs/gotchas.md) | 踩坑/经验/调试知识库（九节：运行时约束、协议坑、端差异、取证法、重载恢复） |
| [docs/channel-test-matrix.md](./docs/channel-test-matrix.md) | 12 渠道 × 11 类无凭证可测项穷举矩阵 |
| [docs/design.md](./docs/design.md) | 架构设计 |
| [docs/webui-acceptance.md](./docs/webui-acceptance.md) | WebUI 与实机验收记录 |

## 参与共建

人类与 agent 贡献者同样欢迎：

- [CONTRIBUTING.md](./CONTRIBUTING.md)：环境搭建、门禁、commit 规范、PR 检查清单、维护约定
- [AGENTS.md](./AGENTS.md)：agent 协作者操作约定（门禁铁律 / 边界 / 知识回路 / 协作边界 / 披露）
- [SECURITY.md](./SECURITY.md)：漏洞私下报告渠道
- [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)：行为准则
- agent 参与的 PR 需按模板披露参与程度与模型（Harness Model 格式）

## 开发

```sh
npm install
npm run typecheck   # server + client 两套 tsconfig
npm test            # node --test（Node 22.18+ 原生跑 TS）
npm run check:package
npm run check:runtime
paseo plugin install /absolute/path/to/paseo-im   # 或本地开发 reload
```

目录结构：`server/channels/<channel>/` 每渠道适配器（transport + normalize + send + 配对）；`server/` 桥接引擎（policy/routing/queue/progress/questions/deferred/bridge/manager）；`shared/` 契约（模型/配置/RPC，client+server 共用）；`client/` 设置界面（RN 原语）；`tests/` node:test 单测（全部注入假传输，无真实网络）。

## 许可

MIT，详见 [LICENSE](./LICENSE)。第三方项目归属与依赖协议核对见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。渠道协议事实移植自 xmanrui/dsh-im（MIT），文件头已注明出处。微信/iMessage 通道使用未公开或非官方协议，存在稳定性与账号风险，使用即代表知晓并自行承担。
