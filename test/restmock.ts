// What the REST adapter tests share: a local server that speaks a provider's wire format,
// a router with one adapter, and the lifecycle every provider must get through.
import { afterEach, expect } from "vitest";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { SandboxRouter, MemoryLedger, type ProviderAdapter } from "../src/index.js";

export interface Req {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingMessage["headers"];
  body: Buffer;
  // A mocked request body is whatever the adapter under test sent.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json: () => any;
}
export type Reply = { status?: number; json?: unknown; raw?: Buffer | string; type?: string; headers?: Record<string, string> };

const servers: Server[] = [];
afterEach(() => servers.splice(0).forEach((s) => s.close()));

/** The server side of one WebSocket the mock accepted (RFC 6455, unmasked server frames). */
export interface WsConn {
  /** Each message the client sent, as it arrives. */
  onMessage(cb: (data: Buffer, binary: boolean) => void): void;
  send(data: string | Buffer): void;
  close(code?: number, reason?: string): void;
  /** Every client frame was masked, as RFC 6455 requires. */
  masked: boolean;
}

function wsAccept(socket: Duplex, req: IncomingMessage, protocol: string | undefined): WsConn {
  const key = String(req.headers["sec-websocket-key"]);
  const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n${protocol ? `Sec-WebSocket-Protocol: ${protocol}\r\n` : ""}\r\n`);
  const frame = (op: number, p: Buffer) => {
    const head = p.length < 126 ? Buffer.from([0x80 | op, p.length]) : p.length < 65536 ? Buffer.from([0x80 | op, 126, p.length >> 8, p.length & 255]) : Buffer.concat([Buffer.from([0x80 | op, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(p.length)); return b; })()]);
    return Buffer.concat([head, p]);
  };
  const listeners: ((data: Buffer, binary: boolean) => void)[] = [];
  const conn: WsConn = {
    masked: true,
    onMessage: (cb) => void listeners.push(cb),
    send: (data) => void (socket.writable && socket.write(frame(typeof data === "string" ? 1 : 2, Buffer.from(data)))),
    close: (code = 1000, reason = "") => {
      const p = Buffer.alloc(2 + Buffer.byteLength(reason));
      p.writeUInt16BE(code);
      p.write(reason, 2);
      if (socket.writable) socket.end(frame(8, p));
    },
  };
  let buf = Buffer.alloc(0);
  socket.on("error", () => undefined);
  socket.on("data", (c: Buffer) => {
    buf = Buffer.concat([buf, c]);
    while (buf.length >= 2) {
      const op = buf[0]! & 0x0f;
      const masked = (buf[1]! & 0x80) !== 0;
      let len = buf[1]! & 0x7f;
      let off = 2;
      if (len === 126) [len, off] = [buf.readUInt16BE(2), 4];
      else if (len === 127) [len, off] = [Number(buf.readBigUInt64BE(2)), 10];
      const need = off + (masked ? 4 : 0) + len;
      if (buf.length < need) return;
      const payload = Buffer.from(buf.subarray(off + (masked ? 4 : 0), need));
      if (masked) for (let i = 0; i < payload.length; i++) payload[i]! ^= buf[off + (i & 3)]!;
      else conn.masked = false;
      buf = buf.subarray(need);
      if (op === 8) {
        if (socket.writable) socket.end(frame(8, payload));
      } else if (op === 1 || op === 2) for (const l of listeners) l(payload, op === 2);
    }
  });
  return conn;
}

/**
 * A mock provider API; every request is recorded as "METHOD /path". `upgrade` takes WebSocket
 * requests: it calls `accept()` (optionally with the subprotocol it picks) or returns a Reply to refuse.
 */
export async function mock(handler: (r: Req) => Reply | undefined, upgrade?: (r: Req, accept: (protocol?: string) => WsConn) => Reply | undefined) {
  const seen: string[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const u = new URL(req.url ?? "/", "http://x");
    const body = Buffer.concat(chunks);
    seen.push(`${req.method} ${u.pathname}`);
    const out = handler({ method: req.method ?? "GET", path: u.pathname, query: u.searchParams, headers: req.headers, body, json: () => JSON.parse(body.toString() || "{}") }) ?? {
      status: 404,
      json: { error: `no route ${req.method} ${u.pathname}` },
    };
    const payload = out.raw ?? JSON.stringify(out.json ?? {});
    res.writeHead(out.status ?? 200, { "content-type": out.type ?? (out.raw !== undefined ? "application/octet-stream" : "application/json"), ...out.headers });
    res.end(payload);
  });
  server.on("upgrade", (req: IncomingMessage, socket: Duplex) => {
    const u = new URL(req.url ?? "/", "http://x");
    seen.push(`WS ${u.pathname}`);
    const r: Req = { method: "GET", path: u.pathname, query: u.searchParams, headers: req.headers, body: Buffer.alloc(0), json: () => ({}) };
    const refused = upgrade ? upgrade(r, (protocol) => wsAccept(socket, req, protocol)) : { status: 404, json: { error: "no websocket here" } };
    if (refused) {
      const payload = refused.raw ?? JSON.stringify(refused.json ?? {});
      socket.end(`HTTP/1.1 ${refused.status ?? 400} Refused\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(payload)}\r\nconnection: close\r\n\r\n${payload}`);
    }
  });
  // On the address the tests dial. A server on every address (`::`) shares its port number with
  // any other process that binds 127.0.0.1 to it, and macOS sends 127.0.0.1 to that one.
  servers.push(server.listen(0, "127.0.0.1"));
  await new Promise((ok) => server.once("listening", ok));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

/** What every mock's exec does: `exit N` exits N, anything else echoes. */
export const fakeRun = (cmd: string) => {
  const m = /exit (\d+)/.exec(cmd);
  return m ? { stdout: "", stderr: "boom\n", code: Number(m[1]) } : { stdout: `ran: ${cmd}\n`, stderr: "", code: 0 };
};

export function routerFor(adapter: ProviderAdapter, env: Record<string, string>, clock = { t: Date.UTC(2026, 10, 11, 12) }) {
  const router = new SandboxRouter({
    providers: [adapter],
    ledger: new MemoryLedger(),
    env,
    now: () => clock.t,
    config: { allowPaid: true, providers: { [adapter.info.id]: { options: { pollMs: 5 } } } },
  });
  return { router, clock };
}

/** create → exec (ok and non-zero) → optional files → kill, shared by every provider. */
export async function lifecycle(router: SandboxRouter, opts: { files?: boolean } = {}) {
  const sbx = await router.create({ timeoutSec: 120 });
  const ok = await sbx.commands.run("echo hi");
  expect(ok.exitCode).toBe(0);
  expect(ok.stdout).toContain("echo hi");
  const bad = await sbx.commands.run("exit 3");
  expect(bad.exitCode).toBe(3);
  if (opts.files) {
    await sbx.files.write("/tmp/a.txt", "hello");
    expect(await sbx.files.read("/tmp/a.txt")).toBe("hello");
  }
  await sbx.kill();
  expect((await sbx.info())!.state).toBe("stopped");
  return sbx;
}

/** For providers without a TTL: past the deadline, the sweep deletes the sandbox. */
export async function deletedAtDeadline(router: SandboxRouter, clock: { t: number }, seen: string[], deletePath: (id: string) => string) {
  const sbx = await router.create({ timeoutSec: 60 });
  clock.t += 61_000;
  const swept = await router.sweep();
  expect(swept.reaped).toBe(1);
  expect(seen).toContain(deletePath(sbx.providerSandboxId));
}
