// Celesto cloud computers: Firecracker microVMs for agents. Free: $5 one-time credit, no card
// (expires 30 days after activation; one retained Micro sandbox). No TTL, no env at create
// and no files API, so env goes into each command, files go through the exec fallback, and
// the router deletes computers at the deadline (enforcesTimeout: false).
// SDK: npm `@celestoai/sdk` (https://api.celesto.ai/v1, Bearer). CLI: `celesto computer`.
// MCP: https://mcp.celesto.ai/mcp.

import { defineProvider, loadSdk } from "./util.js";
import { shellQuote } from "../core/sandbox.js";
import type { ProviderContext } from "../core/types.js";

type CelestoSdk = typeof import("@celestoai/sdk");
type CComputer = Awaited<ReturnType<CelestoSdk["Computer"]["get"]>>;

const cache = new Map<string, CComputer>();
const sdk = () => loadSdk<CelestoSdk>("@celestoai/sdk", "celesto");
const config = (ctx: ProviderContext) => ({ apiKey: ctx.env["CELESTO_API_KEY"], baseUrl: ctx.env["CELESTO_BASE_URL"] });

async function get(id: string, ctx: ProviderContext): Promise<CComputer> {
  const hit = cache.get(id);
  if (hit) return hit;
  const c = await (await sdk()).Computer.get(id, config(ctx));
  cache.set(id, c);
  return c;
}

/** Env the computer should carry, kept per process because Celesto has no create-time env. */
const createEnv = new Map<string, Record<string, string>>();

export const celestoProvider = defineProvider({
  info: {
    id: "celesto",
    name: "Celesto",
    homepage: "https://celesto.ai",
    env: ["CELESTO_API_KEY"],
    sdkPackage: "@celestoai/sdk",
    capabilities: ["customImage", "ports", "pause"],
    enforcesTimeout: false,
    freeTier: {
      tier: { kind: "one-time-credit", usd: 5 },
      concurrency: 1,
      requiresCard: false,
      notes: "$5 one-time Micro credit, no card, expires 30 days after activation; one retained Micro sandbox.",
      source: "https://celesto.ai/pricing",
      checked: "2026-11-11",
    },
    // Micro 1 vCPU / 2 GB = $0.015/h and Standard 2 vCPU / 4 GB = $0.03/h fit $0.0075/vCPU-h + $0.00375/GB-h.
    pricing: { vcpuSecondUsd: 0.0075 / 3600, gibSecondUsd: 0.00375 / 3600, defaultCpu: 1, defaultMemoryMiB: 2048, source: "https://celesto.ai/pricing" },
    surfaces: { rest: "https://api.celesto.ai/v1", sdk: ["@celestoai/sdk (npm)", "celesto (PyPI)"], cli: "celesto", mcp: "https://mcp.celesto.ai/mcp" },
  },

  async create(spec, ctx) {
    const { Computer } = await sdk();
    const c = await Computer.create(
      {
        vcpus: Math.max(1, Math.round(spec.cpu)),
        ramMb: spec.memoryMiB,
        image: spec.image,
        templateId: spec.nativeTemplate,
      },
      config(ctx),
    );
    cache.set(c.id, c);
    if (Object.keys(spec.env).length) createEnv.set(c.id, spec.env);
    return { providerSandboxId: c.id, cpu: c.vcpus, memoryMiB: c.ramMb };
  },

  async exec(id, command, o, ctx) {
    const env = { ...createEnv.get(id), ...o.env };
    const prefix = Object.entries(env).map(([k, v]) => `export ${k}=${shellQuote(v)}; `).join("");
    const cd = o.cwd ? `cd ${shellQuote(o.cwd)} && ` : "";
    const r = await (await get(id, ctx)).run(`sh -c ${shellQuote(`${prefix}${cd}${command}`)}`, { timeout: o.timeoutSec });
    if (r.stdout) o.onStdout?.(r.stdout);
    if (r.stderr) o.onStderr?.(r.stderr);
    return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode };
  },

  async getUrl(id, port, ctx) {
    const url = await (await get(id, ctx)).publishPort(port);
    if (!url) throw new Error(`celesto did not return a URL for port ${port}`);
    return url;
  },

  async pause(id, ctx) {
    await (await get(id, ctx)).stop();
  },

  async resume(id, ctx) {
    await (await get(id, ctx)).start();
  },

  async kill(id, ctx) {
    const c = await get(id, ctx);
    cache.delete(id);
    createEnv.delete(id);
    await c.delete();
  },

  async listAlive(ctx) {
    const all = await (await sdk()).Computer.list({}, config(ctx));
    return all.filter((c) => !["deleted", "deleting", "error"].includes(c.status)).map((c) => c.id);
  },
});
