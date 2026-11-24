# 调试与修复知识库（gotchas）

来源：paseo-im 验收期（2026-11-06/07）真实故障与修复。每条含 现象/根因/修复/验证，可复用于后续渠道联调与本插件维护。
关联：`docs/design.md`（架构）、`docs/plan.md`（验收标准）、`docs/webui-acceptance.md`（验收记录）、QQ 实机闭环修复提交链（按序：验收修复 → 归档轮换幂等键 → updateJob 落盘 → 随机键重建 → 模型 ID 切分 → 入站不预填，详见 docs/status.md 修复索引）。

---

## 1. Paseo daemon 插件包运行时约束 ⭐ 最高频

**现象**：装依赖即崩 `ReferenceError: __dirname is not defined`；或 `createRequire(import.meta.url)` 报 "The argument 'filename' must be a file URL object… Received undefined"。

**根因**：daemon（0.15.2）用 esbuild 把插件 server 入口打成 **CJS**，再经 `wrapCommonJsBundle` 包成 `(function(require){…})` 在普通函数作用域内 eval——`__dirname` / `__filename` / `import.meta` 全部不可用。任何被静态 import 的依赖只要源码引用裸 `__dirname` 就会加载即炸（实测：`@larksuiteoapi/node-sdk` 顶层读自身 package.json；`@whiskeysockets/baileys` 拖进 pino/thread-stream/protobufjs）。

**修复**：重 SDK 走运行时装载（`server/channels/runtime-loader.ts`），specifier 收进运行时字符串（esbuild 保持不透明）：

```ts
const require_ = createRequire(join(dirname(process.argv[1]), "package.json")); // 子进程入口必在插件目录内
export async function loadPackage<T>(name: string): Promise<T> {
  const entry = require_.resolve(name);
  return import(pathToFileURL(entry).href) as T;  // CJS/ESM 通吃
}
```

类型侧用 `import type` + `typeof import("pkg")` 别名（擦除，不影响打包）。ws/marked/entities 等干净包可静态 import。

**其余同族约束**：
- daemon 日志**按行**捕获插件 console 输出——多行 stack 被拆成独立日志条目，取帧要按时间窗抓连续 sequence；跨 RPC 重建的 Error 无 stack（`stack ?? message` 记日志可兜底）。
- `features.webUi.enabled` 属 `restartRequiredPaths`：改了必须 `paseo daemon restart`（会杀掉以该 daemon 为宿主的 agent 会话）。
- 双实例验收：`PASEO_HOME=~/.paseo-webui`（独立 home + 端口 + WebUI 开 + `pluginsEnabled`）起第二 daemon，Playwright headless 对真实 WebUI 断言，不动生产。

## 2. Node 24 strip-only 直跑 TS + zod v4

- **禁 TS 参数属性** `constructor(private readonly x)`（strip-only 不支持）→ 显式字段 + 构造器赋值。
- tsconfig `lib` 需含 **ES2024**（`Promise.withResolvers`）；注意脚本改 tsconfig 会写出重复顶层键（第一个生效）。
- zod v4：`z.string().hex()` 不存在 → regex；顶层 `z.literal(1)` 解析空文档需 `.default(1)`；绕过 `parse` 的内存写会在后续 parse 时炸。
- `.mjs` 文件（非 TS）不能写 `!` 非空断言。

## 3. provider/model 斜杠约定与长列表选择器

**现象**：选完模型显示"未选择"；模型下拉无法滚动，后方选项点不到。

**根因/修复**：
- `config.provider` 约定 `"provider/model…"`，**model 本身可含斜杠**（`omp/acme-inc/model-x`、`omp/other-provider/deep-model-v2`；daemon 解析：首段=provider，其余=model）。拆分只能按**第一个斜杠**（`indexOf('/')` + slice）——`split("/")` 解构两段会截断 model。
- 宿主 SettingsSelect（自适应菜单）选项超出可视高度时**不可滚动**、后方项点不到（菜单背景拦截）。≥5 项的长列表用屏内自绘 `OptionPicker`（`client/route-editor.tsx`：Pressable 行 + maxHeight 260 ScrollView，`nestedScrollEnabled`，web 滚轮/触屏均可滚）；短菜单（<5 项）保留 SettingsSelect。
- choices 必须过滤不可用 provider（`status:"unavailable"`/`models:[]`）——否则用户随机选到不可用项。providers.snapshot：omp=ready+167 模型；models[].id 已含子前缀，choices 直接用。
- providers.snapshot 字段形状：models 元素 `{provider,id,label,thinkingOptions}`、modes `{id,label}`——用运行时探针（node 直连 SDK 打印）核对，勿靠文档猜。

**Playwright 驱动宿主菜单的坑**：菜单选项无 role（`role=menuitem` 计 0）；选项文本与页面文本同名（"默认去向"既是菜单项又是行值），必须 `page.locator('#overlay-root').getByText(...)` 限定作用域；首启向导遮罩（`aria-label="关闭"` ×2 层叠）拦截一切点击——点「跳过设置」文本按钮关闭（waitFor visible → click → waitFor hidden），点 X 层叠不可靠。

## 4. agent 绑定生命周期：幂等键、归档轮换、状态落盘

**现象（QQ 实机）**：绑定 workspace 后每条消息必败"关联的 Paseo 聊天当前不可用。"

**根因链**（三个独立缺陷叠加）：
1. `workspace.agents.create({idempotencyKey})` 的幂等映射**长于 agent 生命**：agent 归档后同 key 创建返回的仍是归档实例（labels 不参与去重；实测同 labels + 新 key → 全新 agent）。
2. 入站 `handle()` 从 conversation 绑定**预填 job.agentId** → `answer()` 里 `if (!job.agentId)` 为假 → **跳过 prepare** → 归档轮换逻辑永远不执行。
3. 归档 agent 的 `refresh()` 返回**空值快照**（archivedAt/status 均 undefined）——判活不能 `!archivedAt` 反推。

**修复**：
- prepare 的 known 分支刷新判死（空快照即死）→ 删 conversation 绑定 → **轮换幂等键**（`…-r<archivedAt.getTime()>`，undefined 时 `-r1`——键稳定，跨重试仍确定）。
- create 返回后**验活**（同判据），死则随机键 `-g<Date.now36>` 重建一次，再失败才报错（`routing.ts` isAlive/retry）。
- `handle()` 不预填 agentId（置 null），prepare 成为唯一解析点。
- `updateJob` 细粒度变更**内存改后立即异步落盘**（`void chain.run(() => atomicWrite(path, state))`）——只改内存会让 dispatch/failure 标记永不写盘，崩溃恢复 receipt 链路失效。

## 5. QQ 渠道专项（实机已验证）

- 传输：QQ 官方 bot WebSocket（`@tencent-connect` 协议自实现），断线 RESUME 会话恢复、4004 鉴权失败停连。
- 回复：c2c 被动回复窗口 60min / 群 5min，msg_id 每条上限 4/5 片，markdown msg_type=2 被拒（40034090）回退纯文本。
- 入站：C2C_MESSAGE_CREATE / GROUP_AT_MESSAGE_CREATE（群 @ 天然 addressed）；msgId seen 环去重落盘重启有效。
- 端到端验收通过记录：`docs/webui-acceptance.md` QQ 节。

## 5.5 出站网络：双栈域名 IPv6 黑洞（WSL2 实机踩坑）

**症状**：连接报「无法连接 XX API（网络错误）」自动重试，但 `curl` 同机直连正常。

**根因链**（api.telegram.org 实测）：
1. 双栈域名（A + AAAA 都有）；本机 WSL2 的 IPv6 路由黑洞——`curl -6` 超时、`curl -4` 秒通。
2. node（v24 实测）按主机名拨号时命中 AAAA：happy-eyeballs 竞速里 v6 SYN 被黑洞吞掉后 ~400ms 内以 ETIMEDOUT **整体失败，不回退 v4**；`fetch(域名)` 必挂。
3. 关键鉴别：`net.connect` 裸 IP v4 秒通、`fetch(https://IP)` TLS 完整走完（报证书名不符是预期）——网络通，只有「域名→选址」坏。

**修复**（`index.server.ts` 引导期，进程级）：

```ts
dns.setDefaultResultOrder("ipv4first");
net.setDefaultAutoSelectFamily(false);
```

只影响解析顺序偏好，仅有 AAAA 的域名仍走 IPv6，无副作用。覆盖所有渠道出站（telegram/slack/matrix 等同理会撞）。

**排查顺序**：`curl -4`/`curl -6` 分家族测 → `node -e net.connect(裸IP)` 与 `fetch(域名)` 对比 → 定位在选址层再改 node 默认，不要先怀疑凭据/库。

## 5.6 插件 UI：labelAccessory 仅 web host 渲染（手机端不可见）⭐ 端差异

**症状**：web 预览正常的「label 旁按钮」，手机 App 同位置什么都不渲染。

**根因**：宿主 `SettingsInput` 把自有 FormTextInput 作为 row children 注入（插件传入的 `children` 被覆盖），唯一可用插槽是 `labelAccessory`——它存在于 web bundle 的行包装器实现里，但**手机端 host 不渲染**，且 SDK 类型从未声明该 prop（依赖它是赌宿主版本）。

**修复**：只用 SDK 公开契约组件拼装（`SettingsInput` + 输入框下方 `Pressable`+`Icon`）。凭证揭示按钮因此从 label 旁移到输入框下方。。**通用规则**：插件 UI 只依赖 `@getpaseo/plugin/client/ui` 的 .d.ts 声明面；未声明即不可依赖，哪怕 web 端实测可见。

## 5.7 微信扫码配对三坑合一（实机全修）

1. **qrUrl 是落地页不是图片**：iLink `get_bot_qrcode` 返回的 `qrcode_img_content` 实为 `liteapp.weixin.qq.com/q/...` 链接（HTTP 200 + `text/html`，1362 字节落地页）。旧 `defaultMakeQr` fetch 该 URL 把整页 HTML base64 成 `data:text/html` 塞给 `<Image>` → 手机端渲染空白、配对永远无码。修复：本地 `qrcode.toDataURL(qrUrl)` 生成标准 PNG（同 WhatsApp 适配器模式，零网络依赖）。
2. **pollLogin 是 30s 长轮询**：在 `poll()` 里同步 `await` 它，首个二维码要 30s 后才交付，且客户端 1s 轮询会在服务端堆几十个并发长轮询。修复：`poll()` 快照化（立即返回当前状态+缓存二维码），pollLogin 转**后台单飞**（同会话永不多飞）；`need_verifycode` 时暂停后台（空转会触发 verify_code_blocked 锁死），`submitVerification` 后恢复。
3. **配对渠道创建表单鸡生蛋死锁**：微信 token 只能由配对产生，但接入表单走 `connectRpc` → `configure({})` 空字段抛「缺少微信登录凭据」→ 创建必败。修复：配对渠道表单直连 `pairingStartRpc`（服务端无 connectionId 时自动建连接，配对成功自动激活回传 connectionId）；表单内嵌二维码直出。

**验证基线**：`scripts/verify-pairing.mjs`（RPC 环回，无人工）：断言自动建连、PNG 魔数级可渲染二维码（曾回归出 HTML 冒充图片）、15s 内交付、重复执行不堆僵尸行（`pairingStart` 复用最近孤儿连接）。

**测试竞态附坑**：会话 `stop()` 必须 `await backgroundLogin` 等后台单飞静止再返回——否则测试清理 `rm` 与幽灵 `persist()` 竞态（`ENOTEMPTY`，间歇 1/N 概率，8 连跑验证修复）。

## 5.8 会话绑定压过 target + save 双实例 StateStore 竞态（实机全修）

**症状 1**：App 里把连接「消息去向」改到新 agent，实际对话仍进旧 agent。
**根因**：`routing.prepare` 的 `conversations[key].agentId`（会话绑定）只要旧 agent 活着就**永远优先于 target**——改连接去向对已绑定会话不生效。

**修复（save 时对齐 reconcile）**：显式保存 target 时把全会话绑定对齐 routing 期望值 `bindings[key]?.kind==='agent' ? bindings[key].agentId : (target.kind==='agent' ? target.agentId : null)`：跟随旧 agent 的绑定随 target 迁移（agent→agent）或解除（agent→workspace）；历史漂移绑定一次性矫正。迁移规则纯函数在 `routing.ts`（`migrateConversationTargets/migrateBindingTargets`，有单测）。

**症状 2（矫正后回滚复发）**：矫正写盘成功，下一条消息又派回旧 agent。
**根因**：矫正用**独立 StateStore 实例**只写盘；运行中 bridge 持有**另一个内存实例**（旧值），其下一次 mutate 把整个 state 文件覆盖回去。
**修复**：矫正必须优先改写 `active.get(id)?.state`（bridge 正在用的实例），连接未运行才 fallback 独立实例（c57355c）。**通用规则**：凡「读改写共享持久状态」，必须先找运行中组件持有的同一实例；独立实例只适用于确认无人持有的场景。

**存量矫正**：修复只覆盖未来 save；历史漂移绑定需显式触发一次 `im.save`（target 传现值即可）——`scripts/verify-pairing.mjs` 的 RPC 环回模式可直接复用。

## 5.9 微信三连显示判定（出站链路干净证明法）

「一条回复微信显示三条」的取证顺序（勿直接怀疑平台）：
1. agent 会话观测（ai-memory `read_session_observations`）：每条入站应恰好一次 user-prompt + 一次 stop；
2. `connections/<id>/state.json`：单 job 单 `answer`、`delivery=done`；
3. `sendTextChunk` mock HTTP 计数：`sendmessage` 恰 1 次（scripts/selftest-weixin-send.ts）；
4. 生产加观测日志 `sendmessage ok client=<id> bytes=<n>`，真实消息后数行数。
四层各 1 次 → 重复在 iLink 平台显示层，拿第 4 步日志可直接反馈平台。`target-agent` 实测终判：出站 1 次 = 微信显示 1 遍（历史三连为旧缺陷时期遗留显示）。

## 6. 调试工作法（本次沉淀的流程）

1. **失败详情优先**：deliver catch 同时打 `error.stack ?? message`（原始）与 `userMessage(error)`（用户文案）两行——原始行给定位，文案行给回显核对。
2. **时间过滤读日志**：daemon.log 条目带 timestamp（UTC），对比最后一次 "Plugin ready" 时间判断消息是否跑在新代码上；`grep | python json` 按时间窗过滤，避免旧行误导。
3. **状态直读**：`$PASEO_HOME/plugin-data/paseo-im/connections/<id>/state.json` 即真相（updateJob 持久化修复后文件≈内存）。
4. **RPC 环回**：CLI/脚本直连 daemon `invokePluginRpc('paseo-im', …)` 验证管理面（见 `docs/webui-acceptance.md` E 节脚本）。
5. **复现优先于猜测**：SDK 调用（create/refresh/send）逐个直连复现拿真实报错，再改代码；跨进程/打包边界的错误会丢 stack，纯靠推理容易走偏。

## 7. 插件重载丢失在途回复（孤儿 job）——实机复现并修复

**现象**：wechat test 3（23:25:14Z 派发）后恰逢 23:26:12Z 插件重载，agent 回复产出（23:33Z）但微信侧**静默丢失**，无任何 投递失败 日志。

**根因**：`deliver` 的在途等待是纯内存态，只有超时（DeferredTimeoutError）后才 `deadlineAt`+`deferred.track`；重载 abort（`signal.aborted`）时 catch **提前 return 不标 failure**，且内存队列（会话级 + agent 级 `agent:${id}` 串行链）整体蒸发——job 冻结在 `delivery:null && failure:null`，dispatch 三形态皆可能：`null`（队列中未起跑，实证 TG `/status` 15:39Z 排在 peer agent 长任务后、`test 3` 23:24Z）、`sending`（打断在标记间隙）、`sent`（已派发未答复，实证 weixin `test 3`）。`sweepDeferred` 只遍历 deferred registry，启动路径无任何孤儿扫描。

**修复**（初版落地，后经 TG test 3 实证扩为统一重放）：`StateStore.resumableJobs()` 选出全部冻结态（`!delivery && !failure && !question`，dispatch 三形态通吃；**每会话只取最新一条**，平局按插入序；`question` 非空 = 等用户回复，排除）；`manager.activate` 在 `adapter.start()` **之前**逐条 `bridge.rerunQueued` 重放完整 deliver 管道——`findDispatch` 按 message_id 幂等去重（`sending` 不会重复派发），`dispatch:null` 且非问题回复的 job 重置 agentId 交 prepare 按当前绑定重解析（归档轮换本就是 prepare 的职责）。

**验证**：重载后日志 `恢复 1 条中断的在途回复。`（weixin/qq 各一）→ 补发走完 `sendmessage ok`（bytes=274，恰好 1 次 HTTP）→ 用户截图确认微信侧恰好显示 1 遍。1 发 = 1 显，出站链路干净；历史「三连显示」若再现即为 iLink 平台显示层。

**附带坑**：并行全量 `npm test` 下 whatsapp 配对测试（二维码→scanned→ok）会时序 flake（10ms 级断言），单独跑必过（HEAD 与改动侧均验证）——判「我的改动弄坏的」之前先单跑该文件。

## 8. 全新安装构建失败：宿主 SDK 被当成 devDependency（issue #1）

**现象**：`paseo plugin add clarephang/im`（或 `github:ClarePhang/paseo-im`）在 server 构建阶段失败，IM 侧栏永不出现：

```
ERROR: [plugin: paseo-plugin-server-runtime-boundary] Could not resolve type dependency
"@getpaseo/client" imported by .../checkout/server/manager.ts
```

报错文件可能落在任一 `server/*.ts`；偶发只在 `manager.ts`，因为那是遍历到的第一个。

**根因**：`@getpaseo/client` 只声明在 `devDependencies`，而 manifest 的安装命令是 `npm ci --omit=dev --ignore-scripts`，生产树里根本没有这个包。宿主构建器（`@getpaseo/server` 的 `compiler-build.js`）有两条约束叠加：

1. `external` 只含宿主注入的 `PLUGIN_SDK_SPECIFIERS`（`@getpaseo/plugin/*`）与 `zod`——`@getpaseo/client` **不在**其中，会被 esbuild 内联，必须先装下来才能解析；
2. boundary 插件对 `import type` 也做**类型依赖解析**（`Could not resolve type dependency`），所以把导入改成 `import type` 并不能绕过。`server/daemon.ts` 还真实调用 `createPaseoApi` / `DaemonClient`，本来就无法擦除。

**修复**：`@getpaseo/client` 移入 `dependencies`（`@getpaseo/plugin` 仍留 devDependencies，它是宿主注入的构建期 SDK）；重新生成 `npm-shrinkwrap.json` 使其为 `dev: false`（连同 `@getpaseo/relay`、`@getpaseo/protocol`）。`scripts/check-package.mjs` 增加守卫：扫描 `index.server.ts`/`server/`/`shared/` 的 `@getpaseo/*` 导入（含 `type`），除宿主注入的 `@getpaseo/plugin` 与擦除的 `@getpaseo/protocol` 类型外，必须在 `dependencies` 中。

**锁文件坑**：`npm install --package-lock-only` 只更新 `npm-shrinkwrap.json`，`package-lock.json` 仍保持旧的 `dev: true`；npm 只认 shrinkwrap，两份共存必然漂移——已删除 `package-lock.json`，发布形态只保留 shrinkwrap。

**验证**（本机 Paseo 0.16.2 内置构建器，隔离副本，无需 daemon）：

```sh run
# 1) 干净副本按 manifest 安装 → 生产树应能解析宿主 SDK
cd "$(git rev-parse --show-toplevel)" && npm run check:package
# 2) 与 daemon 等价的全新安装
T=$(mktemp -d) && git archive HEAD | tar -x -C "$T" && (cd "$T" && npm ci --omit=dev --ignore-scripts && node -e "require.resolve('@getpaseo/client/package.json')")
```

实测结果：修复前干净副本 `node_modules/@getpaseo` 整个不存在，宿主构建器逐字复现上述报错；修复后 `npm ci --omit=dev` 装出 `client`/`protocol`/`relay`，构建通过（server bundle 11.4 MB、client 47 KB），把 bundle 按 daemon 语义包成 `(function(require){…})` 在函数作用域执行可正常 load（未触发 §1 的 `__dirname` 类崩溃），`tsc` 双侧 + 457 测试全绿。实机安装用独立 `PASEO_HOME`+独立端口（`pluginsEnabled=true`）复跑 `paseo plugin add <repo>`：安装成功、状态 `running/enabled`、日志 `[paseo] Plugin ready` 无未捕获异常、RPC `im.list` 返回 12 渠道/`im.choices` 正常。真实 IM 收发与 0.15.4 环境仍待实机补验。

**版本耦合**：`server/daemon.ts` 的 `appVersion` 已与 `@getpaseo/client@0.16.0` 同步（该字符串参与 daemon 的能力门控），升级依赖时需一起改；0.16.2 宿主实测可构建并运行，但握手协议兼容性以实机为准。

## 9. Fork 跟随 Paseo 升级：manifest 上界、SDK 与 macOS 测试门禁

**现象**：2026-11-24 查 GitHub，最新稳定版为 [Paseo 0.17.4](https://github.com/getpaseo/paseo/releases/tag/v0.17.4)，旧 manifest `>=0.16.0 <0.17.0` 会明确拒绝此版本。升级前 macOS 全量测试还暴露 iMessage 的「非 macOS」用例失败，以及 Slack / Matrix 临时目录清理间歇 `ENOTEMPTY`。

**根因**：manifest 的兼容范围独立于插件自身版本；仅升级宿主或创建新 Git 分支不会改变它。SDK 仍为 0.16.0，daemon `appVersion` 与配对脚本声明亦需同步。另一个更新陷阱是 [Git 插件 update](https://paseo.sh/docs/plugins#install-a-published-plugin) 跟随仓库默认 HEAD，初装 `--ref` 不会锁住后续更新。测试失败则来自独立基线问题：iMessage 用例未模拟 Linux，Slack / Matrix 的出站消息状态写盘可与测试目录删除竞态。

**修复**：两个 SDK 固定至 0.17.4，更新 shrinkwrap、manifest `>=0.17.4 <0.18.0`，同步 daemon / 配对脚本 / 状态手册示例的 `appVersion`。增加 `tests/compatibility.test.ts`，守住 SDK、锁文件、握手声明与 manifest 的版本对应。iMessage 用例显式模拟并恢复平台；Slack 测试改为 await 异步清理，Slack / Matrix 的测试目录删除增加有限重试，让已排队的写入有机会结束。此处未改适配器运行逻辑。以 `stable` 承载 fork 修复，`main` 跟踪上游；远端默认分支变更已在用户明确授权后完成（见下方验证）。

**验证**：`npm run typecheck && npm test`：双侧类型检查通过，463 tests / 463 pass / 0 fail；脱敏和文档链接守卫通过。升级前原样门禁已记录上述基线失败；当前通过结果包含两项新增版本回归断言。用户随后明确授权发布：兼容性提交 `12ec017` 已推送到 `origin/stable`，GitHub 设置页确认 `Default branch changed to stable`。尚未在用户运行中的 daemon 安装或重载，因此不把先前 0.16.2 的实机证据当作 0.17.4 实机验收。维护步骤见 [fork 维护约定](./fork-maintenance.md)。

### 最低版本补充：支持从 0.17.3 开始（2026-11-24）

**现象**：用户需要在 Paseo 0.17.3 安装，但初次升级声明的最低版本 0.17.4 仍会拒绝它。

**根因**：把验证时的最新补丁版本直接当成最低版本，会排除同一 minor 下需要支持的旧补丁。最低版本应对应最旧支持基线。

**修复**：按用户要求，两个 SDK、shrinkwrap、daemon / 自测脚本的 `appVersion` 同步至 0.17.3；manifest 改为 `>=0.17.3 <0.18.0`。现有版本回归断言继续约束这些值同步，README、overview、状态手册与维护流程同步更新。未改变协议字段或渠道适配器。

**验证**：变更前后均跑 `npm run typecheck && npm test`，均为 463 pass / 0 fail；变更后 package / runtime 守卫通过；隔离目录 `npm ci --omit=dev --ignore-scripts` 成功，0.17.3 的 `createPaseoApi` 与 `DaemonClient` 两个运行时导入正常。真实 daemon 加载与 IM 收发仍待实机验收。提交主题为 `fix(compat): support Paseo from 0.17.3`。
