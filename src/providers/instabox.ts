// InstaBox (YC P26, by the InsForge founders): Firecracker Linux VMs. Free plan: one
// 4 vCPU / 8 GiB machine, never billed, pauses after 30 idle min, 480 min max run. Free
// accounts carry an "early allowance" that can end (`earlyAllowanceEnded` on a machine).
// REST: https://api.instabox.sh (X-API-Key ibk_…), OpenAPI at /v1/openapi.json. Mutations
// return an Operation to poll. npm `@insforge/instabox-sdk`; MCP https://instabox.sh/mcp.

import { randomUUID } from "node:crypto";
import { defineProvider, http, httpJson } from "./util.js";
import { pollMs, sleep } from "./rest-helpers.js";
import type { ProviderContext } from "../core/types.js";

const base = (ctx: ProviderContext) => String(ctx.env["INSTABOX_API_URL"] ?? "https://api.instabox.sh").replace(/\/+$/, "");
const auth = (ctx: ProviderContext) => ({ "x-api-key": String(ctx.env["INSTABOX_API_KEY"]) });
const m = (ctx: ProviderContext, id: string, path = "") => `${base(ctx)}/v1/machines/${encodeURIComponent(id)}${path}`;

interface Operation {
  id: string;
  state: "queued" | "running" | "succeeded" | "failed";
  machineId?: string;
  error?: unknown;
}

/** Waits for an Operation to finish; mutations are asynchronous. */
async function settle(op: Operation, ctx: ProviderContext): Promise<Operation> {
  for (let i = 0; i < 300 && op.state !== "succeeded" && op.state !== "failed"; i++) {
    await sleep(pollMs(ctx, 1000));
    op = await httpJson<Operation>(`${base(ctx)}/v1/operations/${encodeURIComponent(op.id)}`, { headers: auth(ctx) });
  }
  if (op.state === "failed") throw new Error(`instabox operation ${op.id} failed: ${JSON.stringify(op.error ?? "")}`);
  if (op.state !== "succeeded") throw new Error(`instabox operation ${op.id} did not finish`);
  return op;
}

export const instaboxProvider = defineProvider({
  info: {
    id: "instabox",
    name: "InstaBox",
    homepage: "https://instabox.sh",
    env: ["INSTABOX_API_KEY"],
    capabilities: ["ports", "pause", "fileList", "snapshot"],
    maxTimeoutSec: 86400,
    freeTier: {
      // One machine that is never billed: free hours are effectively the whole month.
      tier: { kind: "monthly-hours", hours: 744 },
      concurrency: 1,
      maxLifetimeSec: 480 * 60,
      notes: "Free plan: one 4 vCPU / 8 GiB machine, never billed, 480 min max run; the early allowance can end.",
      source: "https://instabox.sh/llms.txt",
      checked: "2026-11-11",
    },
    pricing: { vcpuSecondUsd: 0.004 / 3600, gibSecondUsd: 0.00225 / 3600, defaultCpu: 4, defaultMemoryMiB: 8192, source: "https://instabox.sh/llms.txt" },
    surfaces: { rest: "https://api.instabox.sh/v1", sdk: ["@insforge/instabox-sdk (npm)", "instabox-sdk (PyPI)"], cli: "instabox", mcp: "https://instabox.sh/mcp" },
  },

  async create(spec, ctx) {
    const op = await httpJson<Operation>(`${base(ctx)}/v1/machines`, {
      headers: { ...auth(ctx), "idempotency-key": spec.metadata["sandboxrouting.id"] ?? randomUUID() },
      body: {
        templateId: spec.nativeTemplate ?? (ctx.options["template"] as string | undefined),
        vcpus: Math.max(1, Math.round(spec.cpu)),
        memMiB: spec.memoryMiB,
        env: spec.env,
        metadata: spec.metadata,
        deleteAfterSeconds: Math.min(86400, Math.max(60, spec.timeoutSec)),
        maxRunMinutes: Math.max(1, Math.ceil(spec.timeoutSec / 60)),
      },
    });
    const done = await settle(op, ctx);
    if (!done.machineId) throw new Error("instabox operation finished without a machineId");
    return { providerSandboxId: done.machineId };
  },

  async exec(id, command, o, ctx) {
    const timeoutSeconds = Math.min(o.timeoutSec ?? 600, 600);
    const r = await httpJson<{ stdout: string; stderr: string; exitCode: number }>(m(ctx, id, "/exec"), {
      headers: auth(ctx),
      body: { cmd: command, cwd: o.cwd, envs: o.env, timeoutSeconds },
      timeoutMs: (timeoutSeconds + 30) * 1000,
    });
    if (r.stdout) o.onStdout?.(r.stdout);
    if (r.stderr) o.onStderr?.(r.stderr);
    return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode };
  },

  async readFile(id, path, ctx) {
    const res = await http(`${m(ctx, id, "/files/content")}?path=${encodeURIComponent(path)}`, { headers: auth(ctx) });
    return new Uint8Array(await res.arrayBuffer());
  },

  async writeFile(id, path, data, ctx) {
    await http(`${m(ctx, id, "/files")}?path=${encodeURIComponent(path)}&parents=true`, {
      method: "PUT",
      headers: { ...auth(ctx), "content-type": "application/octet-stream" },
      raw: data,
    });
  },

  async listFiles(id, path, ctx) {
    const r = await httpJson<{ entries?: { name: string; type: string; size: number }[] }>(`${m(ctx, id, "/files")}?path=${encodeURIComponent(path)}`, {
      headers: auth(ctx),
    });
    const dir = path.endsWith("/") ? path : `${path}/`;
    return (r.entries ?? []).map((e) => ({ name: e.name, path: `${dir}${e.name}`, isDir: e.type === "dir", size: e.size }));
  },

  async getUrl(id, port, ctx) {
    return (await httpJson<{ url: string }>(m(ctx, id, "/ports"), { headers: auth(ctx), body: { port, access: "public" } })).url;
  },

  async pause(id, ctx) {
    await settle(await httpJson<Operation>(m(ctx, id, "/suspend"), { method: "POST", headers: { ...auth(ctx), "idempotency-key": randomUUID() } }), ctx);
  },

  async resume(id, ctx) {
    await settle(await httpJson<Operation>(m(ctx, id, "/resume"), { method: "POST", headers: { ...auth(ctx), "idempotency-key": randomUUID() } }), ctx);
  },

  async kill(id, ctx) {
    // Deleting needs both an idempotency key and the id repeated as confirmation.
    const op = await httpJson<Operation>(m(ctx, id), {
      method: "DELETE",
      headers: { ...auth(ctx), "idempotency-key": randomUUID(), "x-confirm-delete": id },
    });
    await settle(op, ctx);
  },

  async listAlive(ctx) {
    const r = await httpJson<{ machines: { id: string; state?: string; desiredState?: string }[] }>(`${base(ctx)}/v1/machines`, { headers: auth(ctx) });
    return r.machines.filter((x) => !["deleting", "deleted", "error"].includes(x.state ?? x.desiredState ?? "")).map((x) => x.id);
  },
});
