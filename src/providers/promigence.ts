// Promigence (private beta; new accounts may need an invite): sandboxes started as "runs"
// from a snapshot. Free: $50 once, valid 30 days ($10 without a card, $40 more with one);
// 20 concurrent, 1 h each. $0.0504 per vCPU-hour and $0.0162 per GiB-hour, awake time only.
// Promigence ends the sandbox at `timeout_ms`. It does not publish how sandboxes are isolated.
// REST: https://api.promigence.ai/v1 (Bearer prom_api_…), OpenAPI at promigence.ai/openapi.json.
// npm `@promigence/sdk` (beta), CLI `promigence` (also a local MCP server).
// Size is a named tier; a run takes no env, so env is kept in a file commands load.

import { randomUUID } from "node:crypto";
import { defineProvider, http, httpJson } from "./util.js";
import { ENV_FILE, envFileBody, pollMs, sleep, withEnvFile } from "./rest-helpers.js";
import type { ProviderContext } from "../core/types.js";

const base = (ctx: ProviderContext) => String(ctx.env["PROMIGENCE_API_URL"] ?? "https://api.promigence.ai").replace(/\/+$/, "");
const auth = (ctx: ProviderContext) => ({ authorization: `Bearer ${ctx.env["PROMIGENCE_API_KEY"]}` });
const box = (ctx: ProviderContext, id: string, path = "") => `${base(ctx)}/v1/sandboxes/${encodeURIComponent(id)}${path}`;

const TIERS = [
  { tier: "xsmall", cpu: 1, memoryMiB: 1024 },
  { tier: "small", cpu: 2, memoryMiB: 4096 },
  { tier: "medium", cpu: 4, memoryMiB: 16384 },
  { tier: "large-16", cpu: 8, memoryMiB: 16384 },
  { tier: "large", cpu: 8, memoryMiB: 32768 },
  { tier: "xlarge", cpu: 16, memoryMiB: 32768 },
  { tier: "2xlarge", cpu: 32, memoryMiB: 65536 },
];
/** Promigence tiers, cheapest first: the first that fits the request. */
export function promigenceTier(cpu: number, memoryMiB: number) {
  return TIERS.find((t) => t.cpu >= cpu && t.memoryMiB >= memoryMiB) ?? TIERS[TIERS.length - 1]!;
}

interface Sandbox {
  sandbox_id: string;
  state: "queued" | "awaiting_capacity" | "ready" | "running" | "paused" | "ended";
  outcome?: string | null;
}
const up = (s: Sandbox) => s.state === "ready" || s.state === "running";

export const promigenceProvider = defineProvider({
  info: {
    id: "promigence",
    name: "Promigence",
    homepage: "https://www.promigence.ai",
    env: ["PROMIGENCE_API_KEY"],
    capabilities: ["ports", "pause", "fileList", "extendTimeout", "snapshot"],
    // Isolation is left unset: Promigence does not publish it, so `minIsolation` requests skip it.
    maxTimeoutSec: 30 * 86_400,
    freeTier: {
      // Only the part that needs no card is counted.
      tier: { kind: "one-time-credit", usd: 10 },
      concurrency: 20,
      maxLifetimeSec: 3600,
      requiresCard: false,
      notes: "$50 once, valid 30 days: $10 without a card, $40 more once one is added. New accounts: 20 concurrent, 1 h each, sizes up to large.",
      source: "https://www.promigence.ai/docs/limits.md",
      checked: "2026-11-12",
    },
    pricing: { vcpuSecondUsd: 0.0504 / 3600, gibSecondUsd: 0.0162 / 3600, defaultCpu: 2, defaultMemoryMiB: 4096, source: "https://www.promigence.ai/facts.json" },
    surfaces: { rest: "https://api.promigence.ai/v1", sdk: ["@promigence/sdk (npm)", "promigence (PyPI)"], cli: "promigence (npm)", mcp: "promigence mcp (stdio)" },
  },

  async create(spec, ctx) {
    const size = promigenceTier(spec.cpu, spec.memoryMiB);
    const wait = ctx.options["pollMs"] === undefined ? 30_000 : 0;
    const run = await httpJson<{ run_id: string; sandboxes: Sandbox[] }>(`${base(ctx)}/v1/runs?wait_ms=${wait}`, {
      headers: { ...auth(ctx), "idempotency-key": spec.metadata["sandboxrouting.id"] ?? randomUUID() },
      body: {
        // A snapshot is the image: an id, an alias, or the stock base.
        snapshot: spec.nativeTemplate ?? String(ctx.options["snapshot"] ?? "promigence/base"),
        count: 1,
        tier: size.tier,
        timeout_ms: Math.max(1000, Math.ceil(spec.timeoutSec * 1000)),
        labels: spec.metadata,
      },
      timeoutMs: wait + 60_000,
    });
    let sandbox = run.sandboxes[0];
    if (!sandbox) throw new Error(`promigence run ${run.run_id} launched no sandbox`);
    const id = sandbox.sandbox_id;
    try {
      for (let i = 0; i < 300 && !up(sandbox); i++) {
        if (sandbox.state === "ended") throw new Error(`promigence sandbox ${id} ended before it was ready: ${sandbox.outcome ?? ""}`);
        await sleep(pollMs(ctx, 1000));
        sandbox = await httpJson<Sandbox>(box(ctx, id), { headers: auth(ctx) });
      }
      if (!up(sandbox)) throw new Error(`promigence sandbox ${id} did not become ready`);
      if (Object.keys(spec.env).length) await this.writeFile(id, ENV_FILE, new TextEncoder().encode(envFileBody(spec.env)), ctx);
    } catch (err) {
      await http(box(ctx, id), { method: "DELETE", headers: auth(ctx) }).catch(() => undefined);
      throw err;
    }
    return { providerSandboxId: id, cpu: size.cpu, memoryMiB: size.memoryMiB };
  },

  async exec(id, command, o, ctx) {
    const timeout_ms = Math.max(1000, (o.timeoutSec ?? 900) * 1000);
    const r = await httpJson<{ exit_code: number | null; stdout: string; stderr: string; timed_out?: boolean }>(box(ctx, id, "/execs"), {
      headers: auth(ctx),
      body: { sh: withEnvFile(command), cwd: o.cwd, env: o.env, timeout_ms, max_output_bytes: 8 * 1024 * 1024 },
      timeoutMs: timeout_ms + 30_000,
    });
    if (r.stdout) o.onStdout?.(r.stdout);
    if (r.stderr) o.onStderr?.(r.stderr);
    // A null exit code means it was killed: by the timeout, or by a signal.
    return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", exitCode: r.exit_code ?? (r.timed_out ? 124 : 137) };
  },

  async readFile(id, path, ctx) {
    return new Uint8Array(await (await http(`${box(ctx, id, "/files")}?path=${encodeURIComponent(path)}`, { headers: auth(ctx) })).arrayBuffer());
  },

  async writeFile(id, path, data, ctx) {
    await http(`${box(ctx, id, "/files")}?path=${encodeURIComponent(path)}`, { method: "PUT", headers: { ...auth(ctx), "content-type": "application/octet-stream" }, raw: data });
  },

  async listFiles(id, path, ctx) {
    const r = await httpJson<{ entries: { name: string; path?: string; is_dir: boolean; size?: number }[] }>(`${box(ctx, id, "/files/list")}?path=${encodeURIComponent(path)}`, { headers: auth(ctx) });
    const dir = path.endsWith("/") ? path : `${path}/`;
    return r.entries.map((e) => ({ name: e.name, path: e.path ?? `${dir}${e.name}`, isDir: e.is_dir, size: e.size }));
  },

  async getUrl(id, port, ctx) {
    // The link carries its own token, so anyone holding it can reach the port.
    return (await httpJson<{ url: string }>(box(ctx, id, "/ports"), { headers: auth(ctx), body: { port } })).url;
  },

  async setTimeout(id, timeoutSec, ctx) {
    // The spec says both that `timeout_ms` is the sandbox's total lifetime and that it counts
    // from now. Sending time already run plus the new remainder is right under the first
    // reading and only late under the second, where the router's own deadline still ends it.
    const cur = await httpJson<{ elapsed_ms?: number }>(box(ctx, id), { headers: auth(ctx) });
    await http(box(ctx, id), { method: "PATCH", headers: auth(ctx), body: { timeout_ms: Math.ceil((cur.elapsed_ms ?? 0) + timeoutSec * 1000) } });
  },

  async pause(id, ctx) {
    // Paused time is not billed and does not count against the timeout; kept 30 days.
    await http(box(ctx, id, "/pause"), { method: "POST", headers: auth(ctx) });
  },

  async resume(id, ctx) {
    await http(box(ctx, id, "/resume"), { method: "POST", headers: auth(ctx) });
  },

  async kill(id, ctx) {
    await http(box(ctx, id), { method: "DELETE", headers: auth(ctx) });
  },

  async listAlive(ctx) {
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const q = new URLSearchParams({ limit: "500", ...(cursor ? { cursor } : {}) });
      const page = await httpJson<{ sandboxes: Sandbox[]; next_cursor?: string | null }>(`${base(ctx)}/v1/sandboxes?${q}`, { headers: auth(ctx) });
      ids.push(...page.sandboxes.filter((s) => s.state !== "ended").map((s) => s.sandbox_id));
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    return ids;
  },
});
