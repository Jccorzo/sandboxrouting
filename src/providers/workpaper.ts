// Workpaper: small Linux VMs ("computers", each with its own kernel) on Workpaper's own
// hardware in Delhi, India. Small and early: no uptime guarantee, no backups.
// Docs (checked 2026-11-21): https://docs.workpaper.co/llms-full.txt (how it works, SDK,
// limits, pricing, free trial). The REST API isn't documented on its own; its wire format is
// taken from the official SDK, npm `workpaper` 0.4.0 (dist/index.js), which "speaks the same
// API as the workpaper CLI":
//   https://api.workpaper.co, header X-API-Key
//     POST   /v1/computers                {name, mode, templateID, timeout, metadata} → computer
//     GET    /v1/computers                [computer]
//     GET    /v1/computers/{id}           {sandboxID, state, cpuCount, memoryMB, metadata, ...}
//     POST   /v1/computers/{id}/exec      {requestID, command, cwd, env, timeoutMs} → {exitCode, stdout, stderr}
//     GET|PUT /v1/computers/{id}/files?path=   raw bytes
//     POST   /v1/computers/{id}/pause     stop: disk and memory kept, billing stops
//     POST   /v1/computers/{id}/connect   {timeout}: wake
//     DELETE /v1/computers/{id}
// Errors carry {message, reason}: `at_capacity` (every host busy) and `host_busy` (retry).
// A computer runs until it has been idle for an hour, then pauses; `timeout` is ignored, so
// the router deletes it at its deadline (enforcesTimeout: false). No incoming ports yet.
// Pro is $15 a month, all of it usage credit, at $0.010 an hour for small (2 vCPU / 4 GB)
// and $0.020 for large (4 vCPU / 8 GB); pay as you go is $5 for 150 small hours ($0.033/h).

import { randomUUID } from "node:crypto";
import { HttpError, defineProvider, http, httpJson } from "./util.js";
import { ENV_FILE, envFileBody, pollMs, sbrName, sleep, withEnvFile } from "./rest-helpers.js";
import type { ProviderContext } from "../core/types.js";

const ID = "workpaper";
const base = (ctx: ProviderContext) => String(ctx.env["WORKPAPER_API_URL"] ?? "https://api.workpaper.co").replace(/\/+$/, "");
const auth = (ctx: ProviderContext) => ({ "x-api-key": String(ctx.env["WORKPAPER_API_KEY"] ?? "") });
const box = (ctx: ProviderContext, id: string, path = "") => `${base(ctx)}/v1/computers/${encodeURIComponent(id)}${path}`;

/** Workpaper's two sizes, by their stock template. */
export function workpaperSize(cpu: number, memoryMiB: number): { templateID: string; cpu: number; memoryMiB: number } {
  return cpu <= 2 && memoryMiB <= 4096 ? { templateID: "workpaper-2c4g", cpu: 2, memoryMiB: 4096 } : { templateID: "workpaper-4c8g", cpu: 4, memoryMiB: 8192 };
}

interface Computer {
  sandboxID: string;
  state?: string;
  cpuCount?: number;
  memoryMB?: number;
  metadata?: Record<string, string>;
}

const nameOf = (c: Computer) => c.metadata?.["workpaper.name"] ?? c.sandboxID;

export const workpaperProvider = defineProvider({
  info: {
    id: ID,
    name: "Workpaper",
    homepage: "https://workpaper.co",
    env: ["WORKPAPER_API_KEY"],
    capabilities: ["pause"],
    isolation: "vm",
    enforcesTimeout: false,
    freeTier: {
      // A new account gets one free hour of credit; the 60-minute no-account trial needs the CLI.
      tier: { kind: "one-time-credit", usd: 0.01 },
      concurrency: 4,
      requiresCard: false,
      notes: "Each new account gets a free hour of credit (one small computer). 4 running computers per account. India only.",
      source: "https://docs.workpaper.co/free-trial",
      checked: "2026-11-21",
    },
    // Pro rate, flat per size: small $0.010/h split 2:1 vCPU-hour to GiB-hour, which also gives large $0.020/h.
    pricing: { vcpuSecondUsd: 0.01 / 4 / 3600, gibSecondUsd: 0.01 / 8 / 3600, defaultCpu: 2, defaultMemoryMiB: 4096, source: "https://docs.workpaper.co/pricing" },
    surfaces: { rest: "https://api.workpaper.co/v1/computers", sdk: ["workpaper (npm)", "workpaper (PyPI)"], cli: "workpaper" },
  },

  async create(spec, ctx) {
    const size = workpaperSize(spec.cpu, spec.memoryMiB);
    const name = sbrName(spec);
    let computer: Computer;
    try {
      computer = await httpJson<Computer>(`${base(ctx)}/v1/computers`, {
        headers: auth(ctx),
        // mode "full" keeps it a regular VM: Instant mode adds a CPU charge on top.
        body: { name, mode: "full", templateID: spec.nativeTemplate ?? size.templateID, timeout: 3600, metadata: spec.metadata },
      });
    } catch (err) {
      // The name comes from the router id, so a retried create finds the first one's computer.
      if (!(err instanceof HttpError && err.status === 409)) throw err;
      const mine = (await httpJson<Computer[]>(`${base(ctx)}/v1/computers`, { headers: auth(ctx) })).find((c) => nameOf(c) === name);
      if (!mine) throw err;
      computer = mine;
    }
    const id = computer.sandboxID;
    try {
      let state = computer.state ?? "";
      for (let i = 0; i < 300 && state !== "running"; i++) {
        if (/fail|error|kill|delet/i.test(state)) throw new Error(`workpaper computer ${id} is ${state}`);
        // A retried create may find it paused: wake it.
        if (state === "paused") await http(box(ctx, id, "/connect"), { headers: auth(ctx), body: { timeout: 3600 } });
        await sleep(pollMs(ctx, 1000));
        state = (await httpJson<Computer>(box(ctx, id), { headers: auth(ctx) })).state ?? "";
      }
      if (state !== "running") throw new Error(`workpaper computer ${id} did not start`);
      if (Object.keys(spec.env).length) {
        await http(`${box(ctx, id, "/files")}?path=${encodeURIComponent(ENV_FILE)}`, { method: "PUT", headers: auth(ctx), raw: envFileBody(spec.env) });
      }
    } catch (err) {
      await http(box(ctx, id), { method: "DELETE", headers: auth(ctx) }).catch(() => undefined);
      throw err;
    }
    return { providerSandboxId: id, cpu: computer.cpuCount || size.cpu, memoryMiB: computer.memoryMB || size.memoryMiB };
  },

  async exec(id, command, o, ctx) {
    // One request id for every try, so a retry after "host_busy" can't run the command twice.
    const requestID = randomUUID();
    const timeoutMs = o.timeoutSec ? Math.ceil(o.timeoutSec * 1000) : undefined;
    const began = Date.now();
    for (;;) {
      try {
        const r = await httpJson<{ exitCode: number; stdout?: string; stderr?: string }>(box(ctx, id, "/exec"), {
          headers: auth(ctx),
          body: { requestID, command: withEnvFile(command), cwd: o.cwd, env: o.env, timeoutMs },
          timeoutMs: (timeoutMs ?? 3_600_000) + 30_000,
        });
        if (r.stdout) o.onStdout?.(r.stdout);
        if (r.stderr) o.onStderr?.(r.stderr);
        return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", exitCode: r.exitCode };
      } catch (err) {
        if (!(err instanceof HttpError && /host_busy/.test(err.message)) || Date.now() - began > 120_000) throw err;
        await sleep(pollMs(ctx, 100));
      }
    }
  },

  async readFile(id, path, ctx) {
    return new Uint8Array(await (await http(`${box(ctx, id, "/files")}?path=${encodeURIComponent(path)}`, { headers: auth(ctx) })).arrayBuffer());
  },

  async writeFile(id, path, data, ctx) {
    await http(`${box(ctx, id, "/files")}?path=${encodeURIComponent(path)}`, { method: "PUT", headers: auth(ctx), raw: data });
  },

  async pause(id, ctx) {
    await http(box(ctx, id, "/pause"), { method: "POST", headers: auth(ctx) });
  },

  async resume(id, ctx) {
    await http(box(ctx, id, "/connect"), { headers: auth(ctx), body: { timeout: 3600 } });
  },

  async kill(id, ctx) {
    try {
      await http(box(ctx, id), { method: "DELETE", headers: auth(ctx) });
    } catch (err) {
      if (!(err instanceof HttpError && (err.status === 404 || err.status === 410))) throw err;
    }
  },

  async listAlive(ctx) {
    const all = await httpJson<Computer[]>(`${base(ctx)}/v1/computers`, { headers: auth(ctx) });
    return all.filter((c) => !/kill|delet|fail/i.test(c.state ?? "")).map((c) => c.sandboxID);
  },
});
