// MIOSA (miosa.ai): sandboxes are Firecracker microVMs (or MIOSA's own SOMA VMM when asked for)
// restored from snapshots. Free plan: $1 of usage every month, no card, 5 sandboxes at once,
// machines up to 4 vCPU / 8 GB; machines pause at a $0 balance. One price per size, per second
// while running: xs (1 vCPU / 2 GB) $0.0446/h, small (2 / 4 GB) $0.0893/h, medium (4 / 8 GB)
// $0.1785/h, large $0.357/h, xl $0.7141/h.
// REST: https://api.miosa.ai/api/v1 (Bearer msk_…), OpenAPI https://miosa.ai/openapi.yaml, docs
// https://miosa.ai/docs/api-reference/sandboxes.md and https://miosa.ai/llms.txt. npm `@miosa/sdk`,
// CLI `miosa`. Single resources may come wrapped in `{ "data": … }`; both shapes are read.
// `timeout_sec` counts from the last activity, and a non-persistent sandbox is destroyed when it
// runs out, so a busy one outlives the deadline and the router deletes it (enforcesTimeout:
// false). The idle auto-stop (30 min by default on new accounts) is turned off: it would stop
// the sandbox, not end it. Files go through the router's exec fallback: the public spec leaves
// the read format open, and the SDK uses a filesystem route the spec doesn't publish.

import { randomUUID } from "node:crypto";
import { defineProvider, http, httpJson, HttpError } from "./util.js";
import { pollMs, sleep } from "./rest-helpers.js";
import type { ProviderContext } from "../core/types.js";

const base = (ctx: ProviderContext) => String(ctx.env["MIOSA_API_URL"] ?? "https://api.miosa.ai/api/v1").replace(/\/+$/, "");
const auth = (ctx: ProviderContext) => ({ authorization: `Bearer ${ctx.env["MIOSA_API_KEY"]}` });
const box = (ctx: ProviderContext, id: string, path = "") => `${base(ctx)}/sandboxes/${encodeURIComponent(id)}${path}`;
const unwrap = <T>(r: T | { data: T }): T => (r !== null && typeof r === "object" && "data" in r && (r as { data: T }).data !== undefined ? (r as { data: T }).data : (r as T));

const SIZES = [
  { size: "xs", cpu: 1, memoryMiB: 2048 },
  { size: "small", cpu: 2, memoryMiB: 4096 },
  { size: "medium", cpu: 4, memoryMiB: 8192 },
  { size: "large", cpu: 8, memoryMiB: 16384 },
  { size: "xl", cpu: 16, memoryMiB: 32768 },
];
/** MIOSA's named sizes, smallest first: the first that fits the request. */
export function miosaSize(cpu: number, memoryMiB: number) {
  return SIZES.find((s) => s.cpu >= cpu && s.memoryMiB >= memoryMiB) ?? SIZES[SIZES.length - 1]!;
}

interface Sandbox {
  id: string;
  state?: "creating" | "running" | "stopped" | "paused" | "error" | "destroyed";
  ready?: boolean;
  cpu_count?: number;
  memory_mb?: number;
}
const up = (s: Sandbox) => s.state === "running" && s.ready !== false;

export const miosaProvider = defineProvider({
  info: {
    id: "miosa",
    name: "MIOSA",
    homepage: "https://miosa.ai",
    env: ["MIOSA_API_KEY"],
    capabilities: ["ports", "extendTimeout"],
    isolation: "microvm",
    enforcesTimeout: false,
    freeTier: {
      tier: { kind: "monthly-credit", usd: 1 },
      concurrency: 5,
      requiresCard: false,
      notes: "Free plan: $1 of usage every month, no card; 5 sandboxes at once, 8 GB / 4 vCPU running in total. Machines pause at a $0 balance; credit top-ups from $5.",
      source: "https://miosa.ai/pricing",
      checked: "2026-11-21",
    },
    // Flat per size; small ($0.0893/h for 2 vCPU / 4 GB) split as 2:1 vCPU-hour to GiB-hour,
    // which reproduces every size from xs to xl.
    pricing: { vcpuSecondUsd: 0.0893 / 4 / 3600, gibSecondUsd: 0.0893 / 8 / 3600, defaultCpu: 2, defaultMemoryMiB: 4096, source: "https://miosa.ai/pricing" },
    surfaces: { rest: "https://api.miosa.ai/api/v1", sdk: ["@miosa/sdk (npm)", "miosa (PyPI)", "miosa-go", "ai.miosa:miosa-sdk (Java)"], cli: "miosa" },
  },

  async create(spec, ctx) {
    const size = miosaSize(spec.cpu, spec.memoryMiB);
    // The same key within 24 h returns the sandbox the first request made.
    let s = unwrap(
      await httpJson<Sandbox | { data: Sandbox }>(`${base(ctx)}/sandboxes`, {
        headers: { ...auth(ctx), "idempotency-key": spec.metadata["sandboxrouting.id"] ?? randomUUID() },
        body: {
          template_id: spec.nativeTemplate,
          size: size.size,
          persistent: false,
          timeout_sec: Math.min(86_400, Math.max(1, Math.ceil(spec.timeoutSec))),
          idle_timeout_sec: 0,
          env: spec.env,
          metadata: spec.metadata,
        },
      }),
    );
    const id = s.id;
    try {
      for (let i = 0; i < 300 && !up(s); i++) {
        if (s.state === "error" || s.state === "destroyed" || s.state === "stopped") throw new Error(`miosa sandbox ${id} is ${s.state}`);
        await sleep(pollMs(ctx, 1000));
        s = unwrap(await httpJson<Sandbox | { data: Sandbox }>(box(ctx, id), { headers: auth(ctx) }));
      }
      if (!up(s)) throw new Error(`miosa sandbox ${id} did not become ready`);
    } catch (err) {
      await this.kill(id, ctx).catch(() => undefined);
      throw err;
    }
    return { providerSandboxId: id, cpu: s.cpu_count ?? size.cpu, memoryMiB: s.memory_mb ?? size.memoryMiB };
  },

  async exec(id, command, o, ctx) {
    const timeout = Math.min(86_400, Math.max(1, Math.ceil(o.timeoutSec ?? 3600)));
    const r = unwrap(
      await httpJson<{ exit_code?: number; stdout?: string; stderr?: string; timed_out?: boolean } | { data: { exit_code?: number; stdout?: string; stderr?: string; timed_out?: boolean } }>(
        box(ctx, id, "/exec"),
        { headers: auth(ctx), body: { command, cwd: o.cwd, env: o.env, timeout }, timeoutMs: (timeout + 30) * 1000 },
      ),
    );
    if (r.stdout) o.onStdout?.(r.stdout);
    if (r.stderr) o.onStderr?.(r.stderr);
    return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", exitCode: r.timed_out ? 124 : r.exit_code ?? 0 };
  },

  async getUrl(id, port, ctx) {
    const r = unwrap(await httpJson<{ url: string } | { data: { url: string } }>(box(ctx, id, "/expose"), { headers: auth(ctx), body: { port } }));
    return r.url;
  },

  async setTimeout(id, timeoutSec, ctx) {
    await http(box(ctx, id, "/extend"), { headers: auth(ctx), body: { timeout_sec: Math.min(86_400, Math.max(1, Math.ceil(timeoutSec))) } });
  },

  async kill(id, ctx) {
    try {
      // Destroying an already-destroyed sandbox answers 200.
      await http(box(ctx, id), { method: "DELETE", headers: auth(ctx) });
    } catch (err) {
      if (!(err instanceof HttpError && (err.status === 404 || err.status === 410))) throw err;
    }
  },

  async listAlive(ctx) {
    const ids: string[] = [];
    for (let page = 1; ; page++) {
      const r = await httpJson<{ data?: Sandbox[]; page?: { page?: number; page_size?: number; total?: number } }>(`${base(ctx)}/sandboxes?page=${page}&page_size=100`, {
        headers: auth(ctx),
      });
      if (!Array.isArray(r.data)) throw new Error("miosa: unexpected response shape listing sandboxes");
      ids.push(...r.data.filter((s) => s.state !== "destroyed" && s.state !== "error").map((s) => s.id));
      const total = r.page?.total;
      if (r.data.length < 100 || total === undefined || page * 100 >= total) break;
    }
    return ids;
  },
});
