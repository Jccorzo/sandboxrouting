// CreateOS Sandbox (NodeOps): Firecracker microVMs. Free: 500 credits (~$5) on signup,
// 1 concurrent sandbox, 10 per rolling 24 h, up to 1 vCPU / 1 GB.
// REST: https://api.sb.createos.sh/v1 (X-Api-Key), JSend envelopes. npm `@nodeops-createos/sandbox`.
// No TTL, so the router deletes sandboxes at the deadline (enforcesTimeout: false).

import { defineProvider, http, httpJson } from "./util.js";
import { inline, pollMs, sleep } from "./rest-helpers.js";
import type { ProviderContext } from "../core/types.js";

const base = (ctx: ProviderContext) => String(ctx.env["CREATEOS_SANDBOX_BASE_URL"] ?? "https://api.sb.createos.sh/v1").replace(/\/+$/, "");
const auth = (ctx: ProviderContext) => ({ "x-api-key": String(ctx.env["CREATEOS_SANDBOX_API_KEY"]) });
const sb = (ctx: ProviderContext, id: string, path = "") => `${base(ctx)}/sandboxes/${encodeURIComponent(id)}${path}`;

/** JSend: `{status: "success", data}`; anything else is an error. */
async function jsend<T>(url: string, opts: Parameters<typeof httpJson>[1]): Promise<T> {
  const r = await httpJson<{ status?: string; data?: T; message?: string }>(url, opts);
  if (r?.status && r.status !== "success") throw new Error(`createos: ${r.message ?? JSON.stringify(r.data ?? r)}`);
  return (r?.data ?? r) as T;
}

/** CreateOS sells fixed shapes; pick the smallest that fits. */
export function createosShape(cpu: number, memoryMiB: number): { shape: string; cpu: number; memoryMiB: number } {
  const shapes = [
    { shape: "s-1vcpu-1gb", cpu: 1, memoryMiB: 1024 },
    { shape: "s-1vcpu-2gb", cpu: 1, memoryMiB: 2048 },
    { shape: "s-2vcpu-4gb", cpu: 2, memoryMiB: 4096 },
    { shape: "s-4vcpu-8gb", cpu: 4, memoryMiB: 8192 },
  ];
  return shapes.find((s) => s.cpu >= cpu && s.memoryMiB >= memoryMiB) ?? shapes[shapes.length - 1]!;
}

interface Sbx {
  id: string;
  status: string;
}

export const createosProvider = defineProvider({
  info: {
    id: "createos",
    name: "CreateOS Sandbox",
    homepage: "https://createos.sh",
    env: ["CREATEOS_SANDBOX_API_KEY"],
    capabilities: ["pause"],
    isolation: "microvm",
    enforcesTimeout: false,
    freeTier: {
      tier: { kind: "one-time-credit", usd: 5 },
      concurrency: 1,
      notes: "500 free credits (~$5) on signup; free plan: 1 concurrent, 10 per day, up to 1 vCPU / 1 GB.",
      source: "https://createos.sh/docs/Sandbox/Limits/",
      checked: "2026-11-11",
    },
    pricing: { vcpuSecondUsd: 0.0000100455, gibSecondUsd: 0.01159 / 3600, defaultCpu: 1, defaultMemoryMiB: 1024, source: "https://createos.sh/pricing/sandbox" },
    surfaces: { rest: "https://api.sb.createos.sh/v1", sdk: ["@nodeops-createos/sandbox (npm)"], cli: "createos sb" },
  },

  async create(spec, ctx) {
    const size = createosShape(spec.cpu, spec.memoryMiB);
    const created = await jsend<Sbx>(`${base(ctx)}/sandboxes`, {
      headers: auth(ctx),
      body: {
        shape: size.shape,
        rootfs: spec.nativeTemplate ?? spec.image ?? String(ctx.options["rootfs"] ?? "ubuntu:26.04"),
        envs: spec.env,
      },
    });
    for (let i = 0; i < 300; i++) {
      const cur = await jsend<Sbx>(sb(ctx, created.id), { headers: auth(ctx) });
      if (cur.status === "running") return { providerSandboxId: created.id, cpu: size.cpu, memoryMiB: size.memoryMiB };
      if (/fail|error|destroy/i.test(cur.status)) throw new Error(`createos sandbox ${created.id} is ${cur.status}`);
      await sleep(pollMs(ctx, 1000));
    }
    throw new Error(`createos sandbox ${created.id} did not reach running`);
  },

  async exec(id, command, o, ctx) {
    // Exec env keys must be declared at create time, so cwd and env are inlined instead.
    const r = await jsend<{ result: { stdout: string; stderr: string; exit_code: number } }>(sb(ctx, id, "/exec"), {
      headers: auth(ctx),
      body: { cmd: "sh", args: ["-c", inline(command, o)] },
      timeoutMs: ((o.timeoutSec ?? 3600) + 30) * 1000,
    });
    const { stdout, stderr, exit_code } = r.result;
    if (stdout) o.onStdout?.(stdout);
    if (stderr) o.onStderr?.(stderr);
    return { stdout, stderr, exitCode: exit_code };
  },

  async readFile(id, path, ctx) {
    const res = await http(`${sb(ctx, id, "/files")}?path=${encodeURIComponent(path)}`, { headers: auth(ctx) });
    return new Uint8Array(await res.arrayBuffer());
  },

  async writeFile(id, path, data, ctx) {
    await http(`${sb(ctx, id, "/files")}?path=${encodeURIComponent(path)}`, {
      method: "PUT",
      headers: { ...auth(ctx), "content-type": "application/octet-stream" },
      raw: data,
    });
  },

  async pause(id, ctx) {
    await http(sb(ctx, id, "/pause"), { method: "POST", headers: auth(ctx) });
  },

  async resume(id, ctx) {
    await http(sb(ctx, id, "/resume"), { method: "POST", headers: auth(ctx) });
  },

  async kill(id, ctx) {
    await http(sb(ctx, id), { method: "DELETE", headers: auth(ctx) });
  },

  async listAlive(ctx) {
    const data = await jsend<Sbx[] | { sandboxes: Sbx[] }>(`${base(ctx)}/sandboxes?limit=500`, { headers: auth(ctx) });
    const list = Array.isArray(data) ? data : data.sandboxes;
    return list.filter((s) => !/destroy|delet|fail/i.test(s.status)).map((s) => s.id);
  },
});
