// gRPC over HTTP/2 (node:http2, no dependency) for Luxor's per-session data plane. Both official
// SDKs speak plain gRPC to it, and its Run call is a bidirectional stream, which fetch (HTTP/1.1)
// cannot carry. Messages are protobuf, built and read with grpc-web.ts's field helpers.
// Wire format: https://github.com/grpc/grpc/blob/master/doc/PROTOCOL-HTTP2.md.

import { connect, type ClientHttp2Session, type IncomingHttpHeaders } from "node:http2";
import { HttpError } from "./util.js";

/** gRPC status codes, as the HTTP status `classify` reads (the same table as grpc-web.ts). */
const GRPC_HTTP: Record<number, number> = { 1: 499, 2: 500, 3: 400, 4: 504, 5: 404, 6: 409, 7: 403, 8: 429, 9: 400, 10: 409, 11: 400, 12: 501, 13: 500, 14: 503, 15: 500, 16: 401 };
/** The gRPC code a client gives a non-200 HTTP reply (grpc-go's and connect-node's table). */
const HTTP_GRPC: Record<number, number> = { 400: 13, 401: 16, 403: 7, 404: 12, 429: 14, 502: 14, 503: 14, 504: 14 };

/** A failed gRPC call: an `HttpError` (so `classify` reads its status) that keeps the gRPC code. */
export class GrpcError extends HttpError {
  constructor(
    public readonly code: number,
    message: string,
  ) {
    super(GRPC_HTTP[code] ?? 500, message);
    this.name = "GrpcError";
  }
}

// Connections are shared per origin and keep the process alive only while a call is open.
const sessions = new Map<string, { session: ClientHttp2Session; open: number }>();

function sessionFor(origin: string) {
  const hit = sessions.get(origin);
  if (hit && !hit.session.closed && !hit.session.destroyed) return hit;
  const entry = { session: connect(origin), open: 0 };
  entry.session.on("error", () => sessions.get(origin) === entry && sessions.delete(origin));
  entry.session.on("close", () => sessions.get(origin) === entry && sessions.delete(origin));
  entry.session.on("goaway", () => sessions.get(origin) === entry && sessions.delete(origin));
  entry.session.unref();
  sessions.set(origin, entry);
  return entry;
}

/** One message in a gRPC frame: a flags byte, a big-endian length, the protobuf bytes. */
function frame(message: Uint8Array): Buffer {
  const head = Buffer.alloc(5);
  head.writeUInt32BE(message.length, 1);
  return Buffer.concat([head, message]);
}

function decodeMessage(raw: string | string[] | undefined): string {
  const s = Array.isArray(raw) ? raw.join(", ") : (raw ?? "");
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * A gRPC call that sends every request message and yields each reply message. Fits unary and
 * server-streaming calls, and a bidi call whose requests are all known up front. It half-closes
 * after the requests unless `holdOpen`, which keeps the request side open until the caller stops
 * reading (as the SDK keeps Run's open until the exit frame). `url` is the endpoint plus
 * `/<package>.<Service>/<Method>`. A non-OK status throws a GrpcError.
 */
export async function* grpcCall(
  url: string,
  headers: Record<string, string>,
  requests: Uint8Array[],
  timeoutMs: number,
  opts: { holdOpen?: boolean } = {},
): AsyncGenerator<Uint8Array> {
  const u = new URL(url);
  const path = u.pathname;
  const entry = sessionFor(u.origin);
  entry.open++;
  entry.session.ref();
  const stream = entry.session.request(
    { ":method": "POST", ":path": path, "content-type": "application/grpc", te: "trailers", "grpc-timeout": `${Math.max(1, Math.ceil(timeoutMs))}m`, ...headers },
    { signal: AbortSignal.timeout(timeoutMs + 5_000) },
  );
  let trailers: IncomingHttpHeaders | undefined;
  stream.on("trailers", (t) => (trailers = t));
  try {
    const body = Buffer.concat(requests.map(frame));
    if (opts.holdOpen) stream.write(body);
    else stream.end(body);
    const head = await new Promise<IncomingHttpHeaders>((ok, fail) => {
      stream.once("response", ok);
      stream.once("error", fail);
    });
    const status = Number(head[":status"]);
    if (status !== 200) {
      const code = HTTP_GRPC[status] ?? 2;
      throw new GrpcError(code, `POST ${path}: HTTP ${status}`);
    }
    let buf = Buffer.alloc(0);
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 5) {
        const len = buf.readUInt32BE(1);
        if (buf.length < 5 + len) break;
        if (buf[0]! & 0x01) throw new Error(`POST ${path}: a compressed message, which was not asked for`);
        const message = new Uint8Array(buf.subarray(5, 5 + len));
        buf = buf.subarray(5 + len);
        yield message;
      }
    }
    // A trailers-only reply carries the status in its headers.
    const end = trailers ?? head;
    const code = Number(end["grpc-status"] ?? 2);
    if (code !== 0) throw new GrpcError(code, `POST ${path}: grpc-status ${code} ${decodeMessage(end["grpc-message"])}`.trimEnd());
  } catch (err) {
    if (err instanceof GrpcError) throw err;
    const e = err as NodeJS.ErrnoException;
    if (e.name === "AbortError" || e.name === "TimeoutError") throw new GrpcError(4, `POST ${path}: deadline exceeded`);
    // Connection failures (refused, reset, GOAWAY) read as UNAVAILABLE, as gRPC clients report them.
    throw new GrpcError(14, `POST ${path}: ${e.message}${e.code ? ` (${e.code})` : ""}`);
  } finally {
    if (!stream.closed) stream.close();
    if (--entry.open === 0) entry.session.unref();
  }
}

/** A unary gRPC call: the one reply message. */
export async function grpcUnary(url: string, headers: Record<string, string>, request: Uint8Array, timeoutMs: number): Promise<Uint8Array> {
  let reply: Uint8Array | undefined;
  for await (const m of grpcCall(url, headers, [request], timeoutMs)) reply ??= m;
  if (!reply) throw new GrpcError(13, `POST ${new URL(url).pathname}: OK with no message`);
  return reply;
}

// Protobuf encoding for the few data-plane messages, on top of grpc-web.ts's helpers.
const varint = (n: number): number[] => {
  const out: number[] = [];
  let v = n;
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
  return out;
};

/** A length-delimited field (bytes, string or message) whose value is already bytes. */
export function lenField(no: number, value: Uint8Array): Uint8Array {
  const head = [...varint((no << 3) | 2), ...varint(value.length)];
  const out = new Uint8Array(head.length + value.length);
  out.set(head);
  out.set(value, head.length);
  return out;
}

export function concat(...parts: (Uint8Array | number[])[]): Uint8Array {
  const arrays = parts.map((p) => (p instanceof Uint8Array ? p : Uint8Array.from(p)));
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
  let at = 0;
  for (const a of arrays) {
    out.set(a, at);
    at += a.length;
  }
  return out;
}
