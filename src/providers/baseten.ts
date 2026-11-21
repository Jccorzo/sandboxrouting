// Baseten Sandboxes (baseten.co): isolated environments that go on standby when idle (files and
// processes kept, storage billed only) and resume on the next request. No free tier is published.
// $0.0655 per vCPU-hour and $0.0211 per GiB-hour while active ($0.2154/h for 2 vCPU / 4 GiB).
// 10 sandboxes at once per organization by default.
// Management API: https://api.baseten.co/v1/sandboxes/instances, authenticated with a sandbox
// access token (2 h) that POST /v1/token mints from the Baseten API key
// (https://docs.baseten.co/sandboxes/authentication.md, reference
// https://docs.baseten.co/reference/management-api/sandboxes/overview.md). Commands and files go to
// each sandbox's own runtime API at the `url` create returns, with the same token (OpenAPI
// https://docs.baseten.co/reference/sandbox-api/openapi.json). npm `@basetenlabs/sandbox`, PyPI
// `baseten`, Go `baseten-go/sandbox`, CLI `baseten sandbox`, MCP at <url>/mcp.
// A sandbox is addressed by its name, made from the router id; `create_if_not_exists` makes a
// retried create return the same one. Its lifetime is a DELETE expiration policy: TTL_MAX_AGE at
// create, a DATE when extended. Isolation is not published. A size above the account's
// per-sandbox limit answers 429, which reads as a rate limit.

import { createHash } from "node:crypto";
import { defineProvider, http, httpJson, HttpError } from "./util.js";
import { grantCache, pollMs, sbrName, sleep } from "./rest-helpers.js";
import type { ProviderContext } from "../core/types.js";

const api = (ctx: ProviderContext) => String(ctx.env["BASETEN_API_URL"] ?? "https://api.baseten.co").replace(/\/+$/, "");
const inst = (ctx: ProviderContext, name = "", path = "") => `${api(ctx)}/v1/sandboxes/instances${name ? `/${encodeURIComponent(name)}` : ""}${path}`;

/** Sandbox access tokens, one per API key, minted again before they expire. */
const tokens = grantCache<string>();
async function headers(ctx: ProviderContext): Promise<Record<string, string>> {
  const key = String(ctx.env["BASETEN_API_KEY"]);
  const token = await tokens.get(createHash("sha256").update(key).digest("hex"), async () => {
    const r = await httpJson<{ token: string; expires_at: string }>(`${api(ctx)}/v1/token`, { headers: { authorization: `Bearer ${key}` }, body: { scopes: ["sandboxes"] } });
    return { value: r.token, expiresAt: Date.parse(r.expires_at) || Date.now() + 3_600_000 };
  });
  const team = ctx.env["BASETEN_TEAM_ID"];
  return { authorization: `Bearer ${token}`, ...(team ? { "x-team-id": team } : {}) };
}

interface Sandbox {
  name: string;
  url: string;
  status: string;
  cpu?: number;
  memory?: number;
}
const FAILED = new Set(["FAILED", "DELETING", "TERMINATED", "DEACTIVATED"]);

/** Each sandbox's runtime API URL, learned at create or looked up once. */
const urls = new Map<string, string>();
async function runtime(ctx: ProviderContext, name: string): Promise<string> {
  let url = urls.get(name);
  if (!url) {
    url = (await httpJson<Sandbox>(inst(ctx, name), { headers: await headers(ctx) })).url.replace(/\/+$/, "");
    urls.set(name, url);
  }
  return url;
}
/** A file path as the runtime API takes it: an absolute path keeps its leading slash (`//tmp/a`). */
const fsPath = (path: string) => path.split("/").map(encodeURIComponent).join("/");

/** Baseten sizes: memory sets the vCPUs (2 GiB → 1, 4 → 2, 8 → 4, 16 → 6, 32 → 8, 64 → 16). */
export function basetenSize(cpu: number, memoryMiB: number): { cpu: number; memory: number } {
  const c = Math.min(32, Math.max(1, Math.ceil(cpu)));
  // With cpu set, memory must be 1024–8192 MB per vCPU.
  return { cpu: c, memory: Math.min(c * 8192, Math.max(c * 1024, Math.ceil(memoryMiB))) };
}

interface Process {
  exitCode: number;
  status: "failed" | "killed" | "stopped" | "running" | "completed";
  stdout?: string;
  stderr?: string;
}

export const basetenProvider = defineProvider({
  info: {
    id: "baseten",
    name: "Baseten Sandboxes",
    homepage: "https://www.baseten.co/sandboxes",
    env: ["BASETEN_API_KEY"],
    capabilities: ["ports", "customImage", "fileList", "extendTimeout"],
    freeTier: {
      tier: { kind: "none" },
      concurrency: 10,
      notes: "No free tier published; pay as you go. 10 sandboxes at once per organization, and a per-sandbox memory and vCPU cap per account (both raised through support).",
      source: "https://docs.baseten.co/deployment/resources.md#sandbox-prices",
      checked: "2026-11-21",
    },
    pricing: { vcpuSecondUsd: 0.0655 / 3600, gibSecondUsd: 0.0211 / 3600, defaultCpu: 2, defaultMemoryMiB: 4096, source: "https://www.baseten.co/pricing/" },
    surfaces: {
      rest: "https://api.baseten.co/v1/sandboxes + each sandbox's runtime API",
      sdk: ["@basetenlabs/sandbox (npm)", "baseten (PyPI)", "github.com/basetenlabs/baseten-go/sandbox"],
      cli: "baseten sandbox",
      mcp: "<sandbox url>/mcp",
    },
  },

  async create(spec, ctx) {
    const size = basetenSize(spec.cpu, spec.memoryMiB);
    const name = sbrName(spec);
    let s = await httpJson<Sandbox>(inst(ctx), {
      headers: await headers(ctx),
      body: {
        name,
        create_if_not_exists: true,
        image: spec.image ?? spec.nativeTemplate,
        cpu: size.cpu,
        memory: size.memory,
        region: spec.region,
        envs: Object.entries(spec.env).map(([k, v]) => ({ name: k, value: v, secret: false })),
        labels: { "managed-by": "sandboxrouting" },
        lifecycle: { expiration_policies: [{ action: "DELETE", type: "TTL_MAX_AGE", value: `${Math.max(60, Math.ceil(spec.timeoutSec))}s` }] },
      },
      timeoutMs: 300_000,
    });
    try {
      for (let i = 0; i < 300 && s.status !== "DEPLOYED"; i++) {
        if (FAILED.has(s.status)) throw new Error(`baseten sandbox ${name} is ${s.status}`);
        await sleep(pollMs(ctx, 1000));
        s = await httpJson<Sandbox>(inst(ctx, name), { headers: await headers(ctx) });
      }
      if (s.status !== "DEPLOYED") throw new Error(`baseten sandbox ${name} did not deploy (${s.status})`);
    } catch (err) {
      await this.kill(name, ctx).catch(() => undefined);
      throw err;
    }
    urls.set(name, s.url.replace(/\/+$/, ""));
    return { providerSandboxId: name, cpu: s.cpu ?? size.cpu, memoryMiB: s.memory ?? size.memory };
  },

  async exec(id, command, o, ctx) {
    const timeout = Math.max(1, Math.ceil(o.timeoutSec ?? 3600));
    const res = await http(`${await runtime(ctx, id)}/process`, {
      headers: { ...(await headers(ctx)), accept: "application/x-ndjson" },
      body: { command, env: o.env, workingDir: o.cwd, waitForCompletion: true, timeout },
      timeoutMs: (timeout + 60) * 1000,
    });
    let stdout = "";
    let stderr = "";
    let result: Process | undefined;
    const dec = new TextDecoder();
    let buf = "";
    const take = (line: string) => {
      if (!line.trim()) return;
      const ev = JSON.parse(line) as { type: string; data?: string };
      if (ev.type === "stdout" && ev.data) {
        stdout += ev.data;
        o.onStdout?.(ev.data);
      } else if (ev.type === "stderr" && ev.data) {
        stderr += ev.data;
        o.onStderr?.(ev.data);
      } else if (ev.type === "result" && ev.data) result = JSON.parse(ev.data) as Process;
      else if (ev.type === "error") throw new Error(`baseten exec: ${ev.data ?? "stream error"}`);
    };
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buf += dec.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        take(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    }
    take(buf + dec.decode());
    if (!result) throw new Error("baseten exec: the stream ended without a result");
    // The result holds the whole output; streamed chunks may have lost line ends.
    const exitCode = result.status === "killed" && !result.exitCode ? 124 : result.exitCode;
    return { stdout: result.stdout ?? stdout, stderr: result.stderr ?? stderr, exitCode };
  },

  async readFile(id, path, ctx) {
    const res = await http(`${await runtime(ctx, id)}/filesystem/${fsPath(path)}?download=true`, { headers: { ...(await headers(ctx)), accept: "application/octet-stream" } });
    return new Uint8Array(await res.arrayBuffer());
  },

  async writeFile(id, path, data, ctx) {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(data)]), path.split("/").pop() || "file");
    await http(`${await runtime(ctx, id)}/filesystem/${fsPath(path)}`, { method: "PUT", headers: await headers(ctx), raw: form });
  },

  async listFiles(id, path, ctx) {
    const r = await httpJson<{ files?: { name: string; path: string; size?: number }[]; subdirectories?: { name: string; path: string }[] }>(
      `${await runtime(ctx, id)}/filesystem/${fsPath(path)}`,
      { headers: { ...(await headers(ctx)), accept: "application/json" } },
    );
    return [
      ...(r.subdirectories ?? []).map((d) => ({ name: d.name, path: d.path, isDir: true })),
      ...(r.files ?? []).map((f) => ({ name: f.name, path: f.path, isDir: false, size: f.size })),
    ];
  },

  async getUrl(id, port, ctx) {
    const r = await httpJson<{ url: string }>(inst(ctx, id, "/previews"), { headers: await headers(ctx), body: { port, public: true, create_if_not_exists: true } });
    return r.url;
  },

  async setTimeout(id, timeoutSec, ctx) {
    // TTL_MAX_AGE counts from creation, so a new deadline is a date. The list replaces the old one.
    const value = new Date(Date.now() + Math.max(60, Math.ceil(timeoutSec)) * 1000).toISOString();
    await http(inst(ctx, id), { method: "PATCH", headers: await headers(ctx), body: { lifecycle: { expiration_policies: [{ action: "DELETE", type: "DATE", value }] } } });
  },

  async kill(id, ctx) {
    urls.delete(id);
    try {
      await http(inst(ctx, id), { method: "DELETE", headers: await headers(ctx) });
    } catch (err) {
      if (!(err instanceof HttpError && (err.status === 404 || err.status === 410))) throw err;
    }
  },

  async listAlive(ctx) {
    const names: string[] = [];
    let cursor: string | undefined;
    do {
      const q = new URLSearchParams({ limit: "100", ...(cursor ? { cursor } : {}) });
      const page = await httpJson<{ items: Sandbox[]; pagination?: { cursor?: string | null } }>(`${inst(ctx)}?${q}`, { headers: await headers(ctx) });
      names.push(...page.items.filter((s) => !FAILED.has(s.status)).map((s) => s.name));
      cursor = page.pagination?.cursor ?? undefined;
    } while (cursor);
    return names;
  },
});
