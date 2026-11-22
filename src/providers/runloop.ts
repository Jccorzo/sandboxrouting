// Runloop devboxes: VMs. Free: $50 one-time trial credit, 3 running devboxes, 48 h max.
// Winding down: Runloop's docs (docs.runloop.ai/docs/transitions/overview) say transition
// support for existing customers ended 2026-11-13. On 2026-11-21 api.runloop.ai no longer
// resolved and platform.runloop.ai answered 503, though runloop.ai still offered sign-up.
// REST: https://api.runloop.ai (Bearer), docs https://docs.runloop.ai. Spoken over HTTP, no SDK,
// with the calls the official SDK (npm `@runloop/api-client` 3.0.0, MIT) makes, including its
// retries and long polls. CLI + MCP: `rli mcp start`.

import { randomBytes, randomUUID } from "node:crypto";
import { defineProvider, dispatcherFor, HttpError } from "./util.js";
import { inline, pollMs, sleep, sse } from "./rest-helpers.js";
import { SandboxRouterError } from "../core/errors.js";
import type { ProviderContext } from "../core/types.js";

interface DevboxView {
  id: string;
  status: string;
  tunnel?: { tunnel_key: string } | null;
}

interface ExecutionView {
  execution_id: string;
  status: string;
  exit_status?: number | null;
  stdout?: string | null;
  stderr?: string | null;
  stdout_truncated?: boolean | null;
  stderr_truncated?: boolean | null;
}

const DEFAULT_BASE = "https://api.runloop.ai";
/** The SDK's own override, RUNLOOP_BASE_URL. */
const baseUrl = (ctx: ProviderContext) => (ctx.env["RUNLOOP_BASE_URL"] || DEFAULT_BASE).replace(/\/+$/, "");

/** The SDK's defaults: 30 s per request, 10 min for exec and file calls, 5 retries. */
const TIMEOUT_MS = 30_000;
const LONG_MS = 600_000;
const MAX_RETRIES = 5;

interface Call {
  query?: Record<string, string | undefined>;
  body?: unknown;
  timeoutMs?: number;
  accept?: string;
  /** Long polls and streams take none: their 408 means "ask again". */
  retries?: number;
}

/** Headers from RUNLOOP_CUSTOM_HEADERS, one `Name: value` per line, as the SDK reads them. */
function customHeaders(ctx: ProviderContext): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of (ctx.env["RUNLOOP_CUSTOM_HEADERS"] ?? "").split("\n")) {
    const colon = line.indexOf(":");
    if (colon >= 0) out[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return out;
}

/**
 * One API call, retried as the SDK does: on connection errors, 408, 409, 429 and 5xx (unless
 * `x-should-retry` says otherwise), waiting as Retry-After says or backing off exponentially from
 * one second (`options.pollMs` in tests). Non-GET calls carry one idempotency key across retries.
 */
async function call(ctx: ProviderContext, method: string, path: string, c: Call = {}): Promise<Response> {
  const key = ctx.env["RUNLOOP_API_KEY"];
  if (!key) throw new SandboxRouterError("auth", "runloop needs RUNLOOP_API_KEY", "runloop");
  const query = Object.entries(c.query ?? {}).filter((e): e is [string, string] => e[1] !== undefined);
  const url = `${baseUrl(ctx)}${path}${query.length ? `?${new URLSearchParams(query)}` : ""}`;
  const headers: Record<string, string> = { ...customHeaders(ctx), Accept: c.accept ?? "application/json", Authorization: `Bearer ${key}` };
  if (method !== "GET") headers["x-request-id"] = `stainless-node-retry-${randomUUID()}`;
  if (c.body !== undefined) headers["Content-Type"] = "application/json";
  const body = c.body === undefined ? undefined : JSON.stringify(c.body);
  const timeoutMs = c.timeoutMs ?? TIMEOUT_MS;
  const maxRetries = c.retries ?? MAX_RETRIES;
  for (let retry = 0; ; retry++) {
    // The timeout covers the wait for headers, as in the SDK; a stream's body may take longer.
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(new DOMException("timed out", "TimeoutError")), timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body,
        signal: abort.signal,
        dispatcher: dispatcherFor(Math.max(timeoutMs, LONG_MS) + 1000) as unknown as RequestInit["dispatcher"],
      });
    } catch (err) {
      if (retry < maxRetries) {
        await sleep(backoff(ctx, retry));
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
    if (res.ok) return res;
    const should = res.headers.get("x-should-retry");
    const retryable = should === "true" || (should !== "false" && (res.status === 408 || res.status === 409 || res.status === 429 || res.status >= 500));
    if (retry < maxRetries && retryable) {
      await res.body?.cancel();
      await sleep(retryAfter(res) ?? backoff(ctx, retry));
      continue;
    }
    const text = await res.text().catch(() => "");
    throw new HttpError(res.status, `${method} ${path.split("?")[0]}: ${res.status} ${text.slice(0, 500)}`);
  }
}

function retryAfter(res: Response): number | undefined {
  const ms = parseFloat(res.headers.get("retry-after-ms") ?? "");
  if (!Number.isNaN(ms)) return ms;
  const header = res.headers.get("retry-after");
  if (!header) return undefined;
  const sec = parseFloat(header);
  return Number.isNaN(sec) ? Math.max(0, Date.parse(header) - Date.now()) || undefined : sec * 1000;
}

/** 1 s, 2 s, 4 s ... up to 60 s, less up to 25 % jitter; `options.pollMs` replaces the second. */
const backoff = (ctx: ProviderContext, retry: number) => Math.min(pollMs(ctx, 1000) * 2 ** retry, 60 * pollMs(ctx, 1000)) * (1 - Math.random() * 0.25);

async function json<T>(ctx: ProviderContext, method: string, path: string, c: Call = {}): Promise<T> {
  const text = await (await call(ctx, method, path, c)).text();
  return (text ? JSON.parse(text) : undefined) as T;
}

const box = (id: string) => `/v1/devboxes/${id}`;

/** A time-ordered UUID (v7), the kind the SDK sends as `command_id`. */
function uuidv7(): string {
  const b = randomBytes(16);
  b.writeUIntBE(Date.now(), 0, 6);
  b[6] = (b[6]! & 0x0f) | 0x70;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** The SDK's long poll: the server holds each request up to ~25 s and answers 408 to be asked again. */
async function longPoll<T>(ask: () => Promise<T>, done: (r: T) => boolean): Promise<T> {
  for (;;) {
    try {
      const r = await ask();
      if (done(r)) return r;
    } catch (err) {
      if (err instanceof HttpError && err.status === 408) continue;
      throw err;
    }
  }
}

/** Waits until the devbox runs; a devbox that failed or shut down instead throws. */
async function awaitRunning(id: string, ctx: ProviderContext): Promise<DevboxView> {
  const view = await longPoll(
    () => json<DevboxView>(ctx, "POST", `${box(id)}/wait_for_status`, { body: { statuses: ["running", "failure", "shutdown"] }, timeoutMs: LONG_MS, retries: 0 }),
    (v) => !["provisioning", "initializing"].includes(v.status),
  );
  if (view.status !== "running") throw new Error(`Devbox ${id} is in non-running state ${view.status}`);
  return view;
}

const awaitCompleted = (id: string, executionId: string, ctx: ProviderContext) =>
  longPoll(
    () => json<ExecutionView>(ctx, "POST", `${box(id)}/executions/${executionId}/wait_for_status`, { body: { statuses: ["completed"] }, timeoutMs: LONG_MS, retries: 0 }),
    (v) => v.status === "completed",
  );

/**
 * A command's stdout or stderr as server-sent events, each `{output, offset}`. A stream the server
 * idles out (408, or a timeout) is reopened from the last offset seen, as the SDK does.
 */
async function* outputStream(id: string, executionId: string, which: "stdout" | "stderr", ctx: ProviderContext): AsyncGenerator<string> {
  let offset: number | undefined;
  for (;;) {
    try {
      const res = await call(ctx, "GET", `${box(id)}/executions/${executionId}/stream_${which}_updates`, { query: { offset: String(offset ?? 0) }, accept: "text/event-stream", retries: 0 });
      if (!res.body) return;
      for await (const ev of sse(res.body)) {
        if (ev.event === "error") throw new Error(ev.data);
        if (!ev.data) continue;
        const chunk = JSON.parse(ev.data) as { output: string; offset?: number };
        if (chunk.offset !== undefined) offset = chunk.offset;
        yield chunk.output;
      }
      return;
    } catch (err) {
      const idle = (err instanceof HttpError && err.status === 408) || (err instanceof Error && err.name === "TimeoutError");
      if (!idle) throw err;
    }
  }
}

/** The execution's output, read whole from the stream when the result says it was cut short. */
async function fullOutput(id: string, r: ExecutionView, which: "stdout" | "stderr", ctx: ProviderContext): Promise<string> {
  if (r[`${which}_truncated`] !== true) return r[which] ?? "";
  let out = "";
  for await (const chunk of outputStream(id, r.execution_id, which, ctx)) out += chunk;
  return out;
}

export const runloopProvider = defineProvider({
  info: {
    id: "runloop",
    name: "Runloop",
    offByDefault: "Runloop is winding down: transition support ended 2026-11-13 and api.runloop.ai stopped resolving by 2026-11-21",
    homepage: "https://www.runloop.ai",
    env: ["RUNLOOP_API_KEY"],
    capabilities: ["ports", "pause", "snapshot"],
    isolation: "vm",
    maxTimeoutSec: 48 * 3600,
    freeTier: {
      tier: { kind: "one-time-credit", usd: 50 },
      concurrency: 3,
      maxLifetimeSec: 48 * 3600,
      requiresCard: false,
      notes: "$50 one-time trial credit; 3 running devboxes. Winding down: transition support ended 2026-11-13 and the API host stopped resolving by 2026-11-21.",
      source: "https://docs.runloop.ai/docs/transitions/overview",
      checked: "2026-11-21",
    },
    pricing: { vcpuSecondUsd: 0.00003, gibSecondUsd: 0.000007, defaultCpu: 1, defaultMemoryMiB: 2048, source: "https://www.runloop.ai/pricing" },
    surfaces: { rest: "https://api.runloop.ai", sdk: ["@runloop/api-client (npm)", "runloop_api_client (PyPI)"], cli: "rli", mcp: "rli mcp start" },
  },

  async create(spec, ctx) {
    const custom = spec.cpu !== 1 || spec.memoryMiB !== 2048;
    const created = await json<DevboxView>(ctx, "POST", "/v1/devboxes/create_and_await_running", {
      body: {
        blueprint_name: spec.nativeTemplate ?? null,
        environment_variables: spec.env,
        metadata: spec.metadata,
        launch_parameters: {
          keep_alive_time_seconds: spec.timeoutSec,
          ...(custom
            ? { resource_size_request: "CUSTOM_SIZE", custom_cpu_cores: Math.max(1, Math.round(spec.cpu)), custom_gb_memory: Math.max(1, Math.round(spec.memoryMiB / 1024)) }
            : { resource_size_request: "SMALL" }),
        },
      },
    });
    // The server holds the call while it can; a devbox still booting is waited for.
    if (created.status !== "running") await awaitRunning(created.id, ctx);
    return { providerSandboxId: created.id };
  },

  async exec(id, command, o, ctx) {
    const line = inline(command, o);
    let r: ExecutionView;
    if (o.onStdout || o.onStderr) {
      // Streaming: start it, follow the output streams, and long-poll until it completes.
      const started = await json<ExecutionView>(ctx, "POST", `${box(id)}/execute_async`, { body: { command: line } });
      const follow = async (which: "stdout" | "stderr", cb: ((s: string) => void) | undefined) => {
        if (!cb) return;
        try {
          for await (const chunk of outputStream(id, started.execution_id, which, ctx)) cb(chunk);
        } catch {
          // As in the SDK, a broken stream doesn't fail the command; its result still carries the output.
        }
      };
      const [done] = await Promise.allSettled([awaitCompleted(id, started.execution_id, ctx), follow("stdout", o.onStdout), follow("stderr", o.onStderr)]);
      if (done.status === "rejected") throw done.reason;
      r = done.value;
    } else {
      // The server holds `execute` until the command ends or a while passes; then it is long-polled.
      r = await json<ExecutionView>(ctx, "POST", `${box(id)}/execute`, { body: { command: line, command_id: uuidv7() }, timeoutMs: LONG_MS });
      if (r.status !== "completed") r = await awaitCompleted(id, r.execution_id, ctx);
    }
    const [stdout, stderr] = await Promise.all([fullOutput(id, r, "stdout", ctx), fullOutput(id, r, "stderr", ctx)]);
    return { stdout, stderr, exitCode: r.exit_status ?? -1 };
  },

  async readFile(id, path, ctx) {
    const res = await call(ctx, "POST", `${box(id)}/read_file_contents`, { body: { file_path: path }, accept: "text/plain", timeoutMs: LONG_MS });
    return new TextEncoder().encode(await res.text());
  },

  async writeFile(id, path, data, ctx) {
    // write takes text; binary goes through the router's exec fallback via base64.
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(data);
    } catch {
      throw new SandboxRouterError("unsupported", "binary write", "runloop");
    }
    await json(ctx, "POST", `${box(id)}/write_file_contents`, { body: { file_path: path, contents: text }, timeoutMs: LONG_MS });
  },

  async getUrl(id, port, ctx) {
    if (!(await json<DevboxView>(ctx, "GET", box(id))).tunnel) await json(ctx, "POST", `${box(id)}/enable_tunnel`, { body: { auth_mode: "open" } });
    const tunnel = (await json<DevboxView>(ctx, "GET", box(id))).tunnel;
    if (!tunnel) throw new Error("No tunnel has been enabled for this devbox. Call net.enableTunnel() first.");
    // Tunnels live under the API's domain: api.runloop.ai → {port}-{key}.tunnel.runloop.ai.
    const apiHost = new URL(baseUrl(ctx)).hostname;
    return `https://${port}-${tunnel.tunnel_key}.tunnel.${apiHost.startsWith("api.") ? apiHost.slice(4) : apiHost}`;
  },

  async setTimeout(id, _timeoutSec, ctx) {
    await json(ctx, "POST", `${box(id)}/keep_alive`);
  },

  async pause(id, ctx) {
    await json(ctx, "POST", `${box(id)}/suspend`);
  },

  async resume(id, ctx) {
    await json(ctx, "POST", `${box(id)}/resume`);
    await awaitRunning(id, ctx);
  },

  async kill(id, ctx) {
    await json(ctx, "POST", `${box(id)}/shutdown`);
  },

  async listAlive(ctx) {
    const ids: string[] = [];
    let after: string | undefined;
    for (;;) {
      const page = await json<{ devboxes?: { id: string }[]; has_more?: boolean }>(ctx, "GET", "/v1/devboxes", { query: { status: "running", starting_after: after } });
      const items = page.devboxes ?? [];
      ids.push(...items.map((d) => d.id));
      // A cursor page: the next one starts after the last id, until has_more is false.
      if (page.has_more === false || !items.length) return ids;
      after = items[items.length - 1]!.id;
    }
  },
});
