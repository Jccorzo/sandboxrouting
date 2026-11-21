// Fly.io Machines over the public REST API (https://api.machines.dev/v1, Bearer). Fly's Free
// plan includes $5 of usage a month, shared with Sprites; shared-CPU machines billed per second. Needs an app you own:
// FLY_APP (or providers.fly.options.app). Rate limit: about 1 request/s per action.

import { defineProvider, http, httpJson, withCwdEnv } from "./util.js";
import type { ProviderContext } from "../core/types.js";

const API = "https://api.machines.dev/v1";
const app = (ctx: ProviderContext) => String(ctx.options["app"] ?? ctx.env["FLY_APP"]);
const headers = (ctx: ProviderContext) => ({ authorization: `Bearer ${ctx.env["FLY_API_TOKEN"]}` });
const url = (ctx: ProviderContext, path = "") => `${API}/apps/${encodeURIComponent(app(ctx))}/machines${path}`;

interface Machine {
  id: string;
  state: string;
  config?: { guest?: { cpus: number; memory_mb: number } };
}

export const flyProvider = defineProvider({
  info: {
    id: "fly",
    name: "Fly.io Machines",
    homepage: "https://fly.io/docs/machines/",
    env: ["FLY_API_TOKEN", "FLY_APP"],
    capabilities: ["customImage"],
    isolation: "microvm",
    freeTier: {
      tier: { kind: "monthly-credit", usd: 2.5 },
      concurrency: 3,
      requiresCard: true,
      notes: "Fly's Free plan: $5 of usage a month shared by Machines and Sprites (card required; up to 3 of each). Split evenly between fly and sprites here, since the router meters each apart; give one all of it in config if you use only one. New accounts also get a $1 trial for 7 days.",
      source: "https://fly.io/pricing/",
      checked: "2026-11-21",
    },
    // Shared-CPU list prices fit $0.69/month per vCPU plus $6/GB-month of memory (shared-cpu-1x
    // 256 MB $2.19, 1 GB $6.70; shared-cpu-2x 2 GB $13.39), over a 730-hour month.
    pricing: { vcpuSecondUsd: 0.69 / 730 / 3600, gibSecondUsd: 6 / 730 / 3600, defaultCpu: 1, defaultMemoryMiB: 1024, source: "https://fly.io/docs/about/pricing/" },
    surfaces: { rest: API, sdk: ["fly-go (Go)"], cli: "fly" },
  },

  isConfigured(ctx) {
    return Boolean(ctx.env["FLY_API_TOKEN"] && (ctx.options["app"] || ctx.env["FLY_APP"]));
  },

  async create(spec, ctx) {
    const cpus = Math.max(1, Math.round(spec.cpu));
    const memory_mb = Math.max(256, Math.round(spec.memoryMiB / 256) * 256);
    const m = await httpJson<Machine>(url(ctx), {
      headers: headers(ctx),
      body: {
        region: spec.region,
        config: {
          image: spec.nativeTemplate ?? spec.image ?? "python:3.12-slim",
          env: spec.env,
          metadata: spec.metadata,
          guest: { cpu_kind: "shared", cpus, memory_mb },
          init: { cmd: ["sleep", String(spec.timeoutSec)] },
          auto_destroy: true, // the machine is deleted when sleep ends: the deadline
          restart: { policy: "no" },
        },
      },
    });
    await http(url(ctx, `/${m.id}/wait?state=started&timeout=60`), { headers: headers(ctx) });
    return { providerSandboxId: m.id, cpu: cpus, memoryMiB: memory_mb };
  },

  async exec(id, command, o, ctx) {
    const r = await httpJson<{ stdout?: string; stderr?: string; exit_code?: number }>(url(ctx, `/${id}/exec`), {
      headers: headers(ctx),
      body: { command: ["sh", "-c", withCwdEnv(command, o)], timeout: o.timeoutSec ?? 60 },
      timeoutMs: ((o.timeoutSec ?? 60) + 30) * 1000,
    });
    const stdout = r.stdout ?? "";
    const stderr = r.stderr ?? "";
    if (stdout) o.onStdout?.(stdout);
    if (stderr) o.onStderr?.(stderr);
    return { stdout, stderr, exitCode: r.exit_code ?? -1 };
  },

  async kill(id, ctx) {
    await http(url(ctx, `/${id}?force=true`), { method: "DELETE", headers: headers(ctx) });
  },

  async listAlive(ctx) {
    const all = await httpJson<Machine[]>(url(ctx), { headers: headers(ctx) });
    return all.filter((m) => m.state === "started" || m.state === "starting" || m.state === "created").map((m) => m.id);
  },
});
