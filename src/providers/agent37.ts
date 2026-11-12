// Agent37 (YC F26): gVisor-isolated persistent sandboxes on Hetzner/OVH, billed per minute.
// Free: $5 one-time once a card is on file; 3 awake instances before the first top-up.
// Control API https://api.agent37.com/v1 (Bearer sk_live_…); exec API https://sandbox.agent37.app
// (X-Agent37-Key). No TTL, only idle auto-sleep, so the router deletes instances at the
// deadline (enforcesTimeout: false). Files only work on agent templates, so they go
// through exec here.

import { defineProvider, http, httpJson } from "./util.js";
import { inline } from "./rest-helpers.js";
import type { ProviderContext } from "../core/types.js";

const control = (ctx: ProviderContext) => String(ctx.env["AGENT37_API_URL"] ?? "https://api.agent37.com/v1").replace(/\/+$/, "");
const execBase = (ctx: ProviderContext) => String(ctx.env["AGENT37_EXEC_URL"] ?? "https://sandbox.agent37.app").replace(/\/+$/, "");
const key = (ctx: ProviderContext) => String(ctx.env["AGENT37_API_KEY"]);

interface Instance {
  id: string;
  status?: string;
  state?: string;
}

export const agent37Provider = defineProvider({
  info: {
    id: "agent37",
    name: "Agent37",
    homepage: "https://www.agent37.com",
    env: ["AGENT37_API_KEY"],
    capabilities: ["ports"],
    isolation: "gvisor",
    enforcesTimeout: false,
    freeTier: {
      tier: { kind: "one-time-credit", usd: 5 },
      concurrency: 3,
      requiresCard: true,
      notes: "$5 one-time once a card is on file (not for API-created accounts); 3 awake instances before the first top-up.",
      source: "https://www.agent37.com/docs/agents-api/billing.md",
      checked: "2026-11-11",
    },
    pricing: { vcpuSecondUsd: 0.0011 / 3600, gibSecondUsd: 0.00096 / 3600, defaultCpu: 1, defaultMemoryMiB: 2048, source: "https://www.agent37.com/docs/agents-api/billing.md" },
    surfaces: { rest: "https://api.agent37.com/v1 + https://sandbox.agent37.app", sdk: ["agent37.py (single file)"], cli: "agent37 (npm, UNVERIFIED)" },
  },

  async create(spec, ctx) {
    // 201 once the instance is running.
    const inst = await httpJson<Instance>(`${control(ctx)}/instances`, {
      headers: { authorization: `Bearer ${key(ctx)}` },
      body: {
        template: spec.nativeTemplate ?? String(ctx.options["template"] ?? "agent37-base"),
        resources: { cpu: Math.max(1, Math.round(spec.cpu)), memory: Math.max(1, Math.round(spec.memoryMiB / 1024)) },
        env: spec.env,
        region: spec.region,
        auto_sleep: false,
      },
      timeoutMs: 300_000,
    });
    return { providerSandboxId: inst.id };
  },

  async exec(id, command, o, ctx) {
    // No cwd/env/timeout fields: inlined. Non-zero exits are still HTTP 200.
    const r = await httpJson<{ exit_code: number; stdout: string; stderr: string }>(`${execBase(ctx)}/v1/instances/${encodeURIComponent(id)}/exec`, {
      headers: { "x-agent37-key": key(ctx) },
      body: { command: inline(command, o) },
      timeoutMs: 16 * 60_000,
    });
    if (r.stdout) o.onStdout?.(r.stdout);
    if (r.stderr) o.onStderr?.(r.stderr);
    return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exit_code };
  },

  async getUrl(id, port, ctx) {
    // Port URLs need a key header unless signed; ask for a signed URL (body shape UNVERIFIED).
    const r = await httpJson<{ url?: string }>(`${control(ctx)}/instances/${encodeURIComponent(id)}/signed-url`, {
      headers: { authorization: `Bearer ${key(ctx)}` },
      body: { port },
    });
    return r.url ?? `https://${id}-${port}.agent37.app`;
  },

  async kill(id, ctx) {
    await http(`${control(ctx)}/instances/${encodeURIComponent(id)}`, { method: "DELETE", headers: { authorization: `Bearer ${key(ctx)}` } });
  },

  async listAlive(ctx) {
    const r = await httpJson<{ data: Instance[] }>(`${control(ctx)}/instances`, { headers: { authorization: `Bearer ${key(ctx)}` } });
    return r.data.filter((x) => !/delet|fail/i.test(x.status ?? x.state ?? "")).map((x) => x.id);
  },
});
