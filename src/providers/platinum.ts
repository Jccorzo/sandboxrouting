// Platinum (platinum.dev): Cloud Hypervisor microVMs on bare metal, EU by default. Prepaid
// credits only: $0.0324 per vCPU-hour + $0.0108 per GiB-hour, per second while running
// ($0.108/h for 2 vCPU / 4 GiB); a stopped sandbox bills only its disk. A new org's tier caps a
// sandbox at 2 vCPU / 2 GiB until a verified email and $5 paid (then 4 vCPU / 4 GiB), $25 and a
// card for 8 vCPU / 16 GiB. Spent credit or a spend limit answers 402.
// REST: https://api.platinum.dev (Bearer key, the docs call it PT_TOKEN). OpenAPI at
// www.platinum.dev/openapi.json; docs www.platinum.dev/llms.txt, /docs/sandboxes.md,
// /docs/exec.md, /docs/processes.md, /docs/filesystem.md, /docs/networking.md, /docs/billing.md.
// npm `@platinum-dev/sdk`, CLI `pt`, MCP server.
// Sandboxes are persistent: there is no TTL, only idle timers (auto_stop_minutes), so the router
// deletes at the deadline (enforcesTimeout: false). /exec waits about 85 s at most and takes no
// cwd or env, so commands run as managed processes, waited on and read back by offset.

import { defineProvider, http, httpJson, HttpError } from "./util.js";
import { pollMs, sbrName, sleep } from "./rest-helpers.js";
import type { ProviderContext } from "../core/types.js";

const base = (ctx: ProviderContext) => String(ctx.env["PT_API_URL"] ?? "https://api.platinum.dev").replace(/\/+$/, "");
const auth = (ctx: ProviderContext) => ({ authorization: `Bearer ${ctx.env["PT_TOKEN"]}` });
const box = (ctx: ProviderContext, id: string, path = "") => `${base(ctx)}/v1/sandboxes/${encodeURIComponent(id)}${path}`;
const gone = (err: unknown) => err instanceof HttpError && (err.status === 404 || err.status === 410);

interface Sandbox {
  id: string;
  state: string;
  errorMessage?: string | null;
}
interface Logs {
  stdout: string;
  stderr: string;
  stdout_offset: number;
  stderr_offset: number;
  running: boolean;
  drained?: boolean;
  exit_code: number;
  timed_out?: boolean;
}
const STARTING = ["pending", "provisioning", "starting", "resuming", "restoring", "unarchiving"];

export const platinumProvider = defineProvider({
  info: {
    id: "platinum",
    name: "Platinum",
    homepage: "https://platinum.dev",
    env: ["PT_TOKEN"],
    capabilities: ["ports", "pause", "customImage", "snapshot", "fileList"],
    isolation: "microvm",
    enforcesTimeout: false,
    freeTier: {
      tier: { kind: "none" },
      requiresCard: false,
      notes: "Prepaid credits, no free credit. A new org may run 2 vCPU / 2 GiB per sandbox (4 vCPU / 8 GiB in all); a verified email and $5 paid raise it to 4 vCPU / 4 GiB, a card and $25 to 8 vCPU / 16 GiB.",
      source: "https://www.platinum.dev/docs/billing",
      checked: "2026-11-21",
    },
    pricing: { vcpuSecondUsd: 0.0324 / 3600, gibSecondUsd: 0.0108 / 3600, defaultCpu: 2, defaultMemoryMiB: 4096, source: "https://www.platinum.dev/docs/billing" },
    surfaces: { rest: "https://api.platinum.dev/v1", sdk: ["@platinum-dev/sdk (npm)", "platinum (PyPI)", "Daytona SDK (compatible)"], cli: "pt", mcp: "docs only" },
  },

  async create(spec, ctx) {
    const cpu = Math.min(16, Math.max(1, Math.ceil(spec.cpu)));
    const ram_mb = Math.min(32_768, Math.max(128, Math.ceil(spec.memoryMiB)));
    const q = new URLSearchParams({ wait_for_state: "running", wait_timeout_ms: "60000" });
    const r = await httpJson<Sandbox>(`${base(ctx)}/v1/sandboxes?${q}`, {
      headers: auth(ctx),
      body: {
        name: sbrName(spec),
        ...(spec.nativeTemplate ? { template: spec.nativeTemplate } : spec.image ? { image: { base_image: spec.image } } : {}),
        cpu,
        ram_mb,
        env: spec.env,
        metadata: spec.metadata,
        ...(spec.region ? { region: spec.region } : {}),
        // A safety net for a sandbox the router loses: stop when idle past its lifetime, delete a
        // day after archiving. No periodic backups for throwaway work.
        auto_stop_minutes: Math.max(1, Math.ceil(spec.timeoutSec / 60)),
        auto_archive_days: 1,
        auto_delete_days: 1,
        backup_interval_min: 0,
      },
      timeoutMs: 120_000,
    });
    try {
      let cur = r;
      for (let i = 0; i < 600 && cur.state !== "running"; i++) {
        if (!STARTING.includes(cur.state)) throw new Error(`platinum sandbox ${r.id} is ${cur.state}${cur.errorMessage ? `: ${cur.errorMessage}` : ""}`);
        await sleep(pollMs(ctx, 1000));
        cur = await httpJson<Sandbox>(box(ctx, r.id), { headers: auth(ctx) });
      }
      if (cur.state !== "running") throw new Error(`platinum sandbox ${r.id} did not start`);
    } catch (err) {
      await http(box(ctx, r.id), { method: "DELETE", headers: auth(ctx) }).catch(() => undefined);
      throw err;
    }
    return { providerSandboxId: r.id, cpu, memoryMiB: ram_mb };
  },

  async exec(id, command, o, ctx) {
    const started = await httpJson<{ handle: string }>(box(ctx, id, "/processes"), {
      headers: auth(ctx),
      body: {
        cmd: command,
        ...(o.cwd ? { cwd: o.cwd } : {}),
        ...(o.env && Object.keys(o.env).length ? { env: o.env } : {}),
        // The guest kills the process group at the deadline and marks it timed_out.
        timeout_ms: o.timeoutSec ? Math.min(86_400_000, Math.ceil(o.timeoutSec * 1000)) : 0,
      },
    });
    const proc = box(ctx, id, `/processes/${encodeURIComponent(started.handle)}`);
    let running = true;
    while (running) {
      const p = await httpJson<{ running: boolean }>(`${proc}?wait_ms=25000`, { headers: auth(ctx), timeoutMs: 60_000 });
      running = p.running;
    }
    // Output is kept in a ring: read it from the start until both streams reach EOF.
    let stdout = "";
    let stderr = "";
    let so = 0;
    let se = 0;
    for (let i = 0; ; i++) {
      const q = new URLSearchParams({ stdout_offset: String(so), stderr_offset: String(se), encoding: "base64" });
      const l = await httpJson<Logs>(`${proc}/logs?${q}`, { headers: auth(ctx) });
      const out = Buffer.from(l.stdout, "base64").toString("utf8");
      const err = Buffer.from(l.stderr, "base64").toString("utf8");
      if (out) {
        stdout += out;
        o.onStdout?.(out);
      }
      if (err) {
        stderr += err;
        o.onStderr?.(err);
      }
      const moved = l.stdout_offset !== so || l.stderr_offset !== se;
      so = l.stdout_offset;
      se = l.stderr_offset;
      if (l.drained !== false && !moved) return { stdout, stderr, exitCode: l.timed_out ? 124 : l.exit_code };
      if (!moved) {
        if (i > 50) return { stdout, stderr, exitCode: l.timed_out ? 124 : l.exit_code };
        await sleep(pollMs(ctx, 200));
      }
    }
  },

  async readFile(id, path, ctx) {
    return new Uint8Array(await (await http(`${box(ctx, id, "/files")}?path=${encodeURIComponent(path)}`, { headers: auth(ctx) })).arrayBuffer());
  },

  async writeFile(id, path, data, ctx) {
    // Makes the parent folders; at most 100 MiB through api.platinum.dev.
    await http(`${box(ctx, id, "/files")}?path=${encodeURIComponent(path)}`, {
      method: "PUT",
      headers: { ...auth(ctx), "content-type": "application/octet-stream" },
      raw: data,
    });
  },

  async listFiles(id, path, ctx) {
    const r = await httpJson<{ entries?: { name: string; size: number; is_dir: boolean }[] }>(`${box(ctx, id, "/files/list")}?path=${encodeURIComponent(path)}`, {
      headers: auth(ctx),
    });
    const dir = path.endsWith("/") ? path : `${path}/`;
    return (r.entries ?? []).map((e) => ({ name: e.name, path: `${dir}${e.name}`, isDir: e.is_dir, size: e.size }));
  },

  async getUrl(id, port, ctx) {
    return (await httpJson<{ url: string }>(box(ctx, id, "/expose"), { headers: auth(ctx), body: { port, public: true } })).url;
  },

  async pause(id, ctx) {
    // Keeps memory and processes where it can; a stopped sandbox bills only its disk.
    await http(`${box(ctx, id, "/pause")}?wait_for_state=stopped`, { method: "POST", headers: auth(ctx), timeoutMs: 120_000 });
  },

  async resume(id, ctx) {
    await http(`${box(ctx, id, "/resume")}?wait_for_state=running`, { method: "POST", headers: auth(ctx), timeoutMs: 120_000 });
  },

  async kill(id, ctx) {
    // Returns at once and tears down in the background.
    await http(box(ctx, id), { method: "DELETE", headers: auth(ctx) }).catch((err) => {
      if (!gone(err)) throw err;
    });
  },

  async listAlive(ctx) {
    const ids: string[] = [];
    for (let offset = 0; ; offset += 200) {
      const page = await httpJson<{ rows: Sandbox[]; has_more?: boolean }>(`${base(ctx)}/v1/sandboxes?limit=200&offset=${offset}`, { headers: auth(ctx) });
      ids.push(...page.rows.filter((s) => s.state !== "deleted").map((s) => s.id));
      if (!page.has_more || page.rows.length === 0) return ids;
    }
  },
});
