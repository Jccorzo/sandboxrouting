// Freestyle VMs. Free (monthly, hard stop at the limit): 200 vCPU-h + 400 GiB-h memory,
// 10 concurrent VMs, max 4 vCPU / 8 GiB each. SDK: npm `freestyle`. REST: https://api.freestyle.sh.

import { defineProvider, loadSdk } from "./util.js";
import type { ProviderContext } from "../core/types.js";

type FreestyleSdk = typeof import("freestyle");
let client: InstanceType<FreestyleSdk["Freestyle"]> | undefined;

async function freestyle(ctx: ProviderContext) {
  if (client) return client;
  const { Freestyle } = await loadSdk<FreestyleSdk>("freestyle", "freestyle");
  client = new Freestyle({ apiKey: ctx.env["FREESTYLE_API_KEY"] });
  return client;
}
const vm = async (id: string, ctx: ProviderContext) => (await freestyle(ctx)).vms.ref(id);

// Monthly allowance at list prices: 200 × $0.04032 + 400 × $0.0129 ≈ $13.22.
const MONTHLY_USD = 200 * 0.04032 + 400 * 0.0129;

export const freestyleProvider = defineProvider({
  info: {
    id: "freestyle",
    name: "Freestyle",
    homepage: "https://freestyle.sh",
    env: ["FREESTYLE_API_KEY"],
    sdkPackage: "freestyle",
    capabilities: ["fileList", "pause", "snapshot"],
    freeTier: {
      tier: { kind: "monthly-credit", usd: Math.round(MONTHLY_USD * 100) / 100 },
      concurrency: 10,
      notes: "200 vCPU-h + 400 GiB-h memory a month; VMs pause at the limit until the reset.",
      source: "https://freestyle.sh/docs/vms/pricing-and-limits",
      checked: "2026-11-11",
    },
    pricing: { vcpuSecondUsd: 0.04032 / 3600, gibSecondUsd: 0.0129 / 3600, defaultCpu: 2, defaultMemoryMiB: 4096, source: "https://freestyle.sh/pricing" },
    surfaces: { rest: "https://api.freestyle.sh", sdk: ["freestyle (npm)"], cli: "freestyle" },
  },

  async create(spec, ctx) {
    const { vmId } = await (await freestyle(ctx)).vms.create({
      snapshotId: spec.nativeTemplate ?? null,
      metadata: spec.metadata,
      ttlSeconds: spec.timeoutSec,
      autoDeleteSeconds: 0, // ephemeral: gone once stopped
      // Freestyle VMs get no network unless asked; give outbound Internet like other providers.
      firewall: (ctx.options["firewall"] as { rules: [] } | undefined) ?? {
        rules: [{ action: "allow", source: {}, destination: { public: true } }],
      },
    });
    return { providerSandboxId: vmId };
  },

  async exec(id, command, o, ctx) {
    const cd = o.cwd ? `cd '${o.cwd.replace(/'/g, `'\\''`)}' && ` : "";
    const r = await (await vm(id, ctx)).exec({ command: `${cd}${command}`, env: o.env, timeoutMs: o.timeoutSec ? o.timeoutSec * 1000 : undefined });
    const stdout = r.stdout ?? "";
    const stderr = r.stderr ?? "";
    if (stdout) o.onStdout?.(stdout);
    if (stderr) o.onStderr?.(stderr);
    return { stdout, stderr, exitCode: r.statusCode ?? -1 };
  },

  async readFile(id, path, ctx) {
    return (await vm(id, ctx)).fs.readFile(path);
  },

  async writeFile(id, path, data, ctx) {
    await (await vm(id, ctx)).fs.writeFile(path, data);
  },

  async listFiles(id, path, ctx) {
    const base = path.endsWith("/") ? path : `${path}/`;
    return (await (await vm(id, ctx)).fs.readDir(path)).map((e) => ({ name: e.name, path: `${base}${e.name}`, isDir: e.kind === "directory" || e.kind === "dir" }));
  },

  async pause(id, ctx) {
    await (await vm(id, ctx)).pause();
  },

  async resume(id, ctx) {
    await (await vm(id, ctx)).start();
  },

  async kill(id, ctx) {
    await (await freestyle(ctx)).vms.delete(id);
  },

  async listAlive(ctx) {
    const { vms } = await (await freestyle(ctx)).vms.list({ limit: 1000 });
    return vms.filter((v) => v.state !== "stopped").map((v) => v.id);
  },
});
