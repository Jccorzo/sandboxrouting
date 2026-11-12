// Quivvo: Firecracker machines for agents (runs on Fly.io Machines). Free: $5 once, no card,
// 1 machine running. New accounts may wait in a queue until a paid plan.
// REST: https://tryquivvo.com/api/v1 (Bearer qvk_… or X-API-Key), OpenAPI at /openapi.json.
// Python SDK `quivvo`; npm `quivvo` is the CLI. Hosted MCP server.

import { defineProvider, http, httpJson } from "./util.js";
import type { ProviderContext } from "../core/types.js";

const base = (ctx: ProviderContext) => String(ctx.env["QUIVVO_API_URL"] ?? "https://tryquivvo.com/api/v1").replace(/\/+$/, "");
const auth = (ctx: ProviderContext) => ({ authorization: `Bearer ${ctx.env["QUIVVO_API_KEY"]}` });
const m = (ctx: ProviderContext, id: string, path = "") => `${base(ctx)}/machines/${encodeURIComponent(id)}${path}`;

interface Machine {
  id: string;
  state: string;
  vcpus?: number;
  memory_mib?: number;
}

export const quivvoProvider = defineProvider({
  info: {
    id: "quivvo",
    name: "Quivvo",
    homepage: "https://tryquivvo.com",
    env: ["QUIVVO_API_KEY"],
    capabilities: ["ports", "pause", "fileList", "extendTimeout", "snapshot"],
    isolation: "microvm",
    freeTier: {
      tier: { kind: "one-time-credit", usd: 5 },
      concurrency: 1,
      requiresCard: false,
      notes: "$5 once, no card; 1 machine running, 3 total, up to 2 vCPU / 4 GiB.",
      source: "https://tryquivvo.com/pricing.md",
      checked: "2026-11-11",
    },
    pricing: { vcpuSecondUsd: 0.005 / 3600, gibSecondUsd: 0.011 / 3600, defaultCpu: 1, defaultMemoryMiB: 2048, source: "https://tryquivvo.com/pricing.md" },
    surfaces: { rest: "https://tryquivvo.com/api/v1", sdk: ["quivvo (PyPI)"], cli: "quivvo (npm)", mcp: "hosted" },
  },

  async create(spec, ctx) {
    const machine = await httpJson<Machine>(`${base(ctx)}/machines?wait=1`, {
      headers: auth(ctx),
      body: {
        template: spec.nativeTemplate ?? String(ctx.options["template"] ?? "minimal"),
        vcpus: Math.max(1, Math.round(spec.cpu)),
        memory_mib: spec.memoryMiB,
        env: spec.env,
        region: spec.region,
        delete_after_minutes: Math.max(1, Math.ceil(spec.timeoutSec / 60)),
        idempotency_key: spec.metadata["sandboxrouting.id"],
      },
      timeoutMs: 300_000,
    });
    if (machine.state === "failed") throw new Error(`quivvo machine ${machine.id} failed to start`);
    return { providerSandboxId: machine.id, cpu: machine.vcpus, memoryMiB: machine.memory_mib };
  },

  async exec(id, command, o, ctx) {
    const timeoutMs = Math.min((o.timeoutSec ?? 280) * 1000, 280_000); // API maximum
    const r = await httpJson<{ exit_code: number; stdout: string; stderr: string }>(m(ctx, id, "/exec"), {
      headers: auth(ctx),
      body: { cmd: command, cwd: o.cwd, env: o.env, timeout_ms: timeoutMs },
      timeoutMs: timeoutMs + 30_000,
    });
    if (r.stdout) o.onStdout?.(r.stdout);
    if (r.stderr) o.onStderr?.(r.stderr);
    return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exit_code };
  },

  async readFile(id, path, ctx) {
    const res = await http(`${m(ctx, id, "/files")}?path=${encodeURIComponent(path)}`, { headers: auth(ctx) });
    return new Uint8Array(await res.arrayBuffer());
  },

  async writeFile(id, path, data, ctx) {
    await http(`${m(ctx, id, "/files")}?path=${encodeURIComponent(path)}`, {
      method: "PUT",
      headers: { ...auth(ctx), "content-type": "application/octet-stream" },
      raw: data,
    });
  },

  async listFiles(id, path, ctx) {
    const r = await httpJson<{ entries?: { name?: string; type?: string; size?: number }[] }>(`${m(ctx, id, "/files")}?path=${encodeURIComponent(path)}`, {
      headers: { ...auth(ctx), accept: "application/json" },
    });
    const dir = path.endsWith("/") ? path : `${path}/`;
    return (r.entries ?? []).map((e) => ({ name: e.name ?? "", path: `${dir}${e.name}`, isDir: e.type === "dir", size: e.size }));
  },

  async getUrl(id, port, ctx) {
    const r = await httpJson<{ url?: string | null }>(m(ctx, id, "/ports"), { headers: auth(ctx), body: { port, public: true } });
    if (!r.url) throw new Error(`quivvo returned no URL for port ${port}`);
    return r.url;
  },

  async setTimeout(id, timeoutSec, ctx) {
    await http(m(ctx, id), { method: "PATCH", headers: auth(ctx), body: { delete_after_minutes: Math.max(1, Math.ceil(timeoutSec / 60)) } });
  },

  async pause(id, ctx) {
    await http(m(ctx, id, "/suspend"), { method: "POST", headers: auth(ctx) });
  },

  async resume(id, ctx) {
    await http(`${m(ctx, id, "/resume")}?wait=1`, { method: "POST", headers: auth(ctx) });
  },

  async kill(id, ctx) {
    await http(m(ctx, id), { method: "DELETE", headers: auth(ctx) });
  },

  async listAlive(ctx) {
    const r = await httpJson<{ machines: Machine[] }>(`${base(ctx)}/machines`, { headers: auth(ctx) });
    return r.machines.filter((x) => !["deleted", "failed", "stopped"].includes(x.state)).map((x) => x.id);
  },
});
