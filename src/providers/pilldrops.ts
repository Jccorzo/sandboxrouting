// PillDrops (pilldrops.com): sandboxes for untrusted and AI-written code, hosted or self-hosted
// from the open-source engine (github.com/pilldrops-oss/pilldrops). Free: $5 of credit once, no
// card; 5 concurrent, 4 h sessions, up to 2 vCPU / 2 GB. $0.000014 per vCPU-second and $0.0000045
// per GB-second while running; a paused (or idle auto-paused) sandbox bills storage only.
// REST: https://pilldrops.com (Bearer key), OpenAPI https://pilldrops.com/openapi.json, agent
// guide https://pilldrops.com/llms.txt. npm `@pilldrops/sdk`, PyPI `pilldrops`, CLI `pilldrops`,
// MCP at <server>/mcp. Its llms.txt says a sandbox is "an isolated microVM (or container)" and
// the pricing page says a dedicated microVM; the adapter claims the weaker, `container`.
// The create's `timeout` is the sandbox's TTL (capped to the plan); env goes as "NAME=VALUE"
// strings, as the SDK sends it. A command runs in the foreground for at most 600 s. File paths
// are confined to the sandbox home: a path outside it answers 400, which hands the call to the
// router's exec fallback. A command on an idle-paused sandbox wakes it.

import { randomUUID } from "node:crypto";
import { defineProvider, http, httpJson, HttpError } from "./util.js";
import { pollMs, sleep } from "./rest-helpers.js";
import { SandboxRouterError } from "../core/errors.js";
import type { ProviderContext } from "../core/types.js";

const base = (ctx: ProviderContext) => String(ctx.env["PILLDROPS_API_URL"] ?? "https://pilldrops.com").replace(/\/+$/, "");
const auth = (ctx: ProviderContext) => ({ authorization: `Bearer ${ctx.env["PILLDROPS_API_KEY"]}` });
const box = (ctx: ProviderContext, id: string, path = "") => `${base(ctx)}/v1/sandboxes/${encodeURIComponent(id)}${path}`;
const EXEC_LIMIT_SEC = 600;

interface Sandbox {
  id: string;
  status?: "pending" | "running" | "pausing" | "paused" | "standby" | "resuming" | "stopped" | "failed";
  state?: string;
}
const stateOf = (s: Sandbox) => s.status ?? s.state ?? "";
const ENDED = new Set(["stopped", "failed"]);

/** A path outside the sandbox home is the caller's to fix, not a missing file: use exec instead. */
function confined(path: string, err: unknown): never {
  if (err instanceof HttpError && err.status === 400) {
    throw new SandboxRouterError("unsupported", `pilldrops file API only reaches the sandbox home, not ${path}`, "pilldrops", { cause: err });
  }
  throw err;
}

export const pilldropsProvider = defineProvider({
  info: {
    id: "pilldrops",
    name: "PillDrops",
    homepage: "https://pilldrops.com",
    env: ["PILLDROPS_API_KEY"],
    capabilities: ["pause", "extendTimeout"],
    isolation: "container",
    maxTimeoutSec: 24 * 3600,
    maxExecSec: EXEC_LIMIT_SEC,
    freeTier: {
      tier: { kind: "one-time-credit", usd: 5 },
      concurrency: 5,
      maxLifetimeSec: 4 * 3600,
      requiresCard: false,
      notes: "$5 of usage credit once, no card; 5 concurrent sandboxes, 4 h each, up to 2 vCPU / 2 GB RAM / 2 GB disk. Nothing is charged when it runs out.",
      source: "https://pilldrops.com/pricing",
      checked: "2026-11-21",
    },
    pricing: { vcpuSecondUsd: 0.000014, gibSecondUsd: 0.0000045, defaultCpu: 2, defaultMemoryMiB: 2048, source: "https://pilldrops.com/pricing" },
    surfaces: { rest: "https://pilldrops.com/v1", sdk: ["@pilldrops/sdk (npm)", "pilldrops (PyPI)"], cli: "pilldrops (npm @pilldrops/cli)", mcp: "https://pilldrops.com/mcp" },
  },

  async create(spec, ctx) {
    let s = await httpJson<Sandbox>(`${base(ctx)}/v1/sandboxes`, {
      headers: { ...auth(ctx), "idempotency-key": spec.metadata["sandboxrouting.id"] ?? randomUUID() },
      body: {
        template: spec.nativeTemplate ?? String(ctx.options["template"] ?? "python-3.11"),
        timeout: Math.max(1, Math.ceil(spec.timeoutSec)),
        vcpu: Math.max(1, Math.ceil(spec.cpu)),
        memory_mb: Math.ceil(spec.memoryMiB),
        env: Object.entries(spec.env).map(([k, v]) => `${k}=${v}`),
        client: "sandboxrouting",
      },
    });
    const id = s.id;
    try {
      for (let i = 0; i < 300 && stateOf(s) !== "running"; i++) {
        if (ENDED.has(stateOf(s))) throw new Error(`pilldrops sandbox ${id} is ${stateOf(s)}`);
        await sleep(pollMs(ctx, 1000));
        s = await httpJson<Sandbox>(box(ctx, id), { headers: auth(ctx) });
      }
      if (stateOf(s) !== "running") throw new Error(`pilldrops sandbox ${id} did not start`);
    } catch (err) {
      await this.kill(id, ctx).catch(() => undefined);
      throw err;
    }
    // Resources above the plan's cap are lowered server-side; the response doesn't echo them.
    return { providerSandboxId: id };
  },

  async exec(id, command, o, ctx) {
    const timeout = Math.min(EXEC_LIMIT_SEC, Math.max(1, Math.ceil(o.timeoutSec ?? EXEC_LIMIT_SEC)));
    const r = await httpJson<{ stdout?: string; stderr?: string; exit_code?: number; truncated?: boolean }>(box(ctx, id, "/exec"), {
      headers: auth(ctx),
      body: { cmd: command, cwd: o.cwd, timeout, env: o.env },
      timeoutMs: (timeout + 60) * 1000,
    });
    if (r.stdout) o.onStdout?.(r.stdout);
    if (r.stderr) o.onStderr?.(r.stderr);
    return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", exitCode: r.exit_code ?? -1 };
  },

  async readFile(id, path, ctx) {
    const res = await http(`${box(ctx, id, "/files")}?path=${encodeURIComponent(path)}`, { headers: auth(ctx) }).catch((err) => confined(path, err));
    return new Uint8Array(await res.arrayBuffer());
  },

  async writeFile(id, path, data, ctx) {
    await http(`${box(ctx, id, "/files")}?path=${encodeURIComponent(path)}`, {
      method: "POST",
      headers: { ...auth(ctx), "content-type": "application/octet-stream" },
      raw: data,
    }).catch((err) => confined(path, err));
  },

  async setTimeout(id, timeoutSec, ctx) {
    // A positive TTL counted from now, capped to the plan's session length.
    await http(box(ctx, id, "/timeout"), { headers: auth(ctx), body: { seconds: Math.max(1, Math.ceil(timeoutSec)) } });
  },

  async pause(id, ctx) {
    await http(box(ctx, id, "/pause"), { method: "POST", headers: auth(ctx) });
  },

  async resume(id, ctx) {
    await http(box(ctx, id, "/resume"), { method: "POST", headers: auth(ctx) });
  },

  async kill(id, ctx) {
    try {
      await http(box(ctx, id), { method: "DELETE", headers: auth(ctx) });
    } catch (err) {
      if (!(err instanceof HttpError && (err.status === 404 || err.status === 410))) throw err;
    }
  },

  async listAlive(ctx) {
    const r = await httpJson<{ sandboxes?: Sandbox[] } | Sandbox[]>(`${base(ctx)}/v1/sandboxes`, { headers: auth(ctx) });
    const rows = Array.isArray(r) ? r : r.sandboxes;
    if (!Array.isArray(rows)) throw new Error("pilldrops: unexpected response shape listing sandboxes");
    return rows.filter((s) => !ENDED.has(stateOf(s))).map((s) => s.id);
  },
});
