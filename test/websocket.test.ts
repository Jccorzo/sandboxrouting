// The WebSocket client in src/providers/websocket.ts against a local node:http server that does
// the server side of RFC 6455 by hand, so each rule (accept key, masking, fragments, ping, close,
// limits, abort) is checked on the wire.
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { acceptFor, clientFrame, WebSocketClient, WebSocketError } from "../src/providers/websocket.js";
import { classify } from "../src/core/errors.js";

/** A frame as the server sends it: unmasked, `fin` unless told otherwise. */
function serverFrame(opcode: number, payload: Buffer | string, fin = true): Buffer {
  const p = Buffer.from(payload);
  const head = p.length < 126 ? Buffer.from([0, p.length]) : Buffer.from([0, 126, p.length >> 8, p.length & 255]);
  head[0] = (fin ? 0x80 : 0) | opcode;
  return Buffer.concat([head, p]);
}

interface ClientFrame {
  opcode: number;
  masked: boolean;
  payload: Buffer;
}

const servers: Server[] = [];
afterEach(() => servers.splice(0).forEach((s) => s.close()));

/** A server whose `onOpen` gets each upgraded socket and the client frames it sends. */
async function wsServer(onOpen: (socket: Duplex, req: IncomingMessage, received: ClientFrame[]) => void, opts: { accept?: (key: string) => string; status?: number; protocol?: string } = {}) {
  const server = createServer((_req, res) => {
    res.writeHead(opts.status ?? 426, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "upgrade required" }));
  });
  server.on("upgrade", (req, socket: Duplex) => {
    if (opts.status) {
      socket.end(`HTTP/1.1 ${opts.status} Refused\r\ncontent-type: application/json\r\ncontent-length: 21\r\n\r\n{"error":"forbidden"}`);
      return;
    }
    const key = String(req.headers["sec-websocket-key"]);
    const accept = (opts.accept ?? acceptFor)(key);
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n` +
        (opts.protocol ? `Sec-WebSocket-Protocol: ${opts.protocol}\r\n` : "") +
        "\r\n",
    );
    const received: ClientFrame[] = [];
    let buf = Buffer.alloc(0);
    socket.on("data", (c: Buffer) => {
      buf = Buffer.concat([buf, c]);
      while (buf.length >= 2) {
        const opcode = buf[0]! & 0x0f;
        const masked = (buf[1]! & 0x80) !== 0;
        let len = buf[1]! & 0x7f;
        let off = 2;
        if (len === 126) {
          len = buf.readUInt16BE(2);
          off = 4;
        }
        const need = off + (masked ? 4 : 0) + len;
        if (buf.length < need) return;
        const mask = masked ? buf.subarray(off, off + 4) : undefined;
        const payload = Buffer.from(buf.subarray(off + (masked ? 4 : 0), need));
        if (mask) for (let i = 0; i < payload.length; i++) payload[i]! ^= mask[i & 3]!;
        buf = buf.subarray(need);
        received.push({ opcode, masked, payload });
        socket.emit("frame", { opcode, masked, payload });
      }
    });
    onOpen(socket, req, received);
  });
  servers.push(server.listen(0, "127.0.0.1"));
  await new Promise((ok) => server.once("listening", ok));
  return `ws://127.0.0.1:${(server.address() as AddressInfo).port}/path?x=1`;
}

const collect = async (ws: WebSocketClient) => {
  const out: string[] = [];
  for await (const m of ws.messages()) out.push(m.binary ? `bin:${m.data.toString("hex")}` : m.data.toString());
  return out;
};

describe("websocket client", () => {
  it("handshakes with a random key, custom headers and a subprotocol, and echoes messages", async () => {
    let seen: IncomingMessage | undefined;
    const url = await wsServer(
      (socket, req) => {
        seen = req;
        socket.on("frame", (f: ClientFrame) => {
          if (f.opcode === 1) socket.write(serverFrame(1, `echo:${f.payload}`));
          if (f.opcode === 2) socket.write(serverFrame(2, f.payload));
          if (f.opcode === 8) socket.end(serverFrame(8, f.payload));
        });
      },
      { protocol: "token.abc" },
    );
    const ws = await WebSocketClient.connect(url, { headers: { Authorization: "Bearer t" }, protocols: ["archil.v1", "token.abc"] });
    expect(ws.state).toBe("open");
    expect(ws.protocol).toBe("token.abc");
    expect(seen!.headers).toMatchObject({ authorization: "Bearer t", "sec-websocket-version": "13", "sec-websocket-protocol": "archil.v1, token.abc" });
    expect(Buffer.from(String(seen!.headers["sec-websocket-key"]), "base64")).toHaveLength(16);
    ws.send("hi");
    ws.send(new Uint8Array([0, 255]));
    const got = collect(ws);
    await new Promise((r) => setTimeout(r, 50));
    await ws.close(1000, "bye");
    expect(await got).toEqual(["echo:hi", "bin:00ff"]);
    expect(ws.state).toBe("closed");
    expect(ws.closeCode).toBe(1000);
  });

  it("masks every client frame with a fresh key", async () => {
    let received: ClientFrame[] = [];
    const url = await wsServer((_s, _r, r) => (received = r));
    const ws = await WebSocketClient.connect(url);
    ws.send("same");
    ws.send("same");
    await new Promise((r) => setTimeout(r, 50));
    expect(received).toHaveLength(2);
    expect(received.every((f) => f.masked)).toBe(true);
    expect(received.map((f) => f.payload.toString())).toEqual(["same", "same"]);
    // Two frames with the same payload differ on the wire: each has its own mask.
    const a = clientFrame(1, Buffer.from("same"));
    const b = clientFrame(1, Buffer.from("same"));
    expect(a[1]! & 0x80).toBe(0x80);
    expect(a.equals(b)).toBe(false);
    ws.close().catch(() => undefined);
  });

  it("refuses a wrong Sec-WebSocket-Accept", async () => {
    const url = await wsServer(() => undefined, { accept: () => "bm90IHRoZSByaWdodCBrZXk=" });
    await expect(WebSocketClient.connect(url)).rejects.toThrow(/Sec-WebSocket-Accept/);
  });

  it("turns a refused handshake into an HttpError the router classifies", async () => {
    for (const [status, kind] of [
      [401, "auth"],
      [403, "auth"],
      [429, "rate_limit"],
    ] as const) {
      const url = await wsServer(() => undefined, { status });
      const err = await WebSocketClient.connect(url).catch((e: unknown) => e);
      expect(classify(err).kind).toBe(kind);
    }
  });

  it("joins fragmented messages and answers pings", async () => {
    let received: ClientFrame[] = [];
    const url = await wsServer((socket, _r, r) => {
      received = r;
      socket.write(Buffer.concat([serverFrame(1, "hel", false), serverFrame(9, "ping!"), serverFrame(0, "lo ", false), serverFrame(0, "world")]));
      setTimeout(() => socket.end(serverFrame(8, Buffer.from([0x03, 0xe8]))), 30);
    });
    const ws = await WebSocketClient.connect(url);
    expect(await collect(ws)).toEqual(["hello world"]);
    const pong = received.find((f) => f.opcode === 0xa)!;
    expect(pong.payload.toString()).toBe("ping!");
    expect(pong.masked).toBe(true);
    expect(ws.closeCode).toBe(1000);
  });

  it("answers the server's close with the same code and ends the stream", async () => {
    let received: ClientFrame[] = [];
    const url = await wsServer((socket, _r, r) => {
      received = r;
      socket.write(serverFrame(1, "last"));
      socket.write(serverFrame(8, Buffer.concat([Buffer.from([0x0f, 0xa0]), Buffer.from("going away")])));
      // A frame after close is dropped.
      socket.write(serverFrame(1, "late"));
    });
    const ws = await WebSocketClient.connect(url);
    expect(await collect(ws)).toEqual(["last"]);
    expect(ws.closeCode).toBe(4000);
    expect(ws.closeReason).toBe("going away");
    await new Promise((r) => setTimeout(r, 30));
    expect(received.find((f) => f.opcode === 8)!.payload.readUInt16BE(0)).toBe(4000);
    expect(() => ws.send("x")).toThrow(/can't send/);
  });

  it("closes with 1002 on a masked server frame or an unknown opcode", async () => {
    for (const bad of [Buffer.from([0x81, 0x82, 1, 2, 3, 4, 0, 0]), Buffer.from([0x83, 0])]) {
      let received: ClientFrame[] = [];
      const url = await wsServer((socket, _r, r) => {
        received = r;
        socket.write(bad);
      });
      const ws = await WebSocketClient.connect(url);
      const err = await collect(ws).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(WebSocketError);
      expect((err as WebSocketError).code).toBe(1002);
      await new Promise((r) => setTimeout(r, 30));
      expect(received.find((f) => f.opcode === 8)!.payload.readUInt16BE(0)).toBe(1002);
    }
  });

  it("rejects a frame over the size limit from its header, before buffering it", async () => {
    let received: ClientFrame[] = [];
    const url = await wsServer((socket, _r, r) => {
      received = r;
      // Announces 1000 bytes and sends only the header.
      socket.write(Buffer.from([0x82, 126, 0x03, 0xe8]));
    });
    const ws = await WebSocketClient.connect(url, { maxMessageBytes: 100 });
    const err = (await collect(ws).catch((e: unknown) => e)) as WebSocketError;
    expect(err.code).toBe(1009);
    await new Promise((r) => setTimeout(r, 30));
    expect(received.find((f) => f.opcode === 8)!.payload.readUInt16BE(0)).toBe(1009);
  });

  it("fails on a dropped connection and on an abort mid-stream", async () => {
    const dropped = await wsServer((socket) => {
      socket.write(serverFrame(1, "one"));
      setTimeout(() => socket.destroy(), 20);
    });
    const ws1 = await WebSocketClient.connect(dropped);
    const seen: string[] = [];
    const err1 = (await (async () => {
      for await (const m of ws1.messages()) seen.push(m.data.toString());
    })().catch((e: unknown) => e)) as WebSocketError;
    expect(seen).toEqual(["one"]);
    expect(err1.code).toBe(1006);

    const quiet = await wsServer((socket) => socket.write(serverFrame(1, "first")));
    const ac = new AbortController();
    const ws2 = await WebSocketClient.connect(quiet, { signal: ac.signal });
    const it2 = ws2.messages();
    expect((await it2.next()).value!.data.toString()).toBe("first");
    setTimeout(() => ac.abort("stop"), 20);
    await expect(it2.next()).rejects.toThrow(/aborted: stop/);
  });

  it("times out a handshake that never answers", async () => {
    const server = createServer();
    server.on("upgrade", () => undefined);
    servers.push(server.listen(0, "127.0.0.1"));
    await new Promise((ok) => server.once("listening", ok));
    const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    await expect(WebSocketClient.connect(url, { timeoutMs: 50 })).rejects.toThrow(/no handshake/);
    const ac = new AbortController();
    const p = WebSocketClient.connect(url, { signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toThrow(/aborted/);
  });
});

