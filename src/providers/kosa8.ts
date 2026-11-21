// kosa8 Cloud (kosa8.com): sealed microVM sandboxes on kosa8's hosts in us-ash1 and eu-hel1. No
// free tier, trial or pay-as-you-go: every account adds a card and picks a plan from $29/month
// (Solo: 100 sandbox-hours, 2 running, at most 2 vCPU / 4 GB). A sandbox-hour is an hour of a
// 2 vCPU / 4 GB sandbox running, larger sizes counting by vCPU; more hours come in $15 packs of
// 100 ($0.15 per 2 vCPU-hour), the rate used here. An idle sandbox sleeps (default after 300 s)
// and uses no sandbox-hours; the next command wakes it.
// REST: https://api.kosa8.com (Bearer k8c_live_…), OpenAPI https://api.kosa8.com/openapi.json,
// rate card https://api.kosa8.com/v1/pricing, plans https://kosa8.com/pricing/, guide
// https://docs.kosa8.com/guides/cloud.md. npm `@kosa8/sdk`, Go, Java and Python SDKs, CLI
// `kosa8`, MCP https://api.kosa8.com/mcp.
// `ttl_s` deletes the sandbox at its deadline. A buffered command stops at 90 s, so commands are
// streamed (NDJSON, base64 frames), which has no such limit. Create takes no idempotency key.
// A refusal at a plan limit is a 402 (quota); too many active sandboxes is a 429.

import { defineProvider, http, httpJson, HttpError, refusals } from "./util.js";
import { inline, pollMs, sbrName, sleep } from "./rest-helpers.js";
import type { ProviderContext } from "../core/types.js";

const base = (ctx: ProviderContext) => String(ctx.env["KOSA8_API_URL"] ?? "https://api.kosa8.com").replace(/\/+$/, "");
const auth = (ctx: ProviderContext) => ({ authorization: `Bearer ${ctx.env["KOSA8_API_KEY"]}` });
const box = (ctx: ProviderContext, id: string, path = "") => `${base(ctx)}/v1/sandboxes/${encodeURIComponent(id)}${path}`;

/** kosa8 sizes, vCPU x GiB. */
export function kosa8Size(cpu: number): { size: string; cpu: number; memoryMiB: number } {
  if (cpu <= 2) return { size: "2x4", cpu: 2, memoryMiB: 4096 };
  if (cpu <= 4) return { size: "4x8", cpu: 4, memoryMiB: 8192 };
  if (cpu <= 8) return { size: "8x16", cpu: 8, memoryMiB: 16384 };
  return { size: "16x32", cpu: 16, memoryMiB: 32768 };
}

interface Sandbox {
  id: string;
  state: "creating" | "running" | "paused" | "sleeping" | "stopped" | "expired" | "error" | "deleted" | "host_removed" | "host_lost";
  last_error?: string | null;
  cpus?: number;
  mem_mb?: number;
}
const ALIVE = new Set(["creating", "running", "paused", "sleeping"]);

/** A 429 `quota_exceeded` is too many sandboxes active at once (create, fork or wake), which clears as they end. */
const refused = refusals("kosa8", [{ status: 429, body: /quota_exceeded/, kind: "rate_limit", why: "too many sandboxes active at once" }]);

interface Frame {
  stream?: "stdout" | "stderr";
  data?: string;
  heartbeat?: boolean;
  done?: boolean;
  exit?: number | null;
  error?: string;
  code?: string;
}

export const kosa8Provider = defineProvider({
  info: {
    id: "kosa8",
    name: "kosa8 Cloud",
    homepage: "https://kosa8.com",
    env: ["KOSA8_API_KEY"],
    capabilities: ["ports", "pause", "customImage", "fileList", "extendTimeout"],
    isolation: "microvm",
    maxTimeoutSec: 90 * 24 * 3600,
    freeTier: {
      tier: { kind: "none" },
      requiresCard: true,
      notes: "No free tier, trial or pay-as-you-go: a plan is required before the first sandbox (Solo $29/month: 100 sandbox-hours, 2 running, up to 2 vCPU / 4 GB). Past the plan's hours, new work stops until a $15 pack of 100 hours is added.",
      source: "https://kosa8.com/pricing/",
      checked: "2026-11-21",
    },
    // $15 per 100 sandbox-hours, a sandbox-hour being 2 vCPU / 4 GB: counted by vCPU, memory included.
    pricing: { vcpuSecondUsd: 0.075 / 3600, gibSecondUsd: 0, defaultCpu: 2, defaultMemoryMiB: 4096, source: "https://kosa8.com/pricing/" },
    surfaces: { rest: "https://api.kosa8.com", sdk: ["@kosa8/sdk (npm)", "kosa8-go", "com.kosa8:kosa8 (Maven)"], cli: "kosa8", mcp: "https://api.kosa8.com/mcp" },
  },

  async create(spec, ctx) {
    const size = kosa8Size(spec.cpu);
    const r = await httpJson<{ sandbox: Sandbox }>(`${base(ctx)}/v1/sandboxes`, {
      headers: auth(ctx),
      body: {
        name: sbrName(spec),
        template: spec.nativeTemplate,
        image: spec.image,
        size: size.size,
        region: spec.region,
        ttl_s: Math.max(60, Math.ceil(spec.timeoutSec)),
        env: spec.env,
      },
      timeoutMs: 180_000,
    }).catch((err: unknown) => {
      throw refused(err);
    });
    const id = r.sandbox.id;
    try {
      let s = r.sandbox;
      // 202: booting cold (state creating) until it is up.
      for (let i = 0; i < 300 && s.state !== "running"; i++) {
        if (!ALIVE.has(s.state)) throw new Error(`kosa8 sandbox ${id} is ${s.state}${s.last_error ? `: ${s.last_error}` : ""}`);
        await sleep(pollMs(ctx, 1000));
        s = (await httpJson<{ sandbox: Sandbox }>(box(ctx, id), { headers: auth(ctx) })).sandbox;
      }
      if (s.state !== "running") throw new Error(`kosa8 sandbox ${id} did not start (${s.state})`);
    } catch (err) {
      await this.kill(id, ctx).catch(() => undefined);
      throw err;
    }
    return { providerSandboxId: id, cpu: size.cpu, memoryMiB: size.memoryMiB };
  },

  async exec(id, command, o, ctx) {
    const timeout_s = Math.min(86_400, Math.max(1, Math.ceil(o.timeoutSec ?? 3600)));
    const res = await http(box(ctx, id, "/exec"), {
      headers: { ...auth(ctx), accept: "application/x-ndjson" },
      body: { cmd: ["sh", "-c", inline(command, { cwd: o.cwd })], env: Object.entries(o.env ?? {}).map(([k, v]) => `${k}=${v}`), stream: true, timeout_s },
      timeoutMs: (timeout_s + 60) * 1000,
    });
    let stdout = "";
    let stderr = "";
    const out = new TextDecoder();
    const err = new TextDecoder();
    const lines = new TextDecoder();
    let buf = "";
    const take = (f: Frame): { exitCode: number } | undefined => {
      if (f.done) {
        if (f.code === "exec_timeout") return { exitCode: 124 };
        if (f.exit === null || f.exit === undefined) throw new Error(`kosa8 exec: ${f.error ?? "ended without an exit code"}`);
        return { exitCode: f.exit };
      }
      if (f.heartbeat || !f.data) return undefined;
      const bytes = Buffer.from(f.data, "base64");
      if (f.stream === "stderr") {
        const t = err.decode(bytes, { stream: true });
        stderr += t;
        if (t) o.onStderr?.(t);
      } else {
        const t = out.decode(bytes, { stream: true });
        stdout += t;
        if (t) o.onStdout?.(t);
      }
      return undefined;
    };
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buf += lines.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const end = take(JSON.parse(line) as Frame);
        if (end) return { stdout: stdout + out.decode(), stderr: stderr + err.decode(), exitCode: end.exitCode };
      }
    }
    const last = (buf + lines.decode()).trim();
    const end = last ? take(JSON.parse(last) as Frame) : undefined;
    if (end) return { stdout: stdout + out.decode(), stderr: stderr + err.decode(), exitCode: end.exitCode };
    throw new Error("kosa8 exec: the stream ended without a done frame");
  },

  async readFile(id, path, ctx) {
    return new Uint8Array(await (await http(`${box(ctx, id, "/files")}?path=${encodeURIComponent(path)}`, { headers: auth(ctx), timeoutMs: 300_000 })).arrayBuffer());
  },

  async writeFile(id, path, data, ctx) {
    await http(`${box(ctx, id, "/files")}?path=${encodeURIComponent(path)}`, {
      method: "PUT",
      headers: { ...auth(ctx), "content-type": "application/octet-stream" },
      raw: data,
      timeoutMs: 300_000,
    });
  },

  async listFiles(id, path, ctx) {
    const r = await httpJson<{ files?: { name?: string; path: string; type?: string; size?: number }[] }>(`${box(ctx, id, "/files/list")}?path=${encodeURIComponent(path)}`, {
      headers: auth(ctx),
    });
    return (r.files ?? []).map((f) => ({ name: f.name ?? f.path.split("/").pop() ?? f.path, path: f.path, isDir: /dir/i.test(f.type ?? ""), size: f.size }));
  },

  async getUrl(id, port, ctx) {
    // Opening a port that is already open answers 200 with a fresh link.
    const r = await httpJson<{ preview: { url: string } }>(box(ctx, id, "/previews"), { headers: auth(ctx), body: { port, public: true, wake: true } });
    return r.preview.url;
  },

  async setTimeout(id, timeoutSec, ctx) {
    await http(box(ctx, id), { method: "PATCH", headers: auth(ctx), body: { ttl_s: Math.max(60, Math.ceil(timeoutSec)) } });
  },

  async pause(id, ctx) {
    await http(box(ctx, id, "/sleep"), { method: "POST", headers: auth(ctx) });
  },

  async resume(id, ctx) {
    await http(box(ctx, id, "/wake"), { method: "POST", headers: auth(ctx) }).catch((err: unknown) => {
      throw refused(err);
    });
  },

  async kill(id, ctx) {
    try {
      await http(box(ctx, id), { method: "DELETE", headers: auth(ctx) });
    } catch (err) {
      if (!(err instanceof HttpError && (err.status === 404 || err.status === 410))) throw err;
    }
  },

  async listAlive(ctx) {
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const q = new URLSearchParams({ limit: "500", ...(cursor ? { cursor } : {}) });
      const page = await httpJson<{ sandboxes: Sandbox[]; next_cursor: string | null }>(`${base(ctx)}/v1/sandboxes?${q}`, { headers: auth(ctx) });
      ids.push(...page.sandboxes.filter((s) => ALIVE.has(s.state)).map((s) => s.id));
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    return ids;
  },
});
