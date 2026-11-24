/** Slack 渠道适配器测试：normalize 真实事件形状、mrkdwn 渲染与 fence-aware
 * 分块、Socket Mode ACK/重连、凭据错误路径、发送/流式/上传与 429 退避。
 * 全部走 fake 传输（deps 注入），无真实网络。 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { mock, test } from "node:test";
import { createFileDownloader, createRestClient, SlackApiError, socketEventData, validateHttpsFileUrl, validateSocketUrl } from "../../server/channels/slack/api.ts";
import { createAdapter, definition, type SlackAdapter, type SlackConnection } from "../../server/channels/slack/index.ts";
import { splitMrkdwnChunks, toMrkdwn, toPlain } from "../../server/channels/slack/markdown.ts";
import { decodeSlackText, isCommandLike, normalizeEvent, stripBotMention } from "../../server/channels/slack/normalize.ts";
import type { SlackFile } from "../../server/channels/slack/schema.ts";
import type { AdapterContext } from "../../server/channels/types.ts";
import type { SlackSocketLike } from "../../server/channels/slack/api.ts";
import type { SlackRestResponse } from "../../server/channels/slack/schema.ts";
import type { ImSettings } from "../../shared/settings.ts";
import { UserFacingError } from "../../shared/errors.ts";

const UUID = "3f9d6a1e-8c24-4f0a-9d1b-2e5f6a7b8c9d";
const TEAM_ID = "T0TEST01";
const BOT_USER_ID = "UBOT01";
const WSS_URL = "wss://wss-primary.slack.com/connection/abc-def";

const SETTINGS: ImSettings = {
  imageMaxDownloadMb: 30,
  imageMaxSingleMb: 5,
  imageMaxTotalMb: 20,
  imageMaxCount: 20,
  busyMode: "queue",
  attachmentTtlHours: 168,
  deferTimeoutMinutes: 30,
};

interface RestCall {
  method: string;
  body: Record<string, unknown>;
}

/** fake REST：记录调用，按 method 返回预设响应或抛错。 */
function fakeRest(handler: (call: RestCall, index: number) => unknown) {
  const calls: RestCall[] = [];
  const rest = async (method: string, body: Record<string, unknown> = {}) => {
    const call = { method, body };
    const index = calls.length;
    calls.push(call);
    const result = handler(call, index);
    if (result instanceof Error) throw result;
    // fake 边界：预设响应均满足 { ok: true, … }
    return result as SlackRestResponse;
  };
  return { calls, rest };
}

/** fake Socket Mode WebSocket：记录 send/close，可手动派发事件。 */
class FakeSocket implements SlackSocketLike {
  readonly sent: string[] = [];
  closes: { code?: number; reason?: string }[] = [];
  readonly #listeners = new Map<string, ((event: { data?: unknown; code?: number }) => void)[]>();

  addEventListener(type: string, listener: (event: { data?: unknown; code?: number }) => void) {
    const list = this.#listeners.get(type) ?? [];
    list.push(listener);
    this.#listeners.set(type, list);
  }
  listenerCount(type: string): number {
    return (this.#listeners.get(type) ?? []).length;
  }
  send(data: string) {
    this.sent.push(data);
  }
  close(code?: number, reason?: string) {
    this.closes.push({ code, reason });
  }
  emit(type: string, event: { data?: unknown; code?: number } = {}) {
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }
  emitJson(value: unknown) {
    this.emit("message", { data: JSON.stringify(value) });
  }
  emitRaw(data: unknown) {
    this.emit("message", { data });
  }
}

function helloSocket(): FakeSocket {
  const socket = new FakeSocket();
  // setImmediate：等 openSocket 返回后监听器已挂上，再派发 hello（不依赖真实时钟）
  setImmediate(() => socket.emitJson({ type: "hello", connection_info: { app_id: "A0TEST01" } }));
  return socket;
}

/** 排空微任务/同步事件回调，让适配器的异步处理链落定（不使用真实定时器）。 */
async function drain(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

/** start() 含异步状态加载与 auth.test，hello 必须等 message 监听器挂上后再派发。 */
async function startWithSocket(adapter: SlackAdapter, socket: FakeSocket): Promise<void> {
  const pending = adapter.start();
  await waitFor(() => socket.listenerCount("message") > 0);
  socket.emitJson({ type: "hello", connection_info: { app_id: "A0TEST01" } });
  await pending;
}

function slackConfig(overrides: Partial<SlackConnection> = {}): SlackConnection {
  return {
    id: UUID,
    channel: "slack",
    name: "测试连接",
    enabled: true,
    target: null,
    policy: {
      groupAdmission: "approval",
      directMessages: "everyone",
      groupUsers: "operators",
      operators: [],
      invocation: "mentions",
    },
    bindings: {},
    revision: 0,
    teamId: TEAM_ID,
    botUserId: BOT_USER_ID,
    ...overrides,
  };
}

interface Harness {
  ctx: AdapterContext<SlackConnection>;
  controller: AbortController;
  dir: string;
  dataDir: string;
  mediaDir: string;
  emitted: unknown[];
  errors: Error[];
  logs: string[];
  cleanup(): Promise<void>;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "paseo-slack-test-"));
  const dataDir = join(dir, "data");
  const mediaDir = join(dir, "media");
  const emitted: unknown[] = [];
  const errors: Error[] = [];
  const logs: string[] = [];
  const controller = new AbortController();
  const ctx: AdapterContext<SlackConnection> = {
    connectionId: UUID,
    config: slackConfig(),
    secrets: { botToken: "xoxb-test-token", appToken: "xapp-test-token" },
    dataDir,
    mediaDir,
    signal: controller.signal,
    settings: async () => SETTINGS,
    log: (level, message) => logs.push(`${level}: ${message}`),
    onMessage: (message) => emitted.push(message),
    onGroups: () => {},
    onError: (error) => errors.push(error),
  };
  return {
    ctx,
    controller,
    dir,
    dataDir,
    mediaDir,
    emitted,
    errors,
    logs,
    // Let finite outbound persistence finish if it races test teardown.
    cleanup: () => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 10 }),
  };
}

async function waitFor(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (condition()) return;
    if (Date.now() - started > timeoutMs) throw new Error("waitFor 超时");
    await drain();
  }
}

/** 已完成 auth.test 的默认 REST 响应表。 */
function defaultRestHandler(
  overrides: Record<string, (call: RestCall, index: number) => unknown> = {},
) {
  return (call: RestCall, index: number): unknown => {
    const override = overrides[call.method];
    if (override) return override(call, index);
    switch (call.method) {
      case "auth.test":
        return { ok: true, team_id: TEAM_ID, user_id: BOT_USER_ID, team: "测试工作区" };
      case "apps.connections.open":
        return { ok: true, url: WSS_URL };
      case "conversations.history":
        return {
          ok: true,
          messages: [{ ts: String(call.body.oldest), user: BOT_USER_ID, text: "父消息内容" }],
        };
      case "chat.postMessage":
        return { ok: true, ts: `170000000${index % 10}.000001` };
      case "chat.startStream":
        return { ok: true, ts: "1700000099.000100" };
      case "chat.update":
      case "chat.appendStream":
      case "chat.stopStream":
      case "files.completeUploadExternal":
      case "files.getUploadURLExternal":
        return { ok: true, upload_url: "https://files.slack.com/upload/v1/abc", file_id: "F06" };
      default:
        return { ok: true };
    }
  };
}

function appMentionPayload(overrides: Record<string, unknown> = {}) {
  return {
    type: "event_callback",
    event_id: "Ev100",
    api_app_id: "A0TEST01",
    event: {
      type: "app_mention",
      channel: "C0CHANNEL",
      user: "UHUMAN",
      text: "<@UBOT01> 部署一下",
      ts: "1700000000.000100",
      event_ts: "1700000000.000100",
      ...overrides,
    },
  };
}

test("normalize：私聊 message（channel_type=im）解码实体并标记 mention", async () => {
  const result = await normalizeEvent(
    {
      type: "event_callback",
      event_id: "Ev1",
      event: {
        type: "message",
        channel: "D0DIRECT",
        channel_type: "im",
        user: "UHUMAN",
        text: "hi &amp; &lt;bye&gt;",
        ts: "1700000000.123456",
        event_ts: "1700000000.123456",
      },
    },
    { botUserId: BOT_USER_ID, connectionId: UUID, downloadFile: async () => "" },
  );
  assert.ok(result);
  assert.equal(result.eventId, "Ev1");
  assert.equal(result.message.kind, "dm");
  assert.equal(result.message.chatId, "D0DIRECT");
  assert.equal(result.message.senderId, "UHUMAN");
  assert.equal(result.message.messageId, "1700000000.123456");
  assert.equal(result.message.timestamp, 1_700_000_000_123);
  assert.equal(result.message.text, "hi & <bye>");
  assert.equal(result.message.trigger.mention, true);
  assert.equal(result.message.trigger.replyToBot, false);
  assert.equal(result.message.trigger.command, false);
  assert.equal(result.threadParentTs, undefined);
});

test("normalize：群内 app_mention 剥离 <@bot> 提记并识别命令形态", async () => {
  const result = await normalizeEvent(
    {
      type: "event_callback",
      event_id: "Ev2",
      event: {
        type: "app_mention",
        channel: "C0CHANNEL",
        user: "UHUMAN",
        text: "<@UBOT01> /status 运行如何",
        ts: "1700000000.000200",
      },
    },
    { botUserId: BOT_USER_ID, connectionId: UUID, downloadFile: async () => "" },
  );
  assert.ok(result);
  assert.equal(result.message.kind, "group");
  assert.equal(result.message.text, "/status 运行如何");
  assert.equal(result.message.trigger.mention, true);
  assert.equal(result.message.trigger.command, true);
});

test("normalize：thread 回复给出 threadId 与待查父消息", async () => {
  const result = await normalizeEvent(
    {
      type: "event_callback",
      event_id: "Ev3",
      event: {
        type: "app_mention",
        channel: "C0CHANNEL",
        user: "UHUMAN",
        text: "<@UBOT01> 继续说说",
        ts: "1700000005.000300",
        thread_ts: "1700000000.000100",
      },
    },
    { botUserId: BOT_USER_ID, connectionId: UUID, downloadFile: async () => "" },
  );
  assert.ok(result);
  assert.equal(result.message.threadId, "1700000000.000100");
  assert.equal(result.threadParentTs, "1700000000.000100");
  // thread_ts === ts（线程根消息本身）不产生父查询
  const root = await normalizeEvent(
    {
      type: "event_callback",
      event_id: "Ev4",
      event: {
        type: "app_mention",
        channel: "C0CHANNEL",
        user: "UHUMAN",
        text: "<@UBOT01> 开个线程",
        ts: "1700000006.000000",
        thread_ts: "1700000006.000000",
      },
    },
    { botUserId: BOT_USER_ID, connectionId: UUID, downloadFile: async () => "" },
  );
  assert.ok(root);
  assert.equal(root.threadParentTs, undefined);
  assert.equal(root.message.threadId, "1700000006.000000");
});

test("normalize：file_share 下载媒体并区分图片与文件", async () => {
  const dir = mkdtempSync(join(tmpdir(), "paseo-slack-media-"));
  try {
    const downloads: { url: string; name: string }[] = [];
    const downloadFile = async (url: string, file: SlackFile) => {
      downloads.push({ url, name: file.name ?? "" });
      const path = join(dir, file.id ?? "file");
      writeFileSync(path, "data");
      return path;
    };
    const result = await normalizeEvent(
      {
        type: "event_callback",
        event_id: "Ev5",
        event: {
          type: "message",
          subtype: "file_share",
          channel: "D0DIRECT",
          channel_type: "im",
          user: "UHUMAN",
          text: "看两个文件",
          ts: "1700000000.000400",
          files: [
            {
              id: "F01",
              name: "截图.png",
              mimetype: "image/png",
              size: 4,
              url_private_download: "https://files.slack.com/files-pri/T01-F01/download/tu.png",
            },
            {
              id: "F02",
              name: "报告.pdf",
              mimetype: "application/pdf",
              size: 4,
              url_private_download: "https://files.slack.com/files-pri/T01-F02/download/baogao.pdf",
            },
          ],
        },
      },
      { botUserId: BOT_USER_ID, connectionId: UUID, downloadFile },
    );
    assert.ok(result);
    const media = result.message.media;
    assert.ok(media);
    assert.equal(media.length, 2);
    assert.equal(media[0].kind, "image");
    assert.equal(media[0].name, "截图.png");
    assert.equal(media[1].kind, "file");
    assert.equal(downloads[0]?.url, "https://files.slack.com/files-pri/T01-F01/download/tu.png");
    assert.equal(readFileSync(media[0].path, "utf8"), "data");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("normalize：过滤 bot 消息、message_changed、群内非 mention 与空噪音", async () => {
  const deps = { botUserId: BOT_USER_ID, connectionId: UUID, downloadFile: async () => "" };
  const cases: unknown[] = [
    // 机器人自身消息
    {
      type: "event_callback",
      event_id: "Ev6",
      event: { type: "message", channel: "D0", channel_type: "im", bot_id: "B01", text: "自动回复", ts: "1.1" },
    },
    // 编辑事件
    {
      type: "event_callback",
      event_id: "Ev7",
      event: {
        type: "message",
        subtype: "message_changed",
        channel: "C0",
        channel_type: "channel",
        user: "UHUMAN",
        message: { text: "新", ts: "1.2" },
        ts: "1.3",
      },
    },
    // 群内非 mention
    {
      type: "event_callback",
      event_id: "Ev8",
      event: {
        type: "message",
        channel: "C0CHANNEL",
        channel_type: "channel",
        user: "UHUMAN",
        text: "普通聊天",
        ts: "1700000000.000500",
      },
    },
    // 无文本无媒体
    {
      type: "event_callback",
      event_id: "Ev9",
      event: { type: "message", channel: "D0", channel_type: "im", user: "UHUMAN", text: "   ", ts: "1.5" },
    },
    // 自己 user_id 的消息
    {
      type: "event_callback",
      event_id: "Ev10",
      event: {
        type: "message",
        channel: "D0",
        channel_type: "im",
        user: BOT_USER_ID,
        text: "自己",
        ts: "1.6",
      },
    },
  ];
  for (const payload of cases) {
    assert.equal(await normalizeEvent(payload, deps), null, JSON.stringify(payload));
  }
});

test("toMrkdwn：粗体/斜体/链接转换，代码块与行内代码保持原样", () => {
  assert.equal(
    toMrkdwn("**重要** 和 __斜体__ 与 [文档](https://example.com/a) 以及 [图](https://x.com/y.png)"),
    "*重要* 和 _斜体_ 与 <https://example.com/a|文档> 以及 <https://x.com/y.png|图>",
  );
  assert.equal(toMrkdwn("普通 `code *x*` 保持"), "普通 `code *x*` 保持");
  assert.equal(toMrkdwn("```js\nlet a = **1**;\n```"), "```js\nlet a = **1**;\n```");
  assert.equal(toMrkdwn(""), "");
  assert.equal(toPlain("**粗**[链接](https://e.com) `c`"), "粗链接 https://e.com c");
});

test("splitMrkdwnChunks：按上限分行断开，围栏跨块闭合重开，超长行硬切", () => {
  // 普通长文本
  const plain = "A".repeat(25_000);
  const plainChunks = splitMrkdwnChunks(plain, 11_000);
  assert.equal(plainChunks.join(""), plain);
  assert.ok(plainChunks.every((chunk) => chunk.length <= 11_000));

  // 围栏跨越分块点：前块以 ``` 结束，后块以 ``` 开头
  const fenced = `${"A".repeat(6_000)}\n\`\`\`js\n${"B".repeat(6_000)}\n${"C".repeat(6_000)}\n\`\`\`\nD`;
  const fencedChunks = splitMrkdwnChunks(fenced, 11_000);
  assert.equal(fencedChunks.join("\n").replaceAll("\n```", "").replaceAll("```\n", ""), fenced.replaceAll("\n```", "").replaceAll("```\n", ""));
  assert.ok(fencedChunks.length >= 3);
  assert.ok(fencedChunks[0].endsWith("```"), "前块应以闭合围栏结束");
  assert.ok(fencedChunks[1].startsWith("```"), "后块应以重开围栏开始");
  assert.ok(fencedChunks.every((chunk) => chunk.length <= 11_000 + 16));

  // 单行超过上限（围栏内）
  const longLine = `\`\`\`\n${"X".repeat(25_000)}\n\`\`\``;
  const hardChunks = splitMrkdwnChunks(longLine, 11_000);
  assert.equal(hardChunks.join("").replaceAll("```", "").replaceAll("\n", ""), "X".repeat(25_000));
  assert.ok(hardChunks.every((chunk) => chunk.length <= 11_000 + 16));

  assert.deepEqual(splitMrkdwnChunks("短文本", 11_000), ["短文本"]);
});

test("stripBotMention 与 isCommandLike", () => {
  assert.equal(stripBotMention("<@UBOT01|张三> 你好 <@UBOT01>", "UBOT01"), "你好");
  assert.equal(isCommandLike("/deploy now"), true);
  assert.equal(isCommandLike("!run"), true);
  assert.equal(isCommandLike("普通 /slash 文本"), false);
});

test("decodeSlackText：单遍解码，&amp;lt; 不二次解码", () => {
  assert.equal(decodeSlackText("a &amp; b &lt;c&gt;"), "a & b <c>");
  assert.equal(decodeSlackText("&amp;lt;tag&amp;gt;"), "&lt;tag&gt;");
  assert.equal(decodeSlackText("无实体"), "无实体");
});

test("configure：必填校验、trim 与机密拆分", () => {
  const fields = definition.configure({ botToken: " xoxb-abc ", appToken: "xapp-xyz " });
  assert.deepEqual(fields.secrets, { botToken: "xoxb-abc", appToken: "xapp-xyz" });
  assert.deepEqual(fields.config, {});
  assert.throws(() => definition.configure({ botToken: "xoxb-abc" }), /缺少必填字段/);
  assert.throws(() => definition.configure({ botToken: "oops", appToken: "xapp-xyz" }), /xoxb-/);
  assert.throws(() => definition.configure({ botToken: "xoxb-abc", appToken: "xoxb-wrong" }), /xapp-/);
});

test("start：缺失/格式错误的凭据给出可执行中文提示", async () => {
  const harness = makeHarness();
  try {
    const noBot: AdapterContext<SlackConnection> = {
      ...harness.ctx,
      secrets: { appToken: "xapp-test-token" },
    };
    await assert.rejects(() => createAdapter(noBot, stubDeps(noBot)).start(), /xoxb-/);

    const badApp: AdapterContext<SlackConnection> = {
      ...harness.ctx,
      secrets: { botToken: "xoxb-test-token", appToken: "not-an-app-token" },
    };
    await assert.rejects(() => createAdapter(badApp, stubDeps(badApp)).start(), /xapp-/);
  } finally {
    await harness.cleanup();
  }
});

function stubDeps(ctx: AdapterContext<SlackConnection>) {
  return {
    rest: async () => {
      throw new Error("不应触网");
    },
    openSocket: () => {
      throw new Error("不应建连");
    },
    downloadFile: async () => "",
    uploadBytes: async () => ({ status: 200 }),
  };
}

test("start：auth.test invalid_auth → UserFacingError", async () => {
  const harness = makeHarness();
  try {
    const { rest } = fakeRest(() => new SlackApiError("auth.test 调用失败（invalid_auth）", { providerCode: "invalid_auth" }));
    await assert.rejects(
      () => createAdapter(harness.ctx, { ...stubDeps(harness.ctx), rest }).start(),
      (error: unknown) => error instanceof Error && /Bot Token/.test(error.message),
    );
  } finally {
    await harness.cleanup();
  }
});

test("start：auth.test 身份与连接配置不一致 → UserFacingError", async () => {
  const harness = makeHarness();
  try {
    const { rest } = fakeRest(() => ({ ok: true, team_id: "T0OTHER9", user_id: BOT_USER_ID }));
    await assert.rejects(
      () => createAdapter(harness.ctx, { ...stubDeps(harness.ctx), rest }).start(),
      /不一致/,
    );
  } finally {
    await harness.cleanup();
  }
});

test("start：apps.connections.open 返回非 wss 地址 → UserFacingError", async () => {
  const harness = makeHarness();
  try {
    const { rest } = fakeRest((call) => {
      if (call.method === "apps.connections.open") return { ok: true, url: "https://evil.example/hook" };
      return defaultRestHandler()(call, 0);
    });
    await assert.rejects(
      () => createAdapter(harness.ctx, { ...stubDeps(harness.ctx), rest }).start(),
      /Socket Mode/,
    );
  } finally {
    await harness.cleanup();
  }
});

test("start：apps.connections.open invalid_auth → App Token 错误提示", async () => {
  const harness = makeHarness();
  try {
    const { rest } = fakeRest((call) => {
      if (call.method === "apps.connections.open") {
        return new SlackApiError("apps.connections.open 调用失败（invalid_auth）", { providerCode: "invalid_auth" });
      }
      return defaultRestHandler()(call, 0);
    });
    await assert.rejects(
      () => createAdapter(harness.ctx, { ...stubDeps(harness.ctx), rest }).start(),
      /App Token/,
    );
  } finally {
    await harness.cleanup();
  }
});

// 例外的真实时钟用例：断言适配器自身 1s 退避表的执行节奏，
// node:test mock.timers 无 tickAsync（@types/node 24.10 未声明），无法确定性驱动。
test("start：瞬时错误走 onError 退避重试，abort 后退出", async () => {
  const harness = makeHarness();
  try {
    const transportError = new SlackApiError("Slack auth.test 网络请求失败", { providerCode: "transport", transient: true });
    const { rest } = fakeRest(() => transportError);
    const adapter = createAdapter(harness.ctx, { ...stubDeps(harness.ctx), rest });
    const pending = adapter.start().catch((error: unknown) => error);
    await waitFor(() => harness.errors.length >= 2);
    assert.ok(harness.errors.every((error) => error === transportError));
    harness.controller.abort();
    const settled = await pending;
    assert.ok(settled instanceof Error);
    assert.ok(!(settled instanceof UserFacingError), "瞬时错误不应变成凭据错误");
  } finally {
    await harness.cleanup();
  }
});

test("Socket Mode：hello 就绪、ACK、事件投递、replyToBot、去重持久化、disconnect→close(4000)", async () => {
  const harness = makeHarness();
  const socket = new FakeSocket();
  const { calls, rest } = fakeRest(defaultRestHandler());
  let adapter: SlackAdapter | undefined;
  try {
    adapter = createAdapter(harness.ctx, {
      rest,
      openSocket: () => socket,
      downloadFile: async () => "",
      uploadBytes: async () => ({ status: 200 }),
    });
    await startWithSocket(adapter, socket);

    // events_api：ACK + 线程回复识别（父消息是机器人）
    socket.emitJson({ type: "events_api", envelope_id: "env1", payload: appMentionPayload({ thread_ts: "1700000000.000100", text: "<@UBOT01> 继续", ts: "1700000005.000300" }) });
    await waitFor(() => harness.emitted.length === 1);
    assert.deepEqual(JSON.parse(socket.sent[0]), { envelope_id: "env1" });
    const message = harness.emitted[0] as { chatId: string; trigger: { replyToBot: boolean }; replyTo?: { id: string; text?: string; sender?: string } };
    assert.equal(message.chatId, "C0CHANNEL");
    assert.equal(message.trigger.replyToBot, true);
    assert.equal(message.replyTo?.id, "1700000000.000100");
    assert.equal(message.replyTo?.sender, BOT_USER_ID);
    assert.equal(message.replyTo?.text, "父消息内容");
    assert.ok(calls.some((call) => call.method === "conversations.history"));

    // 同一 event_id 重复投递只处理一次，状态已落盘
    socket.emitJson({ type: "events_api", envelope_id: "env2", payload: appMentionPayload({ thread_ts: "1700000000.000100", text: "<@UBOT01> 继续", ts: "1700000005.000300" }) });
    await drain();
    assert.equal(harness.emitted.length, 1);
    // 状态写入经 WriteChain 异步落盘，等待文件出现
    const statePath = `${harness.dataDir}/slack-state.json`;
    await waitFor(() => existsSync(statePath));
    const stateFile = readFileSync(statePath, "utf8");
    assert.ok(stateFile.includes("Ev100"));

    // 非 JSON 载荷忽略不崩溃
    socket.emitRaw("not-json");

    // interactive 信封只 ACK
    socket.emitJson({ type: "interactive", envelope_id: "env3", payload: { type: "block_actions" } });
    await waitFor(() => socket.sent.length >= 3);
    assert.deepEqual(JSON.parse(socket.sent[2]), { envelope_id: "env3" });
    assert.equal(harness.emitted.length, 1);

    // disconnect → 客户端必须 close(4000)
    socket.emitJson({ type: "disconnect", envelope_id: "env4" });
    assert.equal(socket.closes.at(-1)?.code, 4000);
  } finally {
    await adapter?.stop();
    await harness.cleanup();
  }
});

test("Socket Mode：断开后按退避重连并恢复收发", async () => {
  const harness = makeHarness();
  const socket1 = new FakeSocket();
  const socket2 = helloSocket();
  const sockets = [socket1, socket2];
  const { calls, rest } = fakeRest(defaultRestHandler());
  let adapter: SlackAdapter | undefined;
  try {
    adapter = createAdapter(harness.ctx, {
      rest,
      openSocket: () => sockets.shift() ?? (() => { throw new Error("无可用测试 socket"); })(),
      downloadFile: async () => "",
      uploadBytes: async () => ({ status: 200 }),
    });
    await startWithSocket(adapter, socket1);

    socket1.emit("close", { code: 1006 });
    await waitFor(() => harness.errors.length >= 1);
    await waitFor(() => calls.filter((call) => call.method === "apps.connections.open").length >= 2, 5_000);
    // sock2 由 helloSocket 自动 hello；就绪后再次可收事件
    socket2.emitJson({
      type: "events_api",
      envelope_id: "env10",
      payload: appMentionPayload({ event_id: "Ev200" }),
    });
    await waitFor(() => harness.emitted.length === 1);
    assert.ok(harness.emitted.length === 1);
  } finally {
    await adapter?.stop();
    await harness.cleanup();
  }
});

test("sendText：mrkdwn 渲染、fence 分块、thread_ts 与 messageId", async () => {
  const harness = makeHarness();
  try {
    const { calls, rest } = fakeRest(defaultRestHandler());
    const adapter = createAdapter(harness.ctx, { ...stubDeps(harness.ctx), rest });
    const result = await adapter.sendText({
      chatId: "C0CHANNEL",
      threadId: "1700000000.000100",
      text: `${"甲".repeat(6_000)}\n${"乙".repeat(5_500)}\n**加粗**`,
    });
    // 行边界断块：6000 + 5500+1+6 两块
    const posts = calls.filter((call) => call.method === "chat.postMessage");
    assert.equal(posts.length, 2);
    assert.equal(posts[0].body.channel, "C0CHANNEL");
    assert.equal(posts[0].body.thread_ts, "1700000000.000100");
    assert.equal(posts[0].body.text, "甲".repeat(6_000));
    assert.equal(posts[1].body.text, `${"乙".repeat(5_500)}\n*加粗*`);
    assert.equal(result.messageId, "1700000000.000001");
    assert.equal(adapter.isOwnMessage("1700000000.000001"), true);
  } finally {
    await harness.cleanup();
  }
});

test("sendText：markdown 被拒时回退纯文本重发", async () => {
  const harness = makeHarness();
  try {
    const { calls, rest } = fakeRest((call, index) => {
      if (call.method === "chat.postMessage" && index === 0) {
        return new SlackApiError("chat.postMessage 调用失败（invalid_blocks）", { providerCode: "invalid_blocks" });
      }
      return { ok: true, ts: "1700000010.000001" };
    });
    const adapter = createAdapter(harness.ctx, { ...stubDeps(harness.ctx), rest });
    const result = await adapter.sendText({ chatId: "C1", text: "**粗** 和 [链接](https://e.com)" });
    const posts = calls.filter((call) => call.method === "chat.postMessage");
    assert.equal(posts.length, 2);
    assert.ok(!((posts[1].body.text as string).includes("*")));
    assert.ok((posts[1].body.text as string).includes("https://e.com"));
    assert.equal(result.messageId, "1700000010.000001");
  } finally {
    await harness.cleanup();
  }
});

test("sendText：sendText 失败抛 UserFacingError；空文本为空操作", async () => {
  const harness = makeHarness();
  try {
    const { rest } = fakeRest((call) => {
      if (call.method === "chat.postMessage") {
        return new SlackApiError("chat.postMessage 调用失败（channel_not_found）", { providerCode: "channel_not_found" });
      }
      return { ok: true };
    });
    const adapter = createAdapter(harness.ctx, { ...stubDeps(harness.ctx), rest });
    await assert.rejects(
      () => adapter.sendText({ chatId: "C404", text: "hi" }),
      (error: unknown) => error instanceof UserFacingError && /channel_not_found/.test(error.message),
    );
    assert.deepEqual(await adapter.sendText({ chatId: "C1", text: "   " }), {});
  } finally {
    await harness.cleanup();
  }
});

test("stream：startStream → appendStream 增量 → stopStream 终稿", async () => {
  const harness = makeHarness();
  try {
    const { calls, rest } = fakeRest(defaultRestHandler());
    const adapter = createAdapter(harness.ctx, { ...stubDeps(harness.ctx), rest });
    const { streamId } = await adapter.streamStart("C0CHANNEL", "1700000000.000100");
    assert.equal(streamId, "1700000099.000100");
    await adapter.streamAppend(streamId, "第一段");
    await adapter.streamAppend(streamId, "第一段第二段");
    const done = await adapter.streamFinish(streamId, "第一段第二段**终稿**");
    const appends = calls.filter((call) => call.method === "chat.appendStream");
    assert.deepEqual(appends.map((call) => call.body.markdown_text), ["第一段", "第二段"]);
    const stops = calls.filter((call) => call.method === "chat.stopStream");
    assert.equal(stops.length, 1);
    assert.equal(stops[0].body.ts, "1700000099.000100");
    assert.equal(stops[0].body.markdown_text, "第一段第二段*终稿*");
    assert.equal(done.messageId, "1700000099.000100");
    await assert.rejects(() => adapter.streamAppend(streamId, "再来"), /不存在/);
  } finally {
    await harness.cleanup();
  }
});

test("stream：startStream 不可用时回退占位消息 + chat.update", async () => {
  const harness = makeHarness();
  try {
    const { calls, rest } = fakeRest((call, index) => {
      if (call.method === "chat.startStream") {
        return new SlackApiError("chat.startStream 调用失败（method_not_supported_for_channel_type）", {
          providerCode: "method_not_supported_for_channel_type",
        });
      }
      if (call.method === "chat.postMessage") return { ok: true, ts: "1700000011.000001" };
      return defaultRestHandler()(call, index);
    });
    const adapter = createAdapter(harness.ctx, { ...stubDeps(harness.ctx), rest });
    const { streamId } = await adapter.streamStart("C0CHANNEL");
    assert.equal(streamId, "1700000011.000001");
    await adapter.streamAppend(streamId, "**进度** 50%");
    const updates = calls.filter((call) => call.method === "chat.update");
    assert.equal(updates.length, 1);
    assert.equal(updates[0].body.ts, "1700000011.000001");
    assert.equal(updates[0].body.text, "*进度* 50%");
    await adapter.streamFinish(streamId, "**完成**");
    assert.equal(calls.filter((call) => call.method === "chat.update").length, 2);
    assert.equal(calls.at(-1)?.body.text, "*完成*");
  } finally {
    await harness.cleanup();
  }
});

test("stream：startStream 瞬时故障（transport）同样回退占位消息 + chat.update，不上抛", async () => {
  const harness = makeHarness();
  try {
    const { calls, rest } = fakeRest((call, index) => {
      if (call.method === "chat.startStream") {
        return new SlackApiError("chat.startStream 网络请求失败", { providerCode: "transport", transient: true });
      }
      if (call.method === "chat.postMessage") return { ok: true, ts: "1700000012.000001" };
      return defaultRestHandler()(call, index);
    });
    const adapter = createAdapter(harness.ctx, { ...stubDeps(harness.ctx), rest });
    const { streamId } = await adapter.streamStart("C0CHANNEL");
    assert.equal(streamId, "1700000012.000001");
    await adapter.streamAppend(streamId, "进度 30%");
    const updates = calls.filter((call) => call.method === "chat.update");
    assert.equal(updates.length, 1);
    assert.equal(updates[0].body.ts, "1700000012.000001");
    assert.equal(updates[0].body.text, "进度 30%");
    await adapter.streamFinish(streamId, "完成");
    assert.equal(calls.filter((call) => call.method === "chat.update").length, 2);
    assert.equal(calls.at(-1)?.body.text, "完成");
    assert.equal(harness.errors.length, 0);
  } finally {
    await harness.cleanup();
  }
});

test("stream：startStream 非瞬时错误（invalid_auth）仍上抛且不走占位回退", async () => {
  const harness = makeHarness();
  try {
    const { calls, rest } = fakeRest((call) => {
      if (call.method === "chat.startStream") {
        return new SlackApiError("chat.startStream 调用失败（invalid_auth）", { providerCode: "invalid_auth" });
      }
      return defaultRestHandler()(call, 0);
    });
    const adapter = createAdapter(harness.ctx, { ...stubDeps(harness.ctx), rest });
    await assert.rejects(() => adapter.streamStart("C0CHANNEL"), /invalid_auth/);
    assert.equal(calls.filter((call) => call.method === "chat.postMessage").length, 0);
  } finally {
    await harness.cleanup();
  }
});

test("sendMedia：三步上传（getUploadURLExternal → PUT → completeUploadExternal）", async () => {
  const harness = makeHarness();
  const filePath = join(harness.dir, "上传.bin");
  writeFileSync(filePath, Buffer.from("file-bytes"));
  try {
    const uploads: { url: string; entries: string[] }[] = [];
    const { calls, rest } = fakeRest(defaultRestHandler());
    const adapter = createAdapter(harness.ctx, {
      rest,
      openSocket: () => {
        throw new Error("不应建连");
      },
      downloadFile: async () => "",
      uploadBytes: async (url, form) => {
        uploads.push({ url, entries: [...form.keys()] });
        return { status: 200 };
      },
    });
    const result = await adapter.sendMedia({
      chatId: "C0CHANNEL",
      threadId: "1700000000.000100",
      kind: "file",
      path: filePath,
      mime: "application/octet-stream",
      name: "附件.bin",
    });
    const ticket = calls.find((call) => call.method === "files.getUploadURLExternal");
    assert.deepEqual(ticket?.body, { filename: "附件.bin", length: 10 });
    assert.equal(uploads[0]?.url, "https://files.slack.com/upload/v1/abc");
    assert.deepEqual(uploads[0]?.entries, ["file"]);
    const complete = calls.find((call) => call.method === "files.completeUploadExternal");
    assert.deepEqual(complete?.body, {
      files: [{ id: "F06", title: "附件.bin" }],
      channel_id: "C0CHANNEL",
      thread_ts: "1700000000.000100",
    });
    assert.deepEqual(result, {});
    assert.equal(adapter.isOwnMessage("1700000099.000100"), false);
  } finally {
    await harness.cleanup();
  }
});

test("editMessage：chat.update 且 message_not_modified 视为成功", async () => {
  const harness = makeHarness();
  try {
    let failOnce = true;
    const { calls, rest } = fakeRest((call) => {
      if (call.method === "chat.update") {
        if (failOnce) {
          failOnce = false;
          return new SlackApiError("chat.update 调用失败（message_not_modified）", { providerCode: "message_not_modified" });
        }
      }
      return { ok: true };
    });
    const adapter = createAdapter(harness.ctx, { ...stubDeps(harness.ctx), rest });
    await adapter.editMessage("1700000000.1", "C1", "**改后**");
    await adapter.editMessage("1700000000.1", "C1", "**再改**");
    const updates = calls.filter((call) => call.method === "chat.update");
    assert.equal(updates.length, 2);
    assert.equal(updates[0].body.text, "*改后*");
  } finally {
    await harness.cleanup();
  }
});

test("testConnection：auth.test 结果映射", async () => {
  const harness = makeHarness();
  try {
    const { rest } = fakeRest(defaultRestHandler());
    const adapter = createAdapter(harness.ctx, { ...stubDeps(harness.ctx), rest });
    assert.deepEqual(await adapter.testConnection(), { ok: true, detail: `Slack 工作区 测试工作区 凭据有效` });

    const failing = fakeRest(() => new SlackApiError("auth.test 调用失败（invalid_auth）", { providerCode: "invalid_auth" }));
    const bad = createAdapter(harness.ctx, { ...stubDeps(harness.ctx), rest: failing.rest });
    const result = await bad.testConnection();
    assert.equal(result.ok, false);
    assert.ok(result.detail?.includes("invalid_auth"));
  } finally {
    await harness.cleanup();
  }
});

test("REST 客户端：429 按 Retry-After 重试一次，ok=false 抛 SlackApiError，按方法选 Token", async () => {
  const responses: { status: number; body: string; headers?: Record<string, string> }[] = [
    { status: 429, body: "{}", headers: { "retry-after": "0" } },
    { status: 200, body: JSON.stringify({ ok: true, url: WSS_URL }) },
    { status: 200, body: JSON.stringify({ ok: true, team_id: TEAM_ID, user_id: BOT_USER_ID }) },
    { status: 200, body: JSON.stringify({ ok: false, error: "channel_not_found" }) },
  ];
  const fetchCalls: { url: string; authorization: string; contentType: string }[] = [];
  mock.method(globalThis, "fetch", async (input: unknown, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    fetchCalls.push({
      url: String(input),
      authorization: headers.get("authorization") ?? "",
      contentType: headers.get("content-type") ?? "",
    });
    const next = responses.shift();
    assert.ok(next, "预设响应已用尽");
    return new Response(next.body, { status: next.status, headers: next.headers });
  });
  try {
    const rest = createRestClient({
      botToken: () => "xoxb-bot-token",
      appToken: () => "xapp-app-token",
      signal: new AbortController().signal,
    });
    const opened = await rest("apps.connections.open", {});
    assert.equal(opened.url, WSS_URL);
    await rest("auth.test", {});
    await assert.rejects(
      () => rest("chat.postMessage", { channel: "C1", text: "hi" }),
      (error: unknown) => error instanceof SlackApiError && error.providerCode === "channel_not_found",
    );
    assert.equal(fetchCalls.length, 4);
    assert.match(fetchCalls[0].url, /slack\.com\/api\/apps\.connections\.open$/);
    // 0/1：apps.connections.open 首次 429 + 按 Retry-After 重试（App Token）
    assert.equal(fetchCalls[0].authorization, "Bearer xapp-app-token");
    assert.equal(fetchCalls[1].authorization, "Bearer xapp-app-token");
    // 2/3：auth.test 与 chat.postMessage（Bot Token）
    assert.equal(fetchCalls[2].authorization, "Bearer xoxb-bot-token");
    assert.equal(fetchCalls[3].authorization, "Bearer xoxb-bot-token");
    assert.equal(fetchCalls[0].contentType, "application/json;charset=utf-8");
  } finally {
    mock.restoreAll();
  }
});

test("REST 客户端：form-encoded 方法与 URL 校验", async () => {
  const fetchCalls: { url: string; body: unknown; contentType: string }[] = [];
  mock.method(globalThis, "fetch", async (input: unknown, init?: RequestInit) => {
    fetchCalls.push({
      url: String(input),
      body: init?.body,
      contentType: new Headers(init?.headers).get("content-type") ?? "",
    });
    return new Response(JSON.stringify({ ok: true, upload_url: "https://files.slack.com/upload/v1/x", file_id: "F1" }), { status: 200 });
  });
  try {
    const rest = createRestClient({
      botToken: () => "xoxb-bot-token",
      appToken: () => "xapp-app-token",
      signal: new AbortController().signal,
    });
    const ticket = await rest("files.getUploadURLExternal", { filename: "a.bin", length: 3 });
    assert.equal(ticket.file_id, "F1");
    assert.equal(fetchCalls[0].contentType, "application/x-www-form-urlencoded;charset=utf-8");
    assert.equal(fetchCalls[0].body, "filename=a.bin&length=3");
  } finally {
    mock.restoreAll();
  }
});

test("URL 安全校验：Socket Mode 必须 wss，文件必须 files.slack.com", () => {
  assert.throws(() => validateSocketUrl("https://wss-primary.slack.com/x"), /wss/);
  assert.throws(() => validateSocketUrl("not-a-url"), /Socket Mode/);
  assert.equal(validateSocketUrl("wss://wss-primary.slack.com/x?token=1"), "wss://wss-primary.slack.com/x?token=1");
  assert.throws(() => validateHttpsFileUrl("http://files.slack.com/files-pri/T-F/a", "文件下载"), /files\.slack\.com/);
  assert.throws(() => validateHttpsFileUrl("https://evil.example/files-pri/T-F/a", "文件下载"), /files\.slack\.com/);
  assert.throws(() => validateHttpsFileUrl("https://files.slack.com:8443/a", "文件下载"), /files\.slack\.com/);
  assert.ok(validateHttpsFileUrl("https://files.slack.com/files-pri/T-F/a.pdf", "文件下载").pathname);
});

test("文件下载：fetch 带 redirect:error，file_id 异常字符被清洗进文件名", async () => {
  const dir = mkdtempSync(join(tmpdir(), "paseo-slack-dl-"));
  const fetchCalls: { input: unknown; init: RequestInit }[] = [];
  mock.method(globalThis, "fetch", async (input: unknown, init?: RequestInit) => {
    fetchCalls.push({ input, init: init ?? {} });
    return new Response(Buffer.from("file-bytes"), {
      status: 200,
      headers: { "content-type": "application/pdf" },
    });
  });
  try {
    const downloader = createFileDownloader({
      botToken: () => "xoxb-test-token",
      mediaDir: dir,
      signal: new AbortController().signal,
      maxBytes: async () => 0,
    });
    const path = await downloader(
      "https://files.slack.com/files-pri/T01-F01/download/baogao.pdf",
      { id: "F01/../x", name: "报告.pdf" },
    );
    assert.match(String(fetchCalls[0]?.input ?? ""), /files\.slack\.com/);
    assert.equal(fetchCalls[0]?.init.redirect, "error");
    assert.equal(new Headers(fetchCalls[0]?.init.headers).get("authorization"), "Bearer xoxb-test-token");
    // id 段的 "/" 被清洗为 "_"，不引入路径分隔符
    assert.equal(basename(path), "F01_.._x-报告.pdf");
    assert.equal(readFileSync(path, "utf8"), "file-bytes");
  } finally {
    mock.restoreAll();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("socketEventData：string/Buffer/包裹对象", () => {
  assert.equal(socketEventData("plain"), "plain");
  assert.equal(socketEventData({ data: Buffer.from("buf") }), "buf");
  assert.equal(socketEventData({ data: new TextEncoder().encode("u8").slice() }), "u8");
  assert.equal(socketEventData({ data: 42 }), null);
});

test("状态文件：重启后 seen 事件去重仍生效", async () => {
  const harness = makeHarness();
  const { rest } = fakeRest(defaultRestHandler());
  const socket = new FakeSocket();
  let adapter: SlackAdapter | undefined;
  try {
    adapter = createAdapter(harness.ctx, {
      rest,
      openSocket: () => socket,
      downloadFile: async () => "",
      uploadBytes: async () => ({ status: 200 }),
    });
    await startWithSocket(adapter, socket);
    socket.emitJson({ type: "events_api", envelope_id: "env1", payload: appMentionPayload() });
    await waitFor(() => harness.emitted.length === 1);
    await adapter.stop();

    // 同一 dataDir 上的新实例不应重复投递同一 event_id
    const second = new FakeSocket();
    const harness2Emitted: unknown[] = [];
    const ctx2: AdapterContext<SlackConnection> = {
      ...harness.ctx,
      onMessage: (message) => harness2Emitted.push(message),
    };
    const adapter2 = createAdapter(ctx2, {
      rest,
      openSocket: () => second,
      downloadFile: async () => "",
      uploadBytes: async () => ({ status: 200 }),
    });
    await startWithSocket(adapter2, second);
    second.emitJson({ type: "events_api", envelope_id: "env9", payload: appMentionPayload() });
    await drain();
    assert.equal(harness2Emitted.length, 0);
    await adapter2.stop();
  } finally {
    await adapter?.stop();
    await harness.cleanup();
  }
});
