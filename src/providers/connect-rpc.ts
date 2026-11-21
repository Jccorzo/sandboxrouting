// The Connect protocol (connectrpc.com/docs/protocol) with the JSON codec, for providers whose API
// is a Connect or gRPC service (Chalk, Prime Intellect's sandbox gateway). Unary calls are a plain
// JSON POST to /<package>.<Service>/<Method>; server streams send and receive length-prefixed
// envelopes, and report their outcome in a final end-of-stream envelope instead of the HTTP status.
// Errors come out as util.ts `HttpError`s with the HTTP status the Connect spec pairs with each
// code, so `classify` and the router's marks read them like any REST refusal.

import { http, HttpError, type HttpOptions } from "./util.js";

/** The HTTP status the Connect protocol gives each error code. */
const STATUS: Record<string, number> = {
  canceled: 499,
  unknown: 500,
  invalid_argument: 400,
  deadline_exceeded: 504,
  not_found: 404,
  already_exists: 409,
  permission_denied: 403,
  resource_exhausted: 429,
  failed_precondition: 400,
  aborted: 409,
  out_of_range: 400,
  unimplemented: 501,
  internal: 500,
  unavailable: 503,
  data_loss: 500,
  unauthenticated: 401,
};

export interface ConnectError {
  code: string;
  message?: string;
}

/** An `HttpError` for a Connect error, keeping its code in the message (`[resource_exhausted] …`). */
export function connectError(method: string, err: ConnectError): HttpError {
  return new HttpError(STATUS[err.code] ?? 500, `${method}: [${err.code}] ${err.message ?? ""}`.trimEnd());
}

const url = (baseUrl: string, method: string) => `${baseUrl.replace(/\/+$/, "")}/${method}`;

/** A unary call: `method` is `package.Service/Method`. */
export async function connectUnary<T>(baseUrl: string, method: string, request: unknown, opts: Omit<HttpOptions, "body" | "raw" | "method"> = {}): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const res = await http(url(baseUrl, method), {
    ...opts,
    method: "POST",
    headers: { "connect-protocol-version": "1", "connect-timeout-ms": String(timeoutMs), ...opts.headers },
    body: request ?? {},
    timeoutMs: timeoutMs + 5_000,
  });
  const text = await res.text();
  return (text ? JSON.parse(text) : {}) as T;
}

const enc = new TextEncoder();

/** One request message in an envelope: a flags byte, a big-endian length, the JSON. */
function envelope(message: unknown): Uint8Array {
  const json = enc.encode(JSON.stringify(message ?? {}));
  const out = new Uint8Array(5 + json.length);
  new DataView(out.buffer).setUint32(1, json.length);
  out.set(json, 5);
  return out;
}

/**
 * A server-streaming call: yields each response message, and throws the end-of-stream error if
 * the stream ends with one. `timeoutMs` is the call's deadline, sent to the server as well.
 */
export async function* connectStream<T>(baseUrl: string, method: string, request: unknown, opts: Omit<HttpOptions, "body" | "raw" | "method"> = {}): AsyncGenerator<T> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const res = await http(url(baseUrl, method), {
    ...opts,
    method: "POST",
    headers: { "content-type": "application/connect+json", "connect-protocol-version": "1", "connect-timeout-ms": String(timeoutMs), ...opts.headers },
    raw: envelope(request),
    timeoutMs: timeoutMs + 5_000,
  });
  let buf = new Uint8Array(0);
  const dec = new TextDecoder();
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    const next = new Uint8Array(buf.length + chunk.length);
    next.set(buf);
    next.set(chunk, buf.length);
    buf = next;
    while (buf.length >= 5) {
      const flags = buf[0]!;
      const len = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(1);
      if (buf.length < 5 + len) break;
      const body = dec.decode(buf.subarray(5, 5 + len));
      buf = buf.subarray(5 + len);
      if (flags & 0x01) throw new Error(`${method}: a compressed message, which was not asked for`);
      if (flags & 0x02) {
        const end = (body ? JSON.parse(body) : {}) as { error?: ConnectError };
        if (end.error) throw connectError(method, end.error);
        return;
      }
      yield JSON.parse(body) as T;
    }
  }
  throw new Error(`${method}: the stream ended without an end-of-stream message`);
}
