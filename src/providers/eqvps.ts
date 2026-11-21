// EQVPS Sandboxes (eqvps.com/en/sandboxes): Firecracker microVMs paid from a prepaid balance
// (crypto top-ups, no KYC). No free tier. $0.040 per vCPU-hour and $0.013 per GB-hour, billed per
// second (60 s minimum); named tariffs from micro (0.25 vCPU) to max (8 vCPU / 16 GB). Up to 20
// sandboxes at once and 2 commands at once per account.
// REST: https://api.eqvps.com/api/v1/eqvps (Bearer token), OpenAPI https://eqvps.com/openapi.json,
// live tariffs at GET /sandboxes/tariffs; docs https://eqvps.com/en/docs/sandboxes and
// https://eqvps.com/llms.txt. npm `@eqvps/sdk`, PyPI `eqvps`, MCP https://mcp.eqvps.com/mcp.
// Ephemeral sandboxes are deleted at `ttl` (24 h max) or after `idle_timeout` (1 h max) without
// activity. A synchronous command is capped at 55 s, so longer ones run as tasks that are polled.
// An empty balance answers 402; the account's own spending cap answers 429 `budget_exceeded`,
// which is turned into a 402 here so the router reads it as used-up credit, not a rate limit.

import { defineProvider, http, httpJson, HttpError } from "./util.js";
import { pollMs, sleep } from "./rest-helpers.js";
import { SandboxRouterError } from "../core/errors.js";
import type { ProviderContext } from "../core/types.js";

const base = (ctx: ProviderContext) => String(ctx.env["EQVPS_API_URL"] ?? "https://api.eqvps.com/api/v1/eqvps").replace(/\/+$/, "");
const auth = (ctx: ProviderContext) => ({ authorization: `Bearer ${ctx.env["EQVPS_API_KEY"]}` });
const box = (ctx: ProviderContext, id: string, path = "") => `${base(ctx)}/sandboxes/${encodeURIComponent(id)}${path}`;
const SYNC_LIMIT_SEC = 55;

const TARIFFS = [
  { tariff: "micro", cpu: 0.25, memoryMiB: 512 },
  { tariff: "small", cpu: 0.5, memoryMiB: 1024 },
  { tariff: "standard", cpu: 1, memoryMiB: 2048 },
  { tariff: "plus", cpu: 2, memoryMiB: 4096 },
  { tariff: "pro", cpu: 4, memoryMiB: 8192 },
  { tariff: "max", cpu: 8, memoryMiB: 16384 },
];
/** EQVPS tariffs, cheapest first: the first that fits the request. */
export function eqvpsTariff(cpu: number, memoryMiB: number) {
  return TARIFFS.find((t) => t.cpu >= cpu && t.memoryMiB >= memoryMiB) ?? TARIFFS[TARIFFS.length - 1]!;
}

interface Sandbox {
  id: string;
  state?: "running" | "starting" | "paused" | "pausing" | "resuming" | "deleting";
  ready?: boolean;
}
interface Task {
  task_id: string;
  state: "running" | "done" | "failed" | "killed" | "timeout";
  exit_code?: number | null;
  done?: boolean;
  stdout?: string;
  stdout_next_offset?: number;
  stderr?: string;
  stderr_next_offset?: number;
}

/** The spending cap is the account's own limit on credit: a quota refusal, not a rate limit. */
function budgetAsQuota(err: unknown): never {
  if (err instanceof HttpError && err.status === 429 && /budget_exceeded/.test(err.message)) throw new HttpError(402, err.message);
  throw err;
}

export const eqvpsProvider = defineProvider({
  info: {
    id: "eqvps",
    name: "EQVPS Sandboxes",
    homepage: "https://eqvps.com/en/sandboxes",
    env: ["EQVPS_API_KEY"],
    capabilities: [],
    isolation: "microvm",
    maxTimeoutSec: 86_400,
    freeTier: {
      tier: { kind: "none" },
      concurrency: 20,
      requiresCard: false,
      notes: "No free tier: a prepaid balance topped up in crypto (no card, no KYC). 20 sandboxes and 2 running commands at once per account.",
      source: "https://eqvps.com/en/sandboxes",
      checked: "2026-11-21",
    },
    pricing: { vcpuSecondUsd: 0.04 / 3600, gibSecondUsd: 0.013 / 3600, defaultCpu: 2, defaultMemoryMiB: 4096, source: "https://api.eqvps.com/api/v1/eqvps/sandboxes/tariffs" },
    surfaces: { rest: "https://api.eqvps.com/api/v1/eqvps", sdk: ["@eqvps/sdk (npm)", "eqvps (PyPI)"], mcp: "https://mcp.eqvps.com/mcp" },
  },

  async create(spec, ctx) {
    const size = eqvpsTariff(spec.cpu, spec.memoryMiB);
    const ttl = Math.min(86_400, Math.max(1, Math.ceil(spec.timeoutSec)));
    // The create takes no idempotency key.
    let s = await httpJson<Sandbox>(`${base(ctx)}/sandboxes`, {
      headers: auth(ctx),
      body: { mode: "ephemeral", tariff: size.tariff, ttl, idle_timeout: Math.min(3600, ttl), env: spec.env },
    }).catch(budgetAsQuota);
    const id = s.id;
    try {
      for (let i = 0; i < 300 && !(s.state === "running" && s.ready !== false); i++) {
        if (s.state === "deleting") throw new Error(`eqvps sandbox ${id} is being deleted`);
        await sleep(pollMs(ctx, 1000));
        s = await httpJson<Sandbox>(box(ctx, id), { headers: auth(ctx) });
      }
      if (!(s.state === "running" && s.ready !== false)) throw new Error(`eqvps sandbox ${id} did not become ready`);
    } catch (err) {
      await this.kill(id, ctx).catch(() => undefined);
      throw err;
    }
    return { providerSandboxId: id, cpu: size.cpu, memoryMiB: size.memoryMiB };
  },

  async exec(id, command, o, ctx) {
    // `command` runs as `bash -lc`; cwd and env are fields of their own.
    const fields = { command, cwd: o.cwd, env: o.env };
    if (o.timeoutSec !== undefined && o.timeoutSec <= SYNC_LIMIT_SEC) {
      const timeout = Math.max(1, Math.ceil(o.timeoutSec));
      const r = await httpJson<{ exit_code: number; stdout: string; stderr: string; timed_out?: boolean }>(box(ctx, id, "/exec"), {
        headers: auth(ctx),
        body: { ...fields, timeout },
        timeoutMs: (timeout + 30) * 1000,
      });
      if (r.stdout) o.onStdout?.(r.stdout);
      if (r.stderr) o.onStderr?.(r.stderr);
      return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", exitCode: r.timed_out ? 124 : r.exit_code };
    }
    // Longer or unbounded: a background task, polled for new output until it ends.
    const started = await httpJson<{ task_id: string }>(box(ctx, id, "/exec"), {
      headers: auth(ctx),
      body: { ...fields, async: true, timeout: o.timeoutSec === undefined ? undefined : Math.ceil(o.timeoutSec) },
    });
    const task = box(ctx, id, `/tasks/${encodeURIComponent(started.task_id)}`);
    let stdout = "";
    let stderr = "";
    let out = 0;
    let err = 0;
    for (;;) {
      const t = await httpJson<Task>(`${task}?stdout_offset=${out}&stderr_offset=${err}`, { headers: auth(ctx) });
      if (t.stdout) {
        stdout += t.stdout;
        o.onStdout?.(t.stdout);
      }
      if (t.stderr) {
        stderr += t.stderr;
        o.onStderr?.(t.stderr);
      }
      out = t.stdout_next_offset ?? out + Buffer.byteLength(t.stdout ?? "");
      err = t.stderr_next_offset ?? err + Buffer.byteLength(t.stderr ?? "");
      if (t.state !== "running" && t.done !== false) {
        const exitCode = t.exit_code ?? (t.state === "timeout" ? 124 : t.state === "killed" ? 137 : t.state === "done" ? 0 : 1);
        return { stdout, stderr, exitCode };
      }
      await sleep(pollMs(ctx, 1000));
    }
  },

  async readFile(id, path, ctx) {
    try {
      const r = await httpJson<{ content_base64?: string }>(`${box(ctx, id, "/files")}?path=${encodeURIComponent(path)}`, { headers: auth(ctx) });
      return new Uint8Array(Buffer.from(r.content_base64 ?? "", "base64"));
    } catch (err) {
      // Files over 5 MiB: the router's exec fallback reads them in pieces.
      if (err instanceof HttpError && err.status === 413) throw new SandboxRouterError("unsupported", `eqvps file API: ${path} is over 5 MiB`, "eqvps");
      throw err;
    }
  },

  async writeFile(id, path, data, ctx) {
    try {
      await http(box(ctx, id, "/files"), { method: "PUT", headers: auth(ctx), body: { path, content_base64: Buffer.from(data).toString("base64") } });
    } catch (err) {
      if (err instanceof HttpError && err.status === 413) throw new SandboxRouterError("unsupported", `eqvps file API: ${path} is over 5 MiB`, "eqvps");
      throw err;
    }
  },

  async kill(id, ctx) {
    try {
      await http(box(ctx, id), { method: "DELETE", headers: auth(ctx) });
    } catch (err) {
      // 404 not found, 410 deleted after its paused snapshot expired: already gone.
      if (!(err instanceof HttpError && (err.status === 404 || err.status === 410))) throw err;
    }
  },

  async listAlive(ctx) {
    const r = await httpJson<{ data?: Sandbox[] }>(`${base(ctx)}/sandboxes`, { headers: auth(ctx) });
    if (!Array.isArray(r.data)) throw new Error("eqvps: unexpected response shape listing sandboxes");
    return r.data.filter((s) => s.state !== "deleting").map((s) => s.id);
  },
});
