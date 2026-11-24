// Groundbox (groundbox.dev): GitHub Actions runners and Linux sandbox VMs, one Firecracker VM
// per sandbox on dedicated cores. Free plan, no card: $5 of usage (plus 3,000 CI minutes a
// month); until a card is on file, 2 sandboxes at a time, up to 2 vCPU / 4 GB, 1 hour each.
// $0.04 per vCPU-hour while running, memory (up to 4 GB per vCPU) included.
// REST: https://api.groundbox.dev/v1 (Bearer gbx_…), OpenAPI at groundbox.dev/openapi.json;
// docs groundbox.dev/docs/sandboxes.md and groundbox.dev/docs/api.md. npm `@groundbox/cli`,
// TypeScript and Python SDKs, MCP https://mcp.groundbox.dev/mcp.
// Errors are `{"error": {"code", "message", "details"}}`; past the free credit or a spend cap
// is a 402, and so is a free limit before a card (`trial_limit`, see `refused` below).
// A deleted sandbox still reads 200 with status "stopped", and deleting it again is safe.

import { randomUUID } from "node:crypto";
import { defineProvider, http, httpJson, HttpError, refusals } from "./util.js";
import { pollMs, sleep } from "./rest-helpers.js";
import type { ProviderContext } from "../core/types.js";

const base = (ctx: ProviderContext) => String(ctx.env["GROUNDBOX_API_URL"] ?? "https://api.groundbox.dev/v1").replace(/\/+$/, "");
const auth = (ctx: ProviderContext) => ({ authorization: `Bearer ${ctx.env["GROUNDBOX_API_KEY"]}` });
const box = (ctx: ProviderContext, id: string, path = "") => `${base(ctx)}/sandboxes/${encodeURIComponent(id)}${path}`;
const gone = (err: unknown) => err instanceof HttpError && (err.status === 404 || err.status === 410);

/** 1 to 16 vCPUs; memory is whole GB, at most 4 per vCPU. */
export function groundboxShape(cpu: number, memoryMiB: number): { cpus: number; memory_gb: number } {
  const cpus = Math.min(16, Math.max(1, Math.ceil(cpu)));
  return { cpus, memory_gb: Math.min(cpus * 4, Math.max(1, Math.ceil(memoryMiB / 1024))) };
}

/** Metadata keys are 1–64 characters and values at most 512. */
const metadata = (m: Record<string, string>) => Object.fromEntries(Object.entries(m).filter(([k, v]) => k.length >= 1 && k.length <= 64 && v.length <= 512));

interface Sandbox {
  id: string;
  status: string;
  error?: string | null;
  started_at?: string | null;
}
const DEAD = ["failed", "stopped", "shutting_down", "shut_down", "stopping"];
/** On the way to running or paused (SandboxStatus in the OpenAPI spec). */
const MOVING = ["queued", "starting", "pausing", "resuming"];

/**
 * Until a card is on file, a call past a free limit gets 402 `trial_limit`, and `details.limit`
 * says which (groundbox.dev/docs/api.md). Read like any other 402, it would mark the one-time $5
 * spent for good; only `trial_credit_exhausted`, a spent balance or a spend cap means that. Two
 * sandboxes already live clears when one ends. A size or lifetime over the limits is this
 * request's alone, so the router tries the next provider and marks nothing. Any other limit, or
 * a body cut short before `details.limit`, is read that way too.
 */
const refused = refusals("groundbox", [
  { status: 402, body: /(?=[\s\S]*"code":\s*"trial_limit")(?=[\s\S]*"limit":\s*"live_sandboxes")/, kind: "rate_limit", why: "2 sandboxes at a time until a card is on file" },
  { status: 402, body: /"code":\s*"trial_limit"/, kind: "invalid", why: "past a free-plan limit for this request" },
]);

/** Polls until the sandbox stops moving; fails unless it is `want` then. */
async function settle(id: string, want: "running" | "paused", ctx: ProviderContext): Promise<void> {
  for (let i = 0; i < 600; i++) {
    const s = await httpJson<Sandbox>(box(ctx, id), { headers: auth(ctx) });
    if (s.status === want) return;
    if (!MOVING.includes(s.status)) throw new Error(`groundbox sandbox ${id} is ${s.status}, not ${want}${s.error ? `: ${s.error}` : ""}`);
    await sleep(pollMs(ctx, 1000));
  }
  throw new Error(`groundbox sandbox ${id} is still not ${want}`);
}

export const groundboxProvider = defineProvider({
  info: {
    id: "groundbox",
    name: "Groundbox",
    homepage: "https://groundbox.dev",
    env: ["GROUNDBOX_API_KEY"],
    capabilities: ["ports", "pause", "customImage", "snapshot", "fileList", "extendTimeout"],
    isolation: "microvm",
    maxTimeoutSec: 43_200 * 60,
    freeTier: {
      tier: { kind: "one-time-credit", usd: 5 },
      concurrency: 2,
      maxLifetimeSec: 3600,
      requiresCard: false,
      notes: "Free plan: $5 of usage and 3,000 CI minutes a month, no card. Until a card is on file: 2 sandboxes at a time, up to 2 vCPU / 4 GB, 1 hour each. The pricing FAQ says the CI minutes reset monthly; it does not say the $5 does.",
      source: "https://groundbox.dev/pricing",
      checked: "2026-11-21",
    },
    pricing: { vcpuSecondUsd: 0.04 / 3600, gibSecondUsd: 0, defaultCpu: 2, defaultMemoryMiB: 4096, source: "https://groundbox.dev/pricing" },
    surfaces: { rest: "https://api.groundbox.dev/v1", sdk: ["TypeScript SDK", "Python SDK"], cli: "groundbox (@groundbox/cli)", mcp: "https://mcp.groundbox.dev/mcp" },
  },

  async create(spec, ctx) {
    const shape = groundboxShape(spec.cpu, spec.memoryMiB);
    const image = spec.nativeTemplate ? undefined : spec.image;
    const r = await httpJson<Sandbox>(`${base(ctx)}/sandboxes`, {
      headers: { ...auth(ctx), "idempotency-key": spec.metadata["sandboxrouting.id"] ?? randomUUID() },
      body: {
        ...shape,
        timeout_minutes: Math.min(43_200, Math.max(1, Math.ceil(spec.timeoutSec / 60))),
        on_timeout: "delete",
        env: spec.env,
        metadata: metadata(spec.metadata),
        template: spec.nativeTemplate,
        image,
      },
      timeoutMs: 300_000,
    }).catch((err: unknown) => {
      throw refused(err);
    });
    try {
      let state = r;
      for (let i = 0; i < 600 && state.status !== "running"; i++) {
        if (DEAD.includes(state.status)) throw new Error(`groundbox sandbox ${r.id} is ${state.status}${state.error ? `: ${state.error}` : ""}`);
        await sleep(pollMs(ctx, 1000));
        state = await httpJson<Sandbox>(box(ctx, r.id), { headers: auth(ctx) });
      }
      if (state.status !== "running") throw new Error(`groundbox sandbox ${r.id} did not start`);
    } catch (err) {
      // Groundbox made it: never leave it running (and billing) when the create fails.
      await http(box(ctx, r.id), { method: "DELETE", headers: auth(ctx) }).catch(() => undefined);
      throw err;
    }
    return { providerSandboxId: r.id, cpu: shape.cpus, memoryMiB: shape.memory_gb * 1024 };
  },

  async exec(id, command, o, ctx) {
    // `cmd` runs with `sh -c`; one call may run up to an hour.
    const timeout_s = Math.min(3600, Math.max(1, Math.ceil(o.timeoutSec ?? 3600)));
    const r = await httpJson<{ exit_code: number; stdout: string; stderr: string; timed_out?: boolean }>(box(ctx, id, "/exec"), {
      headers: auth(ctx),
      body: { cmd: command, cwd: o.cwd, env: o.env, timeout_s },
      timeoutMs: (timeout_s + 60) * 1000,
    });
    if (r.stdout) o.onStdout?.(r.stdout);
    if (r.stderr) o.onStderr?.(r.stderr);
    return { stdout: r.stdout, stderr: r.stderr, exitCode: r.timed_out && r.exit_code === 0 ? 124 : r.exit_code };
  },

  async readFile(id, path, ctx) {
    return new Uint8Array(await (await http(`${box(ctx, id, "/files")}?path=${encodeURIComponent(path)}`, { headers: auth(ctx) })).arrayBuffer());
  },

  async writeFile(id, path, data, ctx) {
    // Makes the parent folders it needs.
    await http(`${box(ctx, id, "/files")}?path=${encodeURIComponent(path)}`, { method: "PUT", headers: { ...auth(ctx), "content-type": "application/octet-stream" }, raw: data });
  },

  async listFiles(id, path, ctx) {
    const r = await httpJson<{ entries: { name: string; path: string; type: string; size_bytes?: number }[] }>(`${box(ctx, id, "/files")}?dir=${encodeURIComponent(path)}`, {
      headers: auth(ctx),
    });
    return r.entries.map((e) => ({ name: e.name, path: e.path, isDir: e.type === "dir", size: e.size_bytes }));
  },

  async getUrl(id, port, ctx) {
    return (await httpJson<{ url: string }>(box(ctx, id, "/previews"), { headers: auth(ctx), body: { port, public: true } })).url;
  },

  async setTimeout(id, timeoutSec, ctx) {
    // `timeout_minutes` counts from the sandbox's last start or wake, not from now.
    const cur = await httpJson<Sandbox>(box(ctx, id), { headers: auth(ctx) });
    const started = Date.parse(cur.started_at ?? "");
    const elapsedSec = Number.isFinite(started) ? Math.max(0, (Date.now() - started) / 1000) : 0;
    const timeout_minutes = Math.min(43_200, Math.max(1, Math.ceil((elapsedSec + timeoutSec) / 60)));
    await http(box(ctx, id), { method: "PATCH", headers: auth(ctx), body: { timeout_minutes } });
  },

  async pause(id, ctx) {
    await http(box(ctx, id, "/pause"), { method: "POST", headers: auth(ctx) });
    await settle(id, "paused", ctx);
  },

  async resume(id, ctx) {
    // A wake needs room under the free plan's 2 live sandboxes, and is refused like a create.
    await http(box(ctx, id, "/resume"), { method: "POST", headers: auth(ctx) }).catch((err: unknown) => {
      throw refused(err);
    });
    await settle(id, "running", ctx);
  },

  async kill(id, ctx) {
    await http(box(ctx, id), { method: "DELETE", headers: auth(ctx) }).catch((err) => {
      if (!gone(err)) throw err;
    });
  },

  async listAlive(ctx) {
    // `live=true`: every status but stopped and failed.
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const q = new URLSearchParams({ live: "true", limit: "200", ...(cursor ? { cursor } : {}) });
      const page: { data: Sandbox[]; next_cursor: string | null } = await httpJson(`${base(ctx)}/sandboxes?${q}`, { headers: auth(ctx) });
      ids.push(...page.data.map((s) => s.id));
      cursor = page.next_cursor;
    } while (cursor);
    return ids;
  },
});
