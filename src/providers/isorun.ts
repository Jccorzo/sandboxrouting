// Isorun: microVMs with their own kernel, booted from any OCI image. Free: $50, no card.
// Paid: $0.025 per vCPU-hour and $0.015 per GiB-hour, per second from create to destroy;
// hibernated sandboxes bill nothing. `timeout` is an idle timer (default 300 s) that destroys
// the sandbox, so a busy one outlives it and the router deletes it at the deadline
// (enforcesTimeout: false).
// REST: https://run-<region>.isorun.ai, the region taken from the key (`isorun_live_<region>_…`),
// Bearer auth. Docs: https://docs.isorun.ai/api-reference, /sandboxes/lifecycle,
// /getting-started/pricing, /sdks/typescript; wire details from npm `isorun` 1.0.3 (github.com/isorun/sdk).
// Exec takes no cwd or env, and create takes no env, so env is kept in a file commands load.
// Port URLs (`/v1/runs/{id}/proxy/{port}/`) need the API key on every request, so the adapter
// doesn't claim `ports`; directory listings carry names only, so `fileList` uses the exec fallback.

import { SandboxRouterError } from "../core/errors.js";
import { defineProvider, http, HttpError, httpJson } from "./util.js";
import { ENV_FILE, envFileBody, inline, pollMs, sleep, withEnvFile } from "./rest-helpers.js";
import type { ProviderContext } from "../core/types.js";

/** `ISORUN_API_URL`, else the runner of the key's region. */
export function isorunBase(ctx: ProviderContext): string {
  const explicit = ctx.env["ISORUN_API_URL"];
  if (explicit) return explicit.replace(/\/+$/, "");
  const parts = String(ctx.env["ISORUN_API_KEY"] ?? "").split("_");
  if (parts.length >= 5 && parts[0] === "isorun" && parts[1] === "live") return `https://run-${parts[2]}.isorun.ai`;
  throw new SandboxRouterError("auth", "isorun: the API key names no region; set ISORUN_API_URL", "isorun");
}
const auth = (ctx: ProviderContext) => ({ authorization: `Bearer ${ctx.env["ISORUN_API_KEY"]}` });
const run = (ctx: ProviderContext, id: string, path = "") => `${isorunBase(ctx)}/v1/runs/${encodeURIComponent(id)}${path}`;
/** A delete of a sandbox that is already gone is not an error. */
const gone = (err: unknown) => {
  if (err instanceof HttpError && (err.status === 404 || err.status === 410)) return;
  throw err;
};

interface Run {
  id: string;
  status?: string;
  vcpus?: number;
  mem_mib?: number;
}
const failed = (status = "") => /fail|error|destroy/i.test(status);

export const isorunProvider = defineProvider({
  info: {
    id: "isorun",
    name: "Isorun",
    homepage: "https://isorun.ai",
    env: ["ISORUN_API_KEY"],
    capabilities: ["customImage", "pause", "extendTimeout"],
    isolation: "microvm",
    enforcesTimeout: false,
    freeTier: {
      tier: { kind: "one-time-credit", usd: 50 },
      requiresCard: false,
      notes: "$50 of free credit (about 1,250 hours of the default 1 vCPU / 1 GiB sandbox), no card. Concurrency and lifetime limits are not published.",
      source: "https://docs.isorun.ai/getting-started/pricing",
      checked: "2026-11-21",
    },
    pricing: { vcpuSecondUsd: 0.025 / 3600, gibSecondUsd: 0.015 / 3600, defaultCpu: 1, defaultMemoryMiB: 1024, source: "https://docs.isorun.ai/getting-started/pricing" },
    surfaces: { rest: "https://run-<region>.isorun.ai/v1", sdk: ["isorun (npm)"], mcp: "isorun (npm, MCP server)" },
  },

  async create(spec, ctx) {
    const vcpus = Math.max(1, Math.ceil(spec.cpu));
    const r = await httpJson<Run>(`${isorunBase(ctx)}/v1/runs`, {
      headers: auth(ctx),
      body: {
        image: spec.image ?? spec.nativeTemplate ?? String(ctx.options["image"] ?? "node:22-slim"),
        vcpus,
        mem_mib: spec.memoryMiB,
        timeout: Math.max(1, Math.ceil(spec.timeoutSec)),
      },
      timeoutMs: 300_000,
    });
    const id = r.id;
    try {
      let status = r.status ?? "";
      for (let i = 0; i < 300 && status !== "running"; i++) {
        if (failed(status)) throw new Error(`isorun sandbox ${id} is ${status}`);
        await sleep(pollMs(ctx, 1000));
        status = (await httpJson<Run>(run(ctx, id), { headers: auth(ctx) })).status ?? "";
      }
      if (status !== "running") throw new Error(`isorun sandbox ${id} did not start running`);
      if (Object.keys(spec.env).length) await this.writeFile(id, ENV_FILE, new TextEncoder().encode(envFileBody(spec.env)), ctx);
    } catch (err) {
      await http(run(ctx, id), { method: "DELETE", headers: auth(ctx) }).catch(() => undefined);
      throw err;
    }
    return { providerSandboxId: id, cpu: r.vcpus ?? vcpus, memoryMiB: r.mem_mib ?? spec.memoryMiB };
  },

  async exec(id, command, o, ctx) {
    const timeout = Math.max(1, Math.ceil(o.timeoutSec ?? 600));
    const r = await httpJson<{ exit_code?: number; stdout?: string; stderr?: string }>(run(ctx, id, "/exec"), {
      headers: auth(ctx),
      body: { command: withEnvFile(inline(command, { cwd: o.cwd, env: o.env })), timeout },
      timeoutMs: (timeout + 30) * 1000,
    });
    const stdout = r.stdout ?? "";
    const stderr = r.stderr ?? "";
    if (stdout) o.onStdout?.(stdout);
    if (stderr) o.onStderr?.(stderr);
    return { stdout, stderr, exitCode: r.exit_code ?? 1 };
  },

  async readFile(id, path, ctx) {
    return new Uint8Array(await (await http(`${run(ctx, id, "/files/download")}?path=${encodeURIComponent(path)}`, { headers: auth(ctx) })).arrayBuffer());
  },

  async writeFile(id, path, data, ctx) {
    await http(`${run(ctx, id, "/files/upload")}?path=${encodeURIComponent(path)}`, {
      method: "POST",
      headers: { ...auth(ctx), "content-type": "application/octet-stream" },
      raw: data,
    });
  },

  async setTimeout(id, timeoutSec, ctx) {
    // Resets the idle timer; 0 would turn it off.
    await http(run(ctx, id), { method: "PATCH", headers: auth(ctx), body: { timeout: Math.max(1, Math.ceil(timeoutSec)) } });
  },

  async pause(id, ctx) {
    await http(run(ctx, id, "/hibernate"), { method: "POST", headers: auth(ctx) });
  },

  async resume(id, ctx) {
    // The same id comes back with the same state.
    await http(run(ctx, id, "/resume"), { method: "POST", headers: auth(ctx) });
  },

  async kill(id, ctx) {
    await http(run(ctx, id), { method: "DELETE", headers: auth(ctx) }).catch(gone);
  },

  async listAlive(ctx) {
    // Lists active sandboxes, hibernated ones included; destroyed ones are under /v1/runs/history.
    const r = await httpJson<Run[] | { runs?: Run[] }>(`${isorunBase(ctx)}/v1/runs`, { headers: auth(ctx) });
    return (Array.isArray(r) ? r : r.runs ?? []).filter((x) => !failed(x.status)).map((x) => x.id);
  },
});
