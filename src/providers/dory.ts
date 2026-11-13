// Dory (dory.run): persistent Linux computers, one full VM each, on shared vCPUs. No free
// tier or trial: prepaid credit. Flat per size, $0.0288/h for 2 vCPU / 4 GB, running time only.
// Its timer pauses or stops the computer and never deletes it (storage keeps billing), so
// the router deletes it at the deadline (enforcesTimeout: false).
// REST: https://api.dory.run/v1 (Bearer cek_live_…) for the lifecycle, OpenAPI at
// dory.run/api/openapi.yaml. Commands and files go to a data API with a short-lived
// per-computer token minted by POST /computers/{id}/access. Lifecycle calls are operations;
// `?wait=` holds the response until they finish. Previews are private only at launch.
// npm `dory-run`, CLI `cec`, MCP https://api.dory.run/mcp.

import { randomUUID } from "node:crypto";
import { defineProvider, http, httpJson } from "./util.js";
import { grantCache, pollMs, sbrName, sleep } from "./rest-helpers.js";
import type { ProviderContext } from "../core/types.js";

const base = (ctx: ProviderContext) => String(ctx.env["DORY_API_URL"] ?? "https://api.dory.run/v1").replace(/\/+$/, "");
const auth = (ctx: ProviderContext) => ({ authorization: `Bearer ${ctx.env["DORY_API_KEY"]}` });
const box = (ctx: ProviderContext, id: string, path = "") => `${base(ctx)}/computers/${encodeURIComponent(id)}${path}`;
const EXEC_LIMIT_SEC = 600;

/** Dory sizes are `ac-<vCPUs>` with 2 GB per vCPU, from ac-2 to ac-64. */
export function dorySize(cpu: number, memoryMiB: number): { size: string; cpu: number; memoryMiB: number } {
  const n = [2, 4, 8, 16, 32, 64].find((c) => c >= cpu && c * 2048 >= memoryMiB) ?? 64;
  return { size: `ac-${n}`, cpu: n, memoryMiB: n * 2048 };
}

interface Computer {
  id: string;
  state: string;
  ready?: boolean;
  state_reason?: string | null;
}
interface Data {
  url: string;
  headers: { authorization: string };
}
const grants = grantCache<Data>();

/** The data API for one computer, with a token that is re-minted before it expires. */
const data = (ctx: ProviderContext, id: string) =>
  grants.get(`${base(ctx)}|${id}`, async () => {
    const r = await httpJson<{ token: string; data_url: string; expires_at: string }>(box(ctx, id, "/access"), { headers: auth(ctx), body: { scopes: ["exec", "files"], expires_in: 3600 } });
    const expires = Date.parse(r.expires_at);
    return { value: { url: r.data_url.replace(/\/+$/, ""), headers: { authorization: `Bearer ${r.token}` } }, expiresAt: Number.isFinite(expires) ? expires : 0 };
  });

/** Waits until the computer is in `want`: lifecycle calls answer before they are done. */
async function settle(ctx: ProviderContext, id: string, want: "running" | "paused"): Promise<void> {
  for (let i = 0; i < 300; i++) {
    const c = await httpJson<Computer>(box(ctx, id), { headers: auth(ctx) });
    if (c.state === want && (want !== "running" || c.ready !== false)) return;
    if (["error", "deleting", "deleted"].includes(c.state)) throw new Error(`dory computer ${id} is ${c.state}${c.state_reason ? `: ${c.state_reason}` : ""}`);
    await sleep(pollMs(ctx, 1000));
  }
  throw new Error(`dory computer ${id} did not become ${want}`);
}

export const doryProvider = defineProvider({
  info: {
    id: "dory",
    name: "Dory",
    homepage: "https://dory.run",
    env: ["DORY_API_KEY"],
    capabilities: ["pause", "fileList", "extendTimeout", "snapshot"],
    isolation: "vm",
    enforcesTimeout: false,
    maxTimeoutSec: 2_592_000,
    maxExecSec: EXEC_LIMIT_SEC,
    freeTier: {
      tier: { kind: "none" },
      notes: "No trial: prepaid credit ($20–$100 a payment). After the first top-up: 2 running computers, sizes ac-2 and ac-4.",
      source: "https://dory.run/docs/pricing/",
      checked: "2026-11-12",
    },
    // $0.0144 per shared vCPU-hour with its 2 GB included.
    pricing: { vcpuSecondUsd: 0.0144 / 3600, gibSecondUsd: 0, defaultCpu: 2, defaultMemoryMiB: 4096, source: "https://dory.run/docs/pricing/" },
    surfaces: { rest: "https://api.dory.run/v1", sdk: ["dory-run (npm)", "dory-run (PyPI)"], cli: "cec", mcp: "https://api.dory.run/mcp" },
  },

  async create(spec, ctx) {
    const size = dorySize(spec.cpu, spec.memoryMiB);
    const r = await httpJson<{ computer?: Computer; id?: string }>(`${base(ctx)}/computers?wait=${ctx.options["pollMs"] === undefined ? 60 : 0}&wait_for=ready`, {
      headers: { ...auth(ctx), "idempotency-key": spec.metadata["sandboxrouting.id"] ?? randomUUID() },
      body: {
        size: size.size,
        name: sbrName(spec),
        image: spec.nativeTemplate,
        desktop: false,
        // A safety net behind the router's own delete: stop, so a stray computer stops billing compute.
        timeout_seconds: Math.max(1, Math.ceil(spec.timeoutSec)),
        on_timeout: "stop",
        env: spec.env,
        metadata: Object.fromEntries(Object.entries(spec.metadata).slice(0, 16)),
      },
      timeoutMs: 120_000,
    });
    // 202 wraps the computer in an operation; 200 (finished within the wait) is the computer.
    const id = r.computer?.id ?? r.id;
    if (!id) throw new Error("dory create returned no computer");
    try {
      await settle(ctx, id, "running");
    } catch (err) {
      await this.kill(id, ctx).catch(() => undefined);
      throw err;
    }
    return { providerSandboxId: id, cpu: size.cpu, memoryMiB: size.memoryMiB };
  },

  async exec(id, command, o, ctx) {
    const timeout_seconds = Math.min(EXEC_LIMIT_SEC, Math.max(1, Math.ceil(o.timeoutSec ?? 60)));
    const d = await data(ctx, id);
    const r = await httpJson<{ exit_code: number | null; stdout: string; stderr: string; timed_out?: boolean }>(`${d.url}/exec`, {
      headers: d.headers,
      body: { command, cwd: o.cwd, env: o.env, user: ctx.options["user"], timeout_seconds },
      timeoutMs: (timeout_seconds + 30) * 1000,
    });
    if (r.stdout) o.onStdout?.(r.stdout);
    if (r.stderr) o.onStderr?.(r.stderr);
    return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exit_code ?? (r.timed_out ? 124 : 137) };
  },

  async readFile(id, path, ctx) {
    const d = await data(ctx, id);
    return new Uint8Array(await (await http(`${d.url}/files?path=${encodeURIComponent(path)}`, { headers: d.headers })).arrayBuffer());
  },

  async writeFile(id, path, bytes, ctx) {
    const d = await data(ctx, id);
    await http(`${d.url}/files?path=${encodeURIComponent(path)}&mkdirs=true`, { method: "PUT", headers: { ...d.headers, "content-type": "application/octet-stream" }, raw: bytes });
  },

  async listFiles(id, path, ctx) {
    const d = await data(ctx, id);
    const r = await httpJson<{ data: { path: string; name: string; type: string; size?: number }[] }>(`${d.url}/files/list?path=${encodeURIComponent(path)}`, { headers: d.headers });
    return r.data.map((e) => ({ name: e.name, path: e.path, isDir: e.type === "directory", size: e.size }));
  },

  async setTimeout(id, timeoutSec, ctx) {
    // Moves Dory's stop timer, which is only the safety net: the router's deadline is what
    // ends the computer. A minute's margin keeps this clock's skew from stopping it early.
    const timeout_at = new Date(Date.now() + (timeoutSec + 60) * 1000).toISOString();
    await http(box(ctx, id, "/extend"), { headers: auth(ctx), body: { timeout_at } });
  },

  async pause(id, ctx) {
    await http(box(ctx, id, "/pause"), { method: "POST", headers: auth(ctx) });
    await settle(ctx, id, "paused");
  },

  async resume(id, ctx) {
    await http(box(ctx, id, "/resume"), { method: "POST", headers: auth(ctx) });
    await settle(ctx, id, "running");
  },

  async kill(id, ctx) {
    grants.drop(`${base(ctx)}|${id}`);
    await http(box(ctx, id), { method: "DELETE", headers: { ...auth(ctx), "ce-confirm-delete": id } });
  },

  async listAlive(ctx) {
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const q = new URLSearchParams({ limit: "200", ...(cursor ? { cursor } : {}) });
      const page = await httpJson<{ data: Computer[]; next_cursor?: string | null; has_more?: boolean }>(`${base(ctx)}/computers?${q}`, { headers: auth(ctx) });
      for (const c of page.data) if (!["deleting", "deleted", "error"].includes(c.state)) ids.push(c.id);
      cursor = page.has_more ? page.next_cursor ?? undefined : undefined;
    } while (cursor);
    return ids;
  },
});
