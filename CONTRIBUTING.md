# 贡献指南（CONTRIBUTING）

感谢参与 paseo-im 共建。本项目是 [Paseo](https://paseo.sh) 的 IM 桥接插件，把 12 个 IM 渠道接入 Paseo agent。人类与 agent 贡献者同样欢迎（agent 约定见 [AGENTS.md](./AGENTS.md)）。

## 环境搭建

- Node ≥ 22.18（项目使用 strip-only 直跑 TS）
- `npm install`
- 本地 Paseo daemon（`paseo daemon status` 可达）；实机联调需要对应渠道凭据

## 门禁（每个 PR 必须全绿）

```sh
npm run typecheck   # 双侧 tsc（server + client）
npm test            # 全量测试（node --test）
node scripts/check-redaction.mjs   # 脱敏守卫（不得含真实 ID/本机路径）
```

建议：改动涉及运行时行为时双跑 `npm test` 两次（存在间歇性 tmp 清理竞态，见 gotchas §5.7 附坑）。

## 分支与提交

- 本 fork 的日常特性分支从 `stable` 拉出；`main` 保留为上游同步分支。维护与升级步骤见 [fork 维护约定](./docs/fork-maintenance.md)。commit 遵循 Conventional Commits（`fix:` / `feat:` / `test:` / `docs:` / `chore:`），主题行可用中文，须说清「改了什么 + 为什么」。
- 实机 bug 修复必须三件套：代码 + 回归测试 + `docs/gotchas.md` 对应节沉淀（现象/根因/修复/验证）。
- 修复索引同步：`docs/status.md` 第 2 节加一行（现象/根因/commit/细节指向）。

## PR 检查清单

- [ ] 门禁三条命令全绿
- [ ] 新增渠道/渠道行为变更：更新 `docs/channel-test-matrix.md` 对应项
- [ ] 实机验收记录写入 `docs/webui-acceptance.md`
- [ ] 文档/示例不含真实 ID、本机绝对路径（守卫会拦，但请自查语义）
- [ ] 状态与索引已同步（status.md / gotchas.md）
- [ ] **agent 参与披露**（强制，格式见 PR 模板）：无 / assisted / autonomous+reviewed，并注明模型（provider/model）

## 实机验收（新渠道）

无凭据阶段：按 `docs/channel-test-matrix.md` 该渠道清单穷举可测项并落测试。凭据到位后：按矩阵「K 实机联调」逐项验收，记录到 `docs/webui-acceptance.md`（对照 QQ/TG/微信既有格式）。失败诊断沿用 `docs/gotchas.md` §6 工作法。

## 维护约定（committer）

- `docs/status.md` 是当前状态活文档：每次合并涉及通道状态/新增缺陷修复的 PR 后更新状态表与修复索引。
- 面向开源者的命令/路径一律用 `$HOME` / `$PASEO_HOME` / `git rev-parse --show-toplevel` 等通用形式，不写贡献者本机路径。
- 发布（squash 到公开仓库）前：全门禁 + `check-redaction` 清零 + `docs/plan.md` 不带入。

## 行为准则

参与即视为同意 [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)。
