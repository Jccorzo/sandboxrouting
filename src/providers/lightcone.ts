// Lightcone (Tzafon): cloud computers for computer use. A computer is a Linux desktop (or a
// browser session) in its own VM, made to be driven by screenshots, clicks and keys (and by
// Tzafon's Northstar model); it also runs shell commands, which is what the router uses.
// Computer-use actions (screenshot, click, type, CDP) are not exposed through the router.
// Compute is billed per second on what the computer actually uses: $0.38 per core-hour of CPU
// in use (at least 0.125 cores per container) and $0.095 per GiB-hour of memory in use. The
// router meters memory as if all of it were in use. No free tier.
// Docs: https://docs.lightcone.ai/guides/computers, .../guides/shell-commands,
//   .../guides/pricing, .../guides/errors, .../guides/security (each also as /index.md;
//   everything in https://docs.lightcone.ai/llms-full.txt). REST paths and fields from npm
//   `@tzafon/lightcone` 0.19.1. API: https://api.tzafon.ai (Bearer key, TZAFON_API_KEY).
// `max_lifetime_seconds` always applies, so Lightcone ends a computer at its timeout. Create
// takes no env, sizes or idempotency key; env is kept in a file commands load.

import { defineProvider, http, httpJson, HttpError } from "./util.js";
import { ENV_FILE, envFileBody, pollMs, sleep, withEnvFile } from "./rest-helpers.js";
import type { ProviderContext } from "../core/types.js";

const base = (ctx: ProviderContext) => String(ctx.env["LIGHTCONE_BASE_URL"] ?? "https://api.tzafon.ai").replace(/\/+$/, "");
const auth = (ctx: ProviderContext) => ({ authorization: `Bearer ${ctx.env["TZAFON_API_KEY"]}` });
const computer = (ctx: ProviderContext, id: string, path = "") => `${base(ctx)}/computers/${encodeURIComponent(id)}${path}`;

interface Computer {
  id: string;
  status?: string;
}

export const lightconeProvider = defineProvider({
  info: {
    id: "lightcone",
    name: "Lightcone",
    homepage: "https://lightcone.ai",
    env: ["TZAFON_API_KEY"],
    capabilities: [],
    isolation: "vm",
    freeTier: { tier: { kind: "none" }, notes: "No free tier or trial credit on the pricing page.", source: "https://docs.lightcone.ai/guides/pricing", checked: "2026-11-21" },
    // CPU and memory are both billed on use; the floor is 0.125 cores of the default 2.
    pricing: {
      vcpuSecondUsd: 0.38 / 3600,
      gibSecondUsd: 0.095 / 3600,
      defaultCpu: 2,
      defaultMemoryMiB: 4096,
      billing: "active-cpu",
      activeCpuFloor: 0.0625,
      source: "https://docs.lightcone.ai/guides/pricing",
    },
    surfaces: { rest: "https://api.tzafon.ai", sdk: ["@tzafon/lightcone (npm)", "tzafon (PyPI)"], cli: "lightcone", mcp: "docs.lightcone.ai/integrations/mcp" },
  },

  async create(spec, ctx) {
    const lifetime = Math.max(1, Math.ceil(spec.timeoutSec));
    let c = await httpJson<Computer>(`${base(ctx)}/computers`, {
      headers: auth(ctx),
      body: { kind: String(ctx.options["kind"] ?? "desktop"), max_lifetime_seconds: lifetime, inactivity_timeout_seconds: lifetime },
    });
    try {
      for (let i = 0; i < 300 && c.status !== "running"; i++) {
        if (/fail|error|terminat|stopp|dead|kill/i.test(c.status ?? "")) throw new Error(`lightcone computer ${c.id} is ${c.status}`);
        await sleep(pollMs(ctx, 1000));
        c = await httpJson<Computer>(computer(ctx, c.id), { headers: auth(ctx) });
      }
      if (c.status !== "running") throw new Error(`lightcone computer ${c.id} did not start (${c.status})`);
      if (Object.keys(spec.env).length) {
        const r = await this.exec(c.id, `cat > ${ENV_FILE} <<'SBR_ENV'\n${envFileBody(spec.env)}SBR_ENV`, {}, ctx);
        if (r.exitCode !== 0) throw new Error(`lightcone computer ${c.id}: could not write its environment: ${r.stderr}`);
      }
    } catch (err) {
      await this.kill(c.id, ctx).catch(() => undefined);
      throw err;
    }
    return { providerSandboxId: c.id };
  },

  async exec(id, command, o, ctx) {
    const timeoutSec = Math.max(1, Math.ceil(o.timeoutSec ?? 600));
    const r = await httpJson<{ exit_code?: number; stdout?: string; stderr?: string }>(computer(ctx, id, "/exec/sync"), {
      headers: auth(ctx),
      body: { command: withEnvFile(command), cwd: o.cwd, env: o.env, timeout_seconds: timeoutSec },
      timeoutMs: (timeoutSec + 30) * 1000,
    });
    const stdout = r.stdout ?? "";
    const stderr = r.stderr ?? "";
    if (stdout) o.onStdout?.(stdout);
    if (stderr) o.onStderr?.(stderr);
    // -1: timed out or ended abnormally.
    const code = r.exit_code ?? -1;
    return { stdout, stderr, exitCode: code === -1 ? 124 : code };
  },

  async kill(id, ctx) {
    try {
      await http(computer(ctx, id), { method: "DELETE", headers: { ...auth(ctx), accept: "*/*" } });
    } catch (err) {
      if (err instanceof HttpError && (err.status === 404 || err.status === 410)) return;
      throw err;
    }
  },

  async listAlive(ctx) {
    const list = await httpJson<Computer[]>(`${base(ctx)}/computers?type=live`, { headers: auth(ctx) });
    return (list ?? []).filter((c) => c.status === "running" || c.status === "starting").map((c) => c.id);
  },
});
