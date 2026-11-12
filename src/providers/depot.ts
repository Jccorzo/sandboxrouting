// Depot Sandboxes: ephemeral microVMs next to Depot CI. No permanent free tier (a 7-day
// trial; the Developer plan is $20/month with 2,000 minutes at 2 vCPU). CPU-only billing.
// SDK: npm `@depot/sandbox` (Connect API depot.sandbox.v1 at https://api.depot.dev, Bearer).
// The SDK reference still says private beta in places; the pricing page lists it on every plan.

import { defineProvider, loadSdk } from "./util.js";
import type { ProviderContext } from "../core/types.js";

type DepotSdk = typeof import("@depot/sandbox");
type DClient = ReturnType<DepotSdk["createClient"]>;
type DSandbox = Awaited<ReturnType<DepotSdk["Sandbox"]["get"]>>;

let client: DClient | undefined;
let sdkMod: DepotSdk | undefined;
const cache = new Map<string, DSandbox>();

async function depot(ctx: ProviderContext): Promise<{ client: DClient; sdk: DepotSdk }> {
  sdkMod ??= await loadSdk<DepotSdk>("@depot/sandbox", "depot");
  client ??= sdkMod.createClient({ token: String(ctx.env["DEPOT_TOKEN"]), endpoint: ctx.env["DEPOT_API_URL"] });
  return { client, sdk: sdkMod };
}

async function get(id: string, ctx: ProviderContext): Promise<DSandbox> {
  const hit = cache.get(id);
  if (hit) return hit;
  const { client, sdk } = await depot(ctx);
  const s = await sdk.Sandbox.get(client, id);
  cache.set(id, s);
  return s;
}

export const depotProvider = defineProvider({
  info: {
    id: "depot",
    name: "Depot Sandboxes",
    homepage: "https://depot.dev/docs/sandboxes",
    env: ["DEPOT_TOKEN"],
    sdkPackage: "@depot/sandbox",
    capabilities: ["fileList", "extendTimeout", "snapshot"],
    maxTimeoutSec: 24 * 3600,
    freeTier: {
      tier: { kind: "none" },
      notes: "7-day trial only. Developer plan $20/mo includes 2,000 minutes at 2 vCPU.",
      source: "https://depot.dev/pricing",
      checked: "2026-11-11",
    },
    // $0.00005 per vCPU-second; memory and disk are not billed.
    pricing: { vcpuSecondUsd: 0.00005, gibSecondUsd: 0, defaultCpu: 2, defaultMemoryMiB: 4096, source: "https://depot.dev/pricing" },
    surfaces: { rest: "https://api.depot.dev (Connect)", sdk: ["@depot/sandbox (npm)"], cli: "depot" },
  },

  async create(spec, ctx) {
    const { client, sdk } = await depot(ctx);
    const s = await sdk.Sandbox.create(client, {
      resources: { vcpus: Math.max(2, Math.round(spec.cpu)), memoryMb: spec.memoryMiB },
      env: spec.env,
      timeoutMinutes: Math.max(1, Math.ceil(spec.timeoutSec / 60)),
      snapshot: spec.nativeTemplate,
      name: spec.metadata["sandboxrouting.id"],
    });
    cache.set(s.sandboxId, s);
    return { providerSandboxId: s.sandboxId, cpu: s.resources?.vcpus, memoryMiB: s.resources?.memoryMb };
  },

  async exec(id, command, o, ctx) {
    // Depot runs argv with no shell, so wrap in sh -c.
    const cmd = await (await get(id, ctx)).runCommand({ cmd: "/bin/sh", args: ["-c", command], cwd: o.cwd, env: o.env });
    const { exitCode } = await cmd.wait();
    const [stdout, stderr] = await Promise.all([cmd.stdout(), cmd.stderr()]);
    if (stdout) o.onStdout?.(stdout);
    if (stderr) o.onStderr?.(stderr);
    return { stdout, stderr, exitCode };
  },

  async readFile(id, path, ctx) {
    const data = await (await get(id, ctx)).fs().readFile(path);
    return typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
  },

  async writeFile(id, path, data, ctx) {
    await (await get(id, ctx)).fs().writeFile(path, data);
  },

  async listFiles(id, path, ctx) {
    const entries = (await (await get(id, ctx)).fs().readdir(path, { withFileTypes: true })) as InstanceType<DepotSdk["DirEntry"]>[];
    const dir = path.endsWith("/") ? path : `${path}/`;
    return entries.map((e) => ({ name: e.name, path: `${dir}${e.name}`, isDir: e.isDirectory() }));
  },

  async setTimeout(id, timeoutSec, ctx) {
    await (await get(id, ctx)).setTimeout({ timeoutMinutes: Math.max(1, Math.ceil(timeoutSec / 60)) });
  },

  async kill(id, ctx) {
    const s = await get(id, ctx);
    cache.delete(id);
    await s.kill();
  },

  async listAlive(ctx) {
    const { client, sdk } = await depot(ctx);
    const ids: string[] = [];
    for await (const s of sdk.Sandbox.listAll(client)) {
      if (s.status && !["finished", "cancelled", "failed"].includes(s.status)) ids.push(s.sandboxId);
    }
    return ids;
  },
});
