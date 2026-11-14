// OpenSandbox: a self-hosted sandbox platform (an AAIF project) that runs sandboxes on Docker
// or Kubernetes behind a lifecycle server. Free on your own hardware.
// Written against specs/sandbox-lifecycle.yml and specs/execd-api.yaml in
// github.com/opensandbox-group/OpenSandbox, and the requests its JS SDK sends:
//   lifecycle  {OPEN_SANDBOX_DOMAIN}/v1, header OPEN-SANDBOX-API-KEY
//     POST   /sandboxes                         {image:{uri}, entrypoint, resourceLimits, timeout, env, metadata}
//     GET    /sandboxes?state=…&page=…          {items, pagination}
//     GET    /sandboxes/{id}                    {id, status:{state, reason, message}}
//     DELETE /sandboxes/{id}
//     POST   /sandboxes/{id}/renew-expiration   {expiresAt} (absolute)
//     POST   /sandboxes/{id}/pause | /resume    async; poll GET until Paused | Running
//     GET    /sandboxes/{id}/endpoints/{port}   {endpoint (host/path, no scheme), headers}
//   execd: the endpoint for port 44772 inside the sandbox, with the endpoint's headers
//     GET  /ping
//     POST /command               {command, cwd, envs, timeout (ms)} → SSE or NDJSON events
//     GET  /files/download?path=…
//     POST /files/upload          multipart: a `metadata` JSON part, then the `file` part
//     GET  /directories/list?path=…&depth=1
// Isolation depends on the server's runtime (Docker containers by default; gVisor, Kata or
// microVMs on Kubernetes), so it is declared as the weakest: container.

import { SandboxRouterError } from "../core/errors.js";
import { defineProvider, http, httpJson, toBuffer } from "./util.js";
import { grantCache, pollMs, sleep } from "./rest-helpers.js";
import type { ProviderContext, ResolvedSpec } from "../core/types.js";

/** The port execd listens on inside every sandbox. */
export const EXECD_PORT = 44772;

/** `OPEN_SANDBOX_DOMAIN` as its SDK reads it: `host[:port]`, or a full URL; `/v1` optional. */
export function opensandboxBase(domain: string): { origin: string; protocol: "http" | "https" } {
  const d = domain.trim().replace(/\/+$/, "").replace(/\/v1$/, "");
  if (/^https?:\/\//.test(d)) return { origin: d, protocol: d.startsWith("https:") ? "https" : "http" };
  return { origin: `http://${d}`, protocol: "http" };
}

const base = (ctx: ProviderContext) => opensandboxBase(String(ctx.env["OPEN_SANDBOX_DOMAIN"] ?? ""));
const api = (ctx: ProviderContext, path: string) => `${base(ctx).origin}/v1${path}`;
const box = (ctx: ProviderContext, id: string, path = "") => api(ctx, `/sandboxes/${encodeURIComponent(id)}${path}`);
const auth = (ctx: ProviderContext): Record<string, string> => {
  const key = ctx.env["OPEN_SANDBOX_API_KEY"];
  return key ? { "OPEN-SANDBOX-API-KEY": key } : {};
};

interface Sandbox {
  id: string;
  status: { state: string; reason?: string; message?: string };
}
interface Endpoint {
  endpoint: string;
  headers?: Record<string, string>;
}
interface StreamEvent {
  type: string;
  text?: string;
  error?: { ename?: string; evalue?: string; exit_code?: number };
}

/** Resolves a port's endpoint to a URL. `options.useServerProxy` asks for one through the server. */
async function endpoint(ctx: ProviderContext, id: string, port: number): Promise<{ url: string; headers: Record<string, string> }> {
  const q = ctx.options["useServerProxy"] ? "?use_server_proxy=true" : "";
  const e = await httpJson<Endpoint>(box(ctx, id, `/endpoints/${port}${q}`), { headers: auth(ctx) });
  const url = /^https?:\/\//.test(e.endpoint) ? e.endpoint : `${base(ctx).protocol}://${e.endpoint}`;
  return { url: url.replace(/\/+$/, ""), headers: e.headers ?? {} };
}

// execd's endpoint does not expire, but it moves when a sandbox resumes or its server restarts,
// so it is kept for a few minutes and forgotten on pause, resume and kill.
const execdCache = grantCache<{ url: string; headers: Record<string, string> }>();
const execd = (ctx: ProviderContext, id: string) =>
  execdCache.get(`${base(ctx).origin} ${id}`, async () => ({ value: await endpoint(ctx, id, EXECD_PORT), expiresAt: Date.now() + 5 * 60_000 }));
const forget = (ctx: ProviderContext, id: string) => execdCache.drop(`${base(ctx).origin} ${id}`);

/** Polls the sandbox until it reaches `want`; a terminal state on the way throws. */
async function waitFor(ctx: ProviderContext, id: string, want: string, limitMs: number): Promise<void> {
  const deadline = Date.now() + limitMs;
  for (;;) {
    const s = await httpJson<Sandbox>(box(ctx, id), { headers: auth(ctx) });
    if (s.status.state === want) return;
    if (s.status.state === "Failed" || s.status.state === "Terminated" || s.status.state === "Stopping") {
      throw new Error(`opensandbox sandbox ${id} is ${s.status.state}: ${s.status.reason ?? ""} ${s.status.message ?? ""}`.trim());
    }
    if (Date.now() > deadline) throw new SandboxRouterError("transient", `opensandbox sandbox ${id} still ${s.status.state} after ${limitMs / 1000} s`, "opensandbox");
    await sleep(pollMs(ctx, 1000));
  }
}

/** Waits until execd answers, as the SDK does after create (30 s by default). */
async function waitForExecd(ctx: ProviderContext, id: string): Promise<void> {
  const deadline = Date.now() + Number(ctx.options["readyTimeoutSec"] ?? 30) * 1000;
  for (;;) {
    try {
      const e = await execd(ctx, id);
      await http(`${e.url}/ping`, { headers: e.headers, timeoutMs: 5000 });
      return;
    } catch (err) {
      forget(ctx, id);
      if (Date.now() > deadline) throw err;
      await sleep(pollMs(ctx, 200));
    }
  }
}

/** The create body. A native template is a snapshot id; otherwise an image, kept alive by `tail`. */
export function opensandboxCreateBody(spec: ResolvedSpec, ctx: ProviderContext) {
  const source = spec.nativeTemplate
    ? { snapshotId: spec.nativeTemplate }
    : { image: { uri: spec.image ?? String(ctx.options["image"] ?? "python:3.12-slim") }, entrypoint: ["tail", "-f", "/dev/null"] };
  return {
    ...source,
    resourceLimits: { cpu: String(spec.cpu), memory: `${Math.round(spec.memoryMiB)}Mi` },
    // The server's minimum is 60 s.
    timeout: Math.max(60, Math.ceil(spec.timeoutSec)),
    env: spec.env,
    metadata: spec.metadata,
  };
}

export const opensandboxProvider = defineProvider({
  info: {
    id: "opensandbox",
    name: "OpenSandbox (self-hosted)",
    homepage: "https://github.com/opensandbox-group/OpenSandbox",
    // The API key is sent when set; a server run without one needs only the domain.
    env: ["OPEN_SANDBOX_DOMAIN"],
    capabilities: ["customImage", "ports", "fileList", "extendTimeout", "pause"],
    selfHosted: true,
    isolation: "container",
    freeTier: { tier: { kind: "unlimited" }, notes: "Your own Docker host or Kubernetes cluster: no per-use cost." },
    pricing: { vcpuSecondUsd: 0, gibSecondUsd: 0, defaultCpu: 1, defaultMemoryMiB: 2048 },
    surfaces: {
      rest: "/v1/sandboxes",
      sdk: ["@alibaba-group/opensandbox (npm)", "opensandbox (PyPI)", "Go, Kotlin, C#"],
      cli: "osb",
      mcp: "opensandbox-mcp",
    },
  },

  async create(spec, ctx) {
    const created = await httpJson<Sandbox>(api(ctx, "/sandboxes"), { headers: auth(ctx), body: opensandboxCreateBody(spec, ctx), timeoutMs: 300_000 });
    try {
      // Provisioning is synchronous on most runtimes; Pending is waited out where it isn't.
      if (created.status.state !== "Running") await waitFor(ctx, created.id, "Running", 300_000);
      await waitForExecd(ctx, created.id);
    } catch (err) {
      forget(ctx, created.id);
      await http(box(ctx, created.id), { method: "DELETE", headers: auth(ctx) }).catch(() => undefined);
      throw err;
    }
    return { providerSandboxId: created.id };
  },

  async exec(id, command, o, ctx) {
    const e = await execd(ctx, id);
    const res = await http(`${e.url}/command`, {
      headers: { ...e.headers, accept: "text/event-stream" },
      body: { command, cwd: o.cwd, envs: o.env, timeout: o.timeoutSec ? Math.ceil(o.timeoutSec * 1000) : undefined },
      timeoutMs: ((o.timeoutSec ?? 3600) + 30) * 1000,
    });
    let stdout = "";
    let stderr = "";
    let failure: StreamEvent["error"] | undefined;
    let complete = false;
    const handle = (line: string) => {
      // Either SSE frames (`data: {...}`) or one JSON object per line, as the SDK accepts.
      const t = line.trim();
      if (!t || t.startsWith(":") || /^(event|id|retry):/.test(t)) return;
      const json = t.startsWith("data:") ? t.slice(5).trim() : t;
      let ev: StreamEvent;
      try {
        ev = JSON.parse(json) as StreamEvent;
      } catch {
        return;
      }
      if (ev.type === "stdout") {
        stdout += ev.text ?? "";
        o.onStdout?.(ev.text ?? "");
      } else if (ev.type === "stderr") {
        stderr += ev.text ?? "";
        o.onStderr?.(ev.text ?? "");
      } else if (ev.type === "error") failure = ev.error ?? {};
      else if (ev.type === "execution_complete") complete = true;
    };
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.search(/[\r\n]/)) >= 0) {
        handle(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    }
    handle(buf + decoder.decode());
    if (failure) {
      // A command that ran and exited non-zero carries its status, -1 when a signal ended it
      // (the timeout included), reported as the shell's 128 + SIGKILL.
      const code = failure.exit_code ?? (/^-?\d+$/.test(failure.evalue?.trim() ?? "") ? Number(failure.evalue) : undefined);
      if (code === undefined) throw new Error(`opensandbox exec: ${failure.ename ?? "error"}: ${failure.evalue ?? ""}`.trim());
      return { stdout, stderr, exitCode: code < 0 ? 137 : code };
    }
    if (!complete) throw new Error("opensandbox exec: the stream ended without a completion event");
    return { stdout, stderr, exitCode: 0 };
  },

  async readFile(id, path, ctx) {
    const e = await execd(ctx, id);
    return new Uint8Array(await (await http(`${e.url}/files/download?path=${encodeURIComponent(path)}`, { headers: e.headers })).arrayBuffer());
  },

  async writeFile(id, path, data, ctx) {
    const e = await execd(ctx, id);
    // execd creates missing parent directories.
    const form = new FormData();
    form.append("metadata", new Blob([JSON.stringify({ path })], { type: "application/json" }), "metadata");
    form.append("file", new Blob([toBuffer(data)], { type: "application/octet-stream" }), path.split("/").pop() || "file");
    await http(`${e.url}/files/upload`, { method: "POST", headers: e.headers, raw: form });
  },

  async listFiles(id, path, ctx) {
    const e = await execd(ctx, id);
    const items = await httpJson<{ path: string; type?: string; size?: number }[]>(`${e.url}/directories/list?path=${encodeURIComponent(path)}&depth=1`, {
      headers: e.headers,
    });
    return items.map((f) => ({ name: f.path.split("/").filter(Boolean).pop() ?? f.path, path: f.path, isDir: f.type === "directory", size: f.size }));
  },

  async getUrl(id, port, ctx) {
    // With secureAccess the endpoint also wants headers, which a bare URL can't carry.
    return `${(await endpoint(ctx, id, port)).url}/`;
  },

  async setTimeout(id, timeoutSec, ctx) {
    // Takes an absolute deadline; the server's create-time maximum does not apply.
    const expiresAt = new Date(Date.now() + Math.max(1, timeoutSec) * 1000).toISOString();
    await http(box(ctx, id, "/renew-expiration"), { headers: auth(ctx), body: { expiresAt } });
  },

  async pause(id, ctx) {
    forget(ctx, id);
    await http(box(ctx, id, "/pause"), { method: "POST", headers: auth(ctx) });
    await waitFor(ctx, id, "Paused", 300_000);
  },

  async resume(id, ctx) {
    forget(ctx, id);
    await http(box(ctx, id, "/resume"), { method: "POST", headers: auth(ctx) });
    await waitFor(ctx, id, "Running", 300_000);
    await waitForExecd(ctx, id);
  },

  async kill(id, ctx) {
    forget(ctx, id);
    await http(box(ctx, id), { method: "DELETE", headers: auth(ctx) });
  },

  async listAlive(ctx) {
    // Everything not yet on its way out; a paused sandbox still holds resources.
    const states = ["Pending", "Running", "Pausing", "Paused", "Resuming"];
    const ids: string[] = [];
    for (let page = 1; ; page++) {
      const q = new URLSearchParams([...states.map((s): [string, string] => ["state", s]), ["page", String(page)], ["pageSize", "100"]]);
      const r = await httpJson<{ items: Sandbox[]; pagination: { hasNextPage: boolean } }>(api(ctx, `/sandboxes?${q}`), { headers: auth(ctx) });
      ids.push(...r.items.filter((s) => states.includes(s.status.state)).map((s) => s.id));
      if (!r.pagination.hasNextPage) return ids;
    }
  },
});
