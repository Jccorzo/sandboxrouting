// Prized sandboxes (beta): Firecracker microVMs started from a template. Free: $30 once, no
// card; on the free credit alone, 10 sandboxes at once, each up to 2 vCPU / 4 GB, with 60
// minutes of running in all. Paid: $0.04 per vCPU-hour and $0.0125 per GB-hour, per second
// while running; paused sandboxes bill only storage. `maxRuntimeMin` deletes a sandbox after
// that many minutes of running (the clock stops while paused).
// Control plane: https://api.prized.dev/api/v1 (Bearer dcp_…); commands and files go to the
// sandbox's own `toolboxBase` with the same key. No OpenAPI document. Docs:
// https://prized.dev/docs/sandboxes-api.md, https://prized.dev/docs/sandboxes.md, /pricing.
// SDKs: PyPI/npm `prized` (docs/sandboxes-python-typescript), CLI `prized sandbox`.
// The file API reaches only /home/prized; other paths use the exec fallback. An empty balance
// is `409 insufficient_balance`, which the adapter reports as the 402 it means.

import { randomUUID } from "node:crypto";
import { defineProvider, http, HttpError, type HttpOptions } from "./util.js";
import { insideRoots, pollMs, sleep } from "./rest-helpers.js";
import type { ProviderContext } from "../core/types.js";

const base = (ctx: ProviderContext) => String(ctx.env["PRIZED_API_URL"] ?? "https://api.prized.dev/api/v1").replace(/\/+$/, "");
const auth = (ctx: ProviderContext) => ({ authorization: `Bearer ${ctx.env["PRIZED_API_KEY"]}` });
const box = (ctx: ProviderContext, id: string, path = "") => `${base(ctx)}/sandboxes/${encodeURIComponent(id)}${path}`;
const ROOT = "/home/prized";
/** Refusals that are about money but don't answer 402. */
const MONEY = /"error"\s*:\s*"(insufficient_balance|paid_balance_required)"/;

/** Prized's calls, with balance refusals turned into 402s the router counts as quota. */
async function call(url: string, opts: HttpOptions = {}): Promise<Response> {
  try {
    return await http(url, opts);
  } catch (err) {
    if (err instanceof HttpError && err.status === 409 && MONEY.test(err.message)) throw new HttpError(402, err.message);
    throw err;
  }
}
const callJson = async <T>(url: string, opts: HttpOptions = {}): Promise<T> => {
  const text = await (await call(url, opts)).text();
  return (text ? JSON.parse(text) : undefined) as T;
};

interface Sandbox {
  id: string;
  state: "starting" | "running" | "pausing" | "paused" | "resizing" | "deleting" | "deleted" | "error";
  resources?: { vcpu?: number; memoryMb?: number };
  errorReason?: string | null;
  toolboxBase?: string;
}

/** Each sandbox's edge address, which never changes for its life. */
const edges = new Map<string, string>();
async function edge(ctx: ProviderContext, id: string): Promise<string> {
  const hit = edges.get(id);
  if (hit) return hit;
  const { sandbox } = await callJson<{ sandbox: Sandbox }>(box(ctx, id), { headers: auth(ctx) });
  if (!sandbox.toolboxBase) throw new Error(`prized sandbox ${id} has no edge address`);
  edges.set(id, sandbox.toolboxBase.replace(/\/+$/, ""));
  return edges.get(id)!;
}

export const prizedProvider = defineProvider({
  info: {
    id: "prized",
    name: "Prized Sandboxes",
    homepage: "https://prized.dev",
    env: ["PRIZED_API_KEY"],
    capabilities: ["pause", "extendTimeout"],
    isolation: "microvm",
    maxTimeoutSec: 7 * 86_400,
    freeTier: {
      tier: { kind: "one-time-credit", usd: 30 },
      concurrency: 10,
      maxLifetimeSec: 3600,
      requiresCard: false,
      notes: "$30 of credit once, no card. On the free credit alone: 10 sandboxes at once, each up to 2 vCPU / 4 GB, 60 minutes of running in all (paused time doesn't count).",
      source: "https://prized.dev/docs/sandboxes.md#free-tier",
      checked: "2026-11-21",
    },
    pricing: { vcpuSecondUsd: 0.04 / 3600, gibSecondUsd: 0.0125 / 3600, defaultCpu: 2, defaultMemoryMiB: 4096, source: "https://prized.dev/pricing" },
    surfaces: { rest: "https://api.prized.dev/api/v1", sdk: ["prized (PyPI)", "prized (npm)"], cli: "prized sandbox", mcp: "prized mcp" },
  },

  async create(spec, ctx) {
    const wait = ctx.options["pollMs"] === undefined ? "?wait=running" : "";
    const labels = Object.fromEntries(Object.entries(spec.metadata).filter(([k, v]) => k.length <= 64 && v.length <= 256).slice(0, 32));
    const r = await callJson<{ sandbox: Sandbox }>(`${base(ctx)}/sandboxes${wait}`, {
      headers: { ...auth(ctx), "idempotency-key": spec.metadata["sandboxrouting.id"] ?? randomUUID() },
      body: {
        template: spec.nativeTemplate ?? String(ctx.options["template"] ?? "prized-base-v1"),
        resources: { vcpu: Math.max(1, Math.ceil(spec.cpu)), memoryMb: Math.max(1024, spec.memoryMiB) },
        envVars: spec.env,
        labels,
        maxRuntimeMin: Math.max(1, Math.ceil(spec.timeoutSec / 60)),
      },
      timeoutMs: 60_000,
    });
    let sandbox = r.sandbox;
    const id = sandbox.id;
    try {
      for (let i = 0; i < 600 && sandbox.state !== "running"; i++) {
        if (sandbox.state === "error" || sandbox.state === "deleting" || sandbox.state === "deleted") {
          throw new Error(`prized sandbox ${id} is ${sandbox.state}: ${sandbox.errorReason ?? ""}`);
        }
        await sleep(pollMs(ctx, 1000));
        sandbox = (await callJson<{ sandbox: Sandbox }>(box(ctx, id), { headers: auth(ctx) })).sandbox;
      }
      if (sandbox.state !== "running") throw new Error(`prized sandbox ${id} did not start running`);
    } catch (err) {
      await http(box(ctx, id), { method: "DELETE", headers: auth(ctx) }).catch(() => undefined);
      throw err;
    }
    if (sandbox.toolboxBase) edges.set(id, sandbox.toolboxBase.replace(/\/+$/, ""));
    return { providerSandboxId: id, cpu: sandbox.resources?.vcpu, memoryMiB: sandbox.resources?.memoryMb };
  },

  async exec(id, command, o, ctx) {
    // `bash -c` as `prized` in /home/prized/work; timeout is 1-3,600 s (300 by default).
    const timeout = Math.min(3600, Math.max(1, Math.ceil(o.timeoutSec ?? 3600)));
    const r = await callJson<{ stdout: string; stderr: string; exitCode: number; timedOut?: boolean }>(`${await edge(ctx, id)}/process/execute`, {
      headers: auth(ctx),
      body: { command, cwd: o.cwd, env: o.env, timeout },
      timeoutMs: (timeout + 30) * 1000,
    });
    if (r.stdout) o.onStdout?.(r.stdout);
    if (r.stderr) o.onStderr?.(r.stderr);
    // A command cut off by its timeout reads `exitCode: -1, timedOut: true`.
    return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", exitCode: r.timedOut ? 124 : r.exitCode };
  },

  async readFile(id, path, ctx) {
    insideRoots("prized", path, [ROOT]);
    return new Uint8Array(await (await call(`${await edge(ctx, id)}/files/download?path=${encodeURIComponent(path)}`, { headers: auth(ctx) })).arrayBuffer());
  },

  async writeFile(id, path, data, ctx) {
    insideRoots("prized", path, [ROOT]);
    await call(`${await edge(ctx, id)}/files/upload?path=${encodeURIComponent(path)}`, {
      method: "POST",
      headers: { ...auth(ctx), "content-type": "application/octet-stream" },
      raw: data,
    });
  },

  async setTimeout(id, timeoutSec, ctx) {
    // Sets the end from now, earlier or later; the free tier only allows earlier.
    await call(box(ctx, id, "/timeout"), { headers: auth(ctx), body: { inMin: Math.max(1, Math.ceil(timeoutSec / 60)) } });
  },

  async pause(id, ctx) {
    await call(`${box(ctx, id, "/pause")}?wait=paused`, { method: "POST", headers: auth(ctx) });
  },

  async resume(id, ctx) {
    await call(`${box(ctx, id, "/resume")}?wait=running`, { method: "POST", headers: auth(ctx) });
  },

  async kill(id, ctx) {
    edges.delete(id);
    // 404 once it is gone; again on a deleting sandbox is a no-op.
    await http(box(ctx, id), { method: "DELETE", headers: auth(ctx) }).catch((err) => {
      if (err instanceof HttpError && (err.status === 404 || err.status === 410)) return;
      throw err;
    });
  },

  async listAlive(ctx) {
    const r = await callJson<{ sandboxes: Sandbox[] }>(`${base(ctx)}/sandboxes`, { headers: auth(ctx) });
    return r.sandboxes.filter((s) => s.state !== "deleting" && s.state !== "deleted" && s.state !== "error").map((s) => s.id);
  },
});
