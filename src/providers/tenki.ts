// Luxor Agent Cloud (was Tenki; tenki.cloud redirects to luxor.ai since 2026-11): disposable
// Linux microVM sessions for agents. Free: $100 one-time credit the first time a payment method
// is added ($0 auth, turns on auto-reload), 5 concurrent sessions on Starter.
// CLI: `luxor` (@luxorai/cli). MCP: https://mcp.luxor.ai/mcp.
// Docs: https://luxor.ai/docs/pricing, https://luxor.ai/docs/account/free-credits,
// https://luxor.ai/docs/sandbox/sdk (the service contract is tenki.sandbox.v1; https://api.luxor.ai
// and https://api.tenki.cloud serve the same API).
//
// Spoken here with fetch and node:http2 as the calls the official SDK (npm `@tenkicloud/sandbox`
// 1.5.1, MIT, also published as `@luxorai/sandbox`; https://github.com/LuxorLabs/tenki-sdk-es)
// makes, with a Bearer token:
// - The control plane, tenki.sandbox.v1.SandboxService, in Connect's JSON codec: create, wait,
//   get, list, extend, expose, pause, resume, terminate, and minting data-plane credentials.
// - Each session's data plane, tenki.sandbox.v1.SandboxSessionDataPlaneService at the endpoint
//   the control plane hands out, with the x-tenki-session-cert credential: Run (exec), ReadFile,
//   WriteFile, List, Stat. The SDKs speak plain gRPC to it, and Run is a bidirectional stream, so
//   this goes over HTTP/2 (tenki-grpc.ts) rather than fetch.
// The SDK reads LUXOR*_* variables first and TENKI_* after; so does this adapter, and the provider
// id stays `tenki`. LUXOR_API_ENDPOINT / TENKI_API_ENDPOINT / TENKI_API_URL move the control plane.

import { connectStream, connectUnary } from "./connect-rpc.js";
import { decode, get, pb, type Fields } from "./grpc-web.js";
import { pollMs, sleep } from "./rest-helpers.js";
import { concat, GrpcError, grpcCall, grpcUnary, lenField } from "./tenki-grpc.js";
import { defineProvider, HttpError } from "./util.js";
import { SandboxRouterError } from "../core/errors.js";
import type { ProviderContext } from "../core/types.js";

const DEFAULT_BASE_URL = "https://api.luxor.ai";
const SERVICE = "tenki.sandbox.v1.SandboxService";
const DATA_PLANE = "tenki.sandbox.v1.SandboxSessionDataPlaneService";
const USER_AGENT = "sandboxrouting";
const API_KEY_PREFIXES = ["lx_", "tk_"];
/** How long create waits for RUNNING (the SDK's DEFAULT_SESSION_CREATE_TIMEOUT_MS). */
const CREATE_WAIT_MS = 180_000;
/** How long a data-plane route may take to come up (the SDK's DEFAULT_DATA_PLANE_READY_TIMEOUT_MS). */
const DATA_PLANE_READY_MS = 60_000;
/** The SDK's default disk when no image, snapshot or template sets one. */
const DEFAULT_DISK_SIZE_GB = 5;
const ENDED = ["TERMINATED", "TERMINATING", "USER_SHUTDOWN"];

/** proto3 JSON of tenki.sandbox.v1.SandboxSession, as far as the adapter reads it. */
interface SessionJson {
  id: string;
  state?: string;
  cpuCores?: number;
  memoryMb?: number;
  timeoutAt?: string;
  terminalError?: string;
}

/** What CreateSession, WaitSession and CreateSessionCredential say about the data plane. */
interface DataPlaneJson {
  session?: SessionJson;
  dataPlaneEndpoint?: string;
  credential?: { credential?: string; expiresAt?: string };
  routeStatus?: string;
}

/** A session's data-plane access: where it answers, with what, and whether its route serves yet. */
interface Grant {
  endpoint: string;
  credential: string;
  until: number;
  verified: boolean;
}

const pick = (ctx: ProviderContext, names: string[]) => names.map((n) => ctx.env[n]?.trim()).find(Boolean);

function baseUrl(ctx: ProviderContext): string {
  return (pick(ctx, ["LUXOR_API_ENDPOINT", "TENKI_API_ENDPOINT", "LUXORAI_API_ENDPOINT", "LUXORAI_API_URL", "TENKI_API_URL"]) ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
}

/** The SDK's token resolution: an auth token before an API key, and only lx_/tk_ keys. */
function token(ctx: ProviderContext): string {
  const t = pick(ctx, ["LUXOR_AUTH_TOKEN", "TENKI_AUTH_TOKEN", "LUXOR_API_KEY", "TENKI_API_KEY", "LUXORAI_AUTH_TOKEN", "LUXORAI_API_KEY"]);
  if (!t) throw new SandboxRouterError("auth", "tenki: missing auth token (set LUXOR_API_KEY)", "tenki");
  if (!API_KEY_PREFIXES.some((p) => t.startsWith(p))) throw new SandboxRouterError("auth", "tenki: invalid auth token: keys start with lx_ or tk_", "tenki");
  return t;
}

const apiHeaders = (ctx: ProviderContext) => ({ Authorization: `Bearer ${token(ctx)}`, "User-Agent": USER_AGENT });

function rpc<T>(ctx: ProviderContext, method: string, request: unknown, timeoutMs = 120_000): Promise<T> {
  return connectUnary<T>(baseUrl(ctx), `${SERVICE}/${method}`, request, { headers: apiHeaders(ctx), timeoutMs });
}

/** SESSION_STATE_RUNNING → RUNNING, as the SDK names states. */
const stateOf = (s: SessionJson | undefined) => (s?.state ?? "").replace(/^SESSION_STATE_/, "") || "UNSPECIFIED";
const isReady = (s: SessionJson) => stateOf(s) === "RUNNING";
const isTerminal = (s: SessionJson) => ["TERMINATED", "TERMINATING"].includes(stateOf(s));
const terminalError = (s: SessionJson) => new Error(`tenki: session entered terminal state: ${stateOf(s)}${s.terminalError ? `: ${s.terminalError}` : ""}`);
/** A JSON Duration from milliseconds. */
const duration = (ms: number) => `${ms / 1000}s`;

/** The SDK's poll delays (pollBackoffMs), shortened by `options.pollMs` in tests. */
const backoff = (ctx: ProviderContext, attempt: number) => {
  const ms = [100, 250, 500, 1_000][attempt] ?? 2_000;
  return sleep(Math.min(ms, pollMs(ctx, ms)));
};
/** The SDK's data-plane readiness delays (dataPlaneReadyBackoffMs). */
const readyBackoff = (ctx: ProviderContext, attempt: number, deadline: number) => {
  const ms = Math.min(50 * (attempt + 1), 750, Math.max(0, deadline - Date.now()));
  return sleep(Math.min(ms, pollMs(ctx, ms)));
};

/** The edge answers 404 (gRPC UNIMPLEMENTED) until it has applied a new session's route. */
const edgeNotReady = (err: unknown) => err instanceof GrpcError && err.code === 12 && /\b404\b/.test(err.message);
const notReadyError = (cause?: unknown) => new HttpError(503, `tenki: data-plane edge route not ready${cause instanceof Error ? ` (${cause.message.replace(/\b404\b/g, "HTTP 4xx")})` : ""}`);

const grants = new Map<string, Grant>();

/** Keeps the data-plane access a control-plane reply carries, unless its route failed. */
function remember(id: string, r: DataPlaneJson): void {
  if (r.routeStatus === "DATA_PLANE_ROUTE_STATUS_FAILED") return;
  const endpoint = r.dataPlaneEndpoint?.trim();
  const credential = r.credential?.credential;
  if (!endpoint || !credential) return;
  const expires = r.credential?.expiresAt ? Date.parse(r.credential.expiresAt) : NaN;
  grants.set(id, { endpoint, credential, until: Number.isFinite(expires) ? expires - 60_000 : Infinity, verified: r.routeStatus === "DATA_PLANE_ROUTE_STATUS_VERIFIED" });
}

/** CreateSessionCredential until the route has an endpoint, as the SDK's renewDataPlaneCredential. */
async function mint(id: string, ctx: ProviderContext): Promise<Grant> {
  const deadline = Date.now() + DATA_PLANE_READY_MS;
  let last: unknown;
  for (let attempt = 0; Date.now() < deadline; attempt++) {
    try {
      const r = await rpc<DataPlaneJson>(ctx, "CreateSessionCredential", { sessionId: id });
      if (r.routeStatus === "DATA_PLANE_ROUTE_STATUS_FAILED") throw new HttpError(503, "tenki: data-plane route verification failed");
      if (!r.dataPlaneEndpoint?.trim()) {
        if (r.routeStatus !== "DATA_PLANE_ROUTE_STATUS_NOT_READY") throw new Error("tenki: data-plane endpoint unavailable");
        last = notReadyError();
      } else {
        remember(id, r);
        const g = grants.get(id);
        if (g) return g;
        throw new Error("tenki: data-plane credential missing from CreateSessionCredential");
      }
    } catch (err) {
      // A session still settling answers FAILED_PRECONDITION; a paused or terminated one won't change.
      const settling = err instanceof HttpError && err.status === 400 && /failed_precondition/.test(err.message) && !/terminated|state\s*=\s*PAUSED/i.test(err.message);
      if (!settling) throw err;
      last = err;
    }
    await readyBackoff(ctx, attempt, deadline);
  }
  throw notReadyError(last);
}

/** The session's data-plane access, minted when missing or past its expiry (checked on every read). */
async function grantFor(id: string, ctx: ProviderContext): Promise<Grant> {
  const g = grants.get(id);
  if (g && g.until > Date.now()) return g;
  return mint(id, ctx);
}

const dpHeaders = (g: Grant) => ({ "x-tenki-session-cert": g.credential, "user-agent": USER_AGENT });
const dpUrl = (g: Grant, method: string) => `${g.endpoint.replace(/\/+$/, "")}/${DATA_PLANE}/${method}`;
const str = (no: number, s: string) => Uint8Array.from(pb.str(no, s));
const bytesOf = (f: Fields, no: number): Uint8Array => {
  const v = f.get(no)?.at(-1);
  return v instanceof Uint8Array ? v : new Uint8Array();
};

/** Probes with Stat until the edge stops answering 404; any other answer proves the route serves. */
async function ensureServing(id: string, g: Grant, ctx: ProviderContext): Promise<void> {
  if (g.verified) return;
  const deadline = Date.now() + DATA_PLANE_READY_MS;
  const probe = lenField(1, concat(str(1, id), str(2, "/home/tenki")));
  let last: unknown;
  for (let attempt = 0; Date.now() < deadline; attempt++) {
    try {
      await grpcUnary(dpUrl(g, "Stat"), dpHeaders(g), probe, 30_000);
      g.verified = true;
      return;
    } catch (err) {
      if (!edgeNotReady(err)) {
        g.verified = true;
        return;
      }
      last = err;
      await readyBackoff(ctx, attempt, deadline);
    }
  }
  throw notReadyError(last);
}

/** A unary data-plane call on a serving route; an expired credential is re-minted once. */
async function dataPlaneUnary(id: string, ctx: ProviderContext, method: string, request: Uint8Array): Promise<Fields> {
  for (let reauth = false; ; reauth = true) {
    const g = await grantFor(id, ctx);
    await ensureServing(id, g, ctx);
    try {
      return decode(await grpcUnary(dpUrl(g, method), dpHeaders(g), request, 300_000));
    } catch (err) {
      if (edgeNotReady(err)) throw notReadyError(err);
      if (reauth || !(err instanceof GrpcError && err.code === 16)) throw err;
      grants.delete(id);
    }
  }
}

/** A Run that failed before the guest answered, and is safe to send again (the SDK's establishment retry). */
function retryableRun(err: unknown, verified: boolean): boolean {
  if (edgeNotReady(err)) return true;
  if (!(err instanceof GrpcError)) return false;
  if (err.code === 14 && /ECONNRESET|connection reset|socket hang up|REFUSED_STREAM|GOAWAY|ECONNREFUSED/i.test(err.message)) return true;
  // While the route is still being provisioned the node may not know the session yet.
  return !verified && ((err.code === 5 && /\bsession not found\b/i.test(err.message)) || err.code === 14);
}

/** The guest's exit frame (RunExit). */
interface Exit {
  exitCode: number;
  reason: string;
}

/** Runs argv through the data plane's Run stream and collects its output, as the SDK's Session.exec. */
async function run(id: string, argv: string[], o: { cwd?: string; env?: Record<string, string>; timeoutMs: number }, ctx: ProviderContext) {
  const start = concat(
    str(1, id),
    pb.strs(2, argv),
    pb.str(3, o.cwd ?? ""),
    pb.map(4, o.env),
    pb.bool(6, true), // stream_stdin: the SDK always opens stdin, then closes it straight away
    pb.uint(7, Math.min(o.timeoutMs, 0xffff_ffff)),
  );
  // SandboxSessionDataPlaneServiceRunRequest{frame: RunRequest{start}} then {frame: {stdin_close: true}}.
  const requests = [lenField(1, lenField(1, start)), lenField(1, Uint8Array.from(pb.bool(4, true)))];
  const deadline = Date.now() + DATA_PLANE_READY_MS;
  let reauth = false;
  for (let attempt = 0; ; attempt++) {
    const g = await grantFor(id, ctx);
    const stdout: Uint8Array[] = [];
    const stderr: Uint8Array[] = [];
    let answered = false;
    try {
      // Run has no deadline of its own (0 = unbounded); the guest enforces timeout_ms.
      for await (const m of grpcCall(dpUrl(g, "Run"), dpHeaders(g), requests, o.timeoutMs + 3_600_000, { holdOpen: true })) {
        const frame = get.msg(decode(m), 1);
        if (!frame) continue;
        if (frame.has(6)) continue; // keepalive
        answered = true;
        g.verified = true;
        if (frame.has(2)) stdout.push(bytesOf(frame, 2));
        else if (frame.has(3)) stderr.push(bytesOf(frame, 3));
        else if (frame.has(4)) {
          const exit = get.msg(frame, 4)!;
          const e: Exit = { exitCode: get.int(exit, 1), reason: get.str(exit, 5) };
          return { ...e, stdout: concat(...stdout), stderr: concat(...stderr) };
        }
      }
      throw new Error("tenki: sandbox run stream closed before exit");
    } catch (err) {
      if (!reauth && err instanceof GrpcError && err.code === 16) {
        reauth = true;
        grants.delete(id);
        continue;
      }
      if (answered || !retryableRun(err, g.verified)) throw err;
      if (Date.now() >= deadline) throw edgeNotReady(err) ? notReadyError(err) : err;
      if (attempt > 0) await readyBackoff(ctx, attempt - 1, deadline);
    }
  }
}

/** Waits for RUNNING: the WaitSession stream, then GetSession polls if the stream gives out (the SDK's waitReady). */
async function waitReady(id: string, s: SessionJson, ctx: ProviderContext, timeoutMs: number): Promise<SessionJson> {
  const deadline = Date.now() + timeoutMs;
  try {
    for await (const r of connectStream<DataPlaneJson>(baseUrl(ctx), `${SERVICE}/WaitSession`, { sessionId: id }, { headers: apiHeaders(ctx), timeoutMs })) {
      if (r.session) s = r.session;
      remember(id, r);
    }
  } catch (err) {
    // UNIMPLEMENTED, UNAVAILABLE, DEADLINE_EXCEEDED and dropped connections fall back to polling.
    const transient = !(err instanceof HttpError) || [499, 501, 503, 504].includes(err.status);
    if (!transient || Date.now() >= deadline) throw err;
  }
  if (isReady(s)) return s;
  if (isTerminal(s)) throw terminalError(s);
  let last: unknown;
  for (let attempt = 0; Date.now() < deadline; attempt++) {
    let r: { session?: SessionJson } | undefined;
    try {
      r = await rpc<{ session?: SessionJson }>(ctx, "GetSession", { sessionId: id }, Math.max(1, Math.min(10_000, deadline - Date.now())));
    } catch (err) {
      // Replica lag (NOT_FOUND) and transient failures are retried within the budget.
      if (err instanceof HttpError && ![404, 503, 504].includes(err.status)) throw err;
      last = err;
    }
    if (r?.session) s = r.session;
    if (r && isReady(s)) return s;
    if (r && isTerminal(s)) throw terminalError(s);
    await backoff(ctx, attempt);
  }
  throw new Error(`tenki: session ${id} created but not ready within wait budget${last instanceof Error ? ` (last error: ${last.message})` : ""}`);
}

export const tenkiProvider = defineProvider({
  info: {
    id: "tenki",
    name: "Luxor Agent Cloud (was Tenki)",
    homepage: "https://luxor.ai",
    env: ["LUXOR_API_KEY"], // or TENKI_API_KEY, LUXOR_AUTH_TOKEN, TENKI_AUTH_TOKEN (isConfigured)
    capabilities: ["customImage", "ports", "pause", "fileList", "extendTimeout", "snapshot"],
    isolation: "microvm",
    freeTier: {
      tier: { kind: "one-time-credit", usd: 100 },
      concurrency: 5,
      requiresCard: true,
      notes: "$100 one-time credit when a payment method is first added ($0 auth; turns on auto-reload of $20 below $5). 5 concurrent on Starter.",
      source: "https://luxor.ai/docs/account/free-credits",
      checked: "2026-11-21",
    },
    pricing: { vcpuSecondUsd: 0.000014, gibSecondUsd: 0.0000045, defaultCpu: 2, defaultMemoryMiB: 4096, source: "https://luxor.ai/docs/pricing" },
    surfaces: {
      rest: "https://api.luxor.ai (ConnectRPC)",
      sdk: ["@tenkicloud/sandbox (npm), also @luxorai/sandbox", "tenki (PyPI)"],
      cli: "luxor",
      mcp: "https://mcp.luxor.ai/mcp",
    },
  },

  isConfigured(ctx) {
    return Boolean(ctx.env["LUXOR_API_KEY"] || ctx.env["LUXOR_AUTH_TOKEN"] || ctx.env["TENKI_API_KEY"] || ctx.env["TENKI_AUTH_TOKEN"]);
  },

  async create(spec, ctx) {
    const image = spec.image?.trim() ?? "";
    const snapshotId = spec.nativeTemplate?.trim() ?? "";
    if (image && snapshotId) throw new SandboxRouterError("invalid", "tenki: only one of image or snapshot may be set", "tenki");
    const r = await rpc<DataPlaneJson>(ctx, "CreateSession", {
      ownerType: "SERVICE",
      ownerId: "self",
      allowInbound: true,
      allowOutbound: true,
      metadata: spec.metadata,
      env: { ...spec.env },
      cpuCores: Math.max(1, Math.round(spec.cpu)),
      memoryMb: spec.memoryMiB,
      // The SDK fills a disk size only when nothing (image, snapshot) brings one.
      diskSizeGb: image || snapshotId ? undefined : DEFAULT_DISK_SIZE_GB,
      maxDuration: spec.timeoutSec > 0 ? duration(spec.timeoutSec * 1000) : undefined,
      // The SDK waits on its own (WaitSession) rather than having the server hold the create open.
      waitReady: false,
      waitForRuntime: false,
      registryRef: image || undefined,
      snapshotId: snapshotId || undefined,
      disableTailnet: false,
    });
    if (!r.session) throw new Error("tenki: CreateSession response missing `session`");
    let s = r.session;
    remember(s.id, r);
    if (!isReady(s)) {
      if (isTerminal(s)) throw terminalError(s);
      s = await waitReady(s.id, s, ctx, CREATE_WAIT_MS);
    }
    return { providerSandboxId: s.id, cpu: s.cpuCores, memoryMiB: s.memoryMb };
  },

  async exec(id, command, o, ctx) {
    // Luxor's own exec timeout defaults to 30 s; pass ours, or an hour.
    const r = await run(id, ["sh", "-c", command], { cwd: o.cwd, env: o.env, timeoutMs: (o.timeoutSec ?? 3600) * 1000 }, ctx);
    if (r.reason.startsWith("first_frame_timeout") || r.reason.startsWith("capability_unavailable")) throw new Error(`tenki: run failed: ${r.reason}`);
    // The session ended under the command: it is gone.
    if (r.reason.startsWith("session_terminated")) throw new HttpError(410, `tenki: ${r.reason}`);
    // The SDK's stdoutText/stderrText, which the adapter used: decoded and trimmed.
    const stdout = new TextDecoder().decode(r.stdout).trim();
    const stderr = new TextDecoder().decode(r.stderr).trim();
    if (stdout) o.onStdout?.(stdout);
    if (stderr) o.onStderr?.(stderr);
    return { stdout, stderr, exitCode: r.exitCode };
  },

  async readFile(id, path, ctx) {
    const f = await dataPlaneUnary(id, ctx, "ReadFile", lenField(1, concat(str(1, id), str(2, path))));
    return new Uint8Array(bytesOf(get.msg(f, 1) ?? new Map(), 2));
  },

  async writeFile(id, path, data, ctx) {
    await dataPlaneUnary(id, ctx, "WriteFile", lenField(1, concat(str(1, id), str(2, path), lenField(3, data))));
  },

  async listFiles(id, path, ctx) {
    const f = await dataPlaneUnary(id, ctx, "List", lenField(1, concat(str(1, id), str(2, path))));
    const dir = path.endsWith("/") ? path : `${path}/`;
    // ListEntry{name, is_dir, size}: the name is the entry's own, not a path.
    return get.msgs(get.msg(f, 1) ?? new Map(), 1).map((e) => {
      const name = get.str(e, 1);
      return { name, path: `${dir}${name}`, isDir: get.bool(e, 2), size: get.int(e, 3) };
    });
  },

  async getUrl(id, port, ctx) {
    return (await rpc<{ previewUrl: string }>(ctx, "ExposePort", { sessionId: id, port })).previewUrl;
  },

  async setTimeout(id, timeoutSec, ctx) {
    // Luxor extends by a duration from the current deadline; the router asks for "from now".
    const { session } = await rpc<{ session?: SessionJson }>(ctx, "GetSession", { sessionId: id });
    const timeoutAt = session?.timeoutAt ? Date.parse(session.timeoutAt) : 0;
    const remaining = Math.max(0, timeoutAt - Date.now());
    const want = timeoutSec * 1000;
    if (want > remaining) await rpc(ctx, "ExtendSession", { sessionId: id, additionalDuration: duration(want - remaining) });
  },

  async pause(id, ctx) {
    await rpc(ctx, "PauseSession", { sessionId: id, async: false }, 600_000);
    grants.delete(id);
  },

  async resume(id, ctx) {
    // Without `async`, the call returns once the session is RUNNING again.
    await rpc(ctx, "ResumeSession", { sessionId: id, async: false }, 600_000);
    grants.delete(id);
  },

  async kill(id, ctx) {
    grants.delete(id);
    await rpc(ctx, "TerminateSession", { sessionId: id });
  },

  async listAlive(ctx) {
    const ids: string[] = [];
    let pageToken = "";
    do {
      const r = await rpc<{ sessions?: SessionJson[]; nextPageToken?: string }>(ctx, "ListWorkspaceSandboxes", { pageSize: 100, pageToken, includeTerminated: false });
      for (const s of r.sessions ?? []) if (!ENDED.includes(stateOf(s))) ids.push(s.id);
      const next = (r.nextPageToken ?? "").trim();
      if (next && next === pageToken) throw new Error("tenki: pagination token did not advance");
      pageToken = next;
    } while (pageToken);
    return ids;
  },
});
