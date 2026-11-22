// Celesto cloud computers: Firecracker microVMs for agents. Free: $5 one-time credit, no card
// (expires 30 days after activation; one retained Micro sandbox). No TTL, no env at create
// and no files API, so env goes into each command, files go through the exec fallback, and
// the router deletes computers at the deadline (enforcesTimeout: false).
// Spoken over HTTP, no SDK: REST at https://api.celesto.ai/v1/computers (Bearer), the calls the
// official SDK (npm `@celestoai/sdk` 0.1.6, Apache-2.0) makes; docs https://docs.celesto.ai.
// CLI: `celesto computer`. MCP: https://mcp.celesto.ai/mcp.

import { defineProvider, httpJson } from "./util.js";
import { shellQuote } from "../core/sandbox.js";
import type { ProviderContext } from "../core/types.js";

interface ComputerDto {
  id: string;
  status: string;
  vcpus: number;
  ram_mb: number;
}

const base = (ctx: ProviderContext) => `${(ctx.env["CELESTO_BASE_URL"] || "https://api.celesto.ai").replace(/\/+$/, "")}/v1/computers`;

function api<T>(ctx: ProviderContext, path: string, init: { method?: string; body?: unknown; timeoutMs?: number } = {}): Promise<T> {
  return httpJson<T>(`${base(ctx)}${path}`, { ...init, headers: { Authorization: `Bearer ${ctx.env["CELESTO_API_KEY"] ?? ""}` } });
}
const one = (id: string) => `/${encodeURIComponent(id)}`;

/** Env the computer should carry, kept per process because Celesto has no create-time env. */
const createEnv = new Map<string, Record<string, string>>();

export const celestoProvider = defineProvider({
  info: {
    id: "celesto",
    name: "Celesto",
    homepage: "https://celesto.ai",
    env: ["CELESTO_API_KEY"],
    capabilities: ["customImage", "ports", "pause"],
    isolation: "microvm",
    enforcesTimeout: false,
    freeTier: {
      tier: { kind: "one-time-credit", usd: 5 },
      concurrency: 1,
      requiresCard: false,
      notes: "$5 one-time Micro credit, no card, expires 30 days after activation; one retained Micro sandbox.",
      source: "https://celesto.ai/pricing",
      checked: "2026-11-11",
    },
    // Micro 1 vCPU / 2 GB = $0.015/h and Standard 2 vCPU / 4 GB = $0.03/h fit $0.0075/vCPU-h + $0.00375/GB-h.
    pricing: { vcpuSecondUsd: 0.0075 / 3600, gibSecondUsd: 0.00375 / 3600, defaultCpu: 1, defaultMemoryMiB: 2048, source: "https://celesto.ai/pricing" },
    surfaces: { rest: "https://api.celesto.ai/v1", sdk: ["@celestoai/sdk (npm)", "celesto (PyPI)"], cli: "celesto", mcp: "https://mcp.celesto.ai/mcp" },
  },

  async create(spec, ctx) {
    const c = await api<ComputerDto>(ctx, "", {
      method: "POST",
      body: { vcpus: Math.max(1, Math.round(spec.cpu)), ram_mb: spec.memoryMiB, image: spec.image, template_id: spec.nativeTemplate },
    });
    if (Object.keys(spec.env).length) createEnv.set(c.id, spec.env);
    return { providerSandboxId: c.id, cpu: c.vcpus, memoryMiB: c.ram_mb };
  },

  async exec(id, command, o, ctx) {
    const env = { ...createEnv.get(id), ...o.env };
    const prefix = Object.entries(env).map(([k, v]) => `export ${k}=${shellQuote(v)}; `).join("");
    const cd = o.cwd ? `cd ${shellQuote(o.cwd)} && ` : "";
    // The API's own default timeout is what the SDK sends when none is given: 30 s.
    const timeout = o.timeoutSec ?? 30;
    const r = await api<{ exit_code: number; stdout: string; stderr: string }>(ctx, `${one(id)}/exec`, {
      method: "POST",
      body: { command: `sh -c ${shellQuote(`${prefix}${cd}${command}`)}`, timeout },
      timeoutMs: timeout * 1000 + 30_000,
    });
    if (r.stdout) o.onStdout?.(r.stdout);
    if (r.stderr) o.onStderr?.(r.stderr);
    return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exit_code };
  },

  async getUrl(id, port, ctx) {
    const p = await api<{ url?: string | null }>(ctx, `${one(id)}/published-ports`, { method: "POST", body: { port } });
    if (!p.url) throw new Error(`celesto did not return a URL for port ${port}`);
    return p.url;
  },

  async pause(id, ctx) {
    await api(ctx, `${one(id)}/stop`, { method: "POST" });
  },

  async resume(id, ctx) {
    await api(ctx, `${one(id)}/start`, { method: "POST" });
  },

  async kill(id, ctx) {
    createEnv.delete(id);
    await api(ctx, one(id), { method: "DELETE" });
  },

  async listAlive(ctx) {
    const all = await api<{ computers: ComputerDto[] }>(ctx, "");
    return all.computers.filter((c) => !["deleted", "deleting", "error"].includes(c.status)).map((c) => c.id);
  },
});
