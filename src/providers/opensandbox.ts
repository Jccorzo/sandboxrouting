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
// `opensandboxCompatible` is the same code for a hosted service that serves this API (Nirvana).

import { SandboxRouterError } from "../core/errors.js";
import { defineProvider, http, httpJson, toBuffer } from "./util.js";
import { grantCache, pollMs, sleep } from "./rest-helpers.js";
import type { ProviderAdapter, ProviderContext, ProviderInfo, ResolvedSpec } from "../core/types.js";

/** The port execd listens on inside every sandbox. */
export const EXECD_PORT = 44772;

/** `OPEN_SANDBOX_DOMAIN` as its SDK reads it: `host[:port]`, or a full URL; `/v1` optional. */
export function opensandboxBase(domain: string): { origin: string; protocol: "http" | "https" } {
  const d = domain.trim().replace(/\/+$/, "").replace(/\/v1$/, "");
  if (/^https?:\/\//.test(d)) return { origin: d, protocol: d.startsWith("https:") ? "https" : "http" };
  return { origin: `http://${d}`, protocol: "http" };
}

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

/** The create body. A native template is a snapshot id; otherwise an image, kept alive by `tail`. */
export function opensandboxCreateBody(spec: ResolvedSpec, ctx: ProviderContext, templateIs: "snapshot" | "image" = "snapshot") {
  const source =
    spec.nativeTemplate && templateIs === "snapshot"
      ? { snapshotId: spec.nativeTemplate }
      : { image: { uri: spec.image ?? spec.nativeTemplate ?? String(ctx.options["image"] ?? "python:3.12-slim") }, entrypoint: ["tail", "-f", "/dev/null"] };
  return {
    ...source,
    resourceLimits: { cpu: String(spec.cpu), memory: `${Math.round(spec.memoryMiB)}Mi` },
    // The server's minimum is 60 s.
    timeout: Math.max(60, Math.ceil(spec.timeoutSec)),
    env: spec.env,
    metadata: spec.metadata,
  };
}

/** How a service that serves OpenSandbox's lifecycle API is reached, and what it leaves out. */
export interface OpensandboxConnection {
  info: ProviderInfo;
  /** The lifecycle server, as `opensandboxBase` reads it. */
  base(ctx: ProviderContext): { origin: string; protocol: "http" | "https" };
  /** Headers every lifecycle call carries. */
  auth(ctx: ProviderContext): Record<string, string>;
  /** `extensions` for the create body, for services that route by it. */
  extensions?(ctx: ProviderContext): Record<string, string>;
  /** What a native template names: a snapshot (OpenSandbox) or an image (services without snapshots). */
  templateIs?: "snapshot" | "image";
  /** False for services that answer pause and resume with an error. */
  pause?: boolean;
}

export function opensandboxCompatible(c: OpensandboxConnection): ProviderAdapter {
  const id = c.info.id;
  const api = (ctx: ProviderContext, path: string) => `${c.base(ctx).origin}/v1${path}`;
  const box = (ctx: ProviderContext, sid: string, path = "") => api(ctx, `/sandboxes/${encodeURIComponent(sid)}${path}`);

  /** Resolves a port's endpoint to a URL. `options.useServerProxy` asks for one through the server. */
  async function endpoint(ctx: ProviderContext, sid: string, port: number): Promise<{ url: string; headers: Record<string, string> }> {
    const q = ctx.options["useServerProxy"] ? "?use_server_proxy=true" : "";
    const e = await httpJson<Endpoint>(box(ctx, sid, `/endpoints/${port}${q}`), { headers: c.auth(ctx) });
    const url = /^https?:\/\//.test(e.endpoint) ? e.endpoint : `${c.base(ctx).protocol}://${e.endpoint}`;
    return { url: url.replace(/\/+$/, ""), headers: e.headers ?? {} };
  }

  // execd's endpoint moves when a sandbox resumes or its server restarts (and a signed one
  // expires after an hour at the least), so it is kept for a few minutes and forgotten on
  // pause, resume and kill.
  const execdCache = grantCache<{ url: string; headers: Record<string, string> }>();
  const execd = (ctx: ProviderContext, sid: string) =>
    execdCache.get(`${c.base(ctx).origin} ${sid}`, async () => ({ value: await endpoint(ctx, sid, EXECD_PORT), expiresAt: Date.now() + 5 * 60_000 }));
  const forget = (ctx: ProviderContext, sid: string) => execdCache.drop(`${c.base(ctx).origin} ${sid}`);

  /** Polls the sandbox until it reaches `want`; a terminal state on the way throws. */
  async function waitFor(ctx: ProviderContext, sid: string, want: string, limitMs: number): Promise<void> {
    const deadline = Date.now() + limitMs;
    for (;;) {
      const s = await httpJson<Sandbox>(box(ctx, sid), { headers: c.auth(ctx) });
      if (s.status.state === want) return;
      if (s.status.state === "Failed" || s.status.state === "Terminated" || s.status.state === "Stopping") {
        throw new Error(`${id} sandbox ${sid} is ${s.status.state}: ${s.status.reason ?? ""} ${s.status.message ?? ""}`.trim());
      }
      if (Date.now() > deadline) throw new SandboxRouterError("transient", `${id} sandbox ${sid} still ${s.status.state} after ${limitMs / 1000} s`, id);
      await sleep(pollMs(ctx, 1000));
    }
  }

  /** Waits until execd answers, as the SDK does after create (30 s by default). */
  async function waitForExecd(ctx: ProviderContext, sid: string): Promise<void> {
    const deadline = Date.now() + Number(ctx.options["readyTimeoutSec"] ?? 30) * 1000;
    for (;;) {
      try {
        const e = await execd(ctx, sid);
        await http(`${e.url}/ping`, { headers: e.headers, timeoutMs: 5000 });
        return;
      } catch (err) {
        forget(ctx, sid);
        if (Date.now() > deadline) throw err;
        await sleep(pollMs(ctx, 200));
      }
    }
  }

  const adapter: ProviderAdapter = {
    info: c.info,

    async create(spec, ctx) {
      const extensions = c.extensions?.(ctx);
      const body = { ...opensandboxCreateBody(spec, ctx, c.templateIs), ...(extensions ? { extensions } : {}) };
      const created = await httpJson<Sandbox>(api(ctx, "/sandboxes"), { headers: c.auth(ctx), body, timeoutMs: 300_000 });
      try {
        // Provisioning is synchronous on most runtimes; Pending is waited out where it isn't.
        if (created.status.state !== "Running") await waitFor(ctx, created.id, "Running", 300_000);
        await waitForExecd(ctx, created.id);
      } catch (err) {
        forget(ctx, created.id);
        await http(box(ctx, created.id), { method: "DELETE", headers: c.auth(ctx) }).catch(() => undefined);
        throw err;
      }
      return { providerSandboxId: created.id };
    },

    async exec(sid, command, o, ctx) {
      const e = await execd(ctx, sid);
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
        if (code === undefined) throw new Error(`${id} exec: ${failure.ename ?? "error"}: ${failure.evalue ?? ""}`.trim());
        return { stdout, stderr, exitCode: code < 0 ? 137 : code };
      }
      if (!complete) throw new Error(`${id} exec: the stream ended without a completion event`);
      return { stdout, stderr, exitCode: 0 };
    },

    async readFile(sid, path, ctx) {
      const e = await execd(ctx, sid);
      return new Uint8Array(await (await http(`${e.url}/files/download?path=${encodeURIComponent(path)}`, { headers: e.headers })).arrayBuffer());
    },

    async writeFile(sid, path, data, ctx) {
      const e = await execd(ctx, sid);
      // execd creates missing parent directories.
      const form = new FormData();
      form.append("metadata", new Blob([JSON.stringify({ path })], { type: "application/json" }), "metadata");
      form.append("file", new Blob([toBuffer(data)], { type: "application/octet-stream" }), path.split("/").pop() || "file");
      await http(`${e.url}/files/upload`, { method: "POST", headers: e.headers, raw: form });
    },

    async listFiles(sid, path, ctx) {
      const e = await execd(ctx, sid);
      const items = await httpJson<{ path: string; type?: string; size?: number }[]>(`${e.url}/directories/list?path=${encodeURIComponent(path)}&depth=1`, {
        headers: e.headers,
      });
      return items.map((f) => ({ name: f.path.split("/").filter(Boolean).pop() ?? f.path, path: f.path, isDir: f.type === "directory", size: f.size }));
    },

    async getUrl(sid, port, ctx) {
      // With secureAccess the endpoint also wants headers, which a bare URL can't carry.
      return `${(await endpoint(ctx, sid, port)).url}/`;
    },

    async setTimeout(sid, timeoutSec, ctx) {
      // Takes an absolute deadline; the server's create-time maximum does not apply.
      const expiresAt = new Date(Date.now() + Math.max(1, timeoutSec) * 1000).toISOString();
      await http(box(ctx, sid, "/renew-expiration"), { headers: c.auth(ctx), body: { expiresAt } });
    },

    async kill(sid, ctx) {
      forget(ctx, sid);
      await http(box(ctx, sid), { method: "DELETE", headers: c.auth(ctx) });
    },

    async listAlive(ctx) {
      // Everything not yet on its way out; a paused sandbox still holds resources.
      const states = ["Pending", "Running", "Pausing", "Paused", "Resuming"];
      const ids: string[] = [];
      for (let page = 1; ; page++) {
        const q = new URLSearchParams([...states.map((s): [string, string] => ["state", s]), ["page", String(page)], ["pageSize", "100"]]);
        const r = await httpJson<{ items: Sandbox[]; pagination: { hasNextPage?: boolean } }>(api(ctx, `/sandboxes?${q}`), { headers: c.auth(ctx) });
        ids.push(...r.items.filter((s) => states.includes(s.status.state)).map((s) => s.id));
        // Nirvana's pagination has no hasNextPage: a short page is the last one there.
        if (!(r.pagination.hasNextPage ?? r.items.length >= 100)) return ids;
      }
    },
  };

  if (c.pause !== false) {
    adapter.pause = async (sid, ctx) => {
      forget(ctx, sid);
      await http(box(ctx, sid, "/pause"), { method: "POST", headers: c.auth(ctx) });
      await waitFor(ctx, sid, "Paused", 300_000);
    };
    adapter.resume = async (sid, ctx) => {
      forget(ctx, sid);
      await http(box(ctx, sid, "/resume"), { method: "POST", headers: c.auth(ctx) });
      await waitFor(ctx, sid, "Running", 300_000);
      await waitForExecd(ctx, sid);
    };
  }
  return adapter;
}

export const opensandboxProvider = defineProvider(
  opensandboxCompatible({
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
    base: (ctx) => opensandboxBase(String(ctx.env["OPEN_SANDBOX_DOMAIN"] ?? "")),
    auth: (ctx): Record<string, string> => {
      const key = ctx.env["OPEN_SANDBOX_API_KEY"];
      return key ? { "OPEN-SANDBOX-API-KEY": key } : {};
    },
  }),
);
