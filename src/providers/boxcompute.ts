// BoxCompute: full Linux VMs (KubeVirt) in Malaysia, on a fixed image. Free: $5 once, valid
// 14 days, no card; 2 running. Four fixed sizes, billed by the second while running.
// A VM has no TTL: it stops after 30 idle minutes, wakes on the next call, and stays until
// deleted, so the router deletes it at the deadline (enforcesTimeout: false).
// REST: https://api.boxcompute.ai/api/v2 (Bearer bc_live_…), OpenAPI at /api/v2/openapi.json.
// The npm SDK (@boxcompute/sdk) lags the live API, so this speaks REST. CLI `bxc`; MCP
// https://mcp.boxcompute.ai/mcp. The file API only reaches /workspace.

import { randomUUID } from "node:crypto";
import { SandboxRouterError } from "../core/errors.js";
import { defineProvider, http, httpJson, HttpError } from "./util.js";
import { insideRoots, pollMs, sbrName, sleep } from "./rest-helpers.js";
import type { ProviderContext } from "../core/types.js";

const base = (ctx: ProviderContext) => String(ctx.env["BOXCOMPUTE_API_URL"] ?? "https://api.boxcompute.ai/api/v2").replace(/\/+$/, "");
const auth = (ctx: ProviderContext) => ({ authorization: `Bearer ${ctx.env["BOXCOMPUTE_API_KEY"]}` });
const box = (ctx: ProviderContext, id: string, path = "") => `${base(ctx)}/sandboxes/${encodeURIComponent(id)}${path}`;
const ROOTS = ["/workspace"];
const EXEC_LIMIT_SEC = 900;

const SIZES = [
  { size: "small", cpu: 0.5, memoryMiB: 1024 },
  { size: "large", cpu: 1.5, memoryMiB: 3072 },
  { size: "xl", cpu: 4, memoryMiB: 8192 }, // xl and xxl need the Starter plan
  { size: "xxl", cpu: 8, memoryMiB: 16384 },
];
/** BoxCompute sizes: the smallest that fits the request. */
export function boxcomputeSize(cpu: number, memoryMiB: number) {
  return SIZES.find((s) => s.cpu >= cpu && s.memoryMiB >= memoryMiB) ?? SIZES[SIZES.length - 1]!;
}

interface Sandbox {
  id: string;
  state: "cold" | "pending" | "running" | "expired";
}

/** The workspace to create in: configured, else the account's first, else a new one. */
async function workspace(ctx: ProviderContext): Promise<string> {
  const set = ctx.options["workspaceId"] ?? ctx.env["BOXCOMPUTE_WORKSPACE_ID"];
  if (set) return String(set);
  const { workspaces } = await httpJson<{ workspaces: { id: string }[] }>(`${base(ctx)}/workspaces`, { headers: auth(ctx) });
  if (workspaces[0]) return workspaces[0].id;
  // The fixed key makes two racing first creates end up with the same workspace.
  const made = await httpJson<{ workspace: { id: string } }>(`${base(ctx)}/workspaces`, {
    headers: { ...auth(ctx), "idempotency-key": "sandboxrouting-workspace" },
    body: { name: "sandboxrouting" },
  });
  return made.workspace.id;
}

export const boxcomputeProvider = defineProvider({
  info: {
    id: "boxcompute",
    name: "BoxCompute",
    homepage: "https://boxcompute.ai",
    env: ["BOXCOMPUTE_API_KEY"],
    capabilities: ["ports", "pause", "fileList"],
    isolation: "vm",
    enforcesTimeout: false,
    maxExecSec: EXEC_LIMIT_SEC,
    freeTier: {
      tier: { kind: "one-time-credit", usd: 5 },
      concurrency: 2,
      requiresCard: false,
      notes: "$5 once for new customers, valid 14 days, no card; 2 running VMs, small and large sizes only.",
      source: "https://boxcompute.ai/pricing/",
      checked: "2026-11-12",
    },
    // Flat per size ($0.05/h for 0.5 vCPU / 1 GiB up to $0.80/h for 8 / 16): $0.10 per vCPU-hour.
    pricing: { vcpuSecondUsd: 0.1 / 3600, gibSecondUsd: 0, defaultCpu: 0.5, defaultMemoryMiB: 1024, source: "https://boxcompute.ai/pricing/" },
    surfaces: { rest: "https://api.boxcompute.ai/api/v2", sdk: ["@boxcompute/sdk (npm)", "boxcompute (PyPI)"], cli: "bxc", mcp: "https://mcp.boxcompute.ai/mcp" },
  },

  async create(spec, ctx) {
    const size = boxcomputeSize(spec.cpu, spec.memoryMiB);
    // Metadata is capped at 16 pairs.
    const metadata = Object.fromEntries(Object.entries(spec.metadata).slice(0, 16));
    let { sandbox } = await httpJson<{ sandbox: Sandbox }>(`${base(ctx)}/sandboxes`, {
      headers: { ...auth(ctx), "idempotency-key": spec.metadata["sandboxrouting.id"] ?? randomUUID() },
      body: { workspaceId: await workspace(ctx), name: sbrName(spec), size: size.size, metadata },
    });
    try {
      for (let i = 0; i < 300 && sandbox.state !== "running"; i++) {
        if (sandbox.state === "expired") throw new Error(`boxcompute sandbox ${sandbox.id} expired before it started`);
        await sleep(pollMs(ctx, 1000));
        ({ sandbox } = await httpJson<{ sandbox: Sandbox }>(box(ctx, sandbox.id), { headers: auth(ctx) }));
      }
      if (sandbox.state !== "running") throw new Error(`boxcompute sandbox ${sandbox.id} did not start`);
    } catch (err) {
      await http(box(ctx, sandbox.id), { method: "DELETE", headers: auth(ctx) }).catch(() => undefined);
      throw err;
    }
    return { providerSandboxId: sandbox.id, cpu: size.cpu, memoryMiB: size.memoryMiB };
  },

  async exec(id, command, o, ctx) {
    const timeoutSeconds = Math.min(EXEC_LIMIT_SEC, Math.max(1, Math.ceil(o.timeoutSec ?? 120)));
    // `cwd` must be under /workspace, so any other directory is entered by the shell instead.
    const native = o.cwd !== undefined && (o.cwd === "/workspace" || o.cwd.startsWith("/workspace/"));
    const line = o.cwd && !native ? `cd '${o.cwd.replace(/'/g, `'\\''`)}' && ${command}` : command;
    try {
      const { result: r } = await httpJson<{ result: { stdout: string; stderr: string; exitCode: number } }>(box(ctx, id, "/execute"), {
        headers: auth(ctx),
        body: { argv: ["sh", "-c", line], cwd: native ? o.cwd : undefined, env: o.env, timeoutSeconds, maxOutputBytes: 1_048_576 },
        timeoutMs: (timeoutSeconds + 30) * 1000,
      });
      if (r.stdout) o.onStdout?.(r.stdout);
      if (r.stderr) o.onStderr?.(r.stderr);
      return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode };
    } catch (err) {
      // 408 is the command's own timeout, which callers see as `timeout`'s exit code.
      if (err instanceof HttpError && err.status === 408) return { stdout: "", stderr: `timed out after ${timeoutSeconds} s\n`, exitCode: 124 };
      throw err;
    }
  },

  async readFile(id, path, ctx) {
    insideRoots("boxcompute", path, ROOTS);
    const parts: Buffer[] = [];
    for (let offset = "0"; ; ) {
      const res = await http(`${box(ctx, id, "/files/content")}?${new URLSearchParams({ path, offset, maxBytes: "8388608" })}`, { headers: auth(ctx) });
      parts.push(Buffer.from(await res.arrayBuffer()));
      const next = res.headers.get("x-boxcompute-next-offset");
      if (res.headers.get("x-boxcompute-eof") !== "false" || !next || next === offset) break;
      offset = next;
    }
    return new Uint8Array(Buffer.concat(parts));
  },

  async writeFile(id, path, data, ctx) {
    insideRoots("boxcompute", path, ROOTS);
    // One PUT takes 8 MiB; larger files go through the router's chunked fallback.
    if (data.byteLength > 8 * 1024 * 1024) throw new SandboxRouterError("unsupported", "boxcompute takes 8 MiB per upload", "boxcompute");
    await http(`${box(ctx, id, "/files/content")}?path=${encodeURIComponent(path)}`, {
      method: "PUT",
      headers: { ...auth(ctx), "content-type": "application/octet-stream" },
      raw: data,
    });
  },

  async listFiles(id, path, ctx) {
    insideRoots("boxcompute", path, ROOTS);
    const out: { name: string; path: string; isDir: boolean; size?: number }[] = [];
    let cursor: string | undefined;
    do {
      const q = new URLSearchParams({ path, pageSize: "1000", ...(cursor ? { cursor } : {}) });
      const r = await httpJson<{ entries: { name: string; path: string; kind: string; size?: number }[]; nextCursor?: string | null }>(`${box(ctx, id, "/files/list")}?${q}`, { headers: auth(ctx) });
      out.push(...r.entries.map((e) => ({ name: e.name, path: e.path, isDir: e.kind === "dir", size: e.size })));
      cursor = r.nextCursor ?? undefined;
    } while (cursor);
    return out;
  },

  async getUrl(id, port, ctx) {
    // One preview tunnel per VM, and it expires after an hour.
    return (await httpJson<{ preview: { url: string } }>(box(ctx, id, "/previews"), { headers: auth(ctx), body: { port } })).preview.url;
  },

  async pause(id, ctx) {
    await http(box(ctx, id, "/stop"), { headers: auth(ctx), body: {} });
  },

  async resume(id, ctx) {
    await http(box(ctx, id, "/start"), { headers: auth(ctx), body: {} });
  },

  async kill(id, ctx) {
    await http(box(ctx, id), { method: "DELETE", headers: auth(ctx) });
  },

  async listAlive(ctx) {
    // A stopped (cold) VM still exists and still counts against the account.
    const { sandboxes } = await httpJson<{ sandboxes: Sandbox[] }>(`${base(ctx)}/sandboxes`, { headers: auth(ctx) });
    return sandboxes.filter((s) => s.state !== "expired").map((s) => s.id);
  },
});
