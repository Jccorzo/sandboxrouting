// Solari Sandboxes (getsolari.com): headless Cloud Hypervisor microVMs started from a memory
// snapshot; the same API key also drives Solari's browsers and desktops.
// Free plan: $3 of credit every month (no rollover), 1 sandbox at a time, 1-hour sessions.
// Free-plan rates are $0.0525 per vCPU-hour and $0.0165 per GB-hour (paid plans are cheaper).
// A balance at zero stops new sandboxes (402 InsufficientCredit); nothing bills past it.
// REST: https://api.getsolari.com (Bearer slr_live_…), docs https://docs.getsolari.com/api-reference
// and https://docs.getsolari.com/llms-full.txt. npm `@solarisdk/sandbox`, PyPI `solari-sandbox`, MCP.
// `timeoutMs` is a rolling idle window that activity resets, so a busy sandbox outlives it; with
// `onTimeout: "kill"` an idle one is destroyed, and the router deletes the rest at its deadline
// (enforcesTimeout: false). REST covers lifecycle plus a one-shot exec (no shell, 10 min max)
// and signed URLs for files; everything else rides a WebSocket this adapter doesn't use.

import { randomUUID } from "node:crypto";
import { defineProvider, http, httpJson, HttpError } from "./util.js";
import { inline } from "./rest-helpers.js";
import type { ProviderContext } from "../core/types.js";

const base = (ctx: ProviderContext) => String(ctx.env["SOLARI_BASE_URL"] ?? "https://api.getsolari.com").replace(/\/+$/, "");
const auth = (ctx: ProviderContext) => ({ authorization: `Bearer ${ctx.env["SOLARI_API_KEY"]}` });
/** Ids are base64url and already URL-safe; encoding keeps any other value from breaking the path. */
const box = (ctx: ProviderContext, id: string, path = "") => `${base(ctx)}/sandboxes/${encodeURIComponent(id)}${path}`;
const EXEC_LIMIT_SEC = 600;

/** Dedicated sandboxes take 1-8 vCPUs and 2048-16384 MiB (a smaller memory is raised to 2048). */
export function solariSize(cpu: number, memoryMiB: number): { cpu: number; memoryMiB: number } {
  return { cpu: Math.min(8, Math.max(1, Math.ceil(cpu))), memoryMiB: Math.min(16384, Math.max(2048, Math.ceil(memoryMiB))) };
}

interface Sandbox {
  sandboxId: string;
  state?: "starting" | "running" | "paused" | "archived" | "releasing" | "gone";
  cpu?: number;
  memMb?: number;
}

export const solariProvider = defineProvider({
  info: {
    id: "solari",
    name: "Solari Sandboxes",
    homepage: "https://www.getsolari.com/sandboxes",
    env: ["SOLARI_API_KEY"],
    capabilities: ["ports", "pause", "extendTimeout"],
    isolation: "microvm",
    enforcesTimeout: false,
    maxExecSec: EXEC_LIMIT_SEC,
    freeTier: {
      tier: { kind: "monthly-credit", usd: 3 },
      concurrency: 1,
      maxLifetimeSec: 3600,
      notes: "Free plan: $3 of credit a month shared with browsers and desktops, no rollover; 1 sandbox or desktop at a time, 1-hour sessions. New sandboxes stop at a zero balance.",
      source: "https://docs.getsolari.com/pricing",
      checked: "2026-11-21",
    },
    pricing: { vcpuSecondUsd: 0.0525 / 3600, gibSecondUsd: 0.0165 / 3600, defaultCpu: 2, defaultMemoryMiB: 2048, source: "https://docs.getsolari.com/pricing" },
    surfaces: { rest: "https://api.getsolari.com", sdk: ["@solarisdk/sandbox (npm)", "solari-sandbox (PyPI)"], cli: "solari (npm @solarisdk/sdk)", mcp: "docs.getsolari.com/mcp" },
  },

  async create(spec, ctx) {
    const size = solariSize(spec.cpu, spec.memoryMiB);
    // A 201 means the VM is live: there is no starting state to wait out. The same key and body
    // within 24 h replay the first sandbox instead of making another.
    const s = await httpJson<Sandbox>(`${base(ctx)}/sandboxes`, {
      headers: { ...auth(ctx), "idempotency-key": spec.metadata["sandboxrouting.id"] ?? randomUUID() },
      body: {
        kind: "sandbox",
        template: spec.nativeTemplate ?? "base",
        isolation: "dedicated",
        cpu: size.cpu,
        memMb: size.memoryMiB,
        envs: spec.env,
        metadata: spec.metadata,
        timeoutMs: Math.max(1000, Math.ceil(spec.timeoutSec * 1000)),
        lifecycle: { onTimeout: "kill" },
      },
    });
    if (s.state === "gone" || s.state === "releasing") {
      await this.kill(s.sandboxId, ctx).catch(() => undefined);
      throw new Error(`solari sandbox ${s.sandboxId} is ${s.state}`);
    }
    return { providerSandboxId: s.sandboxId, cpu: s.cpu ?? size.cpu, memoryMiB: s.memMb ?? size.memoryMiB };
  },

  async exec(id, command, o, ctx) {
    // No shell and no env field on this route: the line goes to `sh -c` with exports inlined.
    const timeoutMs = Math.min(EXEC_LIMIT_SEC, Math.max(1, o.timeoutSec ?? EXEC_LIMIT_SEC)) * 1000;
    const r = await httpJson<{ exitCode: number; stdout: string; stderr: string; timedOut?: boolean }>(box(ctx, id, "/exec"), {
      headers: auth(ctx),
      body: { cmd: "sh", args: ["-c", inline(command, { env: o.env })], cwd: o.cwd, timeoutMs },
      timeoutMs: timeoutMs + 30_000,
    });
    if (r.stdout) o.onStdout?.(r.stdout);
    if (r.stderr) o.onStderr?.(r.stderr);
    // A command that hits its deadline comes back with exitCode -1 and timedOut.
    return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", exitCode: r.timedOut ? 124 : r.exitCode };
  },

  async readFile(id, path, ctx) {
    // Mint a 15-minute signed URL, then fetch it with no Authorization header.
    const { url } = await httpJson<{ url: string }>(`${box(ctx, id, "/files/download-url")}?path=${encodeURIComponent(path)}`, { headers: auth(ctx) });
    return new Uint8Array(await (await http(url)).arrayBuffer());
  },

  async writeFile(id, path, data, ctx) {
    const { url } = await httpJson<{ url: string }>(`${box(ctx, id, "/files/upload-url")}?path=${encodeURIComponent(path)}`, { headers: auth(ctx) });
    await http(url, { method: "PUT", headers: { "content-type": "application/octet-stream" }, raw: data });
  },

  async getUrl(id, port, ctx) {
    // The URL carries a signed token valid for an hour; mint another after that.
    return (await httpJson<{ url: string }>(box(ctx, id, `/ports/${port}`), { headers: auth(ctx) })).url;
  },

  async setTimeout(id, timeoutSec, ctx) {
    // Sets the rolling idle window, clamped to the plan's maximum.
    await http(box(ctx, id, "/timeout"), { headers: auth(ctx), body: { timeoutMs: Math.max(1000, Math.ceil(timeoutSec * 1000)) } });
  },

  async pause(id, ctx) {
    // Saves memory and disk; billing stops and the slot is freed. Repeating it is harmless.
    await http(box(ctx, id, "/pause"), { method: "POST", headers: auth(ctx) });
  },

  async resume(id, ctx) {
    await http(box(ctx, id, "/resume"), { method: "POST", headers: auth(ctx) });
  },

  async kill(id, ctx) {
    try {
      // An already-released sandbox answers 200 again.
      await http(box(ctx, id), { method: "DELETE", headers: auth(ctx) });
    } catch (err) {
      if (!(err instanceof HttpError && (err.status === 404 || err.status === 410))) throw err;
    }
  },

  async listAlive(ctx) {
    // The list doesn't count as activity; GET /sandboxes/:id would keep each one awake.
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const q = new URLSearchParams({ kind: "sandbox", limit: "100", ...(cursor ? { cursor } : {}) });
      const page = await httpJson<{ sandboxes?: Sandbox[]; nextCursor?: string }>(`${base(ctx)}/sandboxes?${q}`, { headers: auth(ctx) });
      if (!Array.isArray(page.sandboxes)) throw new Error("solari: unexpected response shape listing sandboxes");
      ids.push(...page.sandboxes.filter((s) => s.state !== "gone" && s.state !== "releasing").map((s) => s.sandboxId));
      cursor = page.nextCursor;
    } while (cursor);
    return ids;
  },
});
