/** Matrix channel adapter tests: fake transport injected via createAdapter
 * deps; no real network. Protocol facts ported from xmanrui/dsh-im (MIT). */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { emptyPolicy } from "../../shared/config.ts";
import type { NormalizedMessage } from "../../shared/model.ts";
import type { AdapterContext, ChannelAdapter } from "../../server/channels/types.ts";
import type { ImSettings } from "../../shared/settings.ts";
import { createAdapter, definition } from "../../server/channels/matrix/index.ts";
import { defaultDeps, MatrixApiError } from "../../server/channels/matrix/api.ts";
import type { MatrixConnection, MatrixDeps } from "../../server/channels/matrix/api.ts";
import { renderHtml, splitFenceAware } from "../../server/channels/matrix/format.ts";

interface Call {
  method: string;
  path: string;
  body?: unknown;
}

type Handler = (call: Call) => Record<string, unknown> | Error | Promise<Record<string, unknown>>;

interface FakeDeps extends MatrixDeps {
  calls: Call[];
  /** Replace the handler for every call until replaced again. */
  handle(handler: Handler): void;
  /** Handle exactly the next call matching `match` (loop-safe: other calls fall through). */
  once(match: (call: Call) => boolean, handler: Handler): void;
  restCalls(method: string, pathPrefix: string): Call[];
}

function fakeDeps(): FakeDeps {
  const calls: Call[] = [];
  const onces: Array<{ match: (call: Call) => boolean; handler: Handler }> = [];
  let persistent: Handler = (call) => (call.path.startsWith("/sync") ? { next_batch: "b1" } : {});
  let txn = 0;
  const rest = async (
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> => {
    // 让出宏任务：否则后台 sync 循环在假传输下退化为纯微任务自旋，饿死定时器
    await new Promise((resolve) => setImmediate(resolve));
    const call: Call = { method, path, body };
    calls.push(call);
    const onceIndex = onces.findIndex((entry) => entry.match(call));
    const handler = onceIndex >= 0 ? onces.splice(onceIndex, 1)[0]!.handler : persistent;
    const run = Promise.resolve(handler(call)).then((result) => {
      if (result instanceof Error) throw result;
      return result;
    });
    if (!signal) return run;
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(new DOMException("The operation was aborted", "AbortError"));
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
      run.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    });
  };
  return {
    calls,
    handle: (handler) => {
      persistent = handler;
    },
    once: (match, handler) => {
      onces.push({ match, handler });
    },
    rest,
    mediaDownload: async (mxc: string, maxBytes: number) => {
      calls.push({ method: "MEDIA_DOWNLOAD", path: mxc, body: maxBytes });
      return { bytes: new TextEncoder().encode("png-bytes"), mime: "image/png" };
    },
    mediaUpload: async (bytes: Uint8Array, mime: string, filename?: string) => {
      calls.push({ method: "MEDIA_UPLOAD", path: `mxc://hs/uploaded#${filename}:${mime}`, body: bytes.byteLength });
      return "mxc://hs/uploaded";
    },
    sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, 0)),
    txnId: () => `txn-${++txn}`,
    now: () => 1_700_000_000_000,
    restCalls: (method, pathPrefix) =>
      calls.filter((call) => call.method === method && call.path.startsWith(pathPrefix)),
  };
}

const SETTINGS: ImSettings = {
  imageMaxDownloadMb: 30,
  imageMaxSingleMb: 5,
  imageMaxTotalMb: 20,
  imageMaxCount: 20,
  busyMode: "queue",
  attachmentTtlHours: 168,
  deferTimeoutMinutes: 30,
};

const CONFIG: MatrixConnection = {
  id: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
  name: "Matrix 测试",
  enabled: true,
  target: null,
  policy: emptyPolicy(),
  bindings: {},
  revision: 0,
  channel: "matrix",
  homeserver: "https://matrix.example.org",
  userId: "@bot:example.org",
  authMode: "token",
};

interface Harness {
  adapter: ChannelAdapter;
  deps: FakeDeps;
  messages: NormalizedMessage[];
  groups: Array<{ chatId: string; title?: string; added: boolean }>;
  errors: Error[];
  logs: string[];
  dir: string;
  dataDir: string;
  mediaDir: string;
  controller: AbortController;
}

async function makeHarness(
  configOverrides: Partial<MatrixConnection> = {},
  secrets: Record<string, string> = { accessToken: "syt_test" },
  dataDirOverride?: string,
): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "paseo-im-matrix-"));
  const controller = new AbortController();
  const messages: NormalizedMessage[] = [];
  const groups: Harness["groups"] = [];
  const errors: Error[] = [];
  const logs: string[] = [];
  const ctx: AdapterContext<MatrixConnection> = {
    connectionId: "conn-1",
    config: { ...CONFIG, ...configOverrides },
    secrets,
    dataDir: dataDirOverride ?? join(dir, "data"),
    mediaDir: join(dir, "media"),
    signal: controller.signal,
    settings: async () => SETTINGS,
    log: (level, message) => logs.push(`${level}: ${message}`),
    onMessage: (message) => messages.push(message),
    onGroups: (events) => groups.push(...events),
    onError: (error) => errors.push(error),
  };
  const deps = fakeDeps();
  return {
    adapter: createAdapter(ctx, deps),
    deps,
    messages,
    groups,
    errors,
    logs,
    dir,
    dataDir: ctx.dataDir,
    mediaDir: ctx.mediaDir,
    controller,
  };
}

const harnesses: Harness[] = [];

async function readyHarness(
  configOverrides: Partial<MatrixConnection> = {},
  secrets: Record<string, string> = { accessToken: "syt_test" },
): Promise<Harness> {
  const harness = await makeHarness(configOverrides, secrets);
  harness.deps.once((call) => call.path === "/account/whoami", () => ({ user_id: "@bot:example.org" }));
  harness.deps.handle((call) => (call.path.startsWith("/sync") ? { next_batch: "s0" } : {}));
  harnesses.push(harness);
  await harness.adapter.start();
  return harness;
}

async function waitFor(predicate: () => boolean | Promise<boolean>, ms = 5_000): Promise<void> {
  // 轮询谓词：后台 sync 循环通过回调写数组，没有可 await 的完成信号
  const deadline = Date.now() + ms;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("waitFor 超时");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function messageEvent(eventId: string, sender: string, content: Record<string, unknown>, ts = 1_700_000_000_000) {
  return { type: "m.room.message", event_id: eventId, sender, origin_server_ts: ts, content };
}

function withRoom(roomId: string, event: Record<string, unknown>): Record<string, unknown> {
  return { ...event, room: roomId };
}

let batchSeq = 0;

function syncPayload(events: Array<Record<string, unknown>>, dmRooms: string[] = []): Record<string, unknown> {
  const join: Record<string, { timeline: { events: Array<Record<string, unknown>> } }> = {};
  for (const event of events) {
    const { room, ...rest } = event;
    const roomId = String(room);
    (join[roomId] ??= { timeline: { events: [] } }).timeline.events.push(rest);
  }
  return {
    next_batch: `b${++batchSeq}`,
    account_data: { events: [{ type: "m.direct", content: { "@alice:example.org": dmRooms } }] },
    rooms: { join, invite: {} },
  };
}

const SEND_MATCH = (call: Call) => call.method === "PUT" && call.path.includes("/send/m.room.message/");
const syncCount = (harness: Harness) => harness.deps.calls.filter((call) => call.method === "GET" && call.path.startsWith("/sync")).length;

afterEach(async () => {
  while (harnesses.length) {
    const harness = harnesses.pop()!;
    harness.controller.abort();
    await harness.adapter.stop().catch(() => {});
    // Outbound own-message persistence can still finish after stop().
    await rm(harness.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 10 });
  }
});

describe("matrix definition.configure", () => {
  it("拆分字段并按令牌存在推导 authMode", () => {
    const fields = definition.configure({
      homeserver: "https://matrix.example.org/",
      userId: " @bot:example.org ",
      accessToken: " syt_x ",
    });
    assert.deepEqual(fields.config, {
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
      authMode: "token",
    });
    assert.deepEqual(fields.secrets, { accessToken: "syt_x" });
  });

  it("无令牌时回退密码模式", () => {
    const fields = definition.configure({
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
      password: " pw ",
    });
    assert.equal(fields.config.authMode, "password");
    assert.deepEqual(fields.secrets, { password: "pw" });
  });

  it("缺少令牌与密码时报用户可读错误", () => {
    assert.throws(
      () => definition.configure({ homeserver: "https://matrix.example.org", userId: "@bot:example.org" }),
      (error: unknown) => error instanceof Error && error.message.includes("至少填写一项"),
    );
  });

  it("homeserver 与用户 ID 非法时报用户可读错误", () => {
    assert.throws(
      () => definition.configure({ homeserver: "ftp://bad", userId: "@bot:example.org", password: "x" }),
      (error: unknown) => error instanceof Error && error.message.includes("Homeserver"),
    );
    assert.throws(
      () => definition.configure({ homeserver: "https://matrix.example.org", password: "x" }),
      (error: unknown) => error instanceof Error && error.message.includes("缺少必填字段"),
    );
  });
});

describe("matrix start 错误路径", () => {
  it("token 模式缺少 Access Token 抛 UserFacingError", async () => {
    const harness = await makeHarness({}, {});
    harnesses.push(harness);
    await assert.rejects(
      () => harness.adapter.start(),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /缺少 Access Token/);
        return true;
      },
    );
  });

  it("whoami 用户与配置不一致抛 UserFacingError", async () => {
    const harness = await makeHarness();
    harness.deps.once((call) => call.path === "/account/whoami", () => ({ user_id: "@other:example.org" }));
    harnesses.push(harness);
    await assert.rejects(
      () => harness.adapter.start(),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /不一致/);
        return true;
      },
    );
  });

  it("401 M_UNKNOWN_TOKEN 抛 UserFacingError", async () => {
    const harness = await makeHarness();
    harness.deps.once(
      (call) => call.path === "/account/whoami",
      () => new MatrixApiError("Matrix 请求失败（HTTP 401，M_UNKNOWN_TOKEN: Invalid token）", {
        status: 401,
        errcode: "M_UNKNOWN_TOKEN",
      }),
    );
    harnesses.push(harness);
    await assert.rejects(
      () => harness.adapter.start(),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /认证失败/);
        return true;
      },
    );
  });
});

describe("matrix 启动与首次同步", () => {
  it("首次同步只存 next_batch 不回发历史，并记录 m.direct", async () => {
    const harness = await makeHarness();
    harness.deps.once((call) => call.path === "/account/whoami", () => ({ user_id: "@bot:example.org" }));
    const historyEvent = withRoom("!dm:example.org", messageEvent("$h1", "@alice:example.org", { msgtype: "m.text", body: "历史消息" }));
    harness.deps.once(
      (call) => call.method === "GET" && call.path.startsWith("/sync") && !call.path.includes("since="),
      () => ({
        next_batch: "s1",
        account_data: { events: [{ type: "m.direct", content: { "@alice:example.org": ["!dm:example.org"] } }] },
        rooms: { join: { "!dm:example.org": { timeline: { events: [historyEvent] } } }, invite: {} },
      }),
    );
    harness.deps.handle((call) => (call.path.startsWith("/sync") ? { next_batch: "s1" } : {}));
    harnesses.push(harness);
    await harness.adapter.start();
    await waitFor(() => syncCount(harness) >= 2);

    const whoami = harness.deps.restCalls("GET", "/account/whoami");
    assert.equal(whoami.length, 1);
    const initial = harness.deps.calls.find((call) => call.method === "GET" && call.path.startsWith("/sync"))!;
    assert.ok(initial.path.includes("timeout=0"));
    assert.ok(!initial.path.includes("since="));
    assert.ok(initial.path.includes("filter="));
    assert.equal(harness.messages.length, 0, "历史事件不回发");
    const state = JSON.parse(await readFile(join(harness.dataDir, "matrix-state.json"), "utf8"));
    assert.equal(state.nextBatch, "s1");
    assert.ok(state.dmRooms.includes("!dm:example.org"));
    assert.equal(state.session, undefined);
  });

  it("密码模式登录并持久化会话，重启后复用", async () => {
    const harness = await makeHarness({ authMode: "password" }, { password: "pw" });
    harness.deps.once(
      (call) => call.path === "/login",
      (call) => {
        assert.equal(call.method, "POST");
        const body = call.body as Record<string, unknown>;
        assert.equal(body.type, "m.login.password");
        assert.deepEqual(body.identifier, { type: "m.id.user", user: "@bot:example.org" });
        return { access_token: "syt_login", user_id: "@bot:example.org", device_id: "DEV1" };
      },
    );
    harness.deps.once((call) => call.path === "/account/whoami", () => ({ user_id: "@bot:example.org" }));
    harnesses.push(harness);
    await harness.adapter.start();
    const state = JSON.parse(await readFile(join(harness.dataDir, "matrix-state.json"), "utf8"));
    assert.equal(state.session.accessToken, "syt_login");
    assert.equal(state.session.deviceId, "DEV1");

    const reopened = await makeHarness({ authMode: "password" }, {}, harness.dataDir);
    reopened.deps.once((call) => call.path === "/account/whoami", () => ({ user_id: "@bot:example.org" }));
    harnesses.push(reopened);
    await reopened.adapter.start();
    assert.equal(reopened.deps.restCalls("POST", "/login").length, 0, "复用持久化会话，不再登录");
    assert.equal(reopened.deps.restCalls("GET", "/account/whoami").length, 1);
  });

  it("密码会话 whoami 永久失败 → 清会话用密码重登一次再验证", async () => {
    const first = await makeHarness({ authMode: "password" }, { password: "pw" });
    first.deps.once((call) => call.path === "/login", () => ({ access_token: "syt_old", user_id: "@bot:example.org", device_id: "D1" }));
    first.deps.once((call) => call.path === "/account/whoami", () => ({ user_id: "@bot:example.org" }));
    first.deps.handle((call) => (call.path.startsWith("/sync") ? { next_batch: "s0" } : {}));
    harnesses.push(first);
    await first.adapter.start();
    const saved = JSON.parse(await readFile(join(first.dataDir, "matrix-state.json"), "utf8")) as { session?: { accessToken?: string } };
    assert.equal(saved.session?.accessToken, "syt_old");

    // 重启：已保存会话被服务器吊销（401 M_UNKNOWN_TOKEN）→ 自动重登恢复。
    const reopened = await makeHarness({ authMode: "password" }, { password: "pw" }, first.dataDir);
    reopened.deps.once((call) => call.path === "/account/whoami", () =>
      new MatrixApiError("Matrix 请求失败（HTTP 401，M_UNKNOWN_TOKEN）", { status: 401, errcode: "M_UNKNOWN_TOKEN" }));
    reopened.deps.once((call) => call.path === "/login", () => ({ access_token: "syt_new", user_id: "@bot:example.org", device_id: "D2" }));
    reopened.deps.once((call) => call.path === "/account/whoami", () => ({ user_id: "@bot:example.org" }));
    reopened.deps.handle((call) => (call.path.startsWith("/sync") ? { next_batch: "s1" } : {}));
    harnesses.push(reopened);
    await reopened.adapter.start();
    assert.equal(reopened.deps.restCalls("POST", "/login").length, 1, "会话失效后应自动重登一次");
    assert.equal(reopened.deps.restCalls("GET", "/account/whoami").length, 2, "重登后需再次 whoami 验证");
    const state = JSON.parse(await readFile(join(reopened.dataDir, "matrix-state.json"), "utf8")) as { session?: { accessToken?: string } };
    assert.equal(state.session?.accessToken, "syt_new", "新会话已持久化");
    assert.ok(reopened.logs.some((line) => line.includes("重新登录")));
  });

  it("token 模式 whoami 永久失败不触发重登", async () => {
    const harness = await makeHarness(); // 默认 token 模式 + accessToken
    harness.deps.once((call) => call.path === "/account/whoami", () =>
      new MatrixApiError("Matrix 请求失败（HTTP 401，M_UNKNOWN_TOKEN）", { status: 401, errcode: "M_UNKNOWN_TOKEN" }));
    harnesses.push(harness);
    await assert.rejects(() => harness.adapter.start(), /认证失败/);
    assert.equal(harness.deps.restCalls("POST", "/login").length, 0, "token 模式不做密码重登");
  });

  it("testConnection：token 缺失但有密码时试 /login 验证", async () => {
    const harness = await makeHarness({}, { password: "pw" });
    harness.deps.once((call) => call.path === "/login", (call) => {
      assert.equal((call.body as Record<string, unknown>).type, "m.login.password");
      return { access_token: "syt_pw" };
    });
    harness.deps.once((call) => call.path === "/account/whoami", () => ({ user_id: "@bot:example.org" }));
    harnesses.push(harness);
    assert.ok(harness.adapter.testConnection, "testConnection 应当实现");
    const result = await harness.adapter.testConnection();
    assert.equal(result.ok, true);
    assert.match(result.detail ?? "", /@bot:example.org/);
    assert.equal(harness.deps.restCalls("POST", "/login").length, 1);
  });

  it("testConnection：token 与密码与已存会话均缺失 → ok=false", async () => {
    const harness = await makeHarness({}, {});
    harnesses.push(harness);
    assert.ok(harness.adapter.testConnection, "testConnection 应当实现");
    const result = await harness.adapter.testConnection();
    assert.equal(result.ok, false);
    assert.match(result.detail ?? "", /Access Token/);
    assert.equal(harness.deps.calls.length, 0);
  });
});

describe("matrix 入站 normalize", () => {
  it("覆盖 dm、群 @提及、pill 提及、回复机器人、回复他人、thread、噪音与自身过滤", async () => {
    const harness = await readyHarness();

    harness.deps.once(SEND_MATCH, () => ({ event_id: "$own1" }));
    const sent = await harness.adapter.sendText({ chatId: "!room:example.org", text: "占位" });
    assert.equal(sent.messageId, "$own1");

    harness.deps.handle((call) => {
      if (!call.path.startsWith("/sync")) return { next_batch: "sN" };
      return syncPayload([
        withRoom("!dm:example.org", messageEvent("$e1", "@alice:example.org", { msgtype: "m.text", body: "你好" })),
        withRoom("!room:example.org", messageEvent("$e2", "@bob:example.org", {
          msgtype: "m.text",
          body: "@bot:example.org 帮忙",
          "m.mentions": { user_ids: ["@BOT:example.org"] },
        })),
        withRoom("!room:example.org", messageEvent("$e3", "@bob:example.org", {
          msgtype: "m.text",
          body: "@bot:example.org hi",
          formatted_body: '<a href="https://matrix.to/#/@bot:example.org">@bot</a> hi',
        })),
        withRoom("!room:example.org", messageEvent("$e4", "@bob:example.org", { msgtype: "m.text", body: "普通消息" })),
        withRoom("!room:example.org", messageEvent("$e5", "@bob:example.org", {
          msgtype: "m.text",
          body: "机器人帮我看",
          "m.relates_to": { "m.in_reply_to": { event_id: "$own1" } },
        })),
        withRoom("!room:example.org", messageEvent("$e6", "@bob:example.org", {
          msgtype: "m.text",
          body: "回复人类",
          "m.relates_to": { "m.in_reply_to": { event_id: "$humanMsg" } },
        })),
        withRoom("!room:example.org", messageEvent("$e7", "@bob:example.org", {
          msgtype: "m.text",
          body: "thread 消息",
          "m.relates_to": { rel_type: "m.thread", event_id: "$root" },
        })),
        withRoom("!room:example.org", messageEvent("$e8", "@bot:example.org", { msgtype: "m.text", body: "自己" })),
        withRoom("!room:example.org", messageEvent("$e9", "@bob:example.org", {
          msgtype: "m.text",
          body: "* 编辑",
          "m.relates_to": { rel_type: "m.replace", event_id: "$e1" },
        })),
        withRoom("!room:example.org", messageEvent("$e10", "@bob:example.org", { msgtype: "m.notice", body: "通知" })),
        withRoom("!room:example.org", messageEvent("$e11", "@bob:example.org", { msgtype: "m.text", body: "  " })),
      ], ["!dm:example.org"]);
    });
    await waitFor(() => harness.messages.length >= 6);

    const byId = new Map(harness.messages.map((message) => [message.messageId, message]));
    const dm = byId.get("$e1")!;
    assert.equal(dm.kind, "dm");
    assert.equal(dm.chatId, "!dm:example.org");
    assert.equal(dm.text, "你好");
    assert.equal(dm.trigger.mention, true);
    assert.equal(dm.timestamp, 1_700_000_000_000);

    const mention = byId.get("$e2")!;
    assert.equal(mention.kind, "group");
    assert.equal(mention.trigger.mention, true);
    assert.equal(mention.text, "帮忙");
    assert.equal(mention.senderId, "@bob:example.org");

    const pill = byId.get("$e3")!;
    assert.equal(pill.trigger.mention, true);
    assert.equal(pill.text, "hi");

    const plain = byId.get("$e4")!;
    assert.equal(plain.trigger.mention, false);
    assert.equal(plain.text, "普通消息");

    const replyBot = byId.get("$e5")!;
    assert.equal(replyBot.trigger.replyToBot, true);
    assert.equal(replyBot.replyTo?.id, "$own1");
    assert.equal(replyBot.replyTo?.text, "占位");
    assert.equal(replyBot.replyTo?.sender, "@bot:example.org");

    const replyHuman = byId.get("$e6")!;
    assert.equal(replyHuman.trigger.replyToBot, false);
    assert.equal(replyHuman.replyTo?.id, "$humanMsg");

    const thread = byId.get("$e7")!;
    assert.equal(thread.threadId, "$root");

    for (const absent of ["$e8", "$e9", "$e10", "$e11"]) {
      assert.equal(byId.has(absent), false, `${absent} 不应 emit`);
    }

    const baseline = syncCount(harness);
    harness.deps.handle((call) => {
      if (!call.path.startsWith("/sync")) return { next_batch: "sN" };
      return syncPayload(
        [withRoom("!dm:example.org", messageEvent("$e1", "@alice:example.org", { msgtype: "m.text", body: "你好" }))],
        ["!dm:example.org"],
      );
    });
    await waitFor(() => syncCount(harness) >= baseline + 3);
    const dupCount = harness.messages.filter((message) => message.messageId === "$e1").length;
    assert.equal(dupCount, 1, "重复事件应被去重");
  });

  it("媒体消息下载进 mediaDir 并映射 kind/mime/name", async () => {
    const harness = await readyHarness();
    harness.deps.handle((call) => {
      if (!call.path.startsWith("/sync")) return { next_batch: "sN" };
      return syncPayload([
        withRoom("!dm:example.org", messageEvent("$m1", "@alice:example.org", {
          msgtype: "m.image",
          body: "photo.png",
          url: "mxc://example.org/abc123",
          info: { mimetype: "image/png", size: 9 },
        })),
        withRoom("!dm:example.org", messageEvent("$m2", "@alice:example.org", {
          msgtype: "m.file",
          body: "notes.txt",
          filename: "notes.txt",
          url: "mxc://example.org/file1",
          info: { mimetype: "text/plain", size: 9 },
        })),
      ], ["!dm:example.org"]);
    });
    await waitFor(() => harness.messages.length >= 2);

    const image = harness.messages.find((message) => message.messageId === "$m1")!;
    assert.equal(image.media?.length, 1);
    assert.equal(image.media[0]!.kind, "image");
    assert.equal(image.media[0]!.mime, "image/png");
    assert.equal(image.media[0]!.name, "photo.png");
    const bytes = await readFile(image.media[0]!.path);
    assert.equal(new TextDecoder().decode(bytes), "png-bytes");

    const file = harness.messages.find((message) => message.messageId === "$m2")!;
    assert.equal(file.media?.[0]!.kind, "file");
    const download = harness.deps.calls.find((call) => call.method === "MEDIA_DOWNLOAD")!;
    assert.equal(download.path, "mxc://example.org/abc123");
    assert.equal(download.body, 30 * 1024 * 1024, "图片下载上限受 imageMaxDownloadMb 约束");
  });

  it("邀请自动加入并标记 dm", async () => {
    const harness = await readyHarness();
    harness.deps.handle((call) => {
      if (call.method === "POST" && call.path.startsWith("/join/")) return { room_id: "!new:example.org" };
      if (!call.path.startsWith("/sync")) return { next_batch: "sN" };
      return {
        next_batch: "sInvite",
        rooms: {
          join: {},
          invite: {
            "!new:example.org": {
              invite_state: {
                events: [
                  { type: "m.room.member", state_key: "@bot:example.org", sender: "@alice:example.org", content: { membership: "invite", is_direct: true } },
                  { type: "m.room.name", state_key: "", sender: "@alice:example.org", content: { name: "测试房间" } },
                ],
              },
            },
          },
        },
      };
    });
    await waitFor(() => harness.groups.length >= 1, 5_000);
    assert.deepEqual(harness.groups[0], { chatId: "!new:example.org", title: "测试房间", added: true });
    assert.equal(harness.deps.restCalls("POST", "/join/!new%3Aexample.org").length, 1);
    await waitFor(async () => {
      const persisted = (await readFile(join(harness.dataDir, "matrix-state.json"), "utf8").catch(() => "{}")) as string;
      const state = JSON.parse(persisted || "{}") as { nextBatch?: string; dmRooms?: string[] };
      return state.nextBatch === "sInvite" && (state.dmRooms ?? []).includes("!new:example.org");
    });

    harness.deps.handle((call) => {
      if (!call.path.startsWith("/sync")) return { next_batch: "sN" };
      return syncPayload([withRoom("!new:example.org", messageEvent("$in1", "@alice:example.org", { msgtype: "m.text", body: "私聊消息" }))]);
    });
    await waitFor(() => harness.messages.some((message) => message.messageId === "$in1"));
    assert.equal(harness.messages.find((message) => message.messageId === "$in1")!.kind, "dm");
  });

  it("非永久 join 失败仅退避跳过，不阻塞后续批次摄取", async () => {
    const harness = await makeHarness();
    harness.deps.once((call) => call.path === "/account/whoami", () => ({ user_id: "@bot:example.org" }));
    const inviteBlock = { invite_state: { events: [] } };
    let eventSeq = 0;
    harness.deps.handle((call) => {
      if (!call.path.startsWith("/sync")) return { next_batch: "sN" };
      const payload = syncPayload([
        withRoom("!room:example.org", messageEvent(`$after${++eventSeq}`, "@bob:example.org", { msgtype: "m.text", body: "坏邀请之后的消息" })),
      ]);
      (payload.rooms as Record<string, unknown>).invite = { "!bad:example.org": inviteBlock };
      return payload;
    });
    harness.deps.once(
      (call) => call.method === "POST" && call.path.startsWith("/join/!bad%3Aexample.org"),
      () => new MatrixApiError("Matrix 请求失败（HTTP 503）", { status: 503 }),
    );
    harnesses.push(harness);
    await harness.adapter.start();
    await waitFor(() => harness.messages.length >= 3, 8_000);
    assert.ok(harness.logs.some((line) => line.includes("加入房间 !bad:example.org 失败")), "join 失败记 warn");
    assert.equal(harness.errors.length, 0, "join 失败不作为 error 上抛");
    assert.equal(
      harness.deps.restCalls("POST", "/join/!bad%3Aexample.org").length,
      1,
      "退避窗口内不重复尝试 join",
    );
    const state = JSON.parse(await readFile(join(harness.dataDir, "matrix-state.json"), "utf8")) as { nextBatch?: string };
    assert.match(state.nextBatch ?? "", /^b\d+$/, "next_batch 持续持久化推进");
  });

  it("ownIds 随状态持久化，重启后 replyToBot 启发式仍判定", async () => {
    const first = await makeHarness();
    first.deps.once((call) => call.path === "/account/whoami", () => ({ user_id: "@bot:example.org" }));
    first.deps.handle((call) => (call.path.startsWith("/sync") ? { next_batch: "s0" } : {}));
    harnesses.push(first);
    await first.adapter.start();
    first.deps.once(SEND_MATCH, () => ({ event_id: "$ownPersist" }));
    await first.adapter.sendText({ chatId: "!room:example.org", text: "重启前发送" });
    await waitFor(async () => {
      const state = JSON.parse(await readFile(join(first.dataDir, "matrix-state.json"), "utf8")) as { own?: string[] };
      return Array.isArray(state.own) && state.own.includes("$ownPersist");
    });
    await first.controller.abort();
    await first.adapter.stop().catch(() => {});

    const reopened = await makeHarness({}, { accessToken: "syt_test" }, first.dataDir);
    reopened.deps.once((call) => call.path === "/account/whoami", () => ({ user_id: "@bot:example.org" }));
    reopened.deps.handle((call) => {
      if (!call.path.startsWith("/sync")) return { next_batch: "sN" };
      return syncPayload([withRoom("!room:example.org", messageEvent("$replyAfterRestart", "@bob:example.org", {
        msgtype: "m.text",
        body: "重启后的回复",
        "m.relates_to": { "m.in_reply_to": { event_id: "$ownPersist" } },
      }))]);
    });
    harnesses.push(reopened);
    await reopened.adapter.start();
    await waitFor(() => reopened.messages.length >= 1);
    const reply = reopened.messages[0]!;
    assert.equal(reply.trigger.replyToBot, true, "重启后 ownIds 恢复，回复机器人仍触发");
    assert.equal(reply.replyTo?.id, "$ownPersist");
  });
});

describe("matrix 发送", () => {
  it("sendText 渲染白名单 HTML、支持回复引用并返回 messageId", async () => {
    const harness = await readyHarness();
    harness.deps.handle((call) => (SEND_MATCH(call) ? { event_id: "$sent1" } : { next_batch: "sN" }));
    const result = await harness.adapter.sendText({
      chatId: "!room:example.org",
      text: "**加粗** <script>alert(1)</script>\n第二行",
      replyToId: "$target",
    });
    assert.equal(result.messageId, "$sent1");
    const send = harness.deps.restCalls("PUT", "/rooms/!room%3Aexample.org/send/m.room.message/")[0]!;
    const body = send.body as Record<string, unknown>;
    assert.equal(body.msgtype, "m.text");
    assert.equal(body.format, "org.matrix.custom.html");
    assert.ok(String(body.formatted_body).includes("<b>加粗</b>"));
    assert.ok(!String(body.formatted_body).includes("<script>"));
    assert.ok(String(body.formatted_body).includes("<br/>"));
    assert.deepEqual(body["m.relates_to"], { "m.in_reply_to": { event_id: "$target" } });
    assert.equal(harness.adapter.isOwnMessage?.("$sent1"), true);
  });

  it("sendText 空文本直接返回空结果，不发送不触发 typing", async () => {
    const harness = await readyHarness();
    const result = await harness.adapter.sendText({ chatId: "!room:example.org", text: "   " });
    assert.deepEqual(result, {});
    assert.equal(harness.deps.restCalls("PUT", "/rooms/!room%3Aexample.org/send/").length, 0);
    assert.equal(harness.deps.restCalls("PUT", "/rooms/!room%3Aexample.org/typing/").length, 0);
  });

  it("超长文本按 16000 做 fence-aware 分块", async () => {
    const harness = await readyHarness();
    let eventSeq = 0;
    harness.deps.handle((call) => (SEND_MATCH(call) ? { event_id: `$c${++eventSeq}` } : { next_batch: "sN" }));
    const fenceText = `开头\n\`\`\`js\n${"y".repeat(20_000)}\n\`\`\`\n结尾`;
    const result = await harness.adapter.sendText({ chatId: "!room:example.org", text: fenceText });
    const sends = harness.deps.restCalls("PUT", "/rooms/!room%3Aexample.org/send/m.room.message/");
    assert.ok(sends.length >= 3);
    assert.equal(result.messageId, "$c3");
    for (const send of sends) {
      const body = send.body as Record<string, unknown>;
      assert.ok(String(body.body).length <= 16_000, "每个分块不超过 maxChunkChars");
      assert.equal(body.msgtype, "m.text");
    }
    const joined = sends.map((send) => (send.body as Record<string, unknown>).body).join("\n");
    assert.ok(joined.includes("开头"));
    assert.ok(joined.includes("结尾"));
    assert.equal(joined.split("y").length - 1, 20_000, "所有 y 都被发送");
    const fenceChunks = sends.filter((send) => String((send.body as Record<string, unknown>).body).includes("```"));
    assert.ok(fenceChunks.length >= 2, "围栏分块应重开围栏标记");
  });

  it("streamStart/streamAppend/streamFinish 走 m.replace 编辑流", async () => {
    const harness = await readyHarness();
    let seq = 0;
    harness.deps.handle((call) => (SEND_MATCH(call) ? { event_id: `$p${++seq}` } : { next_batch: "sN" }));
    const { streamId } = await harness.adapter.streamStart!("!room:example.org");
    assert.equal(streamId, "$p1");
    const placeholder = harness.deps.restCalls("PUT", "/rooms/")[0]!;
    assert.equal((placeholder.body as Record<string, unknown>).body, "正在处理…");

    await harness.adapter.streamAppend!(streamId, "部分结果");
    const edit = harness.deps.restCalls("PUT", "/rooms/")[1]!;
    const editBody = edit.body as Record<string, unknown>;
    assert.equal(editBody.body, "* 部分结果");
    assert.deepEqual(editBody["m.relates_to"], { rel_type: "m.replace", event_id: streamId });
    assert.equal((editBody["m.new_content"] as Record<string, unknown>).body, "部分结果");

    await harness.adapter.streamAppend!(streamId, "部分结果");
    assert.equal(harness.deps.restCalls("PUT", "/rooms/").length, 2, "相同文本跳过编辑");

    const finish = await harness.adapter.streamFinish!(streamId, "最终结果");
    assert.deepEqual(finish, { messageId: streamId });
    const finalEdit = harness.deps.restCalls("PUT", "/rooms/")[2]!;
    assert.equal((finalEdit.body as Record<string, unknown>).body, "* 最终结果");
  });

  it("sendTyping 立即发送并在发送消息后停止", async () => {
    const harness = await readyHarness();
    harness.deps.handle((call) => (call.path.startsWith("/sync") ? { next_batch: "sN" } : {}));
    const typingPath = "/rooms/!room%3Aexample.org/typing/%40bot%3Aexample.org";
    await harness.adapter.sendTyping!("!room:example.org");
    assert.equal(harness.deps.restCalls("PUT", typingPath).length, 1);
    assert.deepEqual(harness.deps.restCalls("PUT", typingPath)[0]!.body, { typing: true, timeout: 20_000 });

    await harness.adapter.sendText({ chatId: "!room:example.org", text: "答案" });
    const typingCalls = harness.deps.restCalls("PUT", typingPath);
    assert.equal(typingCalls.length, 2);
    assert.deepEqual(typingCalls[1]!.body, { typing: false });
  });

  it("sendTyping 周期续期由适配器定时重发", async (t) => {
    const harness = await readyHarness();
    harness.deps.handle((call) => (call.path.startsWith("/sync")
      ? new Promise<Record<string, unknown>>(() => {})
      : { next_batch: "sN" }));
    const typingPath = "/rooms/!room%3Aexample.org/typing/%40bot%3Aexample.org";
    const flush = async () => {
      for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
    };
    t.mock.timers.enable({ apis: ["setTimeout"] });
    await harness.adapter.sendTyping!("!room:example.org");
    t.mock.timers.tick(10_000);
    await flush();
    t.mock.timers.tick(10_000);
    await flush();
    const renewals = harness.deps.restCalls("PUT", typingPath);
    assert.ok(renewals.length >= 3, `typing 应续期，实际 ${renewals.length} 次`);
    assert.deepEqual(renewals[1]!.body, { typing: true, timeout: 20_000 });
    t.mock.timers.reset();
    await harness.adapter.stop();
    const afterStop = harness.deps.restCalls("PUT", typingPath).length;
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(harness.deps.restCalls("PUT", typingPath).length, afterStop, "stop 后不再续期");
  });

  it("sendMedia 上传 mxc 后发送 m.image", async () => {
    const harness = await readyHarness();
    harness.deps.handle((call) => (SEND_MATCH(call) ? { event_id: "$media1" } : { next_batch: "sN" }));
    const imagePath = join(harness.mediaDir, "out.png");
    await writeFile(imagePath, new Uint8Array([1, 2, 3, 4]));
    const result = await harness.adapter.sendMedia!({
      chatId: "!room:example.org",
      kind: "image",
      path: imagePath,
      name: "out.png",
    });
    assert.equal(result.messageId, "$media1");
    const upload = harness.deps.calls.find((call) => call.method === "MEDIA_UPLOAD")!;
    assert.ok(upload.path.includes("out.png"));
    const send = harness.deps.restCalls("PUT", "/rooms/!room%3Aexample.org/send/")[0]!;
    const body = send.body as Record<string, unknown>;
    assert.equal(body.msgtype, "m.image");
    assert.equal(body.url, "mxc://hs/uploaded");
    assert.deepEqual(body.info, { mimetype: "image/png", size: 4 });
  });

  it("leaveChat 调用 leave；isAdmin 读取 power_levels", async () => {
    const harness = await readyHarness();
    harness.deps.handle((call) => {
      if (call.path.includes("/state/m.room.power_levels")) {
        return { content: { users: { "@alice:example.org": 50 }, users_default: 0 } };
      }
      return { next_batch: "sN" };
    });
    assert.equal(await harness.adapter.isAdmin?.("!room:example.org", "@alice:example.org"), true);
    assert.equal(await harness.adapter.isAdmin?.("!room:example.org", "@bob:example.org"), false);
    await harness.adapter.leaveChat?.("!room:example.org");
    assert.equal(harness.deps.restCalls("POST", "/leave/!room%3Aexample.org").length, 1);
  });
});

describe("matrix 同步错误与重连", () => {
  it("瞬时错误触发 onError 与退避并持续重试", async () => {
    const harness = await readyHarness();
    let syncFailures = 2;
    harness.deps.handle((call) => {
      if (!call.path.startsWith("/sync")) return { next_batch: "sN" };
      if (syncFailures > 0) {
        syncFailures -= 1;
        return new MatrixApiError("Matrix 请求失败（HTTP 502）", { status: 502 });
      }
      return { next_batch: `s${syncCount(harness)}` };
    });
    await waitFor(() => harness.errors.length >= 2 && syncCount(harness) >= 4, 8_000);
    assert.ok(harness.errors.length >= 2);
    assert.ok(syncCount(harness) >= 4, "退避后继续重试");
  });

  it("401 M_UNKNOWN_TOKEN 报 UserFacingError 且循环停止", async () => {
    const harness = await readyHarness();
    harness.deps.handle((call) =>
      call.path.startsWith("/sync")
        ? new MatrixApiError("Matrix 请求失败（HTTP 401，M_UNKNOWN_TOKEN）", { status: 401, errcode: "M_UNKNOWN_TOKEN" })
        : { next_batch: "sN" },
    );
    await waitFor(() => harness.errors.length >= 1, 3_000);
    assert.equal(harness.errors.length, 1);
    assert.match(harness.errors[0]!.message, /访问令牌已失效/);
    const syncCalls = syncCount(harness);
    await waitFor(() => syncCount(harness) > syncCalls, 400).then(
      () => assert.fail("循环应已停止"),
      () => {},
    );
  });
});

describe("matrix format 工具", () => {
  it("splitFenceAware 保证分块不超过上限且不丢内容", () => {
    const text = "a".repeat(35_000);
    const chunks = splitFenceAware(text, 16_000);
    assert.equal(chunks.join(""), text);
    assert.ok(chunks.every((chunk) => chunk.length <= 16_000));
    const fenced = "前\n```js\ncode\n```\n后";
    assert.deepEqual(splitFenceAware(fenced, 16_000), [fenced]);
    const fenceText = `before\n\`\`\`js\n${"y".repeat(20_000)}\n\`\`\`\nafter`;
    const fenceChunks = splitFenceAware(fenceText, 100);
    assert.ok(fenceChunks.every((chunk) => chunk.length <= 100));
    assert.equal(fenceChunks.join("").split("y").length - 1, 20_000);
    assert.ok(fenceChunks[0]!.startsWith("before"));
    assert.ok(fenceChunks[fenceChunks.length - 1]!.endsWith("after"));
  });

  it("renderHtml 白名单化输出", () => {
    const html = renderHtml("**b** [x](https://ok.example.org) [y](javascript:bad) <em>i</em> ~~del~~\n新行");
    assert.ok(html.includes("<b>b</b>"));
    assert.ok(html.includes('<a href="https://ok.example.org">x</a>'));
    assert.ok(html.includes("<a>y</a>"));
    assert.ok(html.includes("<i>i</i>"));
    assert.ok(html.includes("del"));
    assert.ok(!html.includes("<del>"));
    assert.ok(html.includes("<br/>"));
    assert.ok(!html.includes("javascript:"));
  });
});

describe("matrix media download 重定向", () => {
  interface FetchRecord {
    url: string;
    redirect?: string;
  }

  const redirectDeps = (responses: Array<() => Response>): { deps: MatrixDeps; seen: FetchRecord[] } => {
    const seen: FetchRecord[] = [];
    let index = 0;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), redirect: (init as RequestInit | undefined)?.redirect });
      const respond = responses[index];
      index += 1;
      if (!respond) throw new Error("unexpected extra fetch");
      return respond();
    }) as typeof fetch;
    const deps = defaultDeps({ homeserver: "https://hs.example.org", token: () => "t", fetchImpl });
    return { deps, seen };
  };
  const ok = () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/png" } });
  const to = (location: string) => () => new Response(null, { status: 302, headers: { location } });

  it("同域重定向按 manual 模式跟随并成功下载", async () => {
    const { deps, seen } = redirectDeps([
      to("https://hs.example.org/_matrix/client/v3/media/download/abc?alt=1"),
      ok,
    ]);
    const result = await deps.mediaDownload("mxc://hs.example.org/abc", 1024);
    assert.equal(new TextDecoder().decode(result.bytes), "\u0001\u0002\u0003");
    assert.equal(result.mime, "image/png");
    assert.equal(seen.length, 2);
    assert.equal(seen[0]!.redirect, "manual", "媒体下载不使用自动重定向");
    assert.match(seen[1]!.url, /alt=1/);
  });

  it("重定向到外部主机被拒绝", async () => {
    const { deps, seen } = redirectDeps([to("https://evil.example.net/mxc")]);
    await assert.rejects(
      () => deps.mediaDownload("mxc://hs.example.org/abc", 1024),
      (error: unknown) => error instanceof MatrixApiError && error.message.includes("homeserver 域"),
    );
    assert.equal(seen.length, 1, "外部主机不发起第二次请求");
  });

  it("重定向超过 3 跳被拒绝", async () => {
    const { deps, seen } = redirectDeps([
      to("https://hs.example.org/hop1"),
      to("https://hs.example.org/hop2"),
      to("https://hs.example.org/hop3"),
      to("https://hs.example.org/hop4"),
      ok,
    ]);
    await assert.rejects(
      () => deps.mediaDownload("mxc://hs.example.org/abc", 1024),
      (error: unknown) => error instanceof MatrixApiError && error.message.includes("跳"),
    );
    assert.equal(seen.length, 4, "初始请求 + 3 跳后停止");
  });
});
