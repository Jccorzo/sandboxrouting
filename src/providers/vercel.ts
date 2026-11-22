// Vercel Sandbox: Firecracker microVMs. Free (Hobby, monthly): 5 active-CPU hours, 420 GB-h
// memory, 5,000 creations; 10 concurrent, 45 min max. Over quota, creation pauses (no charge).
// Spoken over HTTP, no SDK, with the calls the official SDK (npm `@vercel/sandbox` 3.x) makes to
// https://vercel.com/api (Bearer token, `teamId` query). REST reference:
// https://vercel.com/docs/rest-api/sandboxes. A named sandbox runs in sessions: commands, files
// and timeouts go to its current session, and a stopped one is resumed with `?resume=true`.
// CLI: `sandbox`.

import { posix } from "node:path";
import { gzipSync } from "node:zlib";
import { defineProvider, http, httpJson, HttpError } from "./util.js";
import type { ExecOptions, ExecResult, ProviderContext } from "../core/types.js";

const API = "https://vercel.com/api";
/** A command with no timeout of its own still needs a deadline: the longest sandbox lifetime. */
const NO_EXEC_TIMEOUT_MS = 5 * 3600 * 1000;

interface Creds {
  token: string;
  teamId: string;
  projectId: string;
}

/** Explicit credentials outside Vercel; inside, the project's OIDC token, which names both ids. */
function creds(ctx: ProviderContext): Creds {
  const { VERCEL_TOKEN: token, VERCEL_TEAM_ID: teamId, VERCEL_PROJECT_ID: projectId, VERCEL_OIDC_TOKEN: oidc } = ctx.env;
  if (token && teamId && projectId) return { token, teamId, projectId };
  if (oidc) {
    try {
      const claims = JSON.parse(Buffer.from(oidc.split(".")[1] ?? "", "base64url").toString()) as { owner_id?: unknown; project_id?: unknown };
      if (typeof claims.owner_id === "string" && typeof claims.project_id === "string") return { token: oidc, teamId: claims.owner_id, projectId: claims.project_id };
    } catch {
      // Reported below.
    }
    throw new HttpError(401, "vercel: VERCEL_OIDC_TOKEN is not a Vercel OIDC token (no owner_id/project_id claims)");
  }
  throw new HttpError(401, "vercel: set VERCEL_TOKEN, VERCEL_TEAM_ID and VERCEL_PROJECT_ID, or VERCEL_OIDC_TOKEN");
}

function url(ctx: ProviderContext, path: string, query: Record<string, string | undefined> = {}): { href: string; headers: Record<string, string> } {
  const c = creds(ctx);
  const base = ctx.env["VERCEL_SANDBOX_API_URL"] ?? API;
  const u = new URL(`${base.replace(/\/+$/, "")}${path}`);
  u.searchParams.set("teamId", c.teamId);
  for (const [k, v] of Object.entries(query)) if (v !== undefined) u.searchParams.set(k, v);
  return { href: u.toString(), headers: { Authorization: `Bearer ${c.token}` } };
}

function api<T>(ctx: ProviderContext, path: string, init: { method?: string; body?: unknown; query?: Record<string, string | undefined> } = {}): Promise<T> {
  const { href, headers } = url(ctx, path, init.query);
  return httpJson<T>(href, { method: init.method, body: init.body, headers, timeoutMs: 120_000 });
}

/** The current session of a named sandbox: where its commands and files go. */
interface Session {
  id: string;
  cwd: string;
  routes: { port: number; subdomain: string }[];
}

interface SandboxAndSession {
  sandbox: { name: string };
  session: { id: string; cwd?: string };
  routes?: { port: number; subdomain: string }[];
}

const cache = new Map<string, Session>();

function remember(name: string, r: SandboxAndSession): Session {
  const s = { id: r.session.id, cwd: r.session.cwd ?? "/vercel/sandbox", routes: r.routes ?? [] };
  cache.set(name, s);
  return s;
}

async function get(name: string, ctx: ProviderContext, resume = false): Promise<Session> {
  const hit = resume ? undefined : cache.get(name);
  if (hit) return hit;
  const r = await api<SandboxAndSession>(ctx, `/v2/sandboxes/${encodeURIComponent(name)}`, { query: { projectId: creds(ctx).projectId, resume: resume ? "true" : undefined } });
  return remember(name, r);
}

/** A stopped session (410), or one stopping or snapshotting (422), is resumed and the call retried, as the SDK does. */
const needsResume = (err: unknown) =>
  err instanceof HttpError && (err.status === 410 || (err.status === 422 && /"code"\s*:\s*"sandbox_(stopping|snapshotting)"/.test(err.message)));

async function withResume<T>(name: string, ctx: ProviderContext, fn: (s: Session) => Promise<T>): Promise<T> {
  try {
    return await fn(await get(name, ctx));
  } catch (err) {
    if (!needsResume(err)) throw err;
    return fn(await get(name, ctx, true));
  }
}

/** Reads an `application/x-ndjson` body one object at a time. */
async function* ndjson(body: AsyncIterable<Uint8Array>): AsyncGenerator<Record<string, unknown>> {
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of body) {
    buf += dec.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) yield JSON.parse(line) as Record<string, unknown>;
    }
  }
  const last = (buf + dec.decode()).trim();
  if (last) yield JSON.parse(last) as Record<string, unknown>;
}

interface LogLine {
  stream: "stdout" | "stderr" | "error";
  data: string | { code: string; message: string };
}

/** Runs a command and waits for it: one ndjson stream of the command, its log lines, then the command again with its exit code. */
async function run(session: Session, command: string, o: ExecOptions, ctx: ProviderContext): Promise<ExecResult> {
  const { href, headers } = url(ctx, `/v2/sandboxes/sessions/${session.id}/cmd`);
  const res = await http(href, {
    method: "POST",
    headers,
    body: { command: "sh", args: ["-c", command], cwd: o.cwd, env: o.env ?? {}, sudo: false, wait: true, logs: true },
    timeoutMs: o.timeoutSec ? o.timeoutSec * 1000 + 30_000 : NO_EXEC_TIMEOUT_MS,
  });
  if (!(res.headers.get("content-type") ?? "").startsWith("application/x-ndjson") || !res.body) {
    throw new Error(`vercel: expected a stream of command data, got ${res.headers.get("content-type") ?? "no content type"}`);
  }
  const out = { stdout: "", stderr: "" };
  const take = (line: LogLine, skip = { stdout: 0, stderr: 0 }) => {
    if (line.stream === "error") {
      const e = line.data as { code: string; message: string };
      throw new Error(`vercel: ${e.code}: ${e.message}`);
    }
    const stream = line.stream;
    const data = (line.data as string).slice(Math.min(skip[stream], (line.data as string).length));
    skip[stream] -= (line.data as string).length - data.length;
    if (!data) return;
    out[stream] += data;
    (stream === "stdout" ? o.onStdout : o.onStderr)?.(data);
  };
  let cmdId: string | undefined;
  for await (const msg of ndjson(res.body as unknown as AsyncIterable<Uint8Array>)) {
    const cmd = msg["command"] as { id: string; exitCode?: number | null } | undefined;
    if (cmd && !cmdId) cmdId = cmd.id;
    else if (cmd) return { ...out, exitCode: cmd.exitCode ?? 0 };
    else take(msg as unknown as LogLine);
  }
  if (!cmdId) throw new Error("vercel: the command stream ended before the command started");
  // The stream dropped before the command finished: read the rest of the logs, then wait for it.
  const logs = url(ctx, `/v2/sandboxes/sessions/${session.id}/cmd/${cmdId}/logs`);
  const rest = await http(logs.href, { headers: logs.headers, timeoutMs: NO_EXEC_TIMEOUT_MS });
  const skip = { stdout: out.stdout.length, stderr: out.stderr.length };
  for await (const msg of ndjson(rest.body as unknown as AsyncIterable<Uint8Array>)) take(msg as unknown as LogLine, skip);
  const done = await api<{ command: { exitCode?: number | null } }>(ctx, `/v2/sandboxes/sessions/${session.id}/cmd/${cmdId}`, { query: { wait: "true" } });
  return { ...out, exitCode: done.command.exitCode ?? 0 };
}

/** One file as a gzipped tar archive, the body `fs/write` takes. Names over ustar's limits get a pax header. */
export function tarGz(name: string, data: Uint8Array, mode = 0o644): Buffer {
  const enc = new TextEncoder();
  const header = (entryName: string, size: number, type: string) => {
    const h = Buffer.alloc(512);
    let prefix = "";
    let base = entryName;
    if (enc.encode(entryName).length > 100) {
      const cut = entryName.lastIndexOf("/", entryName.length - 1);
      if (cut > 0 && cut <= 155 && enc.encode(entryName.slice(cut + 1)).length <= 100) {
        prefix = entryName.slice(0, cut);
        base = entryName.slice(cut + 1);
      } else base = entryName.slice(0, 100);
    }
    const put = (s: string, at: number, len: number) => h.write(s, at, Math.min(len, Buffer.byteLength(s)), "utf8");
    const octal = (n: number, len: number) => n.toString(8).padStart(len - 1, "0") + "\0";
    put(base, 0, 100);
    put(octal(mode, 8), 100, 8);
    put(octal(0, 8), 108, 8);
    put(octal(0, 8), 116, 8);
    put(octal(size, 12), 124, 12);
    put(octal(Math.floor(Date.now() / 1000), 12), 136, 12);
    h.fill(" ", 148, 156);
    put(type, 156, 1);
    put("ustar\0", 257, 6);
    put("00", 263, 2);
    put(prefix, 345, 155);
    let sum = 0;
    for (const b of h) sum += b;
    put(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
    return h;
  };
  const pad = (n: number) => Buffer.alloc((512 - (n % 512)) % 512);
  const parts: Buffer[] = [];
  const fits = enc.encode(name).length <= 100 || (name.lastIndexOf("/") > 0 && name.lastIndexOf("/") <= 155 && enc.encode(name.slice(name.lastIndexOf("/") + 1)).length <= 100);
  if (!fits) {
    // A pax record is "<length> path=<name>\n", where the length counts itself.
    const body = ` path=${name}\n`;
    let len = Buffer.byteLength(body) + 1;
    while (String(len).length + Buffer.byteLength(body) !== len) len = String(len).length + Buffer.byteLength(body);
    const record = Buffer.from(`${len}${body}`);
    parts.push(header("PaxHeader", record.length, "x"), record, pad(record.length));
  }
  parts.push(header(name, data.length, "0"), Buffer.from(data), pad(data.length), Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}

// Free usage expressed in dollars at Pro prices, so it meters like the others:
// 5 active-CPU h × $0.128 + 420 GB-h × $0.0212 ≈ $9.54. Metering wall-clock CPU is
// conservative: Vercel bills CPU only while active.
const HOBBY_USD = 5 * 0.128 + 420 * 0.0212;

export const vercelProvider = defineProvider({
  info: {
    id: "vercel",
    name: "Vercel Sandbox",
    homepage: "https://vercel.com/docs/sandbox",
    env: ["VERCEL_TOKEN", "VERCEL_TEAM_ID", "VERCEL_PROJECT_ID"],
    capabilities: ["customImage", "ports", "extendTimeout", "pause"],
    isolation: "microvm",
    maxTimeoutSec: 5 * 3600,
    freeTier: {
      tier: { kind: "monthly-credit", usd: Math.round(HOBBY_USD * 100) / 100 },
      concurrency: 10,
      maxLifetimeSec: 45 * 60,
      requiresCard: false,
      notes: "Hobby: 5 active-CPU h + 420 GB-h memory + 5,000 creations a month; creation pauses at the limit.",
      source: "https://vercel.com/docs/sandbox/pricing",
      checked: "2026-11-11",
    },
    pricing: {
      vcpuSecondUsd: 0.128 / 3600,
      gibSecondUsd: 0.0212 / 3600,
      defaultCpu: 2,
      defaultMemoryMiB: 4096, // 2 GB per vCPU
      billing: "active-cpu", // Active CPU only; provisioned memory for every second
      source: "https://vercel.com/docs/sandbox/pricing",
    },
    surfaces: { rest: "https://api.vercel.com (/v2/sandboxes)", sdk: ["@vercel/sandbox (npm)", "vercel (PyPI)"], cli: "sandbox" },
  },

  isConfigured(ctx) {
    return Boolean(ctx.env["VERCEL_OIDC_TOKEN"] || (ctx.env["VERCEL_TOKEN"] && ctx.env["VERCEL_TEAM_ID"] && ctx.env["VERCEL_PROJECT_ID"]));
  },

  async create(spec, ctx) {
    const ports = (ctx.options["ports"] as number[] | undefined) ?? [];
    const vcpus = Math.min(8, Math.max(1, Math.round(spec.cpu)));
    const image = spec.nativeTemplate ?? spec.image;
    // An image goes to /v3, a runtime to /v2, as the SDK picks.
    const r = await api<SandboxAndSession>(ctx, image ? "/v3/sandboxes" : "/v2/sandboxes", {
      method: "POST",
      body: {
        projectId: creds(ctx).projectId,
        ports,
        timeout: spec.timeoutSec * 1000,
        resources: { vcpus },
        ...(image ? { image } : { runtime: String(ctx.options["runtime"] ?? "node22") }),
        env: spec.env,
        tags: spec.metadata,
        persistent: false,
      },
    });
    remember(r.sandbox.name, r);
    return { providerSandboxId: r.sandbox.name, cpu: vcpus, memoryMiB: vcpus * 2048 };
  },

  async exec(id, command, o, ctx) {
    return withResume(id, ctx, (s) => run(s, command, o, ctx));
  },

  async readFile(id, path, ctx) {
    return withResume(id, ctx, async (s) => {
      const { href, headers } = url(ctx, `/v2/sandboxes/sessions/${s.id}/fs/read`);
      const res = await http(href, { method: "POST", headers, body: { path, cwd: s.cwd }, timeoutMs: 600_000 });
      if (!(res.headers.get("content-type") ?? "").includes("application/octet-stream")) {
        throw new Error(`vercel: unexpected response reading ${path}: ${res.status} ${res.headers.get("content-type") ?? "(no content type)"}`);
      }
      return new Uint8Array(await res.arrayBuffer());
    });
  },

  async writeFile(id, path, data, ctx) {
    await withResume(id, ctx, async (s) => {
      const name = posix.relative("/", posix.isAbsolute(path) ? posix.normalize(path) : posix.join(s.cwd, path));
      const { href, headers } = url(ctx, `/v2/sandboxes/sessions/${s.id}/fs/write`);
      await http(href, { method: "POST", headers: { ...headers, "content-type": "application/gzip", "x-cwd": "/" }, raw: tarGz(name, data), timeoutMs: 600_000 });
    });
  },

  async getUrl(id, port, ctx) {
    const route = (await get(id, ctx)).routes.find((r) => r.port === port);
    if (!route) throw new Error(`No route for port ${port}`);
    return `https://${route.subdomain}.vercel.run`;
  },

  async setTimeout(id, timeoutSec, ctx) {
    // Vercel extends by a duration; the router asks for "this long from now".
    await withResume(id, ctx, (s) => api(ctx, `/v2/sandboxes/sessions/${s.id}/extend-timeout`, { method: "POST", body: { duration: timeoutSec * 1000 } }));
  },

  async pause(id, ctx) {
    const s = await get(id, ctx);
    await api(ctx, `/v2/sandboxes/sessions/${s.id}/stop`, { method: "POST" });
  },

  async resume(id, ctx) {
    await get(id, ctx, true);
  },

  async kill(id, ctx) {
    await get(id, ctx);
    cache.delete(id);
    await api(ctx, `/v2/sandboxes/${encodeURIComponent(id)}`, { method: "DELETE", query: { projectId: creds(ctx).projectId } });
  },
});
