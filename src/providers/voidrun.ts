// VoidRun (void-run.com): MicroVM sandboxes for AI agents, priced in rupees. Free: up to ₹4,600 of
// credit, no card (the page doesn't say whether it is one-time; counted as one-time). Then
// ₹0.0010304 per compute-unit-second of CPU execution time on active workloads and ₹0.0003312 per
// GB-second of RAM allocated while online (₹12.19/h for 2 vCPU / 4 GB busy), converted at the ECB
// rate in currency.ts. An idle sandbox is snapshotted after 60 s (memory and disk, storage only,
// beta-free) and wakes on the next API call; a snapshotted one is deleted after 7 days.
// REST: https://api.void-run.com/api (X-API-Key vr_…), OpenAPI https://void-run.com/docs/openapi/voidrun.yml
// (pages under https://void-run.com/docs/api-reference/), agent index https://void-run.com/docs/llms.txt,
// lifecycle https://void-run.com/docs/core-concepts/lifecycle.md. npm `@voidrun/sdk`, PyPI `voidrun`,
// CLI `voidrun`, MCP.
// There is no TTL (a sandbox runs until deleted), so the router deletes it at the deadline
// (enforcesTimeout: false). Create takes no idempotency key but names are unique: the name comes
// from the router id, and a 409 on a retried create adopts the sandbox with that name. Sync exec
// runs a shell command for at most 300 s.

import { defineProvider, http, httpJson, HttpError } from "./util.js";
import { pollMs, sbrName, sleep } from "./rest-helpers.js";
import { INR_PER_USD } from "./currency.js";
import type { ProviderContext } from "../core/types.js";

const base = (ctx: ProviderContext) => String(ctx.env["VOIDRUN_API_URL"] ?? "https://api.void-run.com/api").replace(/\/+$/, "");
const auth = (ctx: ProviderContext) => ({ "x-api-key": String(ctx.env["VOIDRUN_API_KEY"]) });
const box = (ctx: ProviderContext, id: string, path = "") => `${base(ctx)}/sandboxes/${encodeURIComponent(id)}${path}`;
const EXEC_LIMIT_SEC = 300;

interface Sandbox {
  id: string;
  name?: string;
  status?: "running" | "snapshotted" | "error" | "killed" | "deleted";
  cpu?: number;
  mem?: number;
}
const FAILED = new Set(["error", "killed", "deleted"]);

/** VoidRun sizes: 1–8 vCPUs, 1–16 GiB. */
export function voidrunSize(cpu: number, memoryMiB: number): { cpu: number; mem: number } {
  return { cpu: Math.min(8, Math.max(1, Math.ceil(cpu))), mem: Math.min(16384, Math.max(1024, Math.ceil(memoryMiB))) };
}

async function findByName(ctx: ProviderContext, name: string): Promise<Sandbox | undefined> {
  for (let page = 1; page <= 50; page++) {
    const r = await httpJson<{ data?: Sandbox[]; meta?: { totalPages?: number } }>(`${base(ctx)}/sandboxes?page=${page}&limit=100`, { headers: auth(ctx) });
    const hit = (r.data ?? []).find((s) => s.name === name && s.status !== "deleted");
    if (hit) return hit;
    if (!r.data?.length || page >= (r.meta?.totalPages ?? page)) return undefined;
  }
  return undefined;
}

export const voidrunProvider = defineProvider({
  info: {
    id: "voidrun",
    name: "VoidRun",
    homepage: "https://void-run.com",
    env: ["VOIDRUN_API_KEY"],
    capabilities: ["ports", "pause", "fileList"],
    isolation: "microvm",
    enforcesTimeout: false,
    maxExecSec: EXEC_LIMIT_SEC,
    freeTier: {
      tier: { kind: "one-time-credit", usd: Math.round((4600 / INR_PER_USD) * 100) / 100 },
      requiresCard: false,
      notes: "Up to ₹4,600 of free credit (≈ $49.64 at the ECB rate of 2026-11-20), no card; the page doesn't say whether it is one-time or expires. Prices are in rupees.",
      source: "https://void-run.com/pricing",
      checked: "2026-11-21",
    },
    // "CPU execution time across active workloads" plus "allocated RAM while workloads stay online".
    pricing: {
      vcpuSecondUsd: 0.0010304 / INR_PER_USD,
      gibSecondUsd: 0.0003312 / INR_PER_USD,
      defaultCpu: 2,
      defaultMemoryMiB: 4096,
      billing: "active-cpu",
      source: "https://void-run.com/pricing",
    },
    surfaces: { rest: "https://api.void-run.com/api", sdk: ["@voidrun/sdk (npm)", "voidrun (PyPI)"], cli: "voidrun", mcp: "VoidRun MCP (docs/integrations/mcp)" },
  },

  async create(spec, ctx) {
    const size = voidrunSize(spec.cpu, spec.memoryMiB);
    const name = sbrName(spec);
    let s: Sandbox;
    try {
      s = (
        await httpJson<{ data: Sandbox }>(`${base(ctx)}/sandboxes`, {
          headers: auth(ctx),
          body: {
            name,
            image: spec.nativeTemplate ?? (ctx.options["image"] as string | undefined),
            cpu: size.cpu,
            mem: size.mem,
            envVars: spec.env,
            autoSleep: true,
            region: spec.region,
            sync: true,
          },
          timeoutMs: 180_000,
        })
      ).data;
    } catch (err) {
      // A retried create whose first try went through: the name is the router id's.
      if (!(err instanceof HttpError && err.status === 409)) throw err;
      const found = await findByName(ctx, name);
      if (!found) throw err;
      s = found;
    }
    const id = s.id;
    try {
      for (let i = 0; i < 300 && s.status !== "running"; i++) {
        if (FAILED.has(s.status ?? "")) throw new Error(`voidrun sandbox ${id} is ${s.status}`);
        // A snapshotted sandbox wakes on any call; this one is still coming up.
        await sleep(pollMs(ctx, 1000));
        s = (await httpJson<{ data: Sandbox }>(box(ctx, id), { headers: auth(ctx) })).data;
      }
      if (s.status !== "running") throw new Error(`voidrun sandbox ${id} did not start (${s.status})`);
    } catch (err) {
      await this.kill(id, ctx).catch(() => undefined);
      throw err;
    }
    return { providerSandboxId: id, cpu: s.cpu ?? size.cpu, memoryMiB: s.mem ?? size.mem };
  },

  async exec(id, command, o, ctx) {
    const timeout = Math.min(EXEC_LIMIT_SEC, Math.max(1, Math.ceil(o.timeoutSec ?? EXEC_LIMIT_SEC)));
    const r = await httpJson<{ data?: { stdout?: string; stderr?: string; exitCode?: number } }>(box(ctx, id, "/exec"), {
      headers: auth(ctx),
      body: { command, cwd: o.cwd, env: o.env, timeout },
      timeoutMs: (timeout + 60) * 1000,
    });
    const d = r.data ?? {};
    if (d.stdout) o.onStdout?.(d.stdout);
    if (d.stderr) o.onStderr?.(d.stderr);
    return { stdout: d.stdout ?? "", stderr: d.stderr ?? "", exitCode: d.exitCode ?? -1 };
  },

  async readFile(id, path, ctx) {
    return new Uint8Array(await (await http(`${box(ctx, id, "/files/download")}?path=${encodeURIComponent(path)}`, { headers: auth(ctx) })).arrayBuffer());
  },

  async writeFile(id, path, data, ctx) {
    await http(`${box(ctx, id, "/files/upload")}?path=${encodeURIComponent(path)}`, {
      method: "POST",
      headers: { ...auth(ctx), "content-type": "application/octet-stream" },
      raw: data,
    });
  },

  async listFiles(id, path, ctx) {
    const r = await httpJson<{ data?: { files?: { name: string; path?: string; isDir?: boolean; size?: number }[] } }>(`${box(ctx, id, "/files")}?path=${encodeURIComponent(path)}`, {
      headers: auth(ctx),
    });
    const dir = path.endsWith("/") ? path : `${path}/`;
    return (r.data?.files ?? []).map((f) => ({ name: f.name, path: f.path ?? `${dir}${f.name}`, isDir: !!f.isDir, size: f.size }));
  },

  async getUrl(id, port, ctx) {
    // The list is replaced, so the ports already published are sent back with the new one.
    const cur = await httpJson<{ data?: { port: number; url: string }[] }>(box(ctx, id, "/public-urls"), { headers: auth(ctx) });
    const have = cur.data?.find((p) => p.port === port);
    if (have) return have.url;
    const ports = [...new Set([...(cur.data ?? []).map((p) => p.port), port])];
    await http(box(ctx, id, "/publish-ports"), { method: "PATCH", headers: auth(ctx), body: { publishPorts: ports } });
    const now = await httpJson<{ data?: { port: number; url: string }[] }>(box(ctx, id, "/public-urls"), { headers: auth(ctx) });
    const url = now.data?.find((p) => p.port === port)?.url;
    if (!url) throw new Error(`voidrun: port ${port} was published but has no URL yet`);
    return url;
  },

  async pause(id, ctx) {
    await http(box(ctx, id, "/sleep"), { method: "POST", headers: auth(ctx) });
  },

  async resume(id, ctx) {
    await http(box(ctx, id, "/wake"), { method: "POST", headers: auth(ctx) });
  },

  async kill(id, ctx) {
    try {
      await http(box(ctx, id), { method: "DELETE", headers: auth(ctx) });
    } catch (err) {
      if (!(err instanceof HttpError && (err.status === 404 || err.status === 410))) throw err;
    }
  },

  async listAlive(ctx) {
    const ids: string[] = [];
    for (let page = 1; page <= 1000; page++) {
      const r = await httpJson<{ data?: Sandbox[]; meta?: { totalPages?: number } }>(`${base(ctx)}/sandboxes?page=${page}&limit=100`, { headers: auth(ctx) });
      // Snapshotted ones still hold storage and wake on use: alive until deleted.
      ids.push(...(r.data ?? []).filter((s) => s.status === "running" || s.status === "snapshotted").map((s) => s.id));
      if (!r.data?.length || page >= (r.meta?.totalPages ?? page)) break;
    }
    return ids;
  },
});
