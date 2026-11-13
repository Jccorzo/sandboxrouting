// Maritime (YC F26, maritime.sh) Sandboxes: Firecracker microVMs. Free: a 7-day trial capped
// at $20 of usage, card required. $0.0055 per vCPU-hour + $0.00275 per GB-hour while running.
// Maritime ends the sandbox and its disk at `timeLimitSeconds` (24 h at most).
// REST: https://api.maritime.sh (Bearer mk_…) for the lifecycle. Commands and files go to
// the sandbox's own `dataPlaneUrl` with its `secret` in X-Maritime-Token; both come with the
// sandbox. The file routes are taken from the official SDK (`maritime-sdk` 0.12.0); the
// docs don't describe them. CLI `maritime`; also E2B-compatible at sb.mtm.sh.

import { defineProvider, http, httpJson } from "./util.js";
import { grantCache, sbrName } from "./rest-helpers.js";
import type { ProviderContext } from "../core/types.js";

const base = (ctx: ProviderContext) => String(ctx.env["MARITIME_API_URL"] ?? "https://api.maritime.sh").replace(/\/+$/, "");
const auth = (ctx: ProviderContext) => ({ authorization: `Bearer ${ctx.env["MARITIME_API_KEY"]}` });
const box = (ctx: ProviderContext, id: string, path = "") => `${base(ctx)}/v1/sandboxes/${encodeURIComponent(id)}${path}`;
const MAX_LIFETIME_SEC = 86_400;
const EXEC_LIMIT_SEC = 3600;

interface Sandbox {
  id: string;
  state: "starting" | "running" | "pausing" | "paused" | "resuming" | "error" | "ended";
  resources?: { vcpu?: number; memoryMib?: number };
  dataPlaneUrl?: string;
  secret?: string;
}
interface Plane {
  url: string;
  headers: { "x-maritime-token": string };
}
const planes = grantCache<Plane>();
const KEEP_MS = 10 * 60_000;

function planeOf(s: Sandbox): { value: Plane; expiresAt: number } {
  if (!s.dataPlaneUrl || !s.secret) throw new Error(`maritime sandbox ${s.id} has no data plane (state ${s.state})`);
  return { value: { url: s.dataPlaneUrl.replace(/\/+$/, ""), headers: { "x-maritime-token": s.secret } }, expiresAt: Date.now() + KEEP_MS };
}
/** Where a sandbox's commands and files are served, looked up again every few minutes. */
const plane = (ctx: ProviderContext, id: string) => planes.get(`${base(ctx)}|${id}`, async () => planeOf(await httpJson<Sandbox>(box(ctx, id), { headers: auth(ctx) })));

export const maritimeProvider = defineProvider({
  info: {
    id: "maritime",
    name: "Maritime",
    homepage: "https://maritime.sh",
    env: ["MARITIME_API_KEY"],
    capabilities: ["customImage", "ports", "fileList", "snapshot"],
    isolation: "microvm",
    maxTimeoutSec: MAX_LIFETIME_SEC,
    maxExecSec: EXEC_LIMIT_SEC,
    freeTier: {
      tier: { kind: "one-time-credit", usd: 20 },
      requiresCard: true,
      notes: "7-day trial capped at $20 of usage; card required, charged $20 on day 7 unless cancelled. Then plans from $20/mo (5 machines awake).",
      source: "https://maritime.sh/pricing",
      checked: "2026-11-12",
    },
    pricing: { vcpuSecondUsd: 0.0055 / 3600, gibSecondUsd: 0.00275 / 3600, defaultCpu: 2, defaultMemoryMiB: 4096, source: "https://maritime.sh/pricing" },
    surfaces: { rest: "https://api.maritime.sh", sdk: ["maritime-sdk (npm)", "maritime (PyPI)"], cli: "maritime", mcp: "maritime mcp (stdio)" },
  },

  async create(spec, ctx) {
    // A sandbox with this name that is still alive is returned instead of a second one.
    const sandbox = await httpJson<Sandbox>(`${base(ctx)}/v1/sandboxes`, {
      headers: { ...auth(ctx), ...(spec.metadata["sandboxrouting.id"] ? { "idempotency-key": spec.metadata["sandboxrouting.id"] } : {}) },
      body: {
        name: sbrName(spec),
        // A stock template, a saved snapshot or a public OCI image.
        from: spec.image ?? spec.nativeTemplate ?? "base",
        vcpu: Math.min(16, Math.max(1, Math.ceil(spec.cpu))),
        memoryMib: Math.min(65_536, Math.max(1024, Math.ceil(spec.memoryMiB / 1024) * 1024)),
        env: spec.env,
        metadata: spec.metadata,
        timeLimitSeconds: Math.min(MAX_LIFETIME_SEC, Math.max(60, Math.ceil(spec.timeoutSec))),
        // Background commands don't count as activity, so the idle timer is kept out of the way.
        keepAwake: true,
      },
      timeoutMs: 180_000,
    });
    if (sandbox.state !== "running") {
      await http(box(ctx, sandbox.id), { method: "DELETE", headers: auth(ctx) }).catch(() => undefined);
      throw new Error(`maritime sandbox ${sandbox.id} is ${sandbox.state}`);
    }
    if (sandbox.dataPlaneUrl && sandbox.secret) await planes.get(`${base(ctx)}|${sandbox.id}`, async () => planeOf(sandbox));
    return { providerSandboxId: sandbox.id, cpu: sandbox.resources?.vcpu, memoryMiB: sandbox.resources?.memoryMib };
  },

  async exec(id, command, o, ctx) {
    const timeoutSeconds = Math.min(EXEC_LIMIT_SEC, Math.max(1, Math.ceil(o.timeoutSec ?? 60)));
    const p = await plane(ctx, id);
    const r = await httpJson<{ state: string; exitCode: number | null; stdout?: string; stderr?: string }>(`${p.url}/commands`, {
      headers: p.headers,
      body: { cmd: command, cwd: o.cwd, env: o.env, timeoutSeconds },
      timeoutMs: (timeoutSeconds + 30) * 1000,
    });
    const stdout = r.stdout ?? "";
    const stderr = r.stderr ?? "";
    if (stdout) o.onStdout?.(stdout);
    if (stderr) o.onStderr?.(stderr);
    return { stdout, stderr, exitCode: r.exitCode ?? (r.state === "killed" ? 137 : 1) };
  },

  async readFile(id, path, ctx) {
    const p = await plane(ctx, id);
    return new Uint8Array(await (await http(`${p.url}/files?path=${encodeURIComponent(path)}`, { headers: p.headers })).arrayBuffer());
  },

  async writeFile(id, path, data, ctx) {
    const p = await plane(ctx, id);
    await http(`${p.url}/files?path=${encodeURIComponent(path)}`, { method: "PUT", headers: { ...p.headers, "content-type": "application/octet-stream" }, raw: data });
  },

  async listFiles(id, path, ctx) {
    const p = await plane(ctx, id);
    type Entry = { path: string; type?: string; sizeBytes?: number };
    const r = await httpJson<Entry[] | { entries?: Entry[]; data?: Entry[] }>(`${p.url}/files/list?path=${encodeURIComponent(path)}`, { headers: p.headers });
    const entries = Array.isArray(r) ? r : r.entries ?? r.data ?? [];
    return entries.map((e) => ({ name: e.path.replace(/\/+$/, "").split("/").pop() ?? e.path, path: e.path, isDir: e.type === "dir", size: e.sizeBytes }));
  },

  async getUrl(id, port, ctx) {
    // `token: false` makes the port public; the default is a private URL.
    return (await httpJson<{ url: string }>(box(ctx, id, "/urls"), { headers: auth(ctx), body: { port, token: false } })).url;
  },

  async kill(id, ctx) {
    planes.drop(`${base(ctx)}|${id}`);
    await http(box(ctx, id), { method: "DELETE", headers: auth(ctx) });
  },

  async listAlive(ctx) {
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const q = new URLSearchParams({ limit: "100", ...(cursor ? { cursor } : {}) });
      const page = await httpJson<{ data: Sandbox[]; nextCursor?: string | null }>(`${base(ctx)}/v1/sandboxes?${q}`, { headers: auth(ctx) });
      for (const s of page.data) if (s.state !== "ended" && s.state !== "error") ids.push(s.id);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return ids;
  },
});
