// Munito (munito.ai) Sandboxes, public preview: Linux microVMs on shared vCPUs. Free: a
// one-time trial of $0.90 of sandbox time for 7 days, card required; 2 at once, 2 h each.
// $0.0072 per vCPU-hour + $0.0009 per GiB-hour while running. Munito stops the sandbox and
// drops its files at the timeout (24 h at most).
// REST: https://api.munito.ai/sandboxes/v1 (Bearer munitoai_…). There is no sandbox OpenAPI:
// shapes come from the docs and the official client (`@munitoai/cli`, CLI `munito`).
// A command ends with its request. Outbound network is off unless asked for at create.

import { defineProvider, http, httpJson } from "./util.js";
import { pollMs, sleep } from "./rest-helpers.js";
import type { ProviderContext } from "../core/types.js";

const base = (ctx: ProviderContext) => String(ctx.env["MUNITO_API_URL"] ?? "https://api.munito.ai/sandboxes/v1").replace(/\/+$/, "");
const auth = (ctx: ProviderContext) => ({ authorization: `Bearer ${ctx.env["MUNITO_API_KEY"]}` });
const box = (ctx: ProviderContext, id: string, path = "") => `${base(ctx)}/sandboxes/${encodeURIComponent(id)}${path}`;
const MAX_TIMEOUT_SEC = 86_400;
const EXEC_LIMIT_SEC = 1800;

interface Sandbox {
  id: string;
  status: "pending" | "running" | "paused" | "stopped" | "failed";
  vcpus?: number;
  memory_mib?: number;
  end_reason?: string | null;
}

export const munitoProvider = defineProvider({
  info: {
    id: "munito",
    name: "Munito",
    homepage: "https://munito.ai/sandboxes",
    env: ["MUNITO_API_KEY"],
    capabilities: ["ports", "extendTimeout"],
    isolation: "microvm",
    maxTimeoutSec: MAX_TIMEOUT_SEC,
    maxExecSec: EXEC_LIMIT_SEC,
    freeTier: {
      tier: { kind: "one-time-credit", usd: 0.9 },
      concurrency: 2,
      maxLifetimeSec: 7200,
      requiresCard: true,
      notes: "Trial: $0.90 of sandbox time for 7 days once a card is added; 2 at once, up to 4 vCPU / 8 GiB, 2 h each. Then a plan from $15/mo.",
      source: "https://docs.munito.ai/sandboxes/pricing",
      checked: "2026-11-12",
    },
    pricing: { vcpuSecondUsd: 0.0072 / 3600, gibSecondUsd: 0.0009 / 3600, defaultCpu: 2, defaultMemoryMiB: 4096, source: "https://docs.munito.ai/sandboxes/pricing" },
    surfaces: { rest: "https://api.munito.ai/sandboxes/v1", sdk: ["@munitoai/cli (npm)"], cli: "munito" },
  },

  async create(spec, ctx) {
    const key = spec.metadata["sandboxrouting.id"];
    let sandbox = await httpJson<Sandbox>(`${base(ctx)}/sandboxes`, {
      headers: { ...auth(ctx), ...(key ? { "idempotency-key": key } : {}) },
      body: {
        template: spec.nativeTemplate ?? String(ctx.options["template"] ?? "base"),
        vcpus: Math.min(16, Math.max(1, Math.ceil(spec.cpu))),
        // 512–32768 MiB in steps of 256.
        memory_mib: Math.min(32_768, Math.max(512, Math.ceil(spec.memoryMiB / 256) * 256)),
        timeout: Math.min(MAX_TIMEOUT_SEC, Math.max(10, Math.ceil(spec.timeoutSec))),
        env: spec.env,
        metadata: Object.fromEntries(Object.entries(spec.metadata).slice(0, 16)),
        internet: ctx.options["internet"] !== false,
      },
      timeoutMs: 180_000,
    });
    try {
      for (let i = 0; i < 300 && sandbox.status !== "running"; i++) {
        if (sandbox.status !== "pending") throw new Error(`munito sandbox ${sandbox.id} is ${sandbox.status}${sandbox.end_reason ? ` (${sandbox.end_reason})` : ""}`);
        await sleep(pollMs(ctx, 1000));
        sandbox = await httpJson<Sandbox>(box(ctx, sandbox.id), { headers: auth(ctx) });
      }
      if (sandbox.status !== "running") throw new Error(`munito sandbox ${sandbox.id} did not start`);
    } catch (err) {
      await http(box(ctx, sandbox.id), { method: "DELETE", headers: auth(ctx) }).catch(() => undefined);
      throw err;
    }
    return { providerSandboxId: sandbox.id, cpu: sandbox.vcpus, memoryMiB: sandbox.memory_mib };
  },

  async exec(id, command, o, ctx) {
    const timeout = Math.min(EXEC_LIMIT_SEC, Math.max(1, Math.ceil(o.timeoutSec ?? 60)));
    const r = await httpJson<{ exit_code: number | null; stdout: string; stderr: string; timed_out?: boolean }>(box(ctx, id, "/exec"), {
      headers: auth(ctx),
      body: { command, cwd: o.cwd, env: o.env, timeout },
      timeoutMs: (timeout + 30) * 1000,
    });
    if (r.stdout) o.onStdout?.(r.stdout);
    if (r.stderr) o.onStderr?.(r.stderr);
    return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", exitCode: r.exit_code ?? (r.timed_out ? 124 : 137) };
  },

  async readFile(id, path, ctx) {
    return new Uint8Array(await (await http(`${box(ctx, id, "/files/content")}?path=${encodeURIComponent(path)}`, { headers: auth(ctx) })).arrayBuffer());
  },

  async writeFile(id, path, data, ctx) {
    // Creates parent directories; 100 MiB at most.
    await http(`${box(ctx, id, "/files/content")}?path=${encodeURIComponent(path)}`, { method: "PUT", headers: { ...auth(ctx), "content-type": "application/octet-stream" }, raw: data });
  },

  async getUrl(id, port, ctx) {
    await http(box(ctx, id, `/ports/${port}`), { method: "PUT", headers: auth(ctx), body: { public: true } });
    return (await httpJson<{ url: string }>(box(ctx, id, `/ports/${port}`), { headers: auth(ctx) })).url;
  },

  async setTimeout(id, timeoutSec, ctx) {
    // Seconds from now; it can shorten or lengthen.
    await http(box(ctx, id, "/timeout"), { headers: auth(ctx), body: { timeout: Math.min(MAX_TIMEOUT_SEC, Math.max(10, Math.ceil(timeoutSec))) } });
  },

  async kill(id, ctx) {
    await http(box(ctx, id), { method: "DELETE", headers: auth(ctx) });
  },

  async listAlive(ctx) {
    // The list keeps stopped records. It is a bare array, or a page with `data`.
    const page = await httpJson<Sandbox[] | { data?: Sandbox[] }>(`${base(ctx)}/sandboxes`, { headers: auth(ctx) });
    const rows = Array.isArray(page) ? page : page.data;
    if (!rows) throw new Error("munito list: unexpected response shape");
    return rows.filter((s) => s.status === "pending" || s.status === "running" || s.status === "paused").map((s) => s.id);
  },
});
