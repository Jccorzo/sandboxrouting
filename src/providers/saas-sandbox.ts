// Sandbox as a Service (sandbox-as-a-service.com): disposable sandboxes, each a dedicated VM, in
// three sizes. Prepaid credit billed by the second: small (2 vCPU / 4 GB) $0.09/h, medium
// (4 vCPU / 8 GB) $0.28/h, large (8 vCPU / 16 GB) $0.55/h. New accounts get $5, no card.
// 20 sandboxes at once, 1,440 minutes at most (extensions included), 10 minutes per command.
// REST: https://sandbox-as-a-service.com/v1 (Bearer aas_sk_…), OpenAPI at
// sandbox-as-a-service.com/openapi.json; llms.txt at sandbox-as-a-service.com/llms.txt; limits at
// sandbox-as-a-service.com/docs/limits. npm `sandbox-as-a-service`, PyPI `sandbox-as-a-service`,
// MCP https://sandbox-as-a-service.com/v1/mcp (its local server reads AAS_API_KEY, as this does).
// Errors are `{"error": {"type", "message"}}`: 402 out of credit, 429 rate or concurrency limit,
// 403 a suspended account. Create answers once the sandbox is ready (201), or 200 with the
// existing sandbox when an Idempotency-Key is reused.

import { randomUUID } from "node:crypto";
import { defineProvider, http, httpJson, HttpError } from "./util.js";
import { pollMs, sleep } from "./rest-helpers.js";
import type { ProviderContext } from "../core/types.js";

const base = (ctx: ProviderContext) => String(ctx.env["AAS_API_URL"] ?? "https://sandbox-as-a-service.com/v1").replace(/\/+$/, "");
const auth = (ctx: ProviderContext) => ({ authorization: `Bearer ${ctx.env["AAS_API_KEY"]}` });
const box = (ctx: ProviderContext, id: string, path = "") => `${base(ctx)}/sandboxes/${encodeURIComponent(id)}${path}`;
const gone = (err: unknown) => err instanceof HttpError && (err.status === 404 || err.status === 410);

/** The three sizes: the smallest that has the vCPUs and memory asked for. */
export function saasSize(cpu: number, memoryMiB: number): { size: string; cpu: number; memoryMiB: number } {
  if (cpu <= 2 && memoryMiB <= 4096) return { size: "small", cpu: 2, memoryMiB: 4096 };
  if (cpu <= 4 && memoryMiB <= 8192) return { size: "medium", cpu: 4, memoryMiB: 8192 };
  return { size: "large", cpu: 8, memoryMiB: 16384 };
}

interface Sandbox {
  id: string;
  status: string;
  expires_at?: string;
}
const DEAD = ["failed", "deleting", "deleted"];

export const saasSandboxProvider = defineProvider({
  info: {
    id: "saas-sandbox",
    name: "Sandbox as a Service",
    homepage: "https://sandbox-as-a-service.com",
    env: ["AAS_API_KEY"],
    capabilities: ["ports", "fileList", "extendTimeout"],
    isolation: "vm",
    maxTimeoutSec: 1440 * 60,
    maxExecSec: 600,
    freeTier: {
      tier: { kind: "one-time-credit", usd: 5 },
      concurrency: 20,
      maxLifetimeSec: 1440 * 60,
      requiresCard: false,
      notes: "New accounts get $5 of credit, no card. 20 sandboxes at once, 24 h each at most, 10 minutes per command.",
      source: "https://sandbox-as-a-service.com/pricing",
      checked: "2026-11-21",
    },
    // Flat per size; small ($0.09/h for 2 vCPU / 4 GB) split as 2:1 vCPU-hour to GiB-hour, as miosa does.
    pricing: { vcpuSecondUsd: 0.09 / 4 / 3600, gibSecondUsd: 0.09 / 8 / 3600, defaultCpu: 2, defaultMemoryMiB: 4096, source: "https://sandbox-as-a-service.com/pricing" },
    surfaces: {
      rest: "https://sandbox-as-a-service.com/v1",
      sdk: ["sandbox-as-a-service (npm)", "sandbox-as-a-service (PyPI)"],
      mcp: "https://sandbox-as-a-service.com/v1/mcp",
    },
  },

  async create(spec, ctx) {
    const size = saasSize(spec.cpu, spec.memoryMiB);
    const r = await httpJson<Sandbox>(`${base(ctx)}/sandboxes`, {
      headers: { ...auth(ctx), "idempotency-key": spec.metadata["sandboxrouting.id"] ?? randomUUID() },
      body: {
        size: size.size,
        name: spec.metadata["sandboxrouting.id"],
        timeout_minutes: Math.min(1440, Math.max(1, Math.ceil(spec.timeoutSec / 60))),
        snapshot_id: spec.nativeTemplate,
      },
      timeoutMs: 300_000,
    });
    try {
      let state = r;
      for (let i = 0; i < 300 && state.status !== "running"; i++) {
        if (DEAD.includes(state.status)) throw new Error(`saas-sandbox ${r.id} is ${state.status}`);
        await sleep(pollMs(ctx, 1000));
        state = await httpJson<Sandbox>(box(ctx, r.id), { headers: auth(ctx) });
      }
      if (state.status !== "running") throw new Error(`saas-sandbox ${r.id} did not start`);
    } catch (err) {
      // The provider made it: never leave it running (and billing) when the create fails.
      await http(box(ctx, r.id), { method: "DELETE", headers: auth(ctx) }).catch(() => undefined);
      throw err;
    }
    return { providerSandboxId: r.id, cpu: size.cpu, memoryMiB: size.memoryMiB };
  },

  async exec(id, command, o, ctx) {
    // `command` runs in a shell; at most 10 minutes, killed with exit 124 past its timeout.
    const timeout_ms = Math.min(600_000, Math.max(1000, Math.ceil((o.timeoutSec ?? 600) * 1000)));
    const r = await httpJson<{ status?: string; exit_code: number; stdout: string; stderr: string }>(box(ctx, id, "/exec"), {
      headers: auth(ctx),
      body: { command, cwd: o.cwd, env: o.env, timeout_ms },
      timeoutMs: timeout_ms + 60_000,
    });
    if (r.stdout) o.onStdout?.(r.stdout);
    if (r.stderr) o.onStderr?.(r.stderr);
    return { stdout: r.stdout, stderr: r.stderr, exitCode: r.status === "timeout" && r.exit_code === 0 ? 124 : r.exit_code };
  },

  async readFile(id, path, ctx) {
    const q = new URLSearchParams({ path, encoding: "base64" });
    const r = await httpJson<{ object: string; content: string; encoding?: string }>(`${box(ctx, id, "/files")}?${q}`, { headers: auth(ctx) });
    if (r.object !== "file") throw new Error(`saas-sandbox: ${path} is not a file`);
    return r.encoding === "utf8" ? new TextEncoder().encode(r.content) : new Uint8Array(Buffer.from(r.content, "base64"));
  },

  async writeFile(id, path, data, ctx) {
    await http(box(ctx, id, "/files"), {
      method: "PUT",
      headers: auth(ctx),
      body: { path, content: Buffer.from(data).toString("base64"), encoding: "base64" },
    });
  },

  async listFiles(id, path, ctx) {
    const q = new URLSearchParams({ path, list: "true" });
    const r = await httpJson<{ path?: string; entries: { name: string; type: string; size_bytes?: number | null }[] }>(`${box(ctx, id, "/files")}?${q}`, {
      headers: auth(ctx),
    });
    const dir = (r.path ?? path).replace(/\/+$/, "");
    return r.entries.map((e) => ({ name: e.name, path: `${dir}/${e.name}`, isDir: e.type === "dir", size: e.size_bytes ?? undefined }));
  },

  async getUrl(id, port, ctx) {
    // The URL carries an unguessable token; asking again for the same port returns the same URL.
    return (await httpJson<{ url: string }>(box(ctx, id, "/ports"), { headers: auth(ctx), body: { port } })).url;
  },

  async setTimeout(id, timeoutSec, ctx) {
    // Extending adds minutes to the current deadline, so add what moves it to now + timeoutSec.
    // It can't shorten one: a later deadline is left as it is.
    const cur = await httpJson<Sandbox>(box(ctx, id), { headers: auth(ctx) });
    const expires = Date.parse(cur.expires_at ?? "");
    const left = Number.isFinite(expires) ? (expires - Date.now()) / 1000 : 0;
    const additional_minutes = Math.ceil((timeoutSec - left) / 60);
    if (additional_minutes < 1) return;
    await http(box(ctx, id, "/extend"), { headers: auth(ctx), body: { additional_minutes: Math.min(1440, additional_minutes) } });
  },

  async kill(id, ctx) {
    // 200 deleted, or 202 when teardown finishes in the background; 404 is already gone.
    await http(box(ctx, id), { method: "DELETE", headers: auth(ctx) }).catch((err) => {
      if (!gone(err)) throw err;
    });
  },

  async listAlive(ctx) {
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const q = new URLSearchParams({ limit: "100", ...(cursor ? { starting_after: cursor } : {}) });
      const page: { data: Sandbox[]; has_more?: boolean; next_cursor?: string } = await httpJson(`${base(ctx)}/sandboxes?${q}`, { headers: auth(ctx) });
      for (const s of page.data) if (!DEAD.includes(s.status)) ids.push(s.id);
      cursor = page.has_more ? page.next_cursor ?? page.data.at(-1)?.id : undefined;
    } while (cursor);
    return ids;
  },
});
