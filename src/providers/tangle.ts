// Tangle Sandbox (sandbox.tangle.tools): Linux sandboxes for coding agents, each "a Docker
// container or a Firecracker microVM with its own kernel", paid from prepaid credit.
// Docs (checked 2026-11-21): https://sandbox.tangle.tools/llms.txt,
// https://sandbox.tangle.tools/openapi.json (OpenAPI, "E2B compatibility" tag),
// https://sandbox.tangle.tools/v1/pricing/sandboxes (rate card, no key needed),
// https://docs.tangle.tools/sandbox/quickstart.
// The native API (/v1/sandboxes) runs commands through each sandbox's runtime endpoint, which
// its SDK reaches with per-sandbox connection data. The adapter uses the plain-HTTP routes Tangle
// serves for E2B-style callers instead, "for plain HTTP callers":
//   Authorization: Bearer <TANGLE_API_KEY> (or X-API-Key)
//   POST   /e2b/sandboxes                   {templateID, metadata, envVars, timeout (s, lifetime),
//                                            allow_internet_access} → 201 {sandboxID}, once it runs
//   GET    /e2b/sandboxes                   [{sandboxID, state: running|paused, cpuCount, memoryMB}]
//   GET    /e2b/templates                   [{templateID, aliases, cpuCount, memoryMB, public}]
//   POST   /e2b/sandboxes/{id}/processes    {cmd (/bin/sh -c), cwd, envs, timeout (ms)}
//                                            → {pid, status: running|exited, exitCode, stdout, stderr}
//   GET    /e2b/sandboxes/{id}/processes/{pid}
//   GET|POST /e2b/sandboxes/{id}/files?path=     raw bytes, at most 5 MiB per write
//   GET    /e2b/sandboxes/{id}/files/list?path= {entries: [{name, type: file|dir, path, size}]}
//   DELETE /e2b/sandboxes/{id}
// `POST /e2b/sandboxes/{id}/timeout` answers 501 (not supported), so there is no setTimeout.
// Sizes come from the template; the adapter picks the smallest template that fits the request.
// Price: vCPU × cpuCoreHourUsd + GB × memoryGBHourUsd + disk GB × diskGBHourUsd, never below
// $0.04 an hour (minChargeHourUsd), which the router's per-second rates can't express.

import { HttpError, defineProvider, http, httpJson } from "./util.js";
import { pollMs, sleep } from "./rest-helpers.js";
import type { ProviderContext } from "../core/types.js";

const ID = "tangle";
const base = (ctx: ProviderContext) => String(ctx.env["TANGLE_API_URL"] ?? "https://sandbox.tangle.tools").replace(/\/+$/, "");
const auth = (ctx: ProviderContext) => ({ authorization: `Bearer ${ctx.env["TANGLE_API_KEY"]}` });
const box = (ctx: ProviderContext, id: string, path = "") => `${base(ctx)}/e2b/sandboxes/${encodeURIComponent(id)}${path}`;

interface Template {
  templateID: string;
  aliases?: string[];
  cpuCount: number;
  memoryMB: number;
}
interface Proc {
  pid: string;
  status: "running" | "exited";
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/** The smallest template with at least the requested vCPUs and memory, else the largest. */
export function tangleTemplate(templates: Template[], cpu: number, memoryMiB: number): Template | undefined {
  const bySize = [...templates].sort((a, b) => a.cpuCount - b.cpuCount || a.memoryMB - b.memoryMB);
  return bySize.find((t) => t.cpuCount >= cpu && t.memoryMB >= memoryMiB) ?? bySize.at(-1);
}

export const tangleProvider = defineProvider({
  info: {
    id: ID,
    name: "Tangle Sandbox",
    homepage: "https://sandbox.tangle.tools",
    env: ["TANGLE_API_KEY"],
    capabilities: ["fileList"],
    // Docker containers or Firecracker microVMs, its driver's choice: claim the weaker.
    isolation: "container",
    freeTier: {
      tier: { kind: "none" },
      notes: "No free credit: every call needs prepaid credit. Billed per second, never below $0.04 an hour.",
      source: "https://sandbox.tangle.tools/llms.txt",
      checked: "2026-11-21",
    },
    // general pool; disk ($0.000734/GB-h) and the $0.04/h minimum are left out.
    pricing: { vcpuSecondUsd: 0.010445613 / 3600, gibSecondUsd: 0.007050789 / 3600, defaultCpu: 2, defaultMemoryMiB: 4096, source: "https://sandbox.tangle.tools/v1/pricing/sandboxes" },
    surfaces: { rest: "https://sandbox.tangle.tools (/v1/sandboxes; /e2b/sandboxes for plain HTTP)", sdk: ["@tangle-network/sandbox (npm)", "tangle-sandbox (PyPI)"], cli: "tangle", mcp: "https://id.tangle.tools/mcp" },
  },

  async create(spec, ctx) {
    let templateID = spec.nativeTemplate ?? (ctx.options["template"] as string | undefined);
    let size: Template | undefined;
    if (!templateID) {
      size = tangleTemplate(await httpJson<Template[]>(`${base(ctx)}/e2b/templates`, { headers: auth(ctx) }), spec.cpu, spec.memoryMiB);
      if (!size) throw new Error("tangle: GET /e2b/templates listed no template");
      templateID = size.templateID;
    }
    // Answers once the sandbox runs.
    const r = await httpJson<{ sandboxID: string }>(`${base(ctx)}/e2b/sandboxes`, {
      headers: auth(ctx),
      body: { templateID, metadata: spec.metadata, envVars: spec.env, timeout: Math.max(1, Math.ceil(spec.timeoutSec)), allow_internet_access: true },
      timeoutMs: 300_000,
    });
    return { providerSandboxId: r.sandboxID, cpu: size?.cpuCount, memoryMiB: size?.memoryMB };
  },

  async exec(id, command, o, ctx) {
    const limitMs = o.timeoutSec ? Math.ceil(o.timeoutSec * 1000) : undefined;
    let p = await httpJson<Proc>(box(ctx, id, "/processes"), {
      headers: auth(ctx),
      body: { cmd: command, cwd: o.cwd, envs: o.env, timeout: limitMs },
      timeoutMs: (limitMs ?? 3_600_000) + 30_000,
    });
    // It answers once the command ends; should it answer early, the process is read until it has.
    const deadline = Date.now() + (limitMs ?? 3_600_000) + 30_000;
    while (p.status === "running" && Date.now() < deadline) {
      await sleep(pollMs(ctx, 1000));
      p = await httpJson<Proc>(box(ctx, id, `/processes/${encodeURIComponent(p.pid)}`), { headers: auth(ctx) });
    }
    if (p.status === "running") throw new Error(`tangle exec: process ${p.pid} still running past its deadline`);
    if (p.stdout) o.onStdout?.(p.stdout);
    if (p.stderr) o.onStderr?.(p.stderr);
    return { stdout: p.stdout ?? "", stderr: p.stderr ?? "", exitCode: p.exitCode ?? 1 };
  },

  async readFile(id, path, ctx) {
    return new Uint8Array(await (await http(`${box(ctx, id, "/files")}?path=${encodeURIComponent(path)}`, { headers: auth(ctx) })).arrayBuffer());
  },

  async writeFile(id, path, data, ctx) {
    await http(`${box(ctx, id, "/files")}?path=${encodeURIComponent(path)}`, {
      method: "POST",
      headers: { ...auth(ctx), "content-type": "application/octet-stream" },
      raw: data,
    });
  },

  async listFiles(id, path, ctx) {
    const r = await httpJson<{ entries: { name: string; type: string; path: string; size?: number }[] }>(`${box(ctx, id, "/files/list")}?path=${encodeURIComponent(path)}`, {
      headers: auth(ctx),
    });
    return r.entries.map((e) => ({ name: e.name, path: e.path, isDir: e.type === "dir", size: e.size }));
  },

  async kill(id, ctx) {
    try {
      await http(box(ctx, id), { method: "DELETE", headers: auth(ctx) });
    } catch (err) {
      if (!(err instanceof HttpError && (err.status === 404 || err.status === 410))) throw err;
    }
  },

  async listAlive(ctx) {
    return (await httpJson<{ sandboxID: string }[]>(`${base(ctx)}/e2b/sandboxes`, { headers: auth(ctx) })).map((s) => s.sandboxID);
  },
});
