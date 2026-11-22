// A small RFC 6455 WebSocket client on node:http/https, for the adapters whose providers run
// commands only over a WebSocket (Runta, Watasu, Archil, Northflank). Node 20 has no global
// WebSocket, and the browser-shaped one can't send handshake headers, which three of them need.
// https://www.rfc-editor.org/rfc/rfc6455
//
// One connection, one state (`connecting` → `open` → `closing` → `closed`), moved only by
// `move()`. Frames that arrive once it is closed are dropped. A refused handshake throws an
// `HttpError` with the response's status, so 401/403/429 classify like any HTTP refusal.

import { createHash, randomBytes } from "node:crypto";
import { request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Duplex } from "node:stream";
import { HttpError } from "./util.js";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const OP = { continuation: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa } as const;
const OPCODES = new Set<number>(Object.values(OP));

export type WsState = "connecting" | "open" | "closing" | "closed";

export interface WsOptions {
  headers?: Record<string, string>;
  /** Subprotocols offered in Sec-WebSocket-Protocol; the server must pick one of them or none. */
  protocols?: string[];
  /** How long the handshake may take. Default 30 s. */
  timeoutMs?: number;
  /** Largest message accepted, in bytes; a bigger one closes the connection with 1009. Default 16 MiB. */
  maxMessageBytes?: number;
  signal?: AbortSignal;
}

export interface WsMessage {
  data: Buffer;
  binary: boolean;
}

/** A failure on an open connection: a protocol violation, an abnormal close, an abort. */
export class WebSocketError extends Error {
  constructor(
    message: string,
    public readonly code?: number,
  ) {
    super(message);
    this.name = "WebSocketError";
  }
}

/** The Sec-WebSocket-Accept value a server must answer `key` with. */
export const acceptFor = (key: string) => createHash("sha1").update(key + GUID).digest("base64");

/** One frame from client to server: always final, always masked with a fresh key. */
export function clientFrame(opcode: number, payload: Uint8Array): Buffer {
  const len = payload.length;
  const head = len < 126 ? 2 : len < 65536 ? 4 : 10;
  const out = Buffer.alloc(head + 4 + len);
  out[0] = 0x80 | opcode;
  if (len < 126) out[1] = 0x80 | len;
  else if (len < 65536) {
    out[1] = 0x80 | 126;
    out.writeUInt16BE(len, 2);
  } else {
    out[1] = 0x80 | 127;
    out.writeBigUInt64BE(BigInt(len), 2);
  }
  const mask = randomBytes(4);
  mask.copy(out, head);
  for (let i = 0; i < len; i++) out[head + 4 + i] = payload[i]! ^ mask[i & 3]!;
  return out;
}

export class WebSocketClient {
  #state: WsState = "connecting";
  #socket: Duplex;
  #buf: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  #parts: Buffer[] = [];
  #partsLen = 0;
  #partsOp = 0;
  #queue: WsMessage[] = [];
  #waiters: { resolve: (r: IteratorResult<WsMessage>) => void; reject: (e: Error) => void }[] = [];
  #failure: Error | undefined;
  #closed: Promise<void>;
  #onClosed!: () => void;
  readonly #max: number;
  /** The subprotocol the server picked, if any. */
  readonly protocol: string | undefined;
  /** The close code and reason the server sent, once it has. */
  closeCode: number | undefined;
  closeReason = "";

  private constructor(socket: Duplex, head: Buffer, protocol: string | undefined, max: number, signal?: AbortSignal) {
    this.#socket = socket;
    this.protocol = protocol;
    this.#max = max;
    this.#closed = new Promise((ok) => (this.#onClosed = ok));
    this.#move("open");
    socket.on("data", (chunk: Buffer) => this.#read(chunk));
    socket.on("error", (err) => this.#fail(new WebSocketError(`websocket: ${err.message}`, 1006)));
    socket.on("close", () => {
      if (this.#state !== "closing") this.#fail(new WebSocketError("websocket: the connection closed without a close frame", 1006));
      this.#move("closed");
    });
    if (signal) {
      const abort = () => {
        this.#fail(new WebSocketError(`websocket: aborted${signal.reason ? `: ${String(signal.reason)}` : ""}`));
        this.#socket.destroy();
      };
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
      void this.#closed.then(() => signal.removeEventListener("abort", abort));
    }
    if (head.length) this.#read(head);
  }

  get state(): WsState {
    return this.#state;
  }

  /** Opens a connection to a ws:// or wss:// URL. */
  static connect(url: string, opts: WsOptions = {}): Promise<WebSocketClient> {
    const u = new URL(url);
    if (u.protocol !== "ws:" && u.protocol !== "wss:") throw new Error(`websocket: not a ws:// or wss:// URL: ${url}`);
    const key = randomBytes(16).toString("base64");
    const headers: Record<string, string> = {
      ...opts.headers,
      Connection: "Upgrade",
      Upgrade: "websocket",
      "Sec-WebSocket-Version": "13",
      "Sec-WebSocket-Key": key,
    };
    if (opts.protocols?.length) headers["Sec-WebSocket-Protocol"] = opts.protocols.join(", ");
    const send = u.protocol === "wss:" ? httpsRequest : httpRequest;
    const max = opts.maxMessageBytes ?? 16 * 1024 * 1024;
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (err: Error | undefined, ws?: WebSocketClient) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        if (err) {
          req.destroy();
          reject(err);
        } else resolve(ws!);
      };
      const req: ClientRequest = send(u.toString().replace(/^ws/, "http"), { method: "GET", headers });
      const timeoutMs = opts.timeoutMs ?? 30_000;
      const timer = setTimeout(() => done(new WebSocketError(`websocket: no handshake from ${u.host} within ${timeoutMs} ms`)), timeoutMs);
      const onAbort = () => done(new WebSocketError("websocket: aborted before the handshake finished"));
      if (opts.signal?.aborted) return onAbort();
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      req.on("error", (err) => done(new WebSocketError(`websocket: ${err.message}`)));
      req.on("response", (res: IncomingMessage) => {
        // Not an upgrade: a refusal whose status the router can classify.
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => done(new HttpError(res.statusCode ?? 500, `GET ${u.pathname}: ${res.statusCode} ${Buffer.concat(chunks).toString().slice(0, 500)}`)));
        res.on("error", (err) => done(new WebSocketError(`websocket: ${err.message}`)));
      });
      req.on("upgrade", (res: IncomingMessage, socket: Duplex, head: Buffer) => {
        const bad = (why: string) => {
          socket.destroy();
          done(new WebSocketError(`websocket: bad handshake from ${u.host}: ${why}`));
        };
        if (res.headers["sec-websocket-accept"] !== acceptFor(key)) return bad("Sec-WebSocket-Accept doesn't match the key");
        if (String(res.headers["upgrade"]).toLowerCase() !== "websocket") return bad("no Upgrade: websocket");
        const picked = res.headers["sec-websocket-protocol"];
        if (picked && !opts.protocols?.includes(picked)) return bad(`subprotocol ${picked} wasn't offered`);
        if (res.headers["sec-websocket-extensions"]) return bad("extensions weren't offered");
        done(undefined, new WebSocketClient(socket, head, picked, max, opts.signal));
      });
      req.end();
    });
  }

  /** Sends a text (string) or binary message. */
  send(data: string | Uint8Array): void {
    if (this.#state !== "open") throw new WebSocketError(`websocket: can't send while ${this.#state}`);
    const binary = typeof data !== "string";
    this.#socket.write(clientFrame(binary ? OP.binary : OP.text, binary ? data : Buffer.from(data)));
  }

  /** Sends a ping (keepalive); the server's pong is read and ignored. */
  ping(data = ""): void {
    if (this.#state === "open") this.#socket.write(clientFrame(OP.ping, Buffer.from(data)));
  }

  /** Starts the close handshake and waits for the server's close frame (or `waitMs`). */
  async close(code = 1000, reason = ""): Promise<void> {
    if (this.#state === "open") {
      this.#sendClose(code, reason);
      this.#move("closing");
      const timer = setTimeout(() => this.#socket.destroy(), 2000);
      await this.#closed;
      clearTimeout(timer);
    } else if (this.#state === "closing") await this.#closed;
  }

  /** Each message as it arrives. Ends after a close frame; throws on a failure. */
  async *messages(): AsyncGenerator<WsMessage> {
    while (true) {
      const next = await this.#next();
      if (next.done) return;
      yield next.value;
    }
  }

  #next(): Promise<IteratorResult<WsMessage>> {
    const msg = this.#queue.shift();
    if (msg) return Promise.resolve({ done: false, value: msg });
    if (this.#failure) return Promise.reject(this.#failure);
    if (this.#state === "closed" || this.closeCode !== undefined) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
  }

  /** The one place the state changes. */
  #move(to: WsState) {
    if (this.#state === "closed") return;
    this.#state = to;
    if (to === "closed") {
      this.#onClosed();
      // Anyone still waiting hears the end, or the failure if there was one.
      for (const w of this.#waiters.splice(0)) {
        if (this.#failure) w.reject(this.#failure);
        else w.resolve({ done: true, value: undefined });
      }
    }
  }

  #fail(err: Error) {
    if (this.#failure || this.#state === "closed") return;
    this.#failure = err;
    for (const w of this.#waiters.splice(0)) w.reject(err);
  }

  #emit(msg: WsMessage) {
    const w = this.#waiters.shift();
    if (w) w.resolve({ done: false, value: msg });
    else this.#queue.push(msg);
  }

  #sendClose(code: number, reason: string) {
    const r = Buffer.from(reason);
    const p = Buffer.alloc(2 + r.length);
    p.writeUInt16BE(code, 0);
    r.copy(p, 2);
    this.#socket.write(clientFrame(OP.close, p));
  }

  /** A violation: tell the server why, fail the reader, and drop the connection. */
  #violation(code: number, why: string) {
    this.#fail(new WebSocketError(`websocket: ${why}`, code));
    if (this.#state === "open") this.#sendClose(code, why.slice(0, 120));
    this.#move("closing");
    this.#buf = Buffer.alloc(0);
    this.#socket.end();
    setTimeout(() => this.#socket.destroy(), 1000).unref();
  }

  #reading(): boolean {
    return this.#state !== "closed" && !this.#failure && this.closeCode === undefined;
  }

  #read(chunk: Buffer) {
    // Nothing counts once closed, after a failure, or after the server's close frame.
    if (!this.#reading()) return;
    this.#buf = this.#buf.length ? Buffer.concat([this.#buf, chunk]) : chunk;
    while (this.#buf.length >= 2 && this.#reading()) {
      const b0 = this.#buf[0]!;
      const b1 = this.#buf[1]!;
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      if (b0 & 0x70) return this.#violation(1002, "reserved bits set without an extension");
      // A server must never mask its frames (RFC 6455 5.1).
      if (b1 & 0x80) return this.#violation(1002, "the server sent a masked frame");
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.#buf.length < 4) return;
        len = this.#buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.#buf.length < 10) return;
        const big = this.#buf.readBigUInt64BE(2);
        if (big > BigInt(this.#max)) return this.#violation(1009, `a frame of ${big} bytes is over the ${this.#max}-byte limit`);
        len = Number(big);
        off = 10;
      }
      const control = opcode >= 0x8;
      if (control && (len > 125 || !fin)) return this.#violation(1002, "a control frame was fragmented or over 125 bytes");
      if (!OPCODES.has(opcode)) return this.#violation(1002, `unknown opcode ${opcode}`);
      // Reject an oversized message from its header, before buffering it.
      if (!control && this.#partsLen + len > this.#max) return this.#violation(1009, `a message over the ${this.#max}-byte limit`);
      if (this.#buf.length < off + len) return;
      const payload = Buffer.from(this.#buf.subarray(off, off + len));
      this.#buf = this.#buf.subarray(off + len);
      if (control) this.#control(opcode, payload);
      else this.#data(opcode, fin, payload);
    }
  }

  #control(opcode: number, payload: Buffer) {
    if (opcode === OP.ping) {
      if (this.#state === "open") this.#socket.write(clientFrame(OP.pong, payload));
      return;
    }
    if (opcode === OP.pong) return;
    // Close: 1005 when it carries no code.
    if (payload.length === 1) return this.#violation(1002, "a close frame with a 1-byte payload");
    this.closeCode = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
    this.closeReason = payload.subarray(2).toString();
    if (this.#state === "open") this.#sendClose(this.closeCode === 1005 ? 1000 : this.closeCode, "");
    this.#move("closing");
    this.#socket.end();
    setTimeout(() => this.#socket.destroy(), 1000).unref();
    for (const w of this.#waiters.splice(0)) w.resolve({ done: true, value: undefined });
  }

  #data(opcode: number, fin: boolean, payload: Buffer) {
    if (opcode === OP.continuation) {
      if (!this.#partsOp) return this.#violation(1002, "a continuation frame with no message to continue");
    } else {
      if (this.#partsOp) return this.#violation(1002, "a new message began before the last one ended");
      this.#partsOp = opcode;
    }
    this.#parts.push(payload);
    this.#partsLen += payload.length;
    if (!fin) return;
    const data = this.#parts.length === 1 ? this.#parts[0]! : Buffer.concat(this.#parts);
    const binary = this.#partsOp === OP.binary;
    this.#parts = [];
    this.#partsLen = 0;
    this.#partsOp = 0;
    if (!binary) {
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(data);
      } catch {
        return this.#violation(1007, "a text message that isn't UTF-8");
      }
    }
    this.#emit({ data, binary });
  }
}
