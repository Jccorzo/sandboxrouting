// Boat (YC F26, boat.dev, formerly "Box" on ascii.dev): persistent Ubuntu VMs in the EU.
// Free: 7-day trial, card required, 25 compute hours, 2 concurrent, TTL capped at 2 h.
// REST: https://boat.dev/api/v1 (Bearer boat_…). npm `@boatdev/sdk`, CLI `boat`.

import { randomUUID } from "node:crypto";
import { defineProvider, http, httpJson } from "./util.js";
import { inline, pollMs, sleep } from "./rest-helpers.js";
import type { ProviderContext } from "../core/types.js";

const base = (ctx: ProviderContext) => String(ctx.env["BOAT_API_URL"] ?? "https://boat.dev/api/v1").replace(/\/+$/, "");
const auth = (ctx: ProviderContext) => ({ authorization: `Bearer ${ctx.env["BOAT_API_KEY"]}` });
const s = (ctx: ProviderContext, id: string, path = "") => `${base(ctx)}/sandboxes/${encodeURIComponent(id)}${path}`;

/** Boat sizes: vCPU → type. */
export function boatType(cpu: number): { type: string; cpu: number; memoryMiB: number } {
  if (cpu <= 2) return { type: "small", cpu: 2, memoryMiB: 4096 };
  if (cpu <= 4) return { type: "default", cpu: 4, memoryMiB: 8192 };
  if (cpu <= 8) return { type: "large", cpu: 8, memoryMiB: 16384 };
  return { type: "xlarge", cpu: 16, memoryMiB: 32768 };
}

interface Sandbox {
  id: string;
  status?: string;
  state?: string;
}
const stateOf = (x: Sandbox) => x.status ?? x.state ?? "";

export const boatProvider = defineProvider({
  info: {
    id: "boat",
    name: "Boat",
    homepage: "https://boat.dev",
    env: ["BOAT_API_KEY"],
    capabilities: ["ports", "pause", "fileList", "extendTimeout"],
    isolation: "vm",
    freeTier: {
      // 25 trial hours at the small size ($0.018/h).
      tier: { kind: "one-time-credit", usd: 0.45 },
      concurrency: 2,
      maxLifetimeSec: 7200,
      requiresCard: true,
      notes: "7-day trial: 25 compute hours, 2 concurrent, TTL up to 2 h, small/default sizes; card required.",
      source: "https://docs.boat.dev/free-trial.md",
      checked: "2026-11-11",
    },
    pricing: { vcpuSecondUsd: 0.0045 / 3600, gibSecondUsd: 0.00225 / 3600, defaultCpu: 2, defaultMemoryMiB: 4096, source: "https://docs.boat.dev/pricing.md" },
    surfaces: { rest: "https://boat.dev/api/v1", sdk: ["@boatdev/sdk (npm)", "boat-sdk (PyPI)"], cli: "boat", mcp: "docs only" },
  },

  async create(spec, ctx) {
    const size = boatType(spec.cpu);
    const r = await httpJson<{ status?: string; sandbox: Sandbox }>(`${base(ctx)}/sandboxes`, {
      headers: { ...auth(ctx), "idempotency-key": spec.metadata["sandboxrouting.id"] ?? randomUUID() },
      body: {
        type: size.type,
        ttlSeconds: spec.timeoutSec,
        env: spec.env,
        labels: spec.metadata,
        environment: spec.nativeTemplate,
      },
    });
    const id = r.sandbox.id;
    let state = r.status ?? stateOf(r.sandbox);
    for (let i = 0; i < 300 && state !== "ready"; i++) {
      if (/fail|error/i.test(state)) throw new Error(`boat sandbox ${id} is ${state}`);
      await sleep(pollMs(ctx, 1000));
      const cur = await httpJson<Sandbox | { sandbox: Sandbox }>(s(ctx, id), { headers: auth(ctx) });
      state = stateOf("sandbox" in cur ? cur.sandbox : cur);
    }
    if (state !== "ready") throw new Error(`boat sandbox ${id} did not become ready`);
    return { providerSandboxId: id, cpu: size.cpu, memoryMiB: size.memoryMiB };
  },

  async exec(id, command, o, ctx) {
    // Commands take no env field; exports are inlined. Timeout is 1–600 s.
    const timeoutSeconds = Math.min(600, Math.max(1, o.timeoutSec ?? 600));
    const r = await httpJson<{ exitCode: number; stdout: string; stderr: string }>(s(ctx, id, "/commands"), {
      headers: auth(ctx),
      body: { command: inline(command, { env: o.env }), cwd: o.cwd, timeoutSeconds },
      timeoutMs: (timeoutSeconds + 30) * 1000,
    });
    if (r.stdout) o.onStdout?.(r.stdout);
    if (r.stderr) o.onStderr?.(r.stderr);
    return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode };
  },

  async readFile(id, path, ctx) {
    // Paths must be under /home/user or /tmp; 5 MiB inline limit.
    const r = await httpJson<{ content: string; encoding?: string }>(`${s(ctx, id, "/files")}?path=${encodeURIComponent(path)}`, {
      headers: auth(ctx),
    });
    return r.encoding === "base64" ? new Uint8Array(Buffer.from(r.content, "base64")) : new TextEncoder().encode(r.content);
  },

  async writeFile(id, path, data, ctx) {
    await http(s(ctx, id, "/files"), {
      method: "PUT",
      headers: auth(ctx),
      body: { path, content: Buffer.from(data).toString("base64"), encoding: "base64" },
    });
  },

  async listFiles(id, path, ctx) {
    const r = await httpJson<{ entries?: { name: string; type?: string; isDir?: boolean; size?: number }[] } | { name: string; type?: string; isDir?: boolean; size?: number }[]>(
      `${s(ctx, id, "/files/list")}?path=${encodeURIComponent(path)}`,
      { headers: auth(ctx) },
    );
    const entries = Array.isArray(r) ? r : r.entries ?? [];
    const dir = path.endsWith("/") ? path : `${path}/`;
    return entries.map((e) => ({ name: e.name, path: `${dir}${e.name}`, isDir: e.isDir ?? /dir/i.test(e.type ?? ""), size: e.size }));
  },

  async getUrl(id, port, ctx) {
    return (await httpJson<{ url: string }>(s(ctx, id, "/host"), { headers: auth(ctx), body: { port, public: true } })).url;
  },

  async setTimeout(id, timeoutSec, ctx) {
    await http(s(ctx, id), { method: "PATCH", headers: auth(ctx), body: { ttlSeconds: timeoutSec } });
  },

  async pause(id, ctx) {
    await http(s(ctx, id, "/stop"), { method: "POST", headers: auth(ctx) });
  },

  async resume(id, ctx) {
    await http(s(ctx, id, "/resume"), { method: "POST", headers: auth(ctx) });
  },

  async kill(id, ctx) {
    await http(s(ctx, id), { method: "DELETE", headers: { ...auth(ctx), "x-ascii-confirm-delete": id } });
  },

  async listAlive(ctx) {
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await httpJson<{ sandboxes?: Sandbox[]; data?: Sandbox[]; nextCursor?: string }>(
        `${base(ctx)}/sandboxes${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
        { headers: auth(ctx) },
      );
      for (const x of page.sandboxes ?? page.data ?? []) if (!/delet|fail/i.test(stateOf(x))) ids.push(x.id);
      cursor = page.nextCursor;
    } while (cursor);
    return ids;
  },
});
