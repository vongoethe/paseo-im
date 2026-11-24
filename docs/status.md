# paseo-im 当前状态手册（Status Handbook）

> EN summary: all three flagship channels (QQ / Telegram / WeChat) are live-verified and bridged to one agent session. This file is the living handbook — channel states, defect fix index with commit map, no-human acceptance commands, backlog. Pitfall details live in `docs/gotchas.md`.

> 三通道实机在线的活文档：通道状态、缺陷修复索引（commit 对照）、自测/验收命令、待办清单。
> 变更后更新本文件；踩坑细节一律沉淀到 `docs/gotchas.md`，本文只放「是什么/怎么验/还欠什么」。

## Fork 兼容状态（2026-11-24）

| 项目 | 当前状态 | 验证 / 限制 |
| --- | --- | --- |
| Paseo 版本 | `>=0.17.4 <0.18.0`；client / plugin SDK 均固定为 0.17.4 | [GitHub 最新稳定版](https://github.com/getpaseo/paseo/releases/tag/v0.17.4)；双侧 typecheck + 463 测试通过；此版本实机加载与渠道收发待验 |
| 分支维护 | 本地 `stable` 为拟用默认分支，`main` 保持上游同步用途 | GitHub 默认仍为 `main`，未 push、未开启定时同步；步骤见 [fork 维护约定](./fork-maintenance.md) |
| macOS 门禁 | 修复非 macOS 用例的 platform 模拟，以及 Slack / Matrix 测试临时目录清理竞态 | 仅调整测试；未改渠道适配器，见 gotchas §9 |

兼容性修复的本地提交主题：`fix(compat): support Paseo 0.17.4`（通过 `git log --oneline --grep='support Paseo 0.17.4'` 对照）。Agent 参与：autonomous，OpenAI / GPT-6；尚待人工 review。

## 1. 通道状态（实机验收截止 2026-11-08）

| 渠道 | 连接 | 状态 | 绑定去向 | 备注 |
| --- | --- | --- | --- | --- |
| QQ | PaseoImQqBot | ✅ 在线 | 共同对话 agent | 官方 WS 长连接，断线 RESUME；实机收发/去重/准入/去向全通过 |
| Telegram | PaseoImTgBot | ✅ 在线 | 共同对话 agent（共享历史） | IPv6 黑洞修复后长轮询稳定；偶发 fetch failed 为瞬时抖动自动重试 |
| 微信 | PaseoWeChatBot | ✅ 在线 | 共同对话 agent（共享历史） | iLink 扫码配对实机闭环；二维码本地 PNG 生成；仅私聊 |
| 其余 9 渠道 | — | 适配器/单测齐备 | — | 实机联调待凭据，按 `docs/channel-test-matrix.md` K 清单逐渠道验收 |

会话绑定现状（`connections/<id>/state.json` 的 conversations）：QQ/TG/微信 DM 均指向共同对话 agent（target-agent）。修改去向请走 App「连接详情 → 消息去向」保存——save 时自动把跟随旧 agent 的会话绑定迁移/矫正（gotchas §5.8），无需手动清理。

## 2. 缺陷修复索引（实机调试全记录，按主题）

| 主题 | 现象 | 根因 | 细节 |
| --- | --- | --- | --- |
| Telegram 出站全网失败 | 连接报「网络错误」自动重试，同机 curl 正常 | WSL2 双栈域名 IPv6 路由黑洞，node 拨号卡 v6 不回退 v4 | gotchas §5.5 |
| 插件重载丢在途回复 | 重载窗口内的 agent 回复静默丢失 | 内存队列蒸发，job 冻结 dispatch null/sent | gotchas §7 |
| 微信配对无二维码 | 点击扫码配对无响应/白卡 | qrUrl 是 text/html 落地页 + pollLogin 30s 阻塞 + configure 鸡生蛋死锁 | gotchas §5.7 |
| 凭证输入无显示/切换 | 手机端无眼睛按钮 | labelAccessory 仅 web host 渲染 | gotchas §5.6 |
| 改去向不生效 | 换新 agent 后消息仍进旧会话 | 会话绑定压过 target + save 双实例竞态回滚 | gotchas §5.8 |
| 钉钉卡片无令牌（P0） | 整渠道进度流必坏 | 审查发现 | channel-test-matrix |
| P1×10 / P2×30 | 各渠道审查项 | 四组并行深审 | 审查修复提交线（36 文件 +1993/-295） | 同上 |
| 全新安装构建失败（issue #1） | `paseo plugin add` 报 `Could not resolve type dependency "@getpaseo/client"`，侧栏无 IM 入口 | `@getpaseo/client` 只在 devDependencies，`npm ci --omit=dev` 后生产树无包，宿主构建器连 `import type` 也要解析 | gotchas §8 |
| Paseo 0.17 版本拒绝 | 最新稳定宿主 0.17.4 不满足旧 manifest `<0.17.0` | SDK、manifest 与握手版本需成组升级；macOS 基线另有 platform 模拟缺失及测试清理竞态 | gotchas §9；本地提交 `fix(compat): support Paseo 0.17.4` |

## 3. 自测 / 验收命令集（全部无人工可跑）

```sh run
# 全量门禁：双侧 tsc + 全量测试（提交前必跑）
cd "$(git rev-parse --show-toplevel)" && npm run typecheck && npm test
```

```sh run
# 发布形状自检：清单字段 + 生产依赖可解析性（含 @getpaseo/* 导入守卫，issue #1）
cd "$(git rev-parse --show-toplevel)" && npm run check:package
```

```sh run
# 微信扫码配对环回自测（连生产 daemon，无人工）：自动建连复用 + PNG 魔数二维码 + 15s 交付时限 + 孤儿复用
cd "$(git rev-parse --show-toplevel)" && node scripts/verify-pairing.mjs
```

```sh run
# 通道绑定对齐自检：三条连接 im.save 一次（reconcile 会话绑定到 routing 期望值）
cd "$(git rev-parse --show-toplevel)" && timeout 60 node --input-type=module -e "
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import os from 'node:os';
const require_ = createRequire(process.cwd() + '/package.json');
const { DaemonClient } = await import(pathToFileURL(require_.resolve('@getpaseo/client/internal/daemon-client')).href);
const home = process.env.PASEO_HOME ?? `${os.homedir()}/.paseo`;
const lock = JSON.parse(readFileSync(home + '/paseo.pid', 'utf8'));
const client = new DaemonClient({ url: 'ws://127.0.0.1:' + lock.listen.split(':').pop() + '/ws', clientId: 'paseo-im-selftest', clientType: 'cli', appVersion: '0.17.4', connectTimeoutMs: 8000,
  localCredential: () => readFileSync(home + '/local-credential', 'utf8').trim(),
  logger: { debug(){}, info(){}, warn(){}, error(){} } });
await client.connect();
const list = await client.invokePluginRpc('paseo-im', 'im.list', {});
for (const bucket of list.channels) for (const view of bucket.connections) {
  const saved = await client.invokePluginRpc('paseo-im', 'im.save', { id: view.config.id, revision: view.config.revision, target: view.config.target, enabled: view.config.enabled });
  console.log(bucket.channel, 'reconciled');
}
await client.close();
"
```

微信回发观测眼：`sendTextChunk` 成功即打 `sendmessage ok to=… client=… bytes=…`（`paseo plugin logs paseo-im` 数行数）——真实发送次数与微信显示数不一致即为 iLink 平台显示层（gotchas §5.9 四层取证法）。

## 4. 协同分工记录（两 agent + 桥接会话）

- `audit-agent`（已完成并归档）：多角度全量审查线——四组并行深审 11 渠道，1×P0+10×P1+30×P2 全修（审查修复提交线），产出测试矩阵与 54 个回归用例。
- `bridge-agent`（桥接会话，QQ/TG/微信汇合）：实机联调修复线——TG IPv6 黑洞、微信配对三坑、凭证 UI 端差异、改去向 reconcile（§5.5–§5.8）。
- `target-agent`（当前三通道共同去向）：在途回复恢复线——重载孤儿 job 统一重放（§7）、三通道补发验收闭环、微信三连终判。
- 协同事实：两个 agent 在同一 repo 各自提交（审查修复线 / 实机联调修复线 / 重载恢复线三条提交线），互不冲突；本文档为其信息合并产物。

## 5. 待办

1. 其余 9 渠道实机联调（凭据到位后按矩阵 K 清单逐渠道验收；TG/微信/QQ 已闭环）。
2. 微信三连若再现：按 gotchas §5.9 四层取证，`sendmessage ok` 行数为唯一判据，超 1 行先查本链路，1 行则反馈 iLink 平台。
3. ~~`state-store` 测试 tmp 清理竞态（ENOTEMPTY，间歇 1/N）~~ **已根修**（写链 `drain()` 静止模式：`withStore` 先排空 fire-and-forget 持久化再 `rm`；`manager.deactivate` 同步获得排空语义，顺带消除重载截断最后一次 `updateJob` 持久化的窗口。state-store 单文件 30 连跑 + 全量 6 连跑验证）。余下 whatsapp 配对/并行全量的时序 flake 为另一类（负载相关，诊断法见 gotchas §7 附带坑），独立跟踪。2026-11-21 复跑 5 轮补充观测：失败分别为 whatsapp 配对 10ms 断言、`bots-contract` loader 2s 轮询等待、slack harness tmp 清理 ENOTEMPTY；单跑均必过，`/tmp` 已累积数百个 `paseo-*` 测试目录（多轮复跑残留）。判定：与本轮依赖声明改动无关（改动未触及 `tests/`、`server/`，且无测试读取 package.json/manifest）。
4. Telegram 偶发 `fetch failed`（IPv6 修复后残余瞬时抖动）：自动重试已覆盖，若频率上升按 §5.5 排查序列复核宿主 v6 路由。
5. 全新安装修复（issue #1）：本机 0.16.2 已闭环——构建器验证生产树可解析并构建通过，独立 `PASEO_HOME` 实机 `paseo plugin add` 成功、插件 `running`、日志 `Plugin ready`、`im.list` 返回 12 渠道；余 0.15.4 报告者环境、registry 源安装与真实 IM 渠道收发待复验。
