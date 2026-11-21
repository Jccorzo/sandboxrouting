// Just enough protobuf and gRPC-Web for adapters that speak gRPC-Web (tama, and the sandboxd
// exec of gke-agent-sandbox), with no protobuf dependency: messages are built from numbered
// fields and read back as numbered fields.
// Wire format: https://protobuf.dev/programming-guides/encoding/ and
// https://github.com/grpc/grpc/blob/master/doc/PROTOCOL-WEB.md (5-byte frames; a trailer frame
// with flag 0x80 carries `grpc-status` and `grpc-message`).

import { HttpError, http } from "./util.js";

const varint = (n: number | bigint): number[] => {
  let v = BigInt.asUintN(64, BigInt(n));
  const out: number[] = [];
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return out;
};
const key = (no: number, wire: number) => varint((no << 3) | wire);
const utf8 = new TextEncoder();

/** One encoded field, or nothing for a value proto3 leaves out (empty, zero, false). */
export const pb = {
  str: (no: number, s: string | undefined): number[] => (s ? [...key(no, 2), ...varint(utf8.encode(s).length), ...utf8.encode(s)] : []),
  uint: (no: number, n: number | undefined): number[] => (n ? [...key(no, 0), ...varint(Math.round(n))] : []),
  bool: (no: number, b: boolean | undefined): number[] => (b ? [...key(no, 0), 1] : []),
  msg: (no: number, fields: number[]): number[] => [...key(no, 2), ...varint(fields.length), ...fields],
  /** A `map<string, string>` field: one entry message (key = 1, value = 2) each. */
  map: (no: number, m: Record<string, string> | undefined): number[] => Object.entries(m ?? {}).flatMap(([k, v]) => pb.msg(no, [...pb.str(1, k), ...pb.str(2, v)])),
  /** A repeated string field. */
  strs: (no: number, list: string[] | undefined): number[] => (list ?? []).flatMap((s) => [...key(no, 2), ...varint(utf8.encode(s).length), ...utf8.encode(s)]),
};

/** A decoded message: every field number with its values in order (varints as bigint, the rest as bytes). */
export type Fields = Map<number, (bigint | Uint8Array)[]>;

export function decode(buf: Uint8Array): Fields {
  const out: Fields = new Map();
  let i = 0;
  const readVarint = () => {
    let v = 0n;
    let shift = 0n;
    for (;;) {
      const b = buf[i++];
      if (b === undefined) throw new Error("protobuf: truncated varint");
      v |= BigInt(b & 0x7f) << shift;
      if (b < 0x80) return v;
      shift += 7n;
    }
  };
  while (i < buf.length) {
    const k = Number(readVarint());
    const no = k >>> 3;
    const wire = k & 7;
    let value: bigint | Uint8Array;
    if (wire === 0) value = readVarint();
    else if (wire === 2) {
      const len = Number(readVarint());
      value = buf.subarray(i, i + len);
      i += len;
    } else if (wire === 1 || wire === 5) {
      const len = wire === 1 ? 8 : 4;
      value = buf.subarray(i, i + len);
      i += len;
    } else throw new Error(`protobuf: wire type ${wire} not supported`);
    out.set(no, [...(out.get(no) ?? []), value]);
  }
  return out;
}

const text = new TextDecoder();
/** Readers for one field of a decoded message: the last value wins, as protobuf says. */
export const get = {
  str: (f: Fields, no: number): string => {
    const v = f.get(no)?.at(-1);
    return v instanceof Uint8Array ? text.decode(v) : "";
  },
  int: (f: Fields, no: number): number => {
    const v = f.get(no)?.at(-1);
    return typeof v === "bigint" ? Number(BigInt.asIntN(64, v)) : 0;
  },
  bool: (f: Fields, no: number): boolean => get.int(f, no) !== 0,
  msg: (f: Fields, no: number): Fields | undefined => {
    const v = f.get(no)?.at(-1);
    return v instanceof Uint8Array ? decode(v) : undefined;
  },
  msgs: (f: Fields, no: number): Fields[] => (f.get(no) ?? []).filter((v): v is Uint8Array => v instanceof Uint8Array).map(decode),
};

/** gRPC status codes, as the HTTP status the router's error classifier understands. */
const GRPC_HTTP: Record<number, number> = { 2: 500, 3: 400, 4: 504, 5: 404, 6: 409, 7: 403, 8: 429, 9: 409, 10: 409, 12: 501, 13: 500, 14: 503, 16: 401 };

/** Splits a gRPC-Web body into its first message and its status (from the trailer frame, else the headers). */
export function parseGrpcWeb(body: Uint8Array, headers: Headers): { message?: Uint8Array; status: number; detail: string } {
  let message: Uint8Array | undefined;
  const trailers = new Map<string, string>();
  for (let i = 0; i + 5 <= body.length; ) {
    const flag = body[i]!;
    const len = new DataView(body.buffer, body.byteOffset + i + 1, 4).getUint32(0);
    const frame = body.subarray(i + 5, i + 5 + len);
    i += 5 + len;
    if (flag & 0x80) {
      for (const line of text.decode(frame).split(/\r?\n/)) {
        const at = line.indexOf(":");
        if (at > 0) trailers.set(line.slice(0, at).trim().toLowerCase(), line.slice(at + 1).trim());
      }
    } else message ??= frame;
  }
  const status = trailers.get("grpc-status") ?? headers.get("grpc-status") ?? (message ? "0" : "2");
  const raw = trailers.get("grpc-message") ?? headers.get("grpc-message") ?? "";
  let detail = raw;
  try {
    detail = decodeURIComponent(raw);
  } catch {
    // Not percent-encoded after all.
  }
  return { message, status: Number(status), detail };
}

/** Frames one request message. */
export function grpcWebFrame(fields: number[]): Uint8Array {
  const out = new Uint8Array(5 + fields.length);
  new DataView(out.buffer).setUint32(1, fields.length);
  out.set(fields, 5);
  return out;
}

/**
 * One unary gRPC-Web call. A non-OK status throws an `HttpError` with the HTTP status that
 * status means (NOT_FOUND → 404, UNAUTHENTICATED → 401, RESOURCE_EXHAUSTED → 429, ...).
 */
export async function grpcWebCall(url: string, headers: Record<string, string>, fields: number[], timeoutMs?: number): Promise<Fields> {
  const res = await http(url, {
    method: "POST",
    headers: { ...headers, "content-type": "application/grpc-web+proto", accept: "application/grpc-web+proto", "x-grpc-web": "1" },
    raw: grpcWebFrame(fields),
    timeoutMs,
  });
  const out = parseGrpcWeb(new Uint8Array(await res.arrayBuffer()), res.headers);
  if (out.status !== 0) {
    throw new HttpError(GRPC_HTTP[out.status] ?? 500, `POST ${new URL(url).pathname}: grpc-status ${out.status} ${out.detail}`.trim());
  }
  // A unary OK reply always carries a message frame, if only an empty one.
  if (!out.message) throw new HttpError(502, `POST ${new URL(url).pathname}: OK with no message`);
  return decode(out.message);
}
