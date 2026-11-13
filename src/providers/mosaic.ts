// Mosaic Sandbox (sandbox.mosaicos.com): Firecracker microVMs at a flat $0.05 per active
// hour per unit (a unit is up to 2 vCPU / 4 GiB); hibernated time is free. No free credit
// is documented. Its TTL counts inactivity, so a busy sandbox outlives it and the router
// deletes it at the deadline (enforcesTimeout: false).
// REST: https://sandbox.mosaicos.com/v1 (Bearer msk_live_…), OpenAPI at /openapi.json.
// Unknown JSON fields are rejected. The file API reaches a fixed set of directories.
// npm `@mosaic-sandbox/sdk`, CLI `mos`, MCP at /v1/mcp.

import { defineProvider, http, httpJson } from "./util.js";
import { ENV_FILE, envFileBody, insideRoots, withEnvFile } from "./rest-helpers.js";
import type { ProviderContext } from "../core/types.js";

const base = (ctx: ProviderContext) => String(ctx.env["MOSAIC_API_URL"] ?? "https://sandbox.mosaicos.com").replace(/\/+$/, "");
const auth = (ctx: ProviderContext) => ({ authorization: `Bearer ${ctx.env["MOSAIC_API_TOKEN"]}` });
const box = (ctx: ProviderContext, id: string, path = "") => `${base(ctx)}/v1/sandboxes/${encodeURIComponent(id)}${path}`;
const ROOTS = ["/workspace", "/tmp", "/app", "/opt", "/mnt", "/home", "/shared"];
const EXEC_LIMIT_MS = 900_000;
const READ_CHUNK = 8_388_608;

/** Self-serve shapes pair each vCPU with 2 GiB: 1, 2, 4, 8 or 16 vCPUs. */
export function mosaicShape(cpu: number, memoryMiB: number): { vcpu: number; memory_mb: number } {
  const vcpu = [1, 2, 4, 8, 16].find((c) => c >= cpu && c * 2048 >= memoryMiB) ?? 16;
  return { vcpu, memory_mb: vcpu * 2048 };
}

export const mosaicProvider = defineProvider({
  info: {
    id: "mosaic",
    name: "Mosaic Sandbox",
    homepage: "https://sandbox.mosaicos.com",
    env: ["MOSAIC_API_TOKEN"],
    capabilities: ["ports", "pause", "fileList", "extendTimeout", "snapshot"],
    isolation: "microvm",
    enforcesTimeout: false,
    maxExecSec: EXEC_LIMIT_MS / 1000,
    freeTier: {
      tier: { kind: "none" },
      notes: "No free credit documented; the account may need checkout first. 1,000 sandboxes per organization.",
      source: "https://sandbox.mosaicos.com/pricing/",
      checked: "2026-11-12",
    },
    // $0.05 per hour per unit of 2 vCPU / 4 GiB, RAM included: $0.025 per vCPU-hour.
    pricing: { vcpuSecondUsd: 0.025 / 3600, gibSecondUsd: 0, defaultCpu: 2, defaultMemoryMiB: 4096, source: "https://sandbox.mosaicos.com/pricing/" },
    surfaces: { rest: "https://sandbox.mosaicos.com/v1", sdk: ["@mosaic-sandbox/sdk (npm)", "mosaic-sandbox (PyPI)"], cli: "mos", mcp: "https://sandbox.mosaicos.com/v1/mcp" },
  },

  async create(spec, ctx) {
    const shape = mosaicShape(spec.cpu, spec.memoryMiB);
    const key = spec.metadata["sandboxrouting.id"];
    const r = await httpJson<{ id: string; state: string }>(`${base(ctx)}/v1/sandboxes`, {
      headers: { ...auth(ctx), ...(key ? { "idempotency-key": key } : {}) },
      body: {
        // A template names a runtime (`node-22`, `python-3.14`); an environment built from an
        // OCI image boots as a snapshot.
        ...(ctx.options["snapshot"] ? { snapshot_id: String(ctx.options["snapshot"]) } : { template: spec.nativeTemplate ?? String(ctx.options["template"] ?? "base") }),
        ...shape,
        region: spec.region,
        metadata: spec.metadata,
        // An inactivity deadline, the only one that can be moved later. A hard
        // `max_lifetime_seconds` could not be extended, so the router ends a busy sandbox.
        ttl_seconds: Math.max(1, Math.ceil(spec.timeoutSec)),
      },
      timeoutMs: 180_000,
    });
    // There is no create-time env: it is kept in a file every command loads.
    if (Object.keys(spec.env).length) {
      try {
        await this.writeFile(r.id, ENV_FILE, new TextEncoder().encode(envFileBody(spec.env)), ctx);
      } catch (err) {
        await this.kill(r.id, ctx).catch(() => undefined);
        throw err;
      }
    }
    return { providerSandboxId: r.id, cpu: shape.vcpu, memoryMiB: shape.memory_mb };
  },

  async exec(id, command, o, ctx) {
    const timeout_ms = Math.min(EXEC_LIMIT_MS, Math.max(1000, (o.timeoutSec ?? 300) * 1000));
    const r = await httpJson<{ stdout: string; stderr: string; exit_code: number | null }>(box(ctx, id, "/exec"), {
      headers: auth(ctx),
      body: { cmd: withEnvFile(command), cwd: o.cwd, env: o.env, timeout_ms },
      timeoutMs: timeout_ms + 30_000,
    });
    if (r.stdout) o.onStdout?.(r.stdout);
    if (r.stderr) o.onStderr?.(r.stderr);
    return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", exitCode: r.exit_code ?? -1 };
  },

  async readFile(id, path, ctx) {
    insideRoots("mosaic", path, ROOTS);
    const parts: Buffer[] = [];
    for (let offset = 0; ; ) {
      const q = new URLSearchParams({ path, offset: String(offset), length: String(READ_CHUNK) });
      const r = await httpJson<{ content_base64: string; total_size?: number; eof?: boolean }>(`${box(ctx, id, "/files/content")}?${q}`, { headers: auth(ctx) });
      const part = Buffer.from(r.content_base64 ?? "", "base64");
      parts.push(part);
      offset += part.length;
      if (r.eof !== false || !part.length || (r.total_size !== undefined && offset >= r.total_size)) break;
    }
    return new Uint8Array(Buffer.concat(parts));
  },

  async writeFile(id, path, data, ctx) {
    insideRoots("mosaic", path, ROOTS);
    await http(box(ctx, id, "/files/content"), {
      method: "PUT",
      headers: auth(ctx),
      body: { path, content_base64: Buffer.from(data).toString("base64"), create_parents: true },
    });
  },

  async listFiles(id, path, ctx) {
    insideRoots("mosaic", path, ROOTS);
    const r = await httpJson<{ entries?: { name: string; kind?: string; size?: number }[] }>(`${box(ctx, id, "/files")}?path=${encodeURIComponent(path)}`, { headers: auth(ctx) });
    const dir = path.endsWith("/") ? path : `${path}/`;
    return (r.entries ?? []).map((e) => ({ name: e.name, path: `${dir}${e.name}`, isDir: e.kind === "directory", size: e.size }));
  },

  async getUrl(id, port, ctx) {
    // A preview link lasts a day at most.
    return (await httpJson<{ url: string }>(box(ctx, id, "/previews"), { headers: auth(ctx), body: { port, expires_in_seconds: 86_400, require_auth: false } })).url;
  },

  async setTimeout(id, timeoutSec, ctx) {
    // Counts from this call.
    await http(box(ctx, id, "/timeout"), { headers: auth(ctx), body: { ttl_seconds: Math.max(1, Math.ceil(timeoutSec)) } });
  },

  async pause(id, ctx) {
    await http(box(ctx, id, "/pause"), { headers: auth(ctx), body: {} });
  },

  async resume(id, ctx) {
    await http(box(ctx, id, "/resume"), { method: "POST", headers: auth(ctx) });
  },

  async kill(id, ctx) {
    await http(box(ctx, id), { method: "DELETE", headers: auth(ctx) });
  },

  async listAlive(ctx) {
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const q = new URLSearchParams({ limit: "500", ...(cursor ? { cursor } : {}) });
      const page = await httpJson<{ sandboxes?: { id: string; state: string }[]; next_cursor?: string | null }>(`${base(ctx)}/v1/sandboxes?${q}`, { headers: auth(ctx) });
      for (const s of page.sandboxes ?? []) if (s.state !== "destroyed" && s.state !== "archived") ids.push(s.id);
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    return ids;
  },
});
