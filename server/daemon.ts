import { readFile } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { WebSocket } from "ws";
import { createPaseoApi, type PaseoApi } from "@getpaseo/client";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";

/** Local daemon discovery and credential handshake, mirroring the CLI. The
 * bridge needs a long-lived API; plugins receive one only inside RPCs/hooks. */
export function localTarget(listen: string): { url: string; socketPath?: string } {
  if (listen.startsWith("unix://")) listen = listen.slice(7);
  if (listen.startsWith("pipe://")) {
    return { url: "ws://localhost/ws", socketPath: listen.slice(7) };
  }
  if (listen.startsWith("\\\\.\\pipe\\")) {
    return { url: "ws://localhost/ws", socketPath: listen };
  }
  if (isAbsolute(listen)) {
    return { url: `ws+unix://${listen}:/ws`, socketPath: listen };
  }
  const match = /^(?:tcp:\/\/)?(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|\[::\]):(\d{1,5})$/.exec(listen);
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 65535) {
    throw new Error("本地 Paseo daemon 没有可用的回环监听地址");
  }
  const host = match[1] === "0.0.0.0" ? "127.0.0.1" : match[1] === "[::]" ? "[::1]" : match[1];
  return { url: `ws://${host}:${match[2]}/ws` };
}

export interface DaemonConnection {
  api: PaseoApi;
  serverId: string | null;
  close(): Promise<void>;
}

export async function connectLocalDaemon(home: string): Promise<DaemonConnection> {
  const lock: { pid?: number; listen?: string; serverId?: string } = JSON.parse(
    await readFile(join(home, "paseo.pid"), "utf8"),
  );
  if (!Number.isSafeInteger(lock.pid) || typeof lock.listen !== "string") {
    throw new Error("等待本地 Paseo daemon 监听信息");
  }
  const target = localTarget(lock.listen);
  const client = new DaemonClient({
    url: target.url,
    clientId: "paseo-im",
    clientType: "cli",
    // Keep in sync with the @getpaseo/client version in package.json: the daemon
    // uses this string to gate client capabilities.
    appVersion: "0.17.3",
    connectTimeoutMs: 8000,
    localCredential: async () => {
      const current: { pid?: number; listen?: string } = JSON.parse(
        await readFile(join(home, "paseo.pid"), "utf8"),
      );
      if (current.pid !== lock.pid || current.listen !== lock.listen) {
        throw new Error("本地 daemon 实例已更换");
      }
      try {
        const token = (await readFile(join(home, "local-credential"), "utf8")).trim();
        return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : undefined;
      } catch {
        return undefined;
      }
    },
    webSocketFactory: (url, options) => {
      const socket = new WebSocket(url, options?.protocols, {
        headers: options?.headers,
        ...(target.socketPath ? { socketPath: target.socketPath } : {}),
      });
      return {
        get readyState() {
          return socket.readyState;
        },
        send: (data) => socket.send(data),
        close: (code, reason) => socket.close(code, reason),
        on: (event, listener) => socket.on(event, listener),
        off: (event, listener) => socket.off(event, listener),
      };
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    reconnect: { enabled: true, baseDelayMs: 1000, maxDelayMs: 15_000 },
  });
  try {
    await client.connect();
  } catch {
    await client.close().catch(() => {});
    throw new Error("无法连接本地 Paseo daemon");
  }
  return {
    api: createPaseoApi(client),
    serverId: lock.serverId ?? null,
    close: async () => {
      await client.close();
    },
  };
}
