// One adapter for every service that speaks E2B's sandbox API: E2B itself, and the clouds
// that host an E2B-compatible endpoint (Novita, Tencent Cloud Agent Sandbox, Volcengine AgentKit).
// All of them take the same HTTP calls with their own key and endpoint; no SDK is needed. The
// services differ in what they implement, so each says which optional calls it has.
//
// Two APIs, both spoken here with fetch, as the official `e2b` SDK speaks them:
// - The control plane, REST at https://api.<domain> with an X-API-KEY header: create, connect,
//   kill, timeout, pause, list. OpenAPI: https://docs.e2b.dev/openapi-public.yaml.
// - envd, the daemon inside each sandbox, at https://49983-<id>.<domain> (or
//   https://sandbox.<domain> with E2b-Sandbox-Id/E2b-Sandbox-Port headers on E2B's own domains),
//   with the sandbox's envdAccessToken as X-Access-Token: REST GET/POST /files for file contents,
//   and Connect RPC (JSON codec) for process.Process/Start and filesystem.Filesystem/ListDir.
//   Spec: https://github.com/e2b-dev/infra/tree/main/packages/envd/spec (envd.yaml, *.proto).

import { connectStream, connectUnary } from "./connect-rpc.js";
import { defineProvider, http, HttpError, httpJson } from "./util.js";
import type { ProviderAdapter, ProviderContext, ProviderInfo } from "../core/types.js";

/** What it takes to reach a service: a key, plus its domain or API URL. */
export interface E2bConnection {
  apiKey?: string;
  /** Sandbox domain: the API is `api.<domain>`, a sandbox `<port>-<id>.<domain>`. */
  domain?: string;
  /** Control-plane URL, for services whose API isn't at `api.<domain>`. */
  apiUrl?: string;
  /** One URL for every sandbox's envd, instead of the per-sandbox host (E2B_SANDBOX_URL). */
  sandboxUrl?: string;
}

export interface E2bCompatibleOptions {
  info: ProviderInfo;
  connection(ctx: ProviderContext): E2bConnection;
  /** Template when the caller names none. Undefined uses E2B's default, `base`. */
  template?(ctx: ProviderContext): string | undefined;
  /**
   * False when the service lacks `POST /v2/sandboxes/{id}/connect`: a sandbox is then only
   * reachable from the process that created it, and paused ones can't be resumed.
   */
  reconnect?: boolean;
  pause?: boolean;
  setTimeout?: boolean;
  ports?: boolean;
  /** Lists running and paused sandboxes; an object narrows the list by metadata. */
  listAlive?: boolean | ((ctx: ProviderContext) => Record<string, string>);
}

/** envd's port inside every sandbox. */
const ENVD_PORT = 49983;
/** Domains whose sandboxes all answer at `sandbox.<domain>`, told apart by headers (as the SDK does). */
const SHARED_HOST_DOMAINS = ["e2b.app", "e2b.dev", "e2b.pro", "e2b-staging.dev"];
/** envd versions before this one need the user named on every call (the SDK's ENVD_DEFAULT_USER). */
const ENVD_DEFAULT_USER = "0.4.0";
/** Default template, the SDK's `Sandbox.defaultTemplate`. */
const DEFAULT_TEMPLATE = "base";
/** How often envd sends a keepalive event on a command stream, so idle proxies don't cut it. */
const KEEPALIVE_SEC = 50;
/** A command with no timeout still needs a deadline: E2B's longest sandbox lifetime. */
const NO_EXEC_TIMEOUT_MS = 24 * 3600 * 1000;

/** Compares dotted versions: negative when `a` is older than `b`. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

/** What create and connect answer (the API's `Sandbox` schema), as far as the adapter uses it. */
interface SandboxResponse {
  sandboxID: string;
  envdVersion: string;
  envdAccessToken?: string;
  domain?: string | null;
}

/** A sandbox the adapter can reach: where its envd answers and with what. */
interface Handle {
  id: string;
  domain: string;
  envdUrl: string;
  envdVersion: string;
  headers: Record<string, string>;
}

/** process.Process/Start stream messages (proto3 JSON: bytes are base64, zero values left out). */
interface StartResponse {
  event?: {
    start?: { pid?: number };
    data?: { stdout?: string; stderr?: string };
    end?: { exitCode?: number; exited?: boolean; status?: string; error?: string };
    keepalive?: Record<string, never>;
  };
}

interface ListDirResponse {
  entries?: { name: string; path: string; type?: string; size?: string | number; isSymlink?: boolean }[];
}

export function e2bCompatible(o: E2bCompatibleOptions): ProviderAdapter {
  const id = o.info.id;
  const cache = new Map<string, Handle>();
  const reconnect = o.reconnect ?? true;

  /** The service's endpoints. Unset fields fall back to the E2B_* variables, as the SDK's do. */
  function conn(ctx: ProviderContext) {
    const c = o.connection(ctx);
    const pick = (v: string | undefined, fallback: string | undefined) => (v ? v : fallback || undefined);
    const domain = pick(c.domain, ctx.env["E2B_DOMAIN"]) ?? "e2b.app";
    return {
      apiKey: pick(c.apiKey, ctx.env["E2B_API_KEY"]),
      domain,
      apiUrl: (pick(c.apiUrl, ctx.env["E2B_API_URL"]) ?? `https://api.${domain}`).replace(/\/+$/, ""),
      sandboxUrl: pick(c.sandboxUrl, ctx.env["E2B_SANDBOX_URL"])?.replace(/\/+$/, ""),
    };
  }

  /** A control-plane call. */
  function api<T>(ctx: ProviderContext, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const c = conn(ctx);
    return httpJson<T>(`${c.apiUrl}${path}`, { ...init, headers: c.apiKey ? { "X-API-KEY": c.apiKey } : {}, timeoutMs: 60_000 });
  }

  function handle(r: SandboxResponse, ctx: ProviderContext): Handle {
    const c = conn(ctx);
    const domain = r.domain || c.domain;
    const envdUrl = c.sandboxUrl ?? (SHARED_HOST_DOMAINS.includes(domain) ? `https://sandbox.${domain}` : `https://${ENVD_PORT}-${r.sandboxID}.${domain}`);
    const headers: Record<string, string> = { "E2b-Sandbox-Id": r.sandboxID, "E2b-Sandbox-Port": String(ENVD_PORT) };
    if (r.envdAccessToken) headers["X-Access-Token"] = r.envdAccessToken;
    return { id: r.sandboxID, domain, envdUrl, envdVersion: r.envdVersion, headers };
  }

  /** Old envd needs the user (`user`) named on each call; newer envd picks its default. */
  const oldEnvd = (h: Handle) => compareVersions(h.envdVersion, ENVD_DEFAULT_USER) < 0;
  const userAuth = (h: Handle): Record<string, string> => (oldEnvd(h) ? { Authorization: `Basic ${Buffer.from("user:").toString("base64")}` } : {});
  const filesUrl = (h: Handle, path: string) => `${h.envdUrl}/files?${new URLSearchParams(oldEnvd(h) ? { path, username: "user" } : { path })}`;

  async function get(sandboxId: string, ctx: ProviderContext): Promise<Handle> {
    const hit = cache.get(sandboxId);
    if (hit) return hit;
    if (!reconnect) throw new Error(`${id} cannot reconnect to sandbox ${sandboxId}: only the process that created it can reach it`);
    // connect also resumes a paused sandbox.
    const r = await api<SandboxResponse>(ctx, `/v2/sandboxes/${encodeURIComponent(sandboxId)}/connect`, { method: "POST", body: {} });
    const h = handle(r, ctx);
    cache.set(sandboxId, h);
    return h;
  }

  const adapter: ProviderAdapter = {
    info: o.info,

    async create(spec, ctx) {
      const r = await api<SandboxResponse>(ctx, "/v2/sandboxes", {
        method: "POST",
        body: {
          templateID: spec.nativeTemplate ?? o.template?.(ctx) ?? DEFAULT_TEMPLATE,
          metadata: spec.metadata,
          envVars: spec.env,
          timeout: Math.ceil(spec.timeoutSec),
        },
      });
      if (compareVersions(r.envdVersion, "0.1.0") < 0) {
        await adapter.kill(r.sandboxID, ctx);
        throw new Error(`${id}: the template runs envd ${r.envdVersion}, older than 0.1.0; rebuild it`);
      }
      cache.set(r.sandboxID, handle(r, ctx));
      return { providerSandboxId: r.sandboxID };
    },

    async exec(sandboxId, command, x, ctx) {
      const h = await get(sandboxId, ctx);
      const request = { process: { cmd: "/bin/bash", args: ["-l", "-c", command], envs: x.env, cwd: x.cwd }, stdin: false };
      const headers = { ...h.headers, ...userAuth(h), "Keepalive-Ping-Interval": String(KEEPALIVE_SEC) };
      const timeoutMs = x.timeoutSec ? x.timeoutSec * 1000 : NO_EXEC_TIMEOUT_MS;
      const out = new TextDecoder();
      const err = new TextDecoder();
      let stdout = "";
      let stderr = "";
      for await (const r of connectStream<StartResponse>(h.envdUrl, "process.Process/Start", request, { headers, timeoutMs })) {
        const ev = r.event ?? {};
        if (ev.data?.stdout) {
          const t = out.decode(Buffer.from(ev.data.stdout, "base64"), { stream: true });
          stdout += t;
          if (t) x.onStdout?.(t);
        }
        if (ev.data?.stderr) {
          const t = err.decode(Buffer.from(ev.data.stderr, "base64"), { stream: true });
          stderr += t;
          if (t) x.onStderr?.(t);
        }
        if (ev.end) return { stdout: stdout + out.decode(), stderr: stderr + err.decode(), exitCode: ev.end.exitCode ?? 0 };
      }
      throw new Error(`${id}: the command stream for ${sandboxId} ended before the command did`);
    },

    async readFile(sandboxId, path, ctx) {
      const h = await get(sandboxId, ctx);
      const res = await http(filesUrl(h, path), { headers: h.headers, timeoutMs: 60_000 });
      return new Uint8Array(await res.arrayBuffer());
    },

    async writeFile(sandboxId, path, data, ctx) {
      const h = await get(sandboxId, ctx);
      const form = new FormData();
      form.append("file", new Blob([data.slice()]), path);
      await http(filesUrl(h, path), { method: "POST", headers: h.headers, raw: form, timeoutMs: 60_000 });
    },

    async listFiles(sandboxId, path, ctx) {
      const h = await get(sandboxId, ctx);
      const r = await connectUnary<ListDirResponse>(h.envdUrl, "filesystem.Filesystem/ListDir", { path, depth: 1 }, { headers: { ...h.headers, ...userAuth(h) }, timeoutMs: 60_000 });
      // A symlink reports its target's type; the SDK lists it as a symlink, not a directory.
      return (r.entries ?? []).map((e) => ({ name: e.name, path: e.path, isDir: !e.isSymlink && e.type === "FILE_TYPE_DIRECTORY", size: Number(e.size ?? 0) }));
    },

    async kill(sandboxId, ctx) {
      cache.delete(sandboxId);
      try {
        await api(ctx, `/sandboxes/${encodeURIComponent(sandboxId)}`, { method: "DELETE" });
      } catch (err) {
        // Already gone.
        if (!(err instanceof HttpError && err.status === 404)) throw err;
      }
    },
  };

  if (o.ports) {
    adapter.getUrl = async (sandboxId, port, ctx) => `https://${port}-${sandboxId}.${(await get(sandboxId, ctx)).domain}`;
  }
  if (o.setTimeout) {
    adapter.setTimeout = async (sandboxId, timeoutSec, ctx) => {
      await get(sandboxId, ctx);
      await api(ctx, `/sandboxes/${encodeURIComponent(sandboxId)}/timeout`, { method: "POST", body: { timeout: Math.ceil(timeoutSec) } });
    };
  }
  if (o.pause && reconnect) {
    adapter.pause = async (sandboxId, ctx) => {
      await get(sandboxId, ctx);
      try {
        await api(ctx, `/sandboxes/${encodeURIComponent(sandboxId)}/pause`, { method: "POST", body: {} });
      } catch (err) {
        // 409: already paused.
        if (!(err instanceof HttpError && err.status === 409)) throw err;
      }
      cache.delete(sandboxId);
    };
    adapter.resume = async (sandboxId, ctx) => {
      cache.delete(sandboxId);
      await get(sandboxId, ctx); // connect resumes a paused sandbox
    };
  }
  if (o.listAlive) {
    const narrow = typeof o.listAlive === "function" ? o.listAlive : undefined;
    adapter.listAlive = async (ctx) => {
      const c = conn(ctx);
      const metadata = narrow?.(ctx);
      const ids: string[] = [];
      let nextToken: string | undefined;
      do {
        const q = new URLSearchParams({ state: "running,paused" });
        // The filter is itself a query string of encoded pairs, as the SDK sends it.
        if (metadata) q.set("metadata", new URLSearchParams(Object.entries(metadata).map(([k, v]): [string, string] => [encodeURIComponent(k), encodeURIComponent(v)])).toString());
        if (nextToken) q.set("nextToken", nextToken);
        const res = await http(`${c.apiUrl}/v2/sandboxes?${q}`, { headers: c.apiKey ? { "X-API-KEY": c.apiKey } : {}, timeoutMs: 60_000 });
        for (const s of ((await res.json()) as { sandboxID: string }[] | null) ?? []) ids.push(s.sandboxID);
        nextToken = res.headers.get("x-next-token") || undefined;
      } while (nextToken);
      return ids;
    };
  }
  return defineProvider(adapter);
}
