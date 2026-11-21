// Sandbox0 (sandbox0.ai): persistent agent sandboxes in gVisor that pause idle compute and keep
// the whole writable root filesystem. Billed on memory only, $0.015 per GiB-hour of running time
// (CPU follows memory and isn't charged); paused sandboxes pay only storage ($0.02/GiB-month).
// A one-time $5 credit with a saved card. 20 running sandboxes per team by default.
// REST: https://api.sandbox0.ai/api/v1 (Bearer token), OpenAPI in the JS SDK repository
// (github.com/sandbox0-ai/sdk-js/blob/main/openapi.yaml); docs sandbox0.ai/docs/sandbox.md,
// sandbox0.ai/docs/sandbox/contexts.md, sandbox0.ai/docs/sandbox/files.md, pricing
// sandbox0.ai/pricing. SDKs `sandbox0` (npm, Go, PyPI), CLI `s0`.
// Every sandbox is claimed from a template (`default` unless the spec names one); there is no
// idempotency key on claim. `hard_ttl` deletes the sandbox at the deadline (`ttl` would only
// pause it). A command is a `cmd` context created with `wait_until_done`, which the gateway
// holds for at most five minutes. Responses are `{success, data}`; errors `{success, error}`.
// Team quotas (running sandboxes, claim rate) answer 429 `quota_exceeded`.

import { defineProvider, http, httpJson, HttpError } from "./util.js";
import { pollMs, sleep } from "./rest-helpers.js";
import type { ProviderContext } from "../core/types.js";

const base = (ctx: ProviderContext) => String(ctx.env["SANDBOX0_BASE_URL"] ?? "https://api.sandbox0.ai").replace(/\/+$/, "");
const auth = (ctx: ProviderContext) => ({ authorization: `Bearer ${ctx.env["SANDBOX0_TOKEN"]}` });
const sb = (ctx: ProviderContext, id: string, path = "") => `${base(ctx)}/api/v1/sandboxes/${encodeURIComponent(id)}${path}`;
const gone = (err: unknown) => err instanceof HttpError && (err.status === 404 || err.status === 410);

const EXEC_LIMIT_SEC = 300;

interface Envelope<T> {
  success: boolean;
  data: T;
}
interface Status {
  sandbox_id?: string;
  status?: string;
}

export const sandbox0Provider = defineProvider({
  info: {
    id: "sandbox0",
    name: "Sandbox0",
    homepage: "https://sandbox0.ai",
    env: ["SANDBOX0_TOKEN"],
    capabilities: ["pause", "snapshot", "fileList", "extendTimeout"],
    isolation: "gvisor",
    maxExecSec: EXEC_LIMIT_SEC,
    freeTier: {
      tier: { kind: "one-time-credit", usd: 5 },
      concurrency: 20,
      requiresCard: true,
      notes: "A one-time $5 usage credit per user and team; a saved card is required (adding it charges nothing). 20 running sandboxes per team by default.",
      source: "https://sandbox0.ai/pricing",
      checked: "2026-11-21",
    },
    pricing: { vcpuSecondUsd: 0, gibSecondUsd: 0.015 / 3600, defaultCpu: 2, defaultMemoryMiB: 4096, source: "https://sandbox0.ai/pricing" },
    surfaces: { rest: "https://api.sandbox0.ai/api/v1", sdk: ["sandbox0 (npm)", "sandbox0 (PyPI)", "github.com/sandbox0-ai/sdk-go"], cli: "s0" },
  },

  async create(spec, ctx) {
    // CPU is derived from memory, so only memory is asked for.
    const memoryMiB = Math.max(128, Math.ceil(spec.memoryMiB));
    const r = await httpJson<Envelope<Status>>(`${base(ctx)}/api/v1/sandboxes`, {
      headers: auth(ctx),
      body: {
        template: spec.nativeTemplate ?? "default",
        config: { env_vars: spec.env, hard_ttl: Math.ceil(spec.timeoutSec), resources: { memory: `${memoryMiB}Mi` } },
      },
      timeoutMs: 300_000,
    });
    const id = r.data.sandbox_id;
    if (!id) throw new Error("sandbox0 claim returned no sandbox_id");
    try {
      let state = r.data.status ?? "starting";
      for (let i = 0; i < 600 && state !== "running"; i++) {
        if (state === "failed" || state === "terminating" || state === "paused") throw new Error(`sandbox0 sandbox ${id} is ${state}`);
        await sleep(pollMs(ctx, 1000));
        state = (await httpJson<Envelope<Status>>(sb(ctx, id, "/status"), { headers: auth(ctx) })).data.status ?? "";
      }
      if (state !== "running") throw new Error(`sandbox0 sandbox ${id} did not start`);
    } catch (err) {
      // Sandbox0 made it: never leave it running (and billing) when the create fails.
      await http(sb(ctx, id), { method: "DELETE", headers: auth(ctx) }).catch(() => undefined);
      throw err;
    }
    return { providerSandboxId: id, memoryMiB };
  },

  async exec(id, command, o, ctx) {
    const timeoutSec = Math.min(EXEC_LIMIT_SEC, Math.max(1, Math.ceil(o.timeoutSec ?? EXEC_LIMIT_SEC)));
    const r = await httpJson<Envelope<{ id: string; stdout?: string; stderr?: string; output_raw?: string; exit_code?: number; state?: string }>>(sb(ctx, id, "/contexts"), {
      headers: auth(ctx),
      body: { type: "cmd", cmd: { command: ["sh", "-c", command] }, cwd: o.cwd, env_vars: o.env, wait_until_done: true, ttl_sec: timeoutSec },
      timeoutMs: (timeoutSec + 30) * 1000,
    });
    const d = r.data;
    // Older servers fill only the merged `output_raw`.
    const stdout = d.stdout || d.stderr ? d.stdout ?? "" : d.output_raw ?? "";
    const stderr = d.stderr ?? "";
    if (stdout) o.onStdout?.(stdout);
    if (stderr) o.onStderr?.(stderr);
    // No exit code means the process didn't finish: `ttl_sec` stopped it.
    return { stdout, stderr, exitCode: d.exit_code ?? 124 };
  },

  async readFile(id, path, ctx) {
    const res = await http(`${sb(ctx, id, "/files")}?path=${encodeURIComponent(path)}`, { headers: { ...auth(ctx), accept: "application/octet-stream" } });
    return new Uint8Array(await res.arrayBuffer());
  },

  async writeFile(id, path, data, ctx) {
    // Up to 100 MiB of raw bytes.
    await http(`${sb(ctx, id, "/files")}?path=${encodeURIComponent(path)}`, {
      method: "POST",
      headers: { ...auth(ctx), "content-type": "application/octet-stream" },
      raw: data,
    });
  },

  async listFiles(id, path, ctx) {
    const r = await httpJson<Envelope<{ entries?: { name: string; path?: string; type?: string; size?: number }[] }>>(
      `${sb(ctx, id, "/files/list")}?path=${encodeURIComponent(path)}`,
      { headers: auth(ctx) },
    );
    const dir = path.replace(/\/+$/, "");
    return (r.data.entries ?? []).map((e) => ({ name: e.name, path: e.path ?? `${dir}/${e.name}`, isDir: e.type === "dir", size: e.size }));
  },

  async setTimeout(id, timeoutSec, ctx) {
    // Resets the hard TTL to now + duration.
    await http(sb(ctx, id, "/refresh"), { headers: auth(ctx), body: { duration: Math.ceil(timeoutSec) } });
  },

  async pause(id, ctx) {
    await http(sb(ctx, id, "/pause"), { method: "POST", headers: auth(ctx) });
  },

  async resume(id, ctx) {
    await http(sb(ctx, id, "/resume"), { method: "POST", headers: auth(ctx) });
  },

  async kill(id, ctx) {
    // 202: deletion is durable, teardown finishes in the background. 404: already gone.
    await http(sb(ctx, id), { method: "DELETE", headers: auth(ctx) }).catch((err) => {
      if (!gone(err)) throw err;
    });
  },

  async listAlive(ctx) {
    const ids: string[] = [];
    for (let offset = 0, page = 0; page < 100; page++) {
      const q = new URLSearchParams({ limit: "200", offset: String(offset) });
      const r = await httpJson<Envelope<{ sandboxes: { id: string; status?: string }[]; has_more?: boolean }>>(`${base(ctx)}/api/v1/sandboxes?${q}`, { headers: auth(ctx) });
      for (const s of r.data.sandboxes) if (s.status !== "terminating" && s.status !== "failed") ids.push(s.id);
      if (!r.data.has_more || r.data.sandboxes.length === 0) break;
      offset += r.data.sandboxes.length;
    }
    return ids;
  },
});
