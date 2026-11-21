// StateSet Sandbox (sandbox.stateset.app): cloud sandboxes for agents, isolated with gVisor (the
// only level its platform facts list, enforced). Hobby plan $0/month plus usage by the second:
// dedicated compute $0.128/vCPU-h + $0.0106/GB-h, billed at 50% of what is allocated (its
// estimate of average use), so $0.0746/h for 2 vCPU / 4 GB; shared (Spot) compute is cheaper
// but only with a subscription item, so this adapter asks for dedicated. Hobby: 10 at once,
// 45 minutes each, plus a monthly allowance (5 vCPU-hours, 420 GB-hours). New accounts get $25
// of trial credit after verifying their email; a card is needed before the first sandbox.
// REST: https://api.sandbox.stateset.app/api/v1 (`Authorization: ApiKey sk_…`, as the official
// SDK sends a non-JWT key), OpenAPI at api.sandbox.stateset.app/openapi.json; prices and limits
// at api.sandbox.stateset.app/api/v1/platform/facts; docs sandbox.stateset.app/llms.txt and
// sandbox.stateset.app/pricing. Request shapes follow npm `@stateset/sandbox-sdk` 2.17.0
// (dist/adapters/http-lifecycle-adapter.js, http-execution-adapter.js, transport/http-transport.js).
// Create takes an Idempotency-Key and answers once the sandbox runs (201); past the org's limit
// it may queue the request (202 `{status: "queued", request_id}`), which GET /requests/{id}
// resolves. 402 INSUFFICIENT_CREDITS / PAYMENT_REQUIRED, 429 concurrency limit. Stop deletes.

import { randomUUID } from "node:crypto";
import { defineProvider, http, httpJson, HttpError } from "./util.js";
import { pollMs, sleep } from "./rest-helpers.js";
import type { ProviderContext } from "../core/types.js";

const base = (ctx: ProviderContext) => `${String(ctx.env["STATESET_BASE_URL"] ?? "https://api.sandbox.stateset.app").replace(/\/+$/, "")}/api/v1`;
const auth = (ctx: ProviderContext) => {
  const key = String(ctx.env["STATESET_API_KEY"] ?? "");
  // The SDK sends a JWT as a bearer token and an API key under the `ApiKey` scheme.
  return { authorization: /^[\w-]+\.[\w-]+\.[\w-]+$/.test(key) ? `Bearer ${key}` : `ApiKey ${key}` };
};
const sb = (ctx: ProviderContext, id: string, path = "") => `${base(ctx)}/sandbox/${encodeURIComponent(id)}${path}`;
const gone = (err: unknown) => err instanceof HttpError && (err.status === 404 || err.status === 410);

interface Sandbox {
  sandbox_id: string;
  status: string;
  expires_at?: string;
  allocated_vcpu?: number;
  allocated_memory_gib?: number;
}
interface Queued {
  status: "queued";
  request_id: string;
  estimated_wait_seconds?: number;
}
const DEAD = ["terminating", "terminated", "error", "recovery_failed"];

/** CPU as a Kubernetes quantity and memory in Mi, as the create call takes them. */
export function statesetResources(cpu: number, memoryMiB: number): { cpus: string; memory: string } {
  return { cpus: String(Math.max(0.25, cpu)), memory: `${Math.max(128, Math.ceil(memoryMiB))}Mi` };
}

export const statesetProvider = defineProvider({
  info: {
    id: "stateset",
    name: "StateSet Sandbox",
    homepage: "https://sandbox.stateset.app",
    env: ["STATESET_API_KEY"],
    // An image is passed through when given, but its docs register custom images first, so
    // `customImage` is not claimed.
    capabilities: ["fileList", "extendTimeout"],
    isolation: "gvisor",
    maxTimeoutSec: 86_400,
    maxExecSec: 600,
    freeTier: {
      tier: { kind: "one-time-credit", usd: 25 },
      concurrency: 10,
      maxLifetimeSec: 2700,
      requiresCard: true,
      notes:
        "$25 of trial credit after verifying your email; a card must be on file before the first sandbox (not charged while trial credit lasts). The Hobby plan ($0/month) also includes 5 vCPU-hours and 420 GB-hours of dedicated compute a month, not counted here. Hobby: 10 at once, 45 minutes each.",
      source: "https://sandbox.stateset.app/pricing",
      checked: "2026-11-21",
    },
    // Dedicated compute on Hobby/Pro, billed at 50% of the allocated vCPU and memory.
    pricing: { vcpuSecondUsd: (0.128 * 0.5) / 3600, gibSecondUsd: (0.0106 * 0.5) / 3600, defaultCpu: 2, defaultMemoryMiB: 4096, source: "https://api.sandbox.stateset.app/api/v1/platform/facts" },
    surfaces: { rest: "https://api.sandbox.stateset.app/api/v1", sdk: ["@stateset/sandbox-sdk (npm)", "stateset-sandbox (PyPI)"], cli: "stateset (@stateset/sandbox-cli)", mcp: "@stateset/sandbox-mcp" },
  },

  async create(spec, ctx) {
    let r: Sandbox | Queued;
    r = await httpJson<Sandbox | Queued>(`${base(ctx)}/sandbox/create`, {
      headers: { ...auth(ctx), "idempotency-key": spec.metadata["sandboxrouting.id"] ?? randomUUID() },
      body: {
        ...statesetResources(spec.cpu, spec.memoryMiB),
        resource_class: "dedicated",
        timeout_seconds: Math.min(604_800, Math.max(60, Math.ceil(spec.timeoutSec))),
        env: spec.env,
        image: spec.nativeTemplate ? undefined : spec.image,
        template: spec.nativeTemplate,
      },
      timeoutMs: 300_000,
    });
    // A queued create runs when a slot frees; its stored response is the sandbox.
    for (let i = 0; i < 600 && r.status === "queued"; i++) {
      await sleep(pollMs(ctx, 1000));
      const q = await httpJson<{ status: string; response?: Sandbox & { error?: { message?: string } }; response_status?: number }>(
        `${base(ctx)}/requests/${encodeURIComponent((r as Queued).request_id)}`,
        { headers: auth(ctx) },
      );
      if (q.status === "completed" && q.response) r = q.response;
      else if (q.status === "failed" || q.status === "expired") throw new HttpError(q.response_status ?? 503, `stateset queued create ${q.status}: ${q.response?.error?.message ?? ""}`);
    }
    if (r.status === "queued") throw new HttpError(429, "stateset create still queued behind the concurrency limit");
    const made = r as Sandbox;
    try {
      let state = made;
      for (let i = 0; i < 300 && state.status !== "running"; i++) {
        if (DEAD.includes(state.status)) throw new Error(`stateset sandbox ${made.sandbox_id} is ${state.status}`);
        await sleep(pollMs(ctx, 1000));
        state = await httpJson<Sandbox>(sb(ctx, made.sandbox_id), { headers: auth(ctx) });
      }
      if (state.status !== "running") throw new Error(`stateset sandbox ${made.sandbox_id} did not start`);
    } catch (err) {
      // StateSet made it: never leave it running (and billing) when the create fails.
      await http(sb(ctx, made.sandbox_id, "/stop"), { method: "POST", headers: auth(ctx) }).catch(() => undefined);
      throw err;
    }
    return {
      providerSandboxId: made.sandbox_id,
      cpu: made.allocated_vcpu,
      memoryMiB: made.allocated_memory_gib === undefined ? undefined : Math.round(made.allocated_memory_gib * 1024),
    };
  },

  async exec(id, command, o, ctx) {
    // A string command runs in a shell; `timeout` is 1-600 s in milliseconds.
    const timeout = Math.min(600_000, Math.max(1000, Math.ceil((o.timeoutSec ?? 600) * 1000)));
    const r = await httpJson<{ exit_code: number; stdout: string; stderr: string; outcome?: string; system_error?: string; execution?: unknown }>(sb(ctx, id, "/execute"), {
      headers: { ...auth(ctx), "idempotency-key": randomUUID() },
      body: { command, working_dir: o.cwd, env: o.env, timeout, stream: false },
      timeoutMs: timeout + 60_000,
    });
    // A queued execute's stored result comes wrapped as `{ execution }`.
    const x = (r.execution ?? r) as typeof r;
    if (x.outcome === "unknown") throw new Error(`stateset exec on ${id}: outcome unknown (${x.system_error ?? "connection lost"})`);
    if (x.stdout) o.onStdout?.(x.stdout);
    if (x.stderr) o.onStderr?.(x.stderr);
    return { stdout: x.stdout ?? "", stderr: x.stderr ?? "", exitCode: x.exit_code };
  },

  async readFile(id, path, ctx) {
    const r = await httpJson<{ content: string }>(`${sb(ctx, id, "/files")}?path=${encodeURIComponent(path)}`, { headers: auth(ctx) });
    return new Uint8Array(Buffer.from(r.content, "base64"));
  },

  async writeFile(id, path, data, ctx) {
    await http(sb(ctx, id, "/files"), { headers: auth(ctx), body: { files: [{ path, content: Buffer.from(data).toString("base64") }] } });
  },

  async listFiles(id, path, ctx) {
    const r = await httpJson<{ files: { name: string; path: string; type: string; size?: number }[] }>(`${sb(ctx, id, "/files/list")}?path=${encodeURIComponent(path)}`, {
      headers: auth(ctx),
    });
    return r.files.map((f) => ({ name: f.name, path: f.path, isDir: f.type === "directory", size: f.size }));
  },

  async setTimeout(id, timeoutSec, ctx) {
    // Extending adds seconds to the deadline (60 at least, capped by the plan): add what moves
    // it to now + timeoutSec. A later deadline is left as it is.
    const cur = await httpJson<Sandbox>(sb(ctx, id), { headers: auth(ctx) });
    const expires = Date.parse(cur.expires_at ?? "");
    const left = Number.isFinite(expires) ? (expires - Date.now()) / 1000 : 0;
    const add = Math.ceil(timeoutSec - left);
    if (add <= 0) return;
    await http(sb(ctx, id, "/extend"), { headers: auth(ctx), body: { additional_seconds: Math.min(86_400, Math.max(60, add)) } });
  },

  async kill(id, ctx) {
    // Stop deletes the sandbox; 404 is already gone.
    await http(sb(ctx, id, "/stop"), { method: "POST", headers: auth(ctx) }).catch((err) => {
      if (!gone(err)) throw err;
    });
  },

  async listAlive(ctx) {
    const ids: string[] = [];
    for (let offset = 0, page = 0; page < 100; page++) {
      const r = await httpJson<{ sandboxes: Sandbox[]; pagination?: { has_more?: boolean } }>(`${base(ctx)}/sandboxes?limit=100&offset=${offset}`, { headers: auth(ctx) });
      for (const s of r.sandboxes) if (!DEAD.includes(s.status)) ids.push(s.sandbox_id);
      if (!r.pagination?.has_more || r.sandboxes.length === 0) break;
      offset += r.sandboxes.length;
    }
    return ids;
  },
});
