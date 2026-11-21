// Sandboxer (sandboxer.com): persistent Ubuntu 24.04 Cloud Hypervisor microVMs with root, Docker
// and nested KVM, in us-east and eu-central. No free tier: plans start at $20/month and every plan
// dollar comes back as machine time (small 2 vCPU / 4 GB $0.018/h, default 4 / 8 $0.036/h, large
// 8 / 16 $0.072/h, xlarge 16 / 32 $0.20/h on the $100+ plans), metered per second while running.
// REST: https://sandboxer.com/api/v1 (Bearer sbx_live_…), OpenAPI https://sandboxer.com/openapi.yaml,
// agent guide https://sandboxer.com/llms.txt, prices https://sandboxer.com/pricing.md. npm
// `sandboxer-sdk`, PyPI `sandboxer-sdk`, CLI `sbx`, MCP https://sandboxer.com/mcp.
// `ttlSeconds` archives (stops with a snapshot, billing ends) rather than deletes; a stopped
// sandbox's data is kept 14 days for free. Create takes an Idempotency-Key. A command runs
// synchronously for at most 600 s, and its `cwd` must be relative to /home/user, so the adapter
// inlines `cd` instead. The file API reaches /home/user and /tmp only (5 MiB a file). Without a
// template the sandbox is created with `noEnv`, so none of the account's secrets reach it.

import { randomUUID } from "node:crypto";
import { defineProvider, http, httpJson, HttpError } from "./util.js";
import { inline, insideRoots, pollMs, sleep } from "./rest-helpers.js";
import type { ProviderContext } from "../core/types.js";

const base = (ctx: ProviderContext) => String(ctx.env["SANDBOXER_API_URL"] ?? "https://sandboxer.com/api/v1").replace(/\/+$/, "");
const auth = (ctx: ProviderContext) => ({ authorization: `Bearer ${ctx.env["SANDBOXER_API_KEY"]}` });
const box = (ctx: ProviderContext, id: string, path = "") => `${base(ctx)}/sandboxes/${encodeURIComponent(id)}${path}`;
const EXEC_LIMIT_SEC = 600;
const FILE_ROOTS = ["/home/user", "/tmp"];

/** Sandboxer machine types: vCPU → type. */
export function sandboxerType(cpu: number): { type: string; cpu: number; memoryMiB: number } {
  if (cpu <= 2) return { type: "small", cpu: 2, memoryMiB: 4096 };
  if (cpu <= 4) return { type: "default", cpu: 4, memoryMiB: 8192 };
  if (cpu <= 8) return { type: "large", cpu: 8, memoryMiB: 16384 };
  return { type: "xlarge", cpu: 16, memoryMiB: 32768 };
}

interface Sandbox {
  id: string;
  state?: string;
  error?: string | null;
}
const READY = new Set(["ready", "idle", "running"]);
const FAILED = new Set(["error", "cancelled"]);
const LIVE_STATES = "init,provisioning,provisioned,cloning,ready,idle,running";

export const sandboxerProvider = defineProvider({
  info: {
    id: "sandboxer",
    name: "Sandboxer",
    homepage: "https://sandboxer.com",
    env: ["SANDBOXER_API_KEY"],
    capabilities: ["ports", "pause", "extendTimeout"],
    isolation: "microvm",
    maxExecSec: EXEC_LIMIT_SEC,
    freeTier: {
      tier: { kind: "none" },
      requiresCard: true,
      notes: "No free trial: plans start at $20/month, charged on subscribing, and the plan's dollars come back as machine time. The $20 plan runs 100 at once.",
      source: "https://sandboxer.com/pricing.md",
      checked: "2026-11-21",
    },
    // small (2 vCPU / 4 GB) is $0.018/h; default and large scale linearly from it.
    pricing: { vcpuSecondUsd: 0.0045 / 3600, gibSecondUsd: 0.00225 / 3600, defaultCpu: 2, defaultMemoryMiB: 4096, source: "https://sandboxer.com/pricing.md" },
    surfaces: { rest: "https://sandboxer.com/api/v1", sdk: ["sandboxer-sdk (npm)", "sandboxer-sdk (PyPI)"], cli: "sbx", mcp: "https://sandboxer.com/mcp" },
  },

  async create(spec, ctx) {
    const size = sandboxerType(spec.cpu);
    const template = spec.nativeTemplate;
    const r = await httpJson<{ status?: string; sandbox: Sandbox }>(`${base(ctx)}/sandboxes`, {
      headers: { ...auth(ctx), "idempotency-key": spec.metadata["sandboxrouting.id"] ?? randomUUID() },
      body: {
        type: size.type,
        region: spec.region,
        ttlSeconds: Math.max(1, Math.ceil(spec.timeoutSec)),
        env: spec.env,
        ...(template ? { environment: template } : { noEnv: true }),
      },
    });
    const id = r.sandbox.id;
    try {
      let s = r.sandbox;
      for (let i = 0; i < 300 && !READY.has(s.state ?? ""); i++) {
        if (FAILED.has(s.state ?? "")) throw new Error(`sandboxer sandbox ${id} is ${s.state}${s.error ? `: ${s.error}` : ""}`);
        if (i > 0) await sleep(pollMs(ctx, 1000));
        // Held server-side until the sandbox is no longer starting, for up to 30 s.
        s = (await httpJson<{ sandbox: Sandbox }>(`${box(ctx, id)}?waitFor=ready&timeoutSeconds=30`, { headers: auth(ctx), timeoutMs: 60_000 })).sandbox;
      }
      if (!READY.has(s.state ?? "")) throw new Error(`sandboxer sandbox ${id} did not become ready (${s.state})`);
    } catch (err) {
      await this.kill(id, ctx).catch(() => undefined);
      throw err;
    }
    return { providerSandboxId: id, cpu: size.cpu, memoryMiB: size.memoryMiB };
  },

  async exec(id, command, o, ctx) {
    const timeoutSeconds = Math.min(EXEC_LIMIT_SEC, Math.max(1, Math.ceil(o.timeoutSec ?? EXEC_LIMIT_SEC)));
    const r = await httpJson<{ exitCode: number | null; signal?: string | null; stdout: string; stderr: string; timedOut?: boolean }>(box(ctx, id, "/commands"), {
      headers: auth(ctx),
      body: { command: inline(command, { cwd: o.cwd }), env: o.env, timeoutSeconds },
      timeoutMs: (timeoutSeconds + 60) * 1000,
    });
    if (r.stdout) o.onStdout?.(r.stdout);
    if (r.stderr) o.onStderr?.(r.stderr);
    // No exit code: cut off at the timeout (124, like `timeout`) or killed by a signal.
    const exitCode = r.exitCode ?? (r.timedOut ? 124 : 137);
    return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", exitCode };
  },

  async readFile(id, path, ctx) {
    insideRoots("sandboxer", path, FILE_ROOTS);
    const r = await httpJson<{ content: string; encoding: string }>(`${box(ctx, id, "/files")}?path=${encodeURIComponent(path)}&encoding=base64`, { headers: auth(ctx) });
    return r.encoding === "base64" ? new Uint8Array(Buffer.from(r.content, "base64")) : new TextEncoder().encode(r.content);
  },

  async writeFile(id, path, data, ctx) {
    insideRoots("sandboxer", path, FILE_ROOTS);
    await http(box(ctx, id, "/files"), { method: "PUT", headers: auth(ctx), body: { path, content: Buffer.from(data).toString("base64"), encoding: "base64" } });
  },

  async getUrl(id, port, ctx) {
    return (await httpJson<{ url: string }>(box(ctx, id, "/host"), { headers: auth(ctx), body: { port, public: true } })).url;
  },

  async setTimeout(id, timeoutSec, ctx) {
    // The deadline becomes now + ttlSeconds.
    await http(box(ctx, id), { method: "PATCH", headers: auth(ctx), body: { ttlSeconds: Math.max(1, Math.ceil(timeoutSec)) } });
  },

  async pause(id, ctx) {
    // Stops with memory and disk saved; a stopped sandbox costs nothing.
    await http(box(ctx, id, "/stop"), { method: "POST", headers: auth(ctx), body: {} });
  },

  async resume(id, ctx) {
    await http(box(ctx, id, "/resume"), { method: "POST", headers: auth(ctx), body: {} });
  },

  async kill(id, ctx) {
    try {
      await http(box(ctx, id), { method: "DELETE", headers: { ...auth(ctx), "x-sandboxer-confirm-delete": id } });
    } catch (err) {
      if (!(err instanceof HttpError && (err.status === 404 || err.status === 410))) throw err;
    }
  },

  async listAlive(ctx) {
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const q = new URLSearchParams({ limit: "200", state: LIVE_STATES, ...(cursor ? { cursor } : {}) });
      const page = await httpJson<{ sandboxes: Sandbox[]; pageInfo?: { nextCursor?: string | null } }>(`${base(ctx)}/sandboxes?${q}`, { headers: auth(ctx) });
      ids.push(...page.sandboxes.filter((s) => !FAILED.has(s.state ?? "") && s.state !== "archived" && s.state !== "archiving").map((s) => s.id));
      cursor = page.pageInfo?.nextCursor ?? undefined;
    } while (cursor);
    return ids;
  },
});
