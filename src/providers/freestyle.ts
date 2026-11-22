// Freestyle VMs. Free (monthly, hard stop at the limit): 200 vCPU-h + 400 GiB-h memory,
// 10 concurrent VMs, max 4 vCPU / 8 GiB each.
// Spoken over HTTP, no SDK: REST at https://api.freestyle.sh (Bearer key; docs
// https://docs.freestyle.sh, OpenAPI https://api.freestyle.sh/openapi.json), with the calls the
// official SDK (npm `freestyle` 0.2.23, MIT) makes, including its background requests: every call
// asks the API to detach after 5 s, and a 202 is polled until the stored result is ready.

import { createHash } from "node:crypto";
import { HttpError, defineProvider, dispatcherFor, toBuffer } from "./util.js";
import { pollMs, sleep } from "./rest-helpers.js";
import type { ProviderContext } from "../core/types.js";

/** Asks the API to finish the request server-side if it outlives this many seconds. */
const BACKGROUND_AFTER = "x-freestyle-background-after-secs";
/** Present on every response of a backgrounded request, including a stored error. */
const BACKGROUND_ID = "x-freestyle-background-request-id";
/** Files above this go up as a resumable chunked upload, in chunks of CHUNK, as the SDK does. */
const RESUMABLE_BYTES = 8 * 1024 * 1024;
const CHUNK = 16 * 1024 * 1024;
const CHUNK_ATTEMPTS = 5;
/** Byte transfers aren't backgrounded, so they get longer than JSON calls. */
const BYTES_TIMEOUT_MS = 600_000;

type Query = Record<string, string | number | undefined>;

const base = (ctx: ProviderContext) => (ctx.env["FREESTYLE_API_URL"] ?? "https://api.freestyle.sh").replace(/\/+$/, "");
const auth = (ctx: ProviderContext) => ({ Authorization: `Bearer ${ctx.env["FREESTYLE_API_KEY"] ?? ""}` });
const vmPath = (id: string) => `/v5/vms/${encodeURIComponent(id)}`;

function urlFor(ctx: ProviderContext, path: string, query?: Query): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) qs.set(k, String(v));
  const s = qs.toString();
  return `${base(ctx)}${path}${s ? `?${s}` : ""}`;
}

const isTimeout = (err: unknown) => err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");

/**
 * One request, answered with whatever status came back. Reads (GET, no body) are retried twice on
 * 502/503/504 or a dropped connection, never a create or an exec, as the SDK does.
 */
async function send(url: string, init: { method: string; headers: Record<string, string>; body?: Buffer | string }, retry: boolean, timeoutMs: number): Promise<Response> {
  const safe = retry && init.method === "GET" && init.body === undefined;
  for (let attempt = 0; ; attempt++) {
    let waitMs = 0;
    try {
      const res = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
        dispatcher: dispatcherFor(timeoutMs + 1000) as unknown as RequestInit["dispatcher"],
      });
      if (!safe || attempt >= 2 || ![502, 503, 504].includes(res.status) || res.headers.has(BACKGROUND_ID)) return res;
      const s = Number(res.headers.get("retry-after"));
      if (Number.isFinite(s) && s > 0) waitMs = Math.min(s * 1000, 2000);
      await res.body?.cancel().catch(() => {});
    } catch (err) {
      if (!safe || attempt >= 2 || isTimeout(err)) throw err;
    }
    const backoff = 100 * 2 ** attempt;
    await sleep(Math.max(waitMs, backoff + Math.random() * backoff));
  }
}

/** The call's value, or an HttpError carrying the status and the API's `{code, message}` body. */
async function finalize<T>(res: Response, method: string, path: string): Promise<T> {
  const text = await res.text().catch(() => "");
  if (!res.ok) throw new HttpError(res.status, `${method} ${path}: ${res.status} ${text.slice(0, 500)}`);
  return (text ? JSON.parse(text) : undefined) as T;
}

/** Follows a 202 to its stored result, which is the same value or error the inline call gives. */
async function poll<T>(ctx: ProviderContext, accepted: Response, method: string, path: string): Promise<T> {
  const body = (await accepted.json().catch(() => ({}))) as { requestId?: string; resultUrl?: string };
  const id = accepted.headers.get(BACKGROUND_ID) ?? body.requestId;
  const result = body.resultUrl ?? (id ? `/v5/background-requests/${encodeURIComponent(id)}` : undefined);
  if (!result) throw new HttpError(202, `${method} ${path}: 202 Accepted carried no background request id`);
  const url = /^https?:\/\//i.test(result) ? result : `${base(ctx)}${result}`;
  let unavailableSince: number | undefined;
  for (;;) {
    await sleep(pollMs(ctx, 2000));
    try {
      const res = await send(url, { method: "GET", headers: auth(ctx) }, false, 30_000);
      // Without the request id header it's the polling hop failing, not the stored result.
      if ([408, 429, 502, 503, 504].includes(res.status) && !res.headers.has(BACKGROUND_ID)) {
        await res.body?.cancel().catch(() => {});
        throw new Error(`freestyle background request temporarily unavailable (${res.status})`);
      }
      if (res.status === 202) {
        await res.body?.cancel().catch(() => {});
        unavailableSince = undefined;
        continue;
      }
      return await finalize<T>(res, method, path);
    } catch (err) {
      if (err instanceof HttpError) throw err;
      unavailableSince ??= Date.now();
      if (Date.now() - unavailableSince >= 5 * 60_000) throw err;
    }
  }
}

/** An API call as the SDK's client makes it: backgrounded, polled on 202. */
async function call<T>(ctx: ProviderContext, method: string, path: string, opts: { query?: Query; body?: unknown; raw?: Uint8Array; timeoutMs?: number } = {}): Promise<T> {
  const url = urlFor(ctx, path, opts.query);
  const headers: Record<string, string> = { ...auth(ctx), [BACKGROUND_AFTER]: "5" };
  let body: Buffer | string | undefined;
  if (opts.raw) {
    headers["Content-Type"] = "application/octet-stream";
    body = toBuffer(opts.raw);
  } else if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const res = await send(url, { method, headers, body }, true, timeoutMs);
  if (res.status !== 202) return finalize<T>(res, method, path);
  try {
    return await poll<T>(ctx, res, method, path);
  } catch (err) {
    // The result was too big to store; by now the slow part is done, so a read is fetched again inline.
    if (method !== "GET" || !(err instanceof HttpError) || !/BACKGROUND_RESULT_UNSTORABLE/.test(err.message)) throw err;
    delete headers[BACKGROUND_AFTER];
    return finalize<T>(await send(url, { method, headers, body }, true, timeoutMs), method, path);
  }
}

const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

interface UploadStatus {
  uploadId: string;
  receivedBytes: number;
}

/** One chunk, retried on transient failures; after a failure the session says whether it landed. */
async function putChunk(ctx: ProviderContext, upload: string, chunk: Uint8Array, offset: number): Promise<UploadStatus> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await call<UploadStatus>(ctx, "PUT", upload, { raw: chunk, query: { offset }, timeoutMs: BYTES_TIMEOUT_MS });
    } catch (err) {
      const retryable = !(err instanceof HttpError) || err.status >= 500 || [408, 409, 429].includes(err.status);
      if (!retryable || attempt >= CHUNK_ATTEMPTS) throw err;
      await sleep(Math.min(500 * 2 ** (attempt - 1), 8000));
      const status = await call<UploadStatus>(ctx, "GET", upload).catch(() => undefined);
      if (status && status.receivedBytes > offset) return status;
    }
  }
}

async function upload(ctx: ProviderContext, vm: string, path: string, data: Uint8Array): Promise<void> {
  const size = data.byteLength;
  const session = await call<UploadStatus>(ctx, "POST", `${vm}/fs/uploads`, { body: { path, size, sha256: sha256(data) } });
  const at = `${vm}/fs/uploads/${encodeURIComponent(session.uploadId)}`;
  try {
    let offset = session.receivedBytes;
    while (offset < size) offset = (await putChunk(ctx, at, data.subarray(offset, Math.min(offset + CHUNK, size)), offset)).receivedBytes;
    await call(ctx, "POST", `${at}/commit`, { body: {} });
  } catch (err) {
    // Frees the server-side spool; the original failure is what the caller sees.
    await call(ctx, "DELETE", at).catch(() => {});
    throw err;
  }
}

interface ExecResult {
  stdout?: string | null;
  stderr?: string | null;
  /** Null when the command was killed by its timeout. */
  statusCode?: number | null;
}

// Monthly allowance at list prices: 200 × $0.04032 + 400 × $0.0129 ≈ $13.22.
const MONTHLY_USD = 200 * 0.04032 + 400 * 0.0129;

export const freestyleProvider = defineProvider({
  info: {
    id: "freestyle",
    name: "Freestyle",
    homepage: "https://freestyle.sh",
    env: ["FREESTYLE_API_KEY"],
    capabilities: ["fileList", "pause", "snapshot"],
    isolation: "microvm",
    freeTier: {
      tier: { kind: "monthly-credit", usd: Math.round(MONTHLY_USD * 100) / 100 },
      concurrency: 10,
      notes: "200 vCPU-h + 400 GiB-h memory a month; VMs pause at the limit until the reset.",
      source: "https://freestyle.sh/docs/vms/pricing-and-limits",
      checked: "2026-11-11",
    },
    pricing: { vcpuSecondUsd: 0.04032 / 3600, gibSecondUsd: 0.0129 / 3600, defaultCpu: 2, defaultMemoryMiB: 4096, source: "https://freestyle.sh/pricing" },
    surfaces: { rest: "https://api.freestyle.sh", sdk: ["freestyle (npm)"], cli: "freestyle" },
  },

  async create(spec, ctx) {
    const vm = await call<{ id: string }>(ctx, "POST", "/v5/vms", {
      body: {
        snapshotId: spec.nativeTemplate ?? null,
        metadata: spec.metadata,
        ttlSeconds: spec.timeoutSec,
        autoDeleteSeconds: 0, // ephemeral: gone once stopped
        // Freestyle VMs get no network unless asked; give outbound Internet like other providers.
        firewall: (ctx.options["firewall"] as { rules: [] } | undefined) ?? {
          rules: [{ action: "allow", source: {}, destination: { public: true } }],
        },
      },
    });
    return { providerSandboxId: vm.id };
  },

  async exec(id, command, o, ctx) {
    const cd = o.cwd ? `cd '${o.cwd.replace(/'/g, `'\\''`)}' && ` : "";
    // Unset, the API's own default limit (30 s) applies, as with the SDK.
    const timeoutMs = o.timeoutSec ? o.timeoutSec * 1000 : undefined;
    const r = await call<ExecResult>(ctx, "POST", `${vmPath(id)}/exec-await`, {
      body: { command: `${cd}${command}`, env: o.env, timeoutMs },
      timeoutMs: Math.max(120_000, (timeoutMs ?? 30_000) + 60_000),
    });
    const stdout = r.stdout ?? "";
    const stderr = r.stderr ?? "";
    if (stdout) o.onStdout?.(stdout);
    if (stderr) o.onStderr?.(stderr);
    return { stdout, stderr, exitCode: r.statusCode ?? -1 };
  },

  async readFile(id, path, ctx) {
    // Raw bytes, not backgrounded: the SDK reads files with a plain (retried) GET.
    const res = await send(urlFor(ctx, `${vmPath(id)}/fs/read`, { path }), { method: "GET", headers: auth(ctx) }, true, BYTES_TIMEOUT_MS);
    if (!res.ok) await finalize(res, "GET", `${vmPath(id)}/fs/read`);
    return new Uint8Array(await res.arrayBuffer());
  },

  async writeFile(id, path, data, ctx) {
    if (data.byteLength > RESUMABLE_BYTES) return upload(ctx, vmPath(id), path, data);
    // The hash makes the API reject a body that arrived damaged instead of writing it.
    await call(ctx, "PUT", `${vmPath(id)}/fs/write`, { raw: data, query: { path, sha256: sha256(data) }, timeoutMs: BYTES_TIMEOUT_MS });
  },

  async listFiles(id, path, ctx) {
    const dir = path.endsWith("/") ? path : `${path}/`;
    const { entries } = await call<{ entries: { name: string; kind: string }[] }>(ctx, "GET", `${vmPath(id)}/fs/dir`, { query: { path } });
    return entries.map((e) => ({ name: e.name, path: `${dir}${e.name}`, isDir: e.kind === "directory" || e.kind === "dir" }));
  },

  async pause(id, ctx) {
    await call(ctx, "POST", `${vmPath(id)}/pause`, { body: {} });
  },

  async resume(id, ctx) {
    // Boots a stopped VM or resumes a paused one.
    await call(ctx, "POST", `${vmPath(id)}/start`, { body: {} });
  },

  async kill(id, ctx) {
    await call(ctx, "DELETE", vmPath(id));
  },

  async listAlive(ctx) {
    const { vms } = await call<{ vms: { id: string; state: string }[] }>(ctx, "GET", "/v5/vms", { query: { limit: 1000 } });
    return vms.filter((v) => v.state !== "stopped").map((v) => v.id);
  },
});
