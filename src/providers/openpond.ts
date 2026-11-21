// OpenPond Sandboxes (openpond.ai): isolated sandboxes behind OpenPond's agent platform, billed per
// second while running: $0.072 per vCPU-hour, $0.0234 per GiB-hour and $0.00012 per GiB-hour of VM
// disk ($0.24/h for the 2 vCPU / 4 GiB / 20 GiB Builder tier). Free plan: "limited monthly usage"
// (amount unpublished), 1 concurrent sandbox, 5 retained; Pro $20/month includes $20 of usage and
// 10 concurrent. A stopped sandbox keeps its disk (billed); only delete releases it.
// REST: https://api.openpond.ai/v1/sandboxes (an `opk_…` API key). The docs make the server-side
// SDK (`openpond-sdk`) the supported contract, so the wire format here is read from its source
// (npm `openpond-sdk` 0.13.4, OpenPondSandboxInstanceClient, and types under dist/types). Docs:
// openpond.ai/docs/services/reference/sandbox-api, /docs/services/sandbox-compute/pricing-and-budgets,
// /docs/services/sandbox-compute/files-processes-and-previews, openpond.ai/llms.txt.
// Exec takes only a command and a timeout and returns one combined output, so cwd and env are
// inlined and everything lands in stdout. File paths are relative to the sandbox workspace, so
// files use the router's exec fallback. Resource tiers run on several "qualified runtimes" whose
// isolation isn't published. `maxDurationSeconds` stops a sandbox rather than deleting it, so the
// router deletes at the deadline (enforcesTimeout: false).

import { defineProvider, http, httpJson, HttpError } from "./util.js";
import { inline, pollMs, sleep } from "./rest-helpers.js";
import type { ProviderContext } from "../core/types.js";

const VCPU_HOUR = 0.072;
const GIB_HOUR = 0.0234;

const base = (ctx: ProviderContext) => String(ctx.env["OPENPOND_API_URL"] ?? "https://api.openpond.ai").replace(/\/+$/, "");
/** As the SDK sends an `opk_` key: `ApiKey` scheme plus the `openpond-api-key` header. */
const auth = (ctx: ProviderContext): Record<string, string> => {
  const key = String(ctx.env["OPENPOND_API_KEY"] ?? "").trim();
  return key.startsWith("opk_") ? { authorization: `ApiKey ${key}`, "openpond-api-key": key } : { authorization: `Bearer ${key}` };
};
const box = (ctx: ProviderContext, id = "", path = "") => `${base(ctx)}/v1/sandboxes${id ? `/${encodeURIComponent(id)}` : ""}${path}`;
const gone = (err: unknown) => err instanceof HttpError && (err.status === 404 || err.status === 410);

/** The published resource tiers, smallest that fits. */
export function openpondTier(cpu: number, memoryMiB: number): { cpu: number; memoryGb: number; diskGb: number } {
  const tiers = [
    { cpu: 0.25, memoryGb: 0.5, diskGb: 4 },
    { cpu: 0.5, memoryGb: 1, diskGb: 8 },
    { cpu: 1, memoryGb: 2, diskGb: 10 },
    { cpu: 2, memoryGb: 4, diskGb: 20 },
    { cpu: 4, memoryGb: 8, diskGb: 40 },
  ];
  return tiers.find((t) => t.cpu >= cpu && t.memoryGb * 1024 >= memoryMiB) ?? tiers[tiers.length - 1]!;
}

interface Sandbox {
  id: string;
  state: string;
  resources?: { cpu: number; memoryGb: number };
}

export const openpondProvider = defineProvider({
  info: {
    id: "openpond",
    name: "OpenPond Sandboxes",
    homepage: "https://openpond.ai",
    env: ["OPENPOND_API_KEY"],
    capabilities: ["ports", "pause", "snapshot"],
    enforcesTimeout: false,
    freeTier: {
      tier: { kind: "none" },
      concurrency: 1,
      notes: "Free plan: \"limited monthly usage\" (amount unpublished), 1 concurrent sandbox, 5 retained, so nothing is counted as free. Pro ($20/month) includes $20 of usage and 10 concurrent.",
      source: "https://openpond.ai/docs/services/sandbox-compute/pricing-and-budgets",
      checked: "2026-11-21",
    },
    // VM disk ($0.00012/GiB-h, 20 GiB at the Builder tier) is left out: $0.2376 of the $0.24/h.
    pricing: { vcpuSecondUsd: VCPU_HOUR / 3600, gibSecondUsd: GIB_HOUR / 3600, defaultCpu: 2, defaultMemoryMiB: 4096, source: "https://openpond.ai/docs/services/sandbox-compute/pricing-and-budgets" },
    surfaces: { rest: "https://api.openpond.ai/v1/sandboxes (the SDK's contract)", sdk: ["openpond-sdk (npm)"] },
  },

  async create(spec, ctx) {
    const resources = openpondTier(spec.cpu, spec.memoryMiB);
    const duration = Math.max(60, Math.ceil(spec.timeoutSec));
    // The reservation and the spend cap cover the lifetime asked for, with a quarter to spare.
    const maxUsd = Math.max(0.01, ((resources.cpu * VCPU_HOUR + resources.memoryGb * GIB_HOUR) * duration * 1.25) / 3600).toFixed(2);
    const r = await httpJson<{ sandbox: Sandbox }>(box(ctx), {
      headers: auth(ctx),
      body: {
        resources,
        budget: { maxUsd },
        quotas: { maxSpendUsd: maxUsd, maxDurationSeconds: duration, idleTimeoutSeconds: duration },
        env: Object.entries(spec.env).map(([name, value]) => ({ name, value })),
        metadata: spec.metadata,
      },
      timeoutMs: 180_000,
    });
    const id = r.sandbox.id;
    try {
      let cur = r.sandbox;
      for (let i = 0; i < 600 && cur.state !== "running"; i++) {
        if (cur.state !== "creating") throw new Error(`openpond sandbox ${id} is ${cur.state}`);
        await sleep(pollMs(ctx, 1000));
        cur = (await httpJson<{ sandbox: Sandbox }>(box(ctx, id), { headers: auth(ctx) })).sandbox;
      }
      if (cur.state !== "running") throw new Error(`openpond sandbox ${id} did not start`);
    } catch (err) {
      await http(box(ctx, id), { method: "DELETE", headers: auth(ctx) }).catch(() => undefined);
      throw err;
    }
    return { providerSandboxId: id, cpu: resources.cpu, memoryMiB: resources.memoryGb * 1024 };
  },

  async exec(id, command, o, ctx) {
    const timeoutSeconds = o.timeoutSec ? Math.max(1, Math.ceil(o.timeoutSec)) : undefined;
    const r = await httpJson<{ command: { status: string; output: string; exitCode: number | null } }>(box(ctx, id, "/exec"), {
      headers: auth(ctx),
      body: { command: inline(command, o), ...(timeoutSeconds ? { timeoutSeconds } : {}) },
      timeoutMs: ((timeoutSeconds ?? 3600) + 60) * 1000,
    });
    const out = r.command.output ?? "";
    if (out) o.onStdout?.(out);
    // One combined stream. No exit code: failed to start, or still running when the timeout hit.
    const st = r.command.status;
    return { stdout: out, stderr: "", exitCode: r.command.exitCode ?? (st === "succeeded" ? 0 : st === "failed" || st === "skipped" ? 1 : 124) };
  },

  async getUrl(id, port, ctx) {
    return (await httpJson<{ preview: { url: string } }>(box(ctx, id, "/ports"), { headers: auth(ctx), body: { port, access: "public" } })).preview.url;
  },

  async pause(id, ctx) {
    // Ends compute billing; the sandbox's disk is kept (and billed) until it starts or is deleted.
    await http(box(ctx, id, "/stop"), { method: "POST", headers: auth(ctx), timeoutMs: 180_000 });
  },

  async resume(id, ctx) {
    await http(box(ctx, id, "/start"), { method: "POST", headers: auth(ctx), timeoutMs: 180_000 });
  },

  async kill(id, ctx) {
    await http(box(ctx, id), { method: "DELETE", headers: auth(ctx), timeoutMs: 180_000 }).catch((err) => {
      if (!gone(err)) throw err;
    });
  },

  async listAlive(ctx) {
    const r = await httpJson<{ sandboxes: Sandbox[] }>(box(ctx), { headers: auth(ctx) });
    return r.sandboxes.filter((s) => s.state !== "deleted" && s.state !== "archived").map((s) => s.id);
  },
});
