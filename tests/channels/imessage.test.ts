/** iMessage 渠道适配器测试：全部走注入的假传输（runSql/runOsa），
 * 不触真实 sqlite3/osascript，无网络、无真实定时等待——
 * 用 SqlGate 的调用信号 + stop() 的完成屏障保证确定性。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterContext, ChannelAdapter } from "../../server/channels/types.ts";
import {
  IMESSAGE_BOT_PREFIX,
  createAdapter,
  definition,
  normalizeImessageRow,
  sendScript,
  type ImessageConnection,
  type ImessageDeps,
} from "../../server/channels/imessage/index.ts";
import { decodeAttributedBodyText } from "../../server/channels/imessage/typedstream.ts";
import { UserFacingError } from "../../shared/errors.ts";
import type { NormalizedMessage } from "../../shared/model.ts";
import type { ImSettings } from "../../shared/settings.ts";

const SETTINGS: ImSettings = {
  imageMaxDownloadMb: 30,
  imageMaxSingleMb: 5,
  imageMaxTotalMb: 20,
  imageMaxCount: 20,
  busyMode: "queue",
  attachmentTtlHours: 168,
  deferTimeoutMinutes: 30,
};

const CONNECTION: ImessageConnection = {
  id: "b7c1d0e2-1111-4222-8333-444455556666",
  name: "iMessage 测试",
  channel: "imessage",
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
};

type SqlRow = Record<string, unknown>;

/** runSql 调用栅栏：`await gate.call(k)` 在第 k 次 runSql 发生时 resolve。
 * 适配器只在上一轮轮询（含状态持久化）完全结束后才发起下一次调用，
 * 因此「第 k 次调用已发生」即证明第 k-1 轮已完成。 */
class SqlGate {
  #count = 0;
  #waiters: { at: number; resolve: () => void }[] = [];

  call(at: number): Promise<void> {
    if (this.#count >= at) return Promise.resolve();
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    this.#waiters.push({ at, resolve });
    return promise;
  }

  arrive(): void {
    this.#count += 1;
    this.#waiters = this.#waiters.filter((waiter) => {
      if (waiter.at > this.#count) return true;
      waiter.resolve();
      return false;
    });
  }
}

interface HarnessOptions {
  dataDir?: string;
  /** 每次轮询按顺序消费一批行；Error 项表示该次查询抛错。 */
  pollBatches?: (SqlRow[] | Error)[];
  probeError?: Error;
  maxRowIdError?: Error;
  initialMaxRowId?: number;
  runOsa?: (script: string) => Promise<string>;
}

interface Harness {
  adapter: ChannelAdapter;
  ctx: AdapterContext<ImessageConnection>;
  gate: SqlGate;
  dataDir: string;
  queries: string[];
  sent: string[];
  received: NormalizedMessage[];
  errors: Error[];
  logs: string[];
  pollBatches: (SqlRow[] | Error)[];
}

function createHarness(options: HarnessOptions = {}): Harness {
  // 每个实例独享临时目录：启动失败路径不落盘，成功路径互不可见。
  const dataDir = options.dataDir ?? join(tmpdir(), `paseo-imessage-${randomUUID()}`);
  const gate = new SqlGate();
  const queries: string[] = [];
  const sent: string[] = [];
  const received: NormalizedMessage[] = [];
  const errors: Error[] = [];
  const logs: string[] = [];
  const pollBatches = options.pollBatches ?? [];
  const deps: ImessageDeps = {
    pollIntervalMs: 5,
    backoffMs: [5, 5],
    runSql: async (query) => {
      queries.push(query);
      gate.arrive();
      if (query.startsWith("SELECT 1")) {
        if (options.probeError) throw options.probeError;
        return [];
      }
      if (query.includes("MAX(m.ROWID)")) {
        if (options.maxRowIdError) throw options.maxRowIdError;
        return [{ rowid: options.initialMaxRowId ?? 40 }];
      }
      const next = pollBatches.shift();
      if (next instanceof Error) throw next;
      return next ?? [];
    },
    runOsa:
      options.runOsa ??
      (async (script) => {
        sent.push(script);
        return "";
      }),
  };
  const ctx: AdapterContext<ImessageConnection> = {
    connectionId: CONNECTION.id,
    config: CONNECTION,
    secrets: {},
    dataDir,
    mediaDir: join(dataDir, "media"),
    signal: new AbortController().signal,
    settings: async () => SETTINGS,
    log: (level, message) => logs.push(`${level}: ${message}`),
    onMessage: (message) => received.push(message),
    onGroups: () => {},
    onError: (error) => errors.push(error),
  };
  const adapter = createAdapter(ctx, deps);
  return {
    adapter,
    ctx,
    gate,
    dataDir,
    queries,
    sent,
    received,
    errors,
    logs,
    pollBatches,
  };
}

/** 构造一段 attributedBody typedstream blob：前缀字节 + "NSString" +
 * 0x2b 标签 + 单字节长度 + UTF-8 内容，再转 hex（模拟 hex(m.attributedBody)）。 */
function typedstreamHex(text: string): string {
  const payload = Buffer.from(text, "utf8");
  return Buffer.concat([
    Buffer.from([0x04, 0x0b, 0x01, 0x00]),
    Buffer.from("NSString", "utf8"),
    Buffer.from([0x2b, payload.length]),
    payload,
  ]).toString("hex");
}

/** chat.db 行（与 pollQuery 的 SQL 别名一致）。 */
function imessageRow(overrides: Record<string, unknown> = {}): SqlRow {
  return {
    rowid: 41,
    guid: "guid-41",
    text: "你好",
    attributedBodyHex: null,
    sender: "+8613800000000",
    chatGuid: "iMessage;-;+8613800000000",
    serviceName: "iMessage",
    isFromMe: 0,
    receivedAt: "2026-01-02 03:04:05",
    ...overrides,
  };
}

function statePath(dataDir: string): string {
  return join(dataDir, "imessage-state.json");
}

/** 在 darwin 门禁下执行异步操作：assertDarwin 在同步前缀执行，补丁窗口
 * 覆盖整个调用即可；轮询循环不再复查平台。 */
async function asDarwin<T>(fn: () => Promise<T>): Promise<T> {
  const original = process.platform;
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, "platform", { value: original, configurable: true });
  }
}

test("definition：渠道与能力（不分块、无媒体、无 typing）", () => {
  assert.equal(definition.channel, "imessage");
  const adapter = definition.create(createHarness().ctx);
  assert.deepEqual(adapter.capabilities, {
    progress: "none",
    markdown: "plain",
    uploadImage: false,
    uploadFile: false,
    reactions: false,
    typing: false,
    maxChunkChars: 0,
    threads: false,
  });
});

test("configure：无必填字段，空字段返回空 config/secrets", () => {
  assert.deepEqual(definition.configure({}), { config: {}, secrets: {} });
  const result = definition.configure({ note: " 备注值 " });
  assert.deepEqual(result, { config: { note: "备注值" }, secrets: {} });
});

test("testConnection：db 与 Messages 自动化均可用 → ok", async () => {
  const h = createHarness({ pollBatches: [] });
  assert.ok(h.adapter.testConnection, "testConnection 应当实现");
  const result = await asDarwin(() => h.adapter.testConnection!());
  assert.equal(result.ok, true);
  assert.match(result.detail ?? "", /可用/);
  assert.ok(h.sent[0].includes('tell application "Messages" to get name'));
});

test("testConnection：Messages 自动化不可用 → ok=false 中文提示", async () => {
  const h = createHarness({
    pollBatches: [],
    runOsa: async () => {
      throw new Error("script error: Not authorized to send Apple events (-1743).");
    },
  });
  assert.ok(h.adapter.testConnection, "testConnection 应当实现");
  const result = await asDarwin(() => h.adapter.testConnection!());
  assert.equal(result.ok, false);
  assert.match(result.detail ?? "", /自动化/);
});

test("testConnection：非 macOS → ok=false 中文提示", async () => {
  const h = createHarness({ pollBatches: [] });
  assert.ok(h.adapter.testConnection, "testConnection 应当实现");
  const original = process.platform;
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  try {
    const result = await h.adapter.testConnection();
    assert.equal(result.ok, false);
    assert.match(result.detail ?? "", /仅支持 macOS/);
    assert.equal(h.queries.length, 0);
  } finally {
    Object.defineProperty(process, "platform", { value: original, configurable: true });
  }
});

test("非 macOS：checkPlatform 抛 UserFacingError（中文提示）", () => {
  const original = process.platform;
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  try {
    assert.throws(() => definition.checkPlatform?.(), UserFacingError);
    try {
      definition.checkPlatform?.();
      assert.fail("应当抛出");
    } catch (error) {
      assert.match((error as Error).message, /仅支持 macOS/);
    }
  } finally {
    Object.defineProperty(process, "platform", { value: original, configurable: true });
  }
});

test("checkPlatform 在 darwin 放行", () => {
  const original = process.platform;
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
  try {
    assert.doesNotThrow(() => definition.checkPlatform?.());
  } finally {
    Object.defineProperty(process, "platform", { value: original, configurable: true });
  }
});

test("非 macOS：start 拒绝启动且不触达传输层", async () => {
  const h = createHarness({ pollBatches: [] });
  const original = process.platform;
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  try {
    await assert.rejects(() => h.adapter.start(), UserFacingError);
  } finally {
    Object.defineProperty(process, "platform", { value: original, configurable: true });
  }
  assert.equal(h.queries.length, 0);
});

test("normalize：私聊文本行", () => {
  const message = normalizeImessageRow(imessageRow(), "conn-1");
  assert.ok(message);
  assert.equal(message.channel, "imessage");
  assert.equal(message.connectionId, "conn-1");
  assert.equal(message.kind, "dm");
  assert.equal(message.chatId, "+8613800000000");
  assert.equal(message.senderId, "+8613800000000");
  assert.equal(message.senderName, "+8613800000000");
  assert.equal(message.messageId, "guid-41");
  assert.equal(message.text, "你好");
  assert.equal(message.timestamp, Date.parse("2026-01-02T03:04:05Z"));
  assert.deepEqual(message.trigger, { mention: false, replyToBot: false, command: false });
});

test("normalize：macOS 26 attributedBody hex 解码", () => {
  const message = normalizeImessageRow(
    imessageRow({ text: null, attributedBodyHex: typedstreamHex("来自 macOS 26") }),
    "conn-1",
  );
  assert.equal(message?.text, "来自 macOS 26");
});

test("normalize：仅附件（U+FFFC）无文本 → 不 emit", () => {
  const message = normalizeImessageRow(
    imessageRow({ text: null, attributedBodyHex: typedstreamHex("￼") }),
    "conn-1",
  );
  assert.equal(message, null);
});

test("typedstream：0x81 两字节长度（32KB-64KB 长文本）解码", () => {
  const text = "中".repeat(12_000); // 36,000 UTF-8 字节，落在 32KB-64KB 区间
  const payload = Buffer.from(text, "utf8");
  const length = Buffer.alloc(2);
  length.writeUInt16LE(payload.length);
  const blob = Buffer.concat([
    Buffer.from([0x04, 0x0b, 0x01, 0x00]),
    Buffer.from("NSString", "utf8"),
    Buffer.from([0x2b, 0x81]),
    length,
    payload,
  ]).toString("hex");
  assert.equal(decodeAttributedBodyText(blob), text);
  const message = normalizeImessageRow(imessageRow({ text: null, attributedBodyHex: blob }), "conn-1");
  assert.equal(message?.text, text);
});

test("typedstream：宣称长度越界/超上限 → 拒绝解码", () => {
  const prefix = Buffer.concat([
    Buffer.from([0x04, 0x0b, 0x01, 0x00]),
    Buffer.from("NSString", "utf8"),
    Buffer.from([0x2b, 0x81]),
  ]);
  // 宣称 65,535 字节但负载只有 4 字节 → 越界拒绝
  const overBoundary = Buffer.concat([prefix, Buffer.from([0xff, 0xff, 1, 2, 3, 4])]);
  assert.equal(decodeAttributedBodyText(overBoundary), null);
  // 宣称长度合法但内容不是合法 UTF-8 → 拒绝
  const badUtf8 = Buffer.concat([prefix, Buffer.from([0x03, 0x00, 0xff, 0xfe, 0xfd])]);
  assert.equal(decodeAttributedBodyText(badUtf8), null);
});

test("normalize：机器人回环前缀 → 跳过", () => {
  const message = normalizeImessageRow(
    imessageRow({ text: `${IMESSAGE_BOT_PREFIX}已收到` }),
    "conn-1",
  );
  assert.equal(message, null);
});

test("normalize：is_from_me / 非 iMessage 服务 / 缺文本或发送人 → 跳过", () => {
  assert.equal(normalizeImessageRow(imessageRow({ isFromMe: 1 }), "conn-1"), null);
  assert.equal(normalizeImessageRow(imessageRow({ serviceName: "SMS" }), "conn-1"), null);
  assert.equal(
    normalizeImessageRow(imessageRow({ text: null, attributedBodyHex: null }), "conn-1"),
    null,
  );
  assert.equal(normalizeImessageRow(imessageRow({ sender: null }), "conn-1"), null);
  assert.equal(normalizeImessageRow(imessageRow({ guid: null }), "conn-1"), null);
});

test("normalize：receivedAt 无法解析时退回当前时间", () => {
  const message = normalizeImessageRow(imessageRow({ receivedAt: "garbage" }), "conn-1", () => 7777);
  assert.equal(message?.timestamp, 7777);
});

test("sendScript：whose-clause 动态取服务并转义（引号/反斜杠）", () => {
  // sendScript 只负责转义与服务解析；回环前缀在 sendText 层添加。
  assert.equal(
    sendScript("+8613800000000", '他说 "hi"\\再见'),
    'tell application "Messages"\n'
    + "  set serviceList to every service whose service type = iMessage\n"
    + '  if (count of serviceList) is 0 then error "No iMessage service is available"\n'
    + "  set targetService to item 1 of serviceList\n"
    + '  set targetBuddy to buddy "+8613800000000" of targetService\n'
    + '  send "他说 \\"hi\\"\\\\再见" to targetBuddy\n'
    + "end tell",
  );
});

test("sendText：出站加回环前缀并转义引号与反斜杠", async () => {
  const h = createHarness({ pollBatches: [] });
  await h.adapter.sendText({ chatId: "+8613800000000", text: '他说 "hi"\\再见' });
  assert.equal(h.sent.length, 1);
  assert.equal(
    h.sent[0],
    'tell application "Messages"\n'
    + "  set serviceList to every service whose service type = iMessage\n"
    + '  if (count of serviceList) is 0 then error "No iMessage service is available"\n'
    + "  set targetService to item 1 of serviceList\n"
    + '  set targetBuddy to buddy "+8613800000000" of targetService\n'
    + '  send "🤖 Paseo\\n他说 \\"hi\\"\\\\再见" to targetBuddy\n'
    + "end tell",
  );
});

test("sendText：无可用 iMessage 服务 → 中文可执行提示", async () => {
  const h = createHarness({
    pollBatches: [],
    runOsa: async () => {
      throw new Error("script error: No iMessage service is available (-2700).");
    },
  });
  await assert.rejects(
    () => h.adapter.sendText({ chatId: "+8613800000000", text: "hi" }),
    (error: unknown) => {
      assert.ok(error instanceof UserFacingError);
      assert.match(error.message, /iMessage 服务/);
      return true;
    },
  );
});

test("sendScript：剔除 AppleScript 不支持的控制字符（保留 \\t 之外全部 C0）", () => {
  const script = sendScript("user@example.com", "a\u0000b\u0007c\u000bd\u001fe\td\\f\"g");
  assert.ok(!/[\u0000-\u0007\u000b\u000e-\u001f]/.test(script), "脚本不得含裸控制字符");
  assert.match(script, /send "abcde\\td\\\\f\\"g"/, "保留 \\t 转义与既有引号/反斜杠转义");
});

test("sendText：已带前缀的文本不重复加前缀", async () => {
  const h = createHarness({ pollBatches: [] });
  await h.adapter.sendText({ chatId: "user@example.com", text: `${IMESSAGE_BOT_PREFIX}第二次` });
  assert.match(h.sent[0], /send "🤖 Paseo\\n第二次"/);
  assert.ok(!h.sent[0].includes("Paseo\\n🤖"));
});

test("sendText：收件人与文本校验", async () => {
  const h = createHarness({ pollBatches: [] });
  await assert.rejects(() => h.adapter.sendText({ chatId: "", text: "hi" }), UserFacingError);
  await assert.rejects(() => h.adapter.sendText({ chatId: "a\nb", text: "hi" }), UserFacingError);
  await assert.rejects(
    () => h.adapter.sendText({ chatId: "+8613800000000", text: "  " }),
    UserFacingError,
  );
  assert.equal(h.sent.length, 0);
});

test("sendText：自动化权限错误 → 中文可执行提示", async () => {
  const h = createHarness({
    pollBatches: [],
    runOsa: async () => {
      throw new Error("script error: Not authorized to send Apple events (-1743).");
    },
  });
  await assert.rejects(
    () => h.adapter.sendText({ chatId: "+8613800000000", text: "hi" }),
    (error: unknown) => {
      assert.ok(error instanceof UserFacingError);
      assert.match(error.message, /自动化/);
      return true;
    },
  );
});

test("启动错误：数据库权限 → 完全磁盘访问提示", async () => {
  const h = createHarness({
    pollBatches: [],
    probeError: new Error("Error: in prepare, authorization denied"),
  });
  await assert.rejects(
    () => asDarwin(() => h.adapter.start()),
    (error: unknown) => {
      assert.ok(error instanceof UserFacingError);
      assert.match(error.message, /完全磁盘访问/);
      return true;
    },
  );
});

test("启动错误：其他数据库故障 → 中文提示", async () => {
  const h = createHarness({ pollBatches: [], probeError: new Error("sqlite3: not found") });
  await assert.rejects(
    () => asDarwin(() => h.adapter.start()),
    (error: unknown) => {
      assert.ok(error instanceof UserFacingError);
      assert.match(error.message, /无法读取 iMessage 数据库/);
      return true;
    },
  );
});

test("启动错误：游标初始化失败 → 中文提示", async () => {
  const h = createHarness({ pollBatches: [], maxRowIdError: new Error("disk I/O error") });
  await assert.rejects(
    () => asDarwin(() => h.adapter.start()),
    (error: unknown) => {
      assert.ok(error instanceof UserFacingError);
      assert.match(error.message, /游标/);
      return true;
    },
  );
});

test("轮询：probe → max(ROWID) 初始化游标 → 批量 normalize → cursor 持久化", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "paseo-imessage-"));
  const h = createHarness({
    dataDir,
    initialMaxRowId: 40,
    pollBatches: [
      [
        imessageRow({ rowid: 41, guid: "guid-41", text: "你好", receivedAt: "2026-01-02 03:04:05" }),
        imessageRow({ rowid: 42, guid: "guid-42", text: `${IMESSAGE_BOT_PREFIX}已收到` }),
        imessageRow({
          rowid: 43,
          guid: "guid-43",
          text: null,
          attributedBodyHex: typedstreamHex("解码消息"),
        }),
      ],
    ],
  });
  await asDarwin(() => h.adapter.start());
  // 第 4 次 runSql = 第二轮轮询：证明首轮（含持久化）已完成。
  await h.gate.call(4);
  await h.adapter.stop();

  assert.equal(h.queries[0], "SELECT 1 AS ok LIMIT 1;");
  assert.match(h.queries[1], /MAX\(m\.ROWID\)/);
  const poll1 = h.queries[2];
  assert.match(poll1, /WHERE m\.ROWID > 40 AND m\.is_from_me = 0/);
  assert.match(poll1, /c\.service_name = 'iMessage'/);
  assert.match(poll1, /JOIN chat_message_join cmj ON cmj\.message_id = m\.ROWID/);
  assert.match(poll1, /LEFT JOIN handle h ON h\.ROWID = m\.handle_id/);
  assert.match(poll1, /hex\(m\.attributedBody\) AS attributedBodyHex/);
  assert.match(poll1, /ORDER BY m\.ROWID ASC LIMIT 100/);
  assert.match(h.queries[3], /WHERE m\.ROWID > 43/);

  assert.deepEqual(
    h.received.map((message) => message.messageId),
    ["guid-41", "guid-43"],
  );
  assert.deepEqual(h.received[0], {
    channel: "imessage",
    connectionId: CONNECTION.id,
    kind: "dm",
    chatId: "+8613800000000",
    senderId: "+8613800000000",
    senderName: "+8613800000000",
    messageId: "guid-41",
    timestamp: Date.parse("2026-01-02T03:04:05Z"),
    text: "你好",
    trigger: { mention: false, replyToBot: false, command: false },
  });
  assert.deepEqual(JSON.parse(await readFile(statePath(dataDir), "utf8")), {
    cursor: 43,
    seen: ["guid-41", "guid-43"],
  });
  assert.equal(h.errors.length, 0);
});

test("重启：从持久化 cursor 续跑，不再初始化历史", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "paseo-imessage-"));
  const first = createHarness({
    dataDir,
    initialMaxRowId: 40,
    pollBatches: [[imessageRow({ rowid: 43, guid: "guid-43", text: "继续" })]],
  });
  await asDarwin(() => first.adapter.start());
  await first.gate.call(4); // probe, max, poll1, poll2
  await first.adapter.stop();

  const second = createHarness({ dataDir, pollBatches: [] });
  await asDarwin(() => second.adapter.start());
  await second.gate.call(2); // probe, poll1（无 max 初始化）
  await second.adapter.stop();

  assert.ok(!second.queries.some((query) => query.includes("MAX(m.ROWID)")));
  assert.match(second.queries[1], /WHERE m\.ROWID > 43/);
  assert.equal(second.received.length, 0);
});

test("seen 去重：同 guid 新 rowid 不重复 emit，cursor 仍推进", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "paseo-imessage-"));
  const h = createHarness({
    dataDir,
    initialMaxRowId: 40,
    pollBatches: [[imessageRow({ rowid: 41, guid: "guid-41", text: "第一遍" })]],
  });
  await asDarwin(() => h.adapter.start());
  await h.gate.call(4); // probe, max, poll1(emit), poll2
  assert.equal(h.received.length, 1);

  h.pollBatches.push([imessageRow({ rowid: 44, guid: "guid-41", text: "重复投递" })]);
  await h.gate.call(6); // poll3(去重), poll4
  await h.adapter.stop();

  assert.equal(h.received.length, 1);
  assert.deepEqual(JSON.parse(await readFile(statePath(dataDir), "utf8")), {
    cursor: 44,
    seen: ["guid-41"],
  });
});

test("emit 抛错：cursor 停在该行之前，下一轮重发且不重复", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "paseo-imessage-"));
  const h = createHarness({
    dataDir,
    initialMaxRowId: 40,
    pollBatches: [
      [
        imessageRow({ rowid: 41, guid: "guid-41", text: "第一条" }),
        imessageRow({ rowid: 42, guid: "guid-42", text: "emit 会失败" }),
      ],
      [imessageRow({ rowid: 42, guid: "guid-42", text: "重发成功" })],
    ],
  });
  let failFirst = true;
  const inner = h.ctx.onMessage;
  h.ctx.onMessage = (message) => {
    if (failFirst && message.messageId === "guid-42") {
      failFirst = false;
      throw new Error("emit boom");
    }
    inner(message);
  };
  await asDarwin(() => h.adapter.start());
  await h.gate.call(4); // probe, max, poll1(第 2 条 emit 抛错), poll2(重发)
  await h.adapter.stop();

  assert.match(h.errors[0]!.message, /emit boom/);
  assert.deepEqual(
    h.received.map((message) => message.messageId),
    ["guid-41", "guid-42"],
    "guid-41 不重复投递，guid-42 下轮重发",
  );
  assert.match(h.queries[3], /WHERE m\.ROWID > 41/, "cursor 停在失败行之前（41 而非 42）");
  assert.deepEqual(JSON.parse(await readFile(statePath(dataDir), "utf8")), {
    cursor: 42,
    seen: ["guid-41", "guid-42"],
  });
});

test("瞬时轮询错误：onError + 日志 + 退避后重试", async () => {
  const h = createHarness({
    pollBatches: [new Error("SQLITE_BUSY: database is locked")],
  });
  await asDarwin(() => h.adapter.start());
  await h.gate.call(4); // probe, max, poll1(抛错), poll2(退避重试)
  await h.adapter.stop();

  assert.match(h.errors[0].message, /SQLITE_BUSY/);
  assert.ok(h.logs.some((line) => line.includes("重试")));
  // 退避后至少重试了一次；stop 前轮询仍在继续，精确次数取决于调度。
  assert.ok(h.queries.filter((query) => query.includes("m.ROWID >")).length >= 2);
  assert.equal(h.received.length, 0);
});
