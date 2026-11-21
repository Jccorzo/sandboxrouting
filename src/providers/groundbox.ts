// Groundbox sandboxes: Linux VMs in Firecracker, billed by the second at $0.04 per vCPU-hour
// with memory included (up to 4 GB per vCPU). Free: $5 of usage once per person, and until a
// card is on file at most 2 live sandboxes of 2 vCPU / 4 GB, 1 hour each.
// REST: https://api.groundbox.dev/v1 (Bearer gbx_…), OpenAPI at https://api.groundbox.dev/openapi.json.
// npm `@groundbox/sdk`, CLI `@groundbox/cli`, MCP https://mcp.groundbox.dev/mcp.

import { randomUUID } from "node:crypto";
import { HttpError, defineProvider, http, httpJson } from "./util.js";
import { pollMs, sleep } from "./rest-helpers.js";
import { SandboxRouterError } from "../core/errors.js";
import type { ProviderContext } from "../core/types.js";

const base = (ctx: ProviderContext) => String(ctx.env["GROUNDBOX_API_URL"] ?? "https://api.groundbox.dev/v1").replace(/\/+$/, "");
const auth = (ctx: ProviderContext) => ({ authorization: `Bearer ${String(ctx.env["GROUNDBOX_API_KEY"])}` });
const sbx = (ctx: ProviderContext, id: string, path = "") => `${base(ctx)}/sandboxes/${encodeURIComponent(id)}${path}`;

/** The longest one POST .../exec waits for a command, in seconds. */
const EXEC_MAX_S = 3600;
/** Statuses a sandbox passes through on its way to running or paused. */
const MOVING = ["queued", "starting", "resuming", "pausing"];
/** Statuses that are over for good. */
const OVER = ["stopping", "stopped", "failed"];

interface Sandbox {
  id: string;
  status: string;
  cpus: number;
  memory_gb: number;
  error?: string | null;
}

/**
 * Groundbox answers a request past the limits before a card with 402 `trial_limit`. Only the
 * free credit running out is a quota refusal: too many live sandboxes is a rate limit, and a
 * size or lifetime over the limits is this request's problem, so the router moves on without
 * marking the free tier used up. Any other error keeps its HTTP status.
 */
async function createRequest(url: string, headers: Record<string, string>, body: unknown): Promise<Sandbox> {
  const res = await fetch(url, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await res.text();
  if (res.ok) return JSON.parse(text) as Sandbox;
  const message = `POST /v1/sandboxes: ${res.status} ${text.slice(0, 500)}`;
  let error: { code?: string; details?: { limit?: string } } | undefined;
  try {
    error = (JSON.parse(text) as { error?: typeof error }).error;
  } catch {
    // Not JSON: keep the status.
  }
  if (res.status === 402 && error?.code === "trial_limit") {
    const limit = error.details?.limit;
    if (limit === "live_sandboxes") throw new SandboxRouterError("rate_limit", message, "groundbox");
    if (limit === "sandbox_size" || limit === "sandbox_lifetime") throw new SandboxRouterError("invalid", message, "groundbox");
  }
  throw new HttpError(res.status, message);
}

/** Polls until the sandbox has stopped moving (running, paused, or over). */
async function settle(id: string, ctx: ProviderContext, limitMs = 15 * 60_000): Promise<Sandbox> {
  const deadline = Date.now() + limitMs;
  for (;;) {
    const s = await httpJson<Sandbox>(sbx(ctx, id), { headers: auth(ctx) });
    if (!MOVING.includes(s.status)) return s;
    if (Date.now() > deadline) throw new SandboxRouterError("transient", `groundbox sandbox ${id} still ${s.status} after ${limitMs / 1000} s`, "groundbox");
    await sleep(pollMs(ctx, 1000));
  }
}

export const groundboxProvider = defineProvider({
  info: {
    id: "groundbox",
    name: "Groundbox",
    homepage: "https://groundbox.dev",
    env: ["GROUNDBOX_API_KEY"],
    capabilities: ["customImage", "ports", "pause", "extendTimeout", "fileList"],
    isolation: "microvm",
    maxTimeoutSec: 30 * 24 * 3600,
    maxExecSec: EXEC_MAX_S,
    freeTier: {
      tier: { kind: "one-time-credit", usd: 5 },
      concurrency: 2,
      maxLifetimeSec: 3600,
      requiresCard: false,
      notes: "$5 of usage once per person. Until a card is on file: 2 live sandboxes, 2 vCPU / 4 GB, 1 h each. Paid plan $20/month with $20 of usage included.",
      source: "https://groundbox.dev/pricing",
      checked: "2026-11-21",
    },
    // $0.04 per vCPU-hour, by the second; memory up to 4 GB per vCPU is included.
    pricing: { vcpuSecondUsd: 0.04 / 3600, gibSecondUsd: 0, defaultCpu: 2, defaultMemoryMiB: 4096, source: "https://groundbox.dev/pricing" },
    surfaces: { rest: "https://api.groundbox.dev/v1", sdk: ["@groundbox/sdk (npm)"], cli: "groundbox", mcp: "https://mcp.groundbox.dev/mcp" },
  },

  async create(spec, ctx) {
    const cpus = Math.min(16, Math.max(1, Math.round(spec.cpu)));
    const memoryGb = Math.min(cpus * 4, Math.max(1, Math.ceil(spec.memoryMiB / 1024)));
    const template = spec.nativeTemplate ?? (ctx.options["template"] as string | undefined);
    let s = await createRequest(
      `${base(ctx)}/sandboxes`,
      { ...auth(ctx), "idempotency-key": spec.metadata["sandboxrouting.id"] ?? randomUUID() },
      {
        cpus,
        memory_gb: memoryGb,
        timeout_minutes: Math.max(1, Math.ceil(spec.timeoutSec / 60)),
        env: spec.env,
        metadata: spec.metadata,
        ...(spec.image ? { image: spec.image } : template ? { template } : {}),
      },
    );
    // Usually running already; the first sandbox from a new image waits while its disk is made.
    if (MOVING.includes(s.status)) s = await settle(s.id, ctx);
    if (s.status !== "running") {
      await http(sbx(ctx, s.id), { method: "DELETE", headers: auth(ctx) }).catch(() => undefined);
      throw new Error(`groundbox sandbox ${s.id} is ${s.status}${s.error ? `: ${s.error}` : ""}`);
    }
    return { providerSandboxId: s.id, cpu: s.cpus, memoryMiB: s.memory_gb * 1024 };
  },

  async exec(id, command, o, ctx) {
    const timeoutS = Math.min(EXEC_MAX_S, Math.max(1, Math.ceil(o.timeoutSec ?? 600)));
    const r = await httpJson<{ exit_code: number; stdout: string; stderr: string }>(sbx(ctx, id, "/exec"), {
      headers: auth(ctx),
      body: { cmd: command, cwd: o.cwd, env: o.env, timeout_s: timeoutS },
      timeoutMs: (timeoutS + 30) * 1000,
    });
    if (r.stdout) o.onStdout?.(r.stdout);
    if (r.stderr) o.onStderr?.(r.stderr);
    return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exit_code };
  },

  async readFile(id, path, ctx) {
    const res = await http(`${sbx(ctx, id, "/files")}?path=${encodeURIComponent(path)}`, { headers: auth(ctx) });
    return new Uint8Array(await res.arrayBuffer());
  },

  async writeFile(id, path, data, ctx) {
    await http(`${sbx(ctx, id, "/files")}?path=${encodeURIComponent(path)}`, {
      method: "PUT",
      headers: { ...auth(ctx), "content-type": "application/octet-stream" },
      raw: data,
    });
  },

  async listFiles(id, path, ctx) {
    const r = await httpJson<{ entries: { name: string; path: string; type: string; size_bytes: number }[] }>(`${sbx(ctx, id, "/files")}?dir=${encodeURIComponent(path)}`, {
      headers: auth(ctx),
    });
    return r.entries.map((e) => ({ name: e.name, path: e.path, isDir: e.type === "dir", size: e.size_bytes }));
  },

  async getUrl(id, port, ctx) {
    return (await httpJson<{ url: string }>(sbx(ctx, id, "/previews"), { headers: auth(ctx), body: { port, public: true } })).url;
  },

  async setTimeout(id, timeoutSec, ctx) {
    await httpJson(sbx(ctx, id), { method: "PATCH", headers: auth(ctx), body: { timeout_minutes: Math.max(1, Math.ceil(timeoutSec / 60)) } });
  },

  async pause(id, ctx) {
    await httpJson(sbx(ctx, id, "/pause"), { method: "POST", headers: auth(ctx), body: {} });
    const s = await settle(id, ctx);
    if (s.status !== "paused") throw new Error(`groundbox sandbox ${id} is ${s.status}, not paused`);
  },

  async resume(id, ctx) {
    await httpJson(sbx(ctx, id, "/resume"), { method: "POST", headers: auth(ctx) });
    const s = await settle(id, ctx);
    if (s.status !== "running") throw new Error(`groundbox sandbox ${id} is ${s.status}, not running`);
  },

  async kill(id, ctx) {
    await http(sbx(ctx, id), { method: "DELETE", headers: auth(ctx) });
  },

  async listAlive(ctx) {
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const q: string = `live=true&limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const page: { data: Sandbox[]; next_cursor: string | null } = await httpJson(`${base(ctx)}/sandboxes?${q}`, { headers: auth(ctx) });
      ids.push(...page.data.filter((s) => !OVER.includes(s.status)).map((s) => s.id));
      cursor = page.next_cursor;
    } while (cursor);
    return ids;
  },
});
