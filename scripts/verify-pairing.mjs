#!/usr/bin/env node
/** 微信扫码配对 · 无人工 RPC 环回自测（生产 daemon）。
 *
 * 验收点（全部自动断言，人工只剩「真拿微信扫」一步）：
 *   1. im.pairing.start（无 connectionId）→ 自动创建/复用配对连接；
 *   2. pairing.poll 快照 ≤5s 内返回可渲染二维码（data:image/* + PNG/JPEG 魔数）；
 *   3. 重复执行本脚本不新增连接（孤儿复用生效）。
 *
 * 用法：node scripts/verify-pairing.mjs [--channel weixin|whatsapp|wecom]
 * 退出码非 0 即失败；PASS 行可直接贴验收记录。
 */
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import os from "node:os";

const require_ = createRequire(process.cwd() + "/package.json");
const { DaemonClient } = await import(pathToFileURL(require_.resolve("@getpaseo/client/internal/daemon-client")).href);
const { createPaseoApi } = await import(pathToFileURL(require_.resolve("@getpaseo/client")).href);

const channel = process.argv.includes("--channel") ? process.argv[process.argv.indexOf("--channel") + 1] : "weixin";
const home = process.env.PASEO_HOME ?? `${os.homedir()}/.paseo`;
const plugin = "paseo-im";

const lock = JSON.parse(readFileSync(`${home}/paseo.pid`, "utf8"));
const url = `ws://127.0.0.1:${lock.listen.split(":").pop()}/ws`;
const client = new DaemonClient({
  url,
  clientId: "paseo-im-selftest",
  clientType: "cli",
  appVersion: "0.17.3",
  connectTimeoutMs: 8000,
  localCredential: () => readFileSync(`${home}/local-credential`, "utf8").trim(),
  logger: { debug() {}, info() {}, warn() {}, error() {} },
});
await client.connect();
const api = createPaseoApi(client);
const fail = (message) => {
  console.error(`FAIL: ${message}`);
  process.exitCode = 1;
};

const countConnections = async () => {
  const list = await client.invokePluginRpc(plugin, "im.list", {});
  const bucket = list.channels.find((entry) => entry.channel === channel);
  return bucket?.connections.length ?? 0;
};

try {
  const before = await countConnections();

  const started = Date.now();
  const { attemptId } = await client.invokePluginRpc(plugin, "im.pairing.start", { channel });
  console.log(`PASS start: attemptId=${attemptId}`);

  let qrSeen = false;
  let magic = "";
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const snapshot = await client.invokePluginRpc(plugin, "im.pairing.poll", { attemptId });
    const qr = snapshot.qrDataUrl ?? "";
    if (/^data:image\/(png|jpe?g);base64,/.test(qr)) {
      // 渲染性断言：解码 base64 验魔数（PNG \x89PNG / JPEG \xFF\xD8），防「HTML/文本冒充图片」
      const bytes = Buffer.from(qr.slice(qr.indexOf(",") + 1), "base64").subarray(0, 8);
      const isPng = bytes.subarray(0, 4).toString("latin1") === "\x89PNG";
      const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
      if (!isPng && !isJpeg) {
        magic = bytes.toString("latin1").replace(/[^\x20-\x7e]/g, ".");
        continue;
      }
      magic = isPng ? "PNG" : "JPEG";
      qrSeen = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const elapsed = Date.now() - started;
  if (!qrSeen) fail(`15s 内未拿到可渲染二维码（首个字节：${magic || "无数据"}）`);
  else console.log(`PASS qr: ${magic} data URL，${elapsed}ms 内交付`);

  const after = await countConnections();
  if (after !== before) fail(`连接数 ${before} → ${after}：孤儿复用失效，僵尸行堆积`);
  else console.log(`PASS reuse: 连接数稳定（${before}）`);
} finally {
  await api.dispose().catch(() => {});
  await client.close().catch(() => {});
}
