// Tensorlake Sandboxes: Firecracker microVMs. Free plan, no card: one sandbox of 1 vCPU /
// 1 GB, sessions up to an hour (two once verified). Paid: $0.07 per active core-hour and
// $0.015 per GB-hour. `timeout_secs` counts idle time, so a busy sandbox outlives it and
// the router deletes it at the deadline (enforcesTimeout: false).
// REST: https://api.tensorlake.ai (Bearer tl_apiKey_…) for the lifecycle; commands and files
// go to the sandbox's own host, https://<id>.sandbox.tensorlake.ai/api/v1, with the same key.
// OpenAPI at docs.tensorlake.ai/api-reference/openapi.yaml. npm `@tensorlakeai/tensorlake`,
// CLI `tl sbx`. Create takes no env, labels or region.

import { defineProvider, http, httpJson } from "./util.js";
import { ENV_FILE, envFileBody, sse, withEnvFile } from "./rest-helpers.js";
import type { ProviderContext } from "../core/types.js";

const base = (ctx: ProviderContext) => String(ctx.env["TENSORLAKE_API_URL"] ?? "https://api.tensorlake.ai").replace(/\/+$/, "");
const auth = (ctx: ProviderContext) => ({ authorization: `Bearer ${ctx.env["TENSORLAKE_API_KEY"]}` });
const box = (ctx: ProviderContext, id: string, path = "") => `${base(ctx)}/sandboxes/${encodeURIComponent(id)}${path}`;
/** The sandbox's own host. `TENSORLAKE_SANDBOX_URL` replaces it, with `{id}` for the sandbox. */
const proxy = (ctx: ProviderContext, id: string, path: string) =>
  `${String(ctx.env["TENSORLAKE_SANDBOX_URL"] ?? "https://{id}.sandbox.tensorlake.ai").replace("{id}", id).replace(/\/+$/, "")}/api/v1${path}`;

interface SandboxInfo {
  id: string;
  status: string;
  exposed_ports?: number[];
}

export const tensorlakeProvider = defineProvider({
  info: {
    id: "tensorlake",
    name: "Tensorlake",
    homepage: "https://www.tensorlake.ai",
    env: ["TENSORLAKE_API_KEY"],
    capabilities: ["ports", "fileList", "snapshot"],
    isolation: "microvm",
    enforcesTimeout: false,
    freeTier: {
      // One small sandbox that is never billed: free hours are effectively the whole month.
      tier: { kind: "monthly-hours", hours: 744 },
      concurrency: 1,
      maxLifetimeSec: 3600,
      requiresCard: false,
      notes: "Free plan: 1 sandbox at a time, at most 1 vCPU / 1 GB / 10 GB disk, 1 h sessions (2 h once verified). Larger sizes need usage credits.",
      source: "https://www.tensorlake.ai/pricing",
      checked: "2026-11-12",
    },
    // "CPU is billed on active execution, with a minimum of 20% of allocated vCPU" (pricing page).
    pricing: {
      vcpuSecondUsd: 0.07 / 3600,
      gibSecondUsd: 0.015 / 3600,
      defaultCpu: 1,
      defaultMemoryMiB: 1024,
      billing: "active-cpu",
      activeCpuFloor: 0.2,
      source: "https://docs.tensorlake.ai/platform/billing.md",
    },
    surfaces: { rest: "https://api.tensorlake.ai", sdk: ["@tensorlakeai/tensorlake (npm)", "tensorlake (PyPI)"], cli: "tl sbx" },
  },

  async create(spec, ctx) {
    const cpus = Math.max(1, spec.cpu);
    // Memory must be 1024–8192 MB per CPU.
    const memory_mb = Math.min(cpus * 8192, Math.max(cpus * 1024, spec.memoryMiB));
    // Unnamed, so it is ephemeral: an idle timeout terminates it instead of suspending it.
    const r = await httpJson<{ sandbox_id: string; status: string }>(`${base(ctx)}/sandboxes`, {
      headers: auth(ctx),
      body: { image: spec.nativeTemplate, resources: { cpus, memory_mb }, timeout_secs: Math.max(1, Math.ceil(spec.timeoutSec)), wait: true },
      timeoutMs: 300_000,
    });
    if (r.status !== "running") {
      await http(box(ctx, r.sandbox_id), { method: "DELETE", headers: auth(ctx) }).catch(() => undefined);
      throw new Error(`tensorlake sandbox ${r.sandbox_id} is ${r.status}`);
    }
    if (Object.keys(spec.env).length) {
      try {
        await this.writeFile(r.sandbox_id, ENV_FILE, new TextEncoder().encode(envFileBody(spec.env)), ctx);
      } catch (err) {
        await http(box(ctx, r.sandbox_id), { method: "DELETE", headers: auth(ctx) }).catch(() => undefined);
        throw err;
      }
    }
    return { providerSandboxId: r.sandbox_id, cpu: cpus, memoryMiB: memory_mb };
  },

  async exec(id, command, o, ctx) {
    const res = await http(proxy(ctx, id, "/processes/run"), {
      headers: { ...auth(ctx), accept: "text/event-stream" },
      body: { command: "sh", args: ["-c", withEnvFile(command)], env: o.env, working_dir: o.cwd, timeout: o.timeoutSec },
      timeoutMs: ((o.timeoutSec ?? 3600) + 30) * 1000,
    });
    let stdout = "";
    let stderr = "";
    for await (const ev of sse(res.body as unknown as AsyncIterable<Uint8Array>)) {
      if (!ev.data) continue;
      const f = JSON.parse(ev.data) as { line?: string; stream?: string; exit_code?: number | null; signal?: number | null };
      if (f.line !== undefined && f.stream === "stderr") {
        stderr += `${f.line}\n`;
        o.onStderr?.(`${f.line}\n`);
      } else if (f.line !== undefined) {
        stdout += `${f.line}\n`;
        o.onStdout?.(`${f.line}\n`);
      } else if ("exit_code" in f) {
        // Killed by a signal (the timeout included): the shell's 128 + signal.
        return { stdout, stderr, exitCode: f.exit_code ?? 128 + (f.signal ?? 9) };
      }
    }
    throw new Error("tensorlake exec: the stream ended without an exit frame");
  },

  async readFile(id, path, ctx) {
    return new Uint8Array(await (await http(`${proxy(ctx, id, "/files")}?path=${encodeURIComponent(path)}`, { headers: auth(ctx) })).arrayBuffer());
  },

  async writeFile(id, path, data, ctx) {
    await http(`${proxy(ctx, id, "/files")}?path=${encodeURIComponent(path)}`, { method: "PUT", headers: { ...auth(ctx), "content-type": "application/octet-stream" }, raw: data });
  },

  async listFiles(id, path, ctx) {
    const r = await httpJson<{ entries: { name: string; is_dir: boolean; size?: number }[] }>(`${proxy(ctx, id, "/files/list")}?path=${encodeURIComponent(path)}`, { headers: auth(ctx) });
    const dir = path.endsWith("/") ? path : `${path}/`;
    return r.entries.map((e) => ({ name: e.name, path: `${dir}${e.name}`, isDir: e.is_dir, size: e.size }));
  },

  async getUrl(id, port, ctx) {
    // The list is replaced, so the ports already open are sent back with the new one.
    const cur = await httpJson<SandboxInfo>(box(ctx, id), { headers: auth(ctx) });
    const exposed_ports = [...new Set([...(cur.exposed_ports ?? []), port])];
    await http(box(ctx, id), { method: "PATCH", headers: auth(ctx), body: { exposed_ports, allow_unauthenticated_access: true } });
    return `https://${port}-${id}.sandbox.tensorlake.ai`;
  },

  async kill(id, ctx) {
    await http(box(ctx, id), { method: "DELETE", headers: auth(ctx) });
  },

  async listAlive(ctx) {
    // Lists only sandboxes that are not terminated.
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const q = new URLSearchParams({ limit: "100", ...(cursor ? { cursor } : {}) });
      const page = await httpJson<{ sandboxes: SandboxInfo[]; next_cursor?: string | null }>(`${base(ctx)}/sandboxes?${q}`, { headers: auth(ctx) });
      ids.push(...page.sandboxes.filter((s) => s.status !== "terminated").map((s) => s.id));
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    return ids;
  },
});
