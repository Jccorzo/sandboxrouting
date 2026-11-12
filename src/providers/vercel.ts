// Vercel Sandbox: Firecracker microVMs. Free (Hobby, monthly): 5 active-CPU hours, 420 GB-h
// memory, 5,000 creations; 10 concurrent, 45 min max. Over quota, creation pauses (no charge).
// SDK: npm `@vercel/sandbox`. CLI: `sandbox`.

import { defineProvider, loadSdk, toBuffer } from "./util.js";
import type { ProviderContext } from "../core/types.js";

type VercelSdk = typeof import("@vercel/sandbox");
type VSandbox = Awaited<ReturnType<VercelSdk["Sandbox"]["get"]>>;

const cache = new Map<string, VSandbox>();
const sdk = () => loadSdk<VercelSdk>("@vercel/sandbox", "vercel");

/** Explicit credentials outside Vercel; inside, the SDK reads VERCEL_OIDC_TOKEN itself. */
function creds(ctx: ProviderContext) {
  const { VERCEL_TOKEN: token, VERCEL_TEAM_ID: teamId, VERCEL_PROJECT_ID: projectId } = ctx.env;
  return token && teamId && projectId ? { token, teamId, projectId } : {};
}

async function get(name: string, ctx: ProviderContext): Promise<VSandbox> {
  const hit = cache.get(name);
  if (hit) return hit;
  const { Sandbox } = await sdk();
  const sbx = await Sandbox.get({ name, ...creds(ctx) });
  cache.set(name, sbx);
  return sbx;
}

// Free usage expressed in dollars at Pro prices, so it meters like the others:
// 5 active-CPU h × $0.128 + 420 GB-h × $0.0212 ≈ $9.54. Metering wall-clock CPU is
// conservative: Vercel bills CPU only while active.
const HOBBY_USD = 5 * 0.128 + 420 * 0.0212;

export const vercelProvider = defineProvider({
  info: {
    id: "vercel",
    name: "Vercel Sandbox",
    homepage: "https://vercel.com/docs/sandbox",
    env: ["VERCEL_TOKEN", "VERCEL_TEAM_ID", "VERCEL_PROJECT_ID"],
    sdkPackage: "@vercel/sandbox",
    capabilities: ["customImage", "ports", "extendTimeout", "pause"],
    maxTimeoutSec: 5 * 3600,
    freeTier: {
      tier: { kind: "monthly-credit", usd: Math.round(HOBBY_USD * 100) / 100 },
      concurrency: 10,
      maxLifetimeSec: 45 * 60,
      requiresCard: false,
      notes: "Hobby: 5 active-CPU h + 420 GB-h memory + 5,000 creations a month; creation pauses at the limit.",
      source: "https://vercel.com/docs/sandbox/pricing",
      checked: "2026-11-11",
    },
    pricing: {
      vcpuSecondUsd: 0.128 / 3600,
      gibSecondUsd: 0.0212 / 3600,
      defaultCpu: 2,
      defaultMemoryMiB: 4096, // 2 GB per vCPU
      source: "https://vercel.com/docs/sandbox/pricing",
    },
    surfaces: { rest: "https://api.vercel.com (/v2/sandboxes)", sdk: ["@vercel/sandbox (npm)", "vercel (PyPI)"], cli: "sandbox" },
  },

  isConfigured(ctx) {
    return Boolean(ctx.env["VERCEL_OIDC_TOKEN"] || (ctx.env["VERCEL_TOKEN"] && ctx.env["VERCEL_TEAM_ID"] && ctx.env["VERCEL_PROJECT_ID"]));
  },

  async create(spec, ctx) {
    const { Sandbox } = await sdk();
    const ports = (ctx.options["ports"] as number[] | undefined) ?? [];
    const common = {
      ...creds(ctx),
      timeout: spec.timeoutSec * 1000,
      env: spec.env,
      tags: spec.metadata,
      persistent: false,
      ports: ports.length ? ports : undefined,
      resources: { vcpus: Math.min(8, Math.max(1, Math.round(spec.cpu))) },
    };
    const image = spec.nativeTemplate ?? spec.image;
    const sbx = image
      ? await Sandbox.create({ ...common, image })
      : await Sandbox.create({ ...common, runtime: String(ctx.options["runtime"] ?? "node22") });
    cache.set(sbx.name, sbx);
    return { providerSandboxId: sbx.name, cpu: common.resources.vcpus, memoryMiB: common.resources.vcpus * 2048 };
  },

  async exec(id, command, o, ctx) {
    const sbx = await get(id, ctx);
    const r = await sbx.runCommand({ cmd: "sh", args: ["-c", command], cwd: o.cwd, env: o.env });
    const [stdout, stderr] = await Promise.all([r.stdout(), r.stderr()]);
    if (stdout) o.onStdout?.(stdout);
    if (stderr) o.onStderr?.(stderr);
    return { stdout, stderr, exitCode: r.exitCode };
  },

  async readFile(id, path, ctx) {
    const buf = await (await get(id, ctx)).readFileToBuffer({ path });
    if (!buf) throw Object.assign(new Error(`${path} not found`), { status: 404 });
    return new Uint8Array(buf);
  },

  async writeFile(id, path, data, ctx) {
    await (await get(id, ctx)).writeFiles([{ path, content: toBuffer(data) }]);
  },

  async getUrl(id, port, ctx) {
    return (await get(id, ctx)).domain(port);
  },

  async setTimeout(id, timeoutSec, ctx) {
    // Vercel extends by a duration; the router asks for "this long from now".
    await (await get(id, ctx)).extendTimeout(timeoutSec * 1000);
  },

  async pause(id, ctx) {
    await (await get(id, ctx)).stop();
  },

  async resume(id, ctx) {
    const { Sandbox } = await sdk();
    cache.set(id, await Sandbox.get({ name: id, resume: true, ...creds(ctx) }));
  },

  async kill(id, ctx) {
    const sbx = await get(id, ctx);
    cache.delete(id);
    await sbx.delete();
  },
});
