// Zode (zode.dev): Cloud Hypervisor microVMs for coding agents, in eu-central only.
// Free: $10 once, no card (a team workspace gets it when its first card is saved), 2 running.
// $0.00875 per vCPU-hour: $0.0175/h for 2 vCPU / 4 GB (docs and homepage agree, 2026-11-21).
// A sandbox has no TTL and lives until deleted, so the router deletes it at the deadline.
// REST: https://api.zode.dev/v1 (Bearer zode_tok_…), OpenAPI at docs.zode.dev.
// The buffered exec stops at 55 s; longer commands need its WebSocket, which this adapter
// does not speak (maxExecSec). There are no file routes: the router's exec fallback does files.
// npm `@zodedev/sdk`, CLI `zode`.

import { defineProvider, http, httpJson } from "./util.js";
import { ENV_FILE, envFileBody, sbrName, shq, withEnvFile } from "./rest-helpers.js";
import type { ProviderContext } from "../core/types.js";

const base = (ctx: ProviderContext) => String(ctx.env["ZODE_API_URL"] ?? "https://api.zode.dev").replace(/\/+$/, "");
const auth = (ctx: ProviderContext) => ({ authorization: `Bearer ${ctx.env["ZODE_API_KEY"]}` });
const box = (ctx: ProviderContext, id: string, path = "") => `${base(ctx)}/v1/sandboxes/${encodeURIComponent(id)}${path}`;
const EXEC_LIMIT_SEC = 55;

/** Zode shapes: 2, 4, 8 or 16 vCPUs with 2 GB each. */
export function zodeShape(cpu: number, memoryMiB: number): { vcpus: number; ram_mb: number } {
  const vcpus = [2, 4, 8, 16].find((c) => c >= cpu && c * 2048 >= memoryMiB) ?? 16;
  return { vcpus, ram_mb: vcpus * 2048 };
}

interface Sandbox {
  id: string;
  name?: string;
  status: "creating" | "running" | "stopping" | "stopped" | "starting" | "deleting" | "deleted" | "error";
  vcpus?: number;
  ram_mb?: number;
}

export const zodeProvider = defineProvider({
  info: {
    id: "zode",
    name: "Zode",
    homepage: "https://zode.dev",
    env: ["ZODE_API_KEY"],
    capabilities: ["pause", "snapshot"],
    isolation: "microvm",
    enforcesTimeout: false,
    maxExecSec: EXEC_LIMIT_SEC,
    freeTier: {
      tier: { kind: "one-time-credit", usd: 10 },
      concurrency: 2,
      requiresCard: false,
      notes: "$10 once, no card (a team workspace gets it when its first card is saved); 2 running. Storage is free for 48 h, then $0.10/GB-month until deleted.",
      source: "https://docs.zode.dev/pricing.md",
      checked: "2026-11-21",
    },
    // $0.00875 per vCPU-hour, memory included: $0.0175/h for the default 2 vCPU / 4 GB.
    pricing: { vcpuSecondUsd: 0.00875 / 3600, gibSecondUsd: 0, defaultCpu: 2, defaultMemoryMiB: 4096, source: "https://docs.zode.dev/pricing.md" },
    surfaces: { rest: "https://api.zode.dev/v1", sdk: ["@zodedev/sdk (npm)"], cli: "zode", mcp: "zode mcp (stdio)" },
  },

  async create(spec, ctx) {
    const shape = zodeShape(spec.cpu, spec.memoryMiB);
    // Returns once the sandbox runs. There is no env, label or timeout field.
    const sandbox = await httpJson<Sandbox>(`${base(ctx)}/v1/sandboxes`, {
      headers: auth(ctx),
      body: { name: sbrName(spec), ...shape, region: spec.region, image: spec.nativeTemplate },
      timeoutMs: 180_000,
    });
    try {
      if (sandbox.status !== "running") throw new Error(`zode sandbox ${sandbox.id} is ${sandbox.status}`);
      if (Object.keys(spec.env).length) {
        const r = await this.exec(sandbox.id, `printf %s ${shq(envFileBody(spec.env))} > ${ENV_FILE}`, { timeoutSec: 30 }, ctx);
        if (r.exitCode !== 0) throw new Error(`zode sandbox ${sandbox.id}: could not store env: ${r.stderr.trim()}`);
      }
    } catch (err) {
      await http(box(ctx, sandbox.id), { method: "DELETE", headers: auth(ctx) }).catch(() => undefined);
      throw err;
    }
    return { providerSandboxId: sandbox.id, cpu: sandbox.vcpus ?? shape.vcpus, memoryMiB: sandbox.ram_mb ?? shape.ram_mb };
  },

  async exec(id, command, o, ctx) {
    const timeout_ms = Math.min(EXEC_LIMIT_SEC, Math.max(1, o.timeoutSec ?? 30)) * 1000;
    const r = await httpJson<{ exit_code: number; stdout: string; stderr: string; timed_out?: boolean }>(box(ctx, id, "/exec"), {
      headers: auth(ctx),
      // Env is a list of KEY=VALUE strings, not an object.
      body: { argv: ["sh", "-c", withEnvFile(command)], cwd: o.cwd, env: Object.entries(o.env ?? {}).map(([k, v]) => `${k}=${v}`), timeout_ms },
      timeoutMs: timeout_ms + 30_000,
    });
    if (r.stdout) o.onStdout?.(r.stdout);
    if (r.stderr) o.onStderr?.(r.stderr);
    return { stdout: r.stdout, stderr: r.stderr, exitCode: r.timed_out && r.exit_code < 0 ? 124 : r.exit_code };
  },

  async pause(id, ctx) {
    // Hibernates: RAM and disk are saved and compute billing stops.
    await http(box(ctx, id, "/stop"), { method: "POST", headers: auth(ctx), timeoutMs: 180_000 });
  },

  async resume(id, ctx) {
    await http(box(ctx, id, "/start"), { method: "POST", headers: auth(ctx), timeoutMs: 180_000 });
  },

  async kill(id, ctx) {
    await http(box(ctx, id), { method: "DELETE", headers: auth(ctx) });
  },

  async listAlive(ctx) {
    // Deleted sandboxes are left out; a workspace may hold sandboxes the router didn't make.
    const { sandboxes } = await httpJson<{ sandboxes: Sandbox[] }>(`${base(ctx)}/v1/sandboxes`, { headers: auth(ctx) });
    return sandboxes.filter((s) => (s.name ?? "").startsWith("sbr-") && !["deleting", "deleted", "error"].includes(s.status)).map((s) => s.id);
  },
});
