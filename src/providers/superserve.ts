// Superserve (superserve.ai): Firecracker microVMs that pause and resume with memory intact.
// Free: a new account gets a limited trial for its first sandbox, no card; the amount isn't
// published. Compute is $0.0504 per vCPU-hour and $0.0162 per GiB-hour (live from
// GET /billing/pricing/public); storage $0.000108 per GiB-hour while kept, paused or not.
// REST: https://api.superserve.ai (X-API-Key ss_live_…; `ss_live_usw_` keys use api-usw), OpenAPI
// https://api.superserve.ai/openapi.yaml, docs https://docs.superserve.ai/llms.txt. Commands and
// files go to the data plane (https://sandbox.superserve.ai with X-Superserve-Sandbox-Id) with the
// sandbox's own X-Access-Token, returned by create, resume and activate. npm `@superserve/sdk`,
// CLI `superserve`, MCP https://mcp.superserve.ai.
// `timeout_seconds` only pauses a sandbox; `auto_delete_seconds: 0` deletes it as soon as it
// pauses, so the two together end it at the deadline. A pause the router asks for clears that
// first, and from then on the router's own deadline deletes it (enforcesTimeout: false).

import { defineProvider, http, httpJson, HttpError } from "./util.js";
import { pollMs, sbrName, sleep } from "./rest-helpers.js";
import { SandboxRouterError } from "../core/errors.js";
import type { ProviderContext } from "../core/types.js";

const REGION_KEY = /^ss_live_([a-z0-9]{1,17})_[A-Za-z0-9_-]{32}$/;
const region = (ctx: ProviderContext) => REGION_KEY.exec(String(ctx.env["SUPERSERVE_API_KEY"] ?? ""))?.[1];
const base = (ctx: ProviderContext) =>
  String(ctx.env["SUPERSERVE_BASE_URL"] ?? (region(ctx) === "usw" ? "https://api-usw.superserve.ai" : "https://api.superserve.ai")).replace(/\/+$/, "");
/** The data plane's shared origin, which routes on the X-Superserve-Sandbox-Id header. */
const dataPlane = (ctx: ProviderContext) =>
  String(ctx.env["SUPERSERVE_SANDBOX_URL"] ?? (region(ctx) === "usw" ? "https://usw-sandbox.superserve.ai" : "https://sandbox.superserve.ai")).replace(/\/+$/, "");
const auth = (ctx: ProviderContext) => ({ "x-api-key": String(ctx.env["SUPERSERVE_API_KEY"]) });
const box = (ctx: ProviderContext, id: string, path = "") => `${base(ctx)}/sandboxes/${encodeURIComponent(id)}${path}`;

interface Sandbox {
  id: string;
  status?: "starting" | "active" | "pausing" | "paused" | "resuming" | "migrating" | "failed" | "deleted";
  vcpu_count?: number;
  memory_mib?: number;
  created_at?: string;
  /** Data-plane origin for this sandbox, when it differs from the default. */
  endpoint?: string;
  access_token?: string;
}
const GONE = new Set(["failed", "deleted"]);

/** Per-sandbox data-plane access. Kept in memory; `activate` mints it again after a restart. */
const access = new Map<string, { token: string; origin: string }>();
const remember = (ctx: ProviderContext, s: Sandbox) => {
  if (s.access_token) access.set(s.id, { token: s.access_token, origin: (s.endpoint ?? dataPlane(ctx)).replace(/\/+$/, "") });
};

async function grant(ctx: ProviderContext, id: string, fresh = false) {
  const held = access.get(id);
  if (held && !fresh) return held;
  // Idempotent: returns a new token, resuming the sandbox first if it was paused.
  const s = await httpJson<Sandbox>(box(ctx, id, "/activate"), { method: "POST", headers: auth(ctx) });
  remember(ctx, { ...s, id });
  const got = access.get(id);
  if (!got) throw new Error(`superserve returned no access token for ${id}`);
  return got;
}

/** A data-plane call; a refused token is minted again once (it rotates on every resume). */
async function onBox(ctx: ProviderContext, id: string, call: (a: { token: string; origin: string }, headers: Record<string, string>) => Promise<Response>) {
  const headers = (a: { token: string }) => ({ "x-access-token": a.token, "x-superserve-sandbox-id": id });
  const first = await grant(ctx, id);
  try {
    return await call(first, headers(first));
  } catch (err) {
    if (!(err instanceof HttpError) || (err.status !== 401 && err.status !== 503)) throw err;
    const again = await grant(ctx, id, true);
    return call(again, headers(again));
  }
}

export const superserveProvider = defineProvider({
  info: {
    id: "superserve",
    name: "Superserve",
    homepage: "https://www.superserve.ai",
    env: ["SUPERSERVE_API_KEY"],
    capabilities: ["ports", "pause", "fileList", "extendTimeout"],
    isolation: "microvm",
    enforcesTimeout: false,
    maxTimeoutSec: 604_800,
    freeTier: {
      // The trial's size isn't published, so nothing is counted as free; override it once known.
      tier: { kind: "none" },
      concurrency: 1,
      requiresCard: false,
      notes: "A limited free trial for a new account's first sandbox, no card; its amount isn't published. Then the $20/mo Developer plan or prepaid credit from $5.",
      source: "https://www.superserve.ai/pricing/",
      checked: "2026-11-21",
    },
    pricing: { vcpuSecondUsd: 0.000014, gibSecondUsd: 0.0000045, defaultCpu: 2, defaultMemoryMiB: 4096, source: "https://api.superserve.ai/billing/pricing/public" },
    surfaces: { rest: "https://api.superserve.ai", sdk: ["@superserve/sdk (npm)", "superserve (PyPI)"], cli: "superserve", mcp: "https://mcp.superserve.ai" },
  },

  async create(spec, ctx) {
    // Size comes from the template (superserve/base is 2 vCPU / 4 GiB); only templates built
    // for CPU or memory selection accept vcpu/memory_mib, so none are sent.
    let s = await httpJson<Sandbox>(`${base(ctx)}/sandboxes`, {
      headers: auth(ctx),
      body: {
        name: sbrName(spec),
        from_template: spec.nativeTemplate ?? (ctx.options["template"] as string | undefined),
        timeout_seconds: Math.min(604_800, Math.max(1, Math.ceil(spec.timeoutSec))),
        auto_delete_seconds: 0,
        metadata: spec.metadata,
        env_vars: spec.env,
      },
    });
    const id = s.id;
    remember(ctx, s);
    try {
      // Create answers once the sandbox is ready; a transient state is waited out anyway.
      for (let i = 0; i < 300 && s.status !== undefined && s.status !== "active"; i++) {
        if (GONE.has(s.status)) throw new Error(`superserve sandbox ${id} is ${s.status}`);
        await sleep(pollMs(ctx, 1000));
        s = await httpJson<Sandbox>(box(ctx, id), { headers: auth(ctx) });
      }
      if (s.status !== undefined && s.status !== "active") throw new Error(`superserve sandbox ${id} did not become active`);
    } catch (err) {
      await this.kill(id, ctx).catch(() => undefined);
      throw err;
    }
    return { providerSandboxId: id, cpu: s.vcpu_count, memoryMiB: s.memory_mib };
  },

  async exec(id, command, o, ctx) {
    // The server's default is 30 s, so a timeout is always sent.
    const timeout_s = Math.max(1, Math.ceil(o.timeoutSec ?? 3600));
    const res = await onBox(ctx, id, (a, headers) =>
      http(`${a.origin}/exec`, {
        method: "POST",
        headers,
        body: { command, env: o.env, working_dir: o.cwd, timeout_s },
        timeoutMs: (timeout_s + 30) * 1000,
      }),
    );
    const r = (await res.json()) as { stdout: string; stderr: string; exit_code: number };
    if (r.stdout) o.onStdout?.(r.stdout);
    if (r.stderr) o.onStderr?.(r.stderr);
    return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", exitCode: r.exit_code };
  },

  async readFile(id, path, ctx) {
    const res = await onBox(ctx, id, (a, headers) => http(`${a.origin}/files?path=${encodeURIComponent(path)}`, { headers }));
    return new Uint8Array(await res.arrayBuffer());
  },

  async writeFile(id, path, data, ctx) {
    // Parent directories are created; an existing file is replaced.
    await onBox(ctx, id, (a, headers) =>
      http(`${a.origin}/files?path=${encodeURIComponent(path)}`, { method: "POST", headers: { ...headers, "content-type": "application/octet-stream" }, raw: data }),
    );
  },

  async listFiles(id, path, ctx) {
    // Served by the control plane with the team key; resumes a paused sandbox.
    const r = await httpJson<{ entries: { name: string; is_dir: boolean; size?: number }[] }>(`${box(ctx, id, "/files")}?path=${encodeURIComponent(path)}`, { headers: auth(ctx) });
    const dir = path.endsWith("/") ? path : `${path}/`;
    return r.entries.map((e) => ({ name: e.name, path: `${dir}${e.name}`, isDir: e.is_dir, size: e.size }));
  },

  async getUrl(id, port, ctx) {
    // New sandboxes route only published ports, at https://{port}-{id}.<sandbox host>.
    if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 49983) {
      throw new SandboxRouterError("invalid", `superserve publishes ports 1024-65535 except 49983, not ${port}`, "superserve");
    }
    await http(box(ctx, id, "/preview-ports"), { headers: auth(ctx), body: { port, access: "public" } });
    const host = new URL((access.get(id)?.origin ?? dataPlane(ctx))).host;
    return `https://${port}-${id}.${host}`;
  },

  async setTimeout(id, timeoutSec, ctx) {
    // `timeout_seconds` counts from the start of the current active session. Counting from
    // creation instead can only end it later, never sooner; the router's deadline still holds.
    const cur = await httpJson<Sandbox>(box(ctx, id), { headers: auth(ctx) });
    const created = cur.created_at ? Date.parse(cur.created_at) : NaN;
    const ran = Number.isFinite(created) ? Math.max(0, (Date.now() - created) / 1000) : 0;
    await http(box(ctx, id), { method: "PATCH", headers: auth(ctx), body: { timeout_seconds: Math.min(604_800, Math.ceil(ran + timeoutSec)) } });
  },

  async pause(id, ctx) {
    // Without this, auto_delete_seconds: 0 would delete it the moment it pauses.
    await http(box(ctx, id), { method: "PATCH", headers: auth(ctx), body: { auto_delete_seconds: null } });
    await http(box(ctx, id, "/pause"), { method: "POST", headers: auth(ctx) });
  },

  async resume(id, ctx) {
    const r = await httpJson<Sandbox>(box(ctx, id, "/resume"), { method: "POST", headers: auth(ctx) });
    remember(ctx, { ...r, id });
  },

  async kill(id, ctx) {
    access.delete(id);
    try {
      await http(box(ctx, id), { method: "DELETE", headers: auth(ctx) });
    } catch (err) {
      if (!(err instanceof HttpError && (err.status === 404 || err.status === 410))) throw err;
    }
  },

  async listAlive(ctx) {
    const r = await httpJson<Sandbox[] | { sandboxes?: Sandbox[] }>(`${base(ctx)}/sandboxes?status=starting,active,pausing,paused,resuming,migrating`, {
      headers: auth(ctx),
    });
    const rows = Array.isArray(r) ? r : r.sandboxes;
    if (!Array.isArray(rows)) throw new Error("superserve: unexpected response shape listing sandboxes");
    return rows.filter((s) => !GONE.has(s.status ?? "")).map((s) => s.id);
  },
});
