// boxd (boxd.sh): persistent KVM microVMs ("machines") in Frankfurt and New York.
// Free: €30 of credit; whether a card is needed first is stated both ways, so it is treated
// as needed. Priced in euros on actual use: €0.039 per active vCPU-hour, €0.012 per GiB-hour
// of memory in use. boxd deletes the machine when its `deleteAfter` timer fires.
// There is no REST API: it is gRPC on :9443, spoken here through the SDK, npm `@boxd-sh/sdk`,
// which exchanges the API key for a session. CLI `boxd`. Four sizes, each 1 vCPU per 4 GiB.

import { defineProvider, loadSdk, withCwdEnv } from "./util.js";
import { sbrName } from "./rest-helpers.js";
import type { ProviderContext } from "../core/types.js";

type BoxdSdk = typeof import("@boxd-sh/sdk");
type Client = InstanceType<BoxdSdk["Boxd"]>;

/** Prices are in euros; this is an approximate rate. Override `pricing` in config to be exact. */
const EUR_USD = 1.1;

// One client per key and endpoint: it keeps the session it exchanged the key for.
const clients = new Map<string, Client>();
async function boxd(ctx: ProviderContext): Promise<Client> {
  const apiKey = String(ctx.env["BOXD_API_KEY"]);
  const baseURL = ctx.env["BOXD_BASE_URL"];
  const region = ctx.env["BOXD_REGION"];
  const key = `${apiKey}|${baseURL ?? ""}|${region ?? ""}`;
  let client = clients.get(key);
  if (!client) {
    const sdk = await loadSdk<BoxdSdk>("@boxd-sh/sdk", "boxd");
    client = new sdk.Boxd({ apiKey, baseURL, region } as ConstructorParameters<BoxdSdk["Boxd"]>[0]);
    clients.set(key, client);
  }
  return client;
}

/** boxd sizes: 1, 2, 4 or 8 vCPUs with 4 GiB each. */
export function boxdSize(cpu: number, memoryMiB: number): { vcpu: number; memory: string; memoryMiB: number } {
  const vcpu = [1, 2, 4, 8].find((c) => c >= cpu && c * 4096 >= memoryMiB) ?? 8;
  return { vcpu, memory: `${vcpu * 4}G`, memoryMiB: vcpu * 4096 };
}

export const boxdProvider = defineProvider({
  info: {
    id: "boxd",
    name: "boxd",
    homepage: "https://boxd.sh",
    env: ["BOXD_API_KEY"],
    sdkPackage: "@boxd-sh/sdk",
    capabilities: ["customImage", "ports", "pause", "fileList", "extendTimeout", "snapshot"],
    isolation: "microvm",
    freeTier: {
      tier: { kind: "one-time-credit", usd: 30 },
      requiresCard: true,
      notes: "€30 of credit. One page says a payment method is needed before the first machine, another that without one you get 2 machines. 50 machines per org per region.",
      source: "https://boxd.sh/pricing",
      checked: "2026-11-12",
    },
    // Billed while in use: ranked at the expected CPU share; memory, the reservation and
    // metering at the ceiling for a machine that is busy with all its memory in use.
    pricing: { vcpuSecondUsd: (0.039 * EUR_USD) / 3600, gibSecondUsd: (0.012 * EUR_USD) / 3600, defaultCpu: 1, defaultMemoryMiB: 4096, billing: "active-cpu", source: "https://boxd.sh/pricing" },
    surfaces: { rest: "gRPC boxd.sh:9443 (no REST)", sdk: ["@boxd-sh/sdk (npm)", "boxd (PyPI)"], cli: "boxd" },
  },

  async create(spec, ctx) {
    const client = await boxd(ctx);
    const size = boxdSize(spec.cpu, spec.memoryMiB);
    const machine = await client.machines.create({
      // Names are unique per region, so a retried create cannot make a second machine.
      name: sbrName(spec),
      image: spec.image ?? spec.nativeTemplate,
      env: spec.env,
      labels: spec.metadata,
      // The sandbox mode: no peers, no integrations.
      isolated: true,
      deleteAfter: Math.max(1, Math.ceil(spec.timeoutSec)),
      region: spec.region,
      config: { vcpu: size.vcpu, memory: size.memory },
    });
    try {
      await client.machines.waitUntilReady(machine.id);
    } catch (err) {
      await client.machines.delete(machine.id).catch(() => undefined);
      throw err;
    }
    return { providerSandboxId: machine.id, cpu: size.vcpu, memoryMiB: size.memoryMiB };
  },

  async exec(id, command, o, ctx) {
    const client = await boxd(ctx);
    const r = await client.machines.exec(id, {
      command: ["sh", "-c", withCwdEnv(command, { cwd: o.cwd })],
      env: o.env,
      timeout: o.timeoutSec ? o.timeoutSec * 1000 : undefined,
    });
    if (r.stdout) o.onStdout?.(r.stdout);
    if (r.stderr) o.onStderr?.(r.stderr);
    return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode };
  },

  async readFile(id, path, ctx) {
    return (await boxd(ctx)).machines.files.download(id, path);
  },

  async writeFile(id, path, data, ctx) {
    await (await boxd(ctx)).machines.files.upload(id, path, data);
  },

  async listFiles(id, path, ctx) {
    const { entries } = await (await boxd(ctx)).machines.files.listDir(id, path);
    const dir = path.endsWith("/") ? path : `${path}/`;
    return entries.map((e) => ({ name: e.name, path: `${dir}${e.name}`, isDir: e.isDir, size: e.sizeBytes }));
  },

  async getUrl(id, port, ctx) {
    const client = await boxd(ctx);
    const name = `p${port}`;
    const find = async () => (await client.machines.proxies.list(id)).find((p) => p.name === name && p.port === port);
    let proxy = await find();
    if (!proxy) {
      await client.machines.proxies.create(id, name, port);
      proxy = await find();
    }
    if (!proxy) throw new Error(`boxd made no route for port ${port}`);
    return `https://${proxy.domain}`;
  },

  async setTimeout(id, timeoutSec, ctx) {
    // Replaces the timer: delete this many seconds from now.
    await (await boxd(ctx)).machines.setDeleteAfter(id, Math.max(1, Math.ceil(timeoutSec)));
  },

  async pause(id, ctx) {
    // Standby: memory is kept, and memory and disk keep billing.
    await (await boxd(ctx)).machines.pause(id);
  },

  async resume(id, ctx) {
    await (await boxd(ctx)).machines.resume(id);
  },

  async kill(id, ctx) {
    await (await boxd(ctx)).machines.delete(id);
  },

  async listAlive(ctx) {
    // An org holds machines the router didn't make; a hibernated or stopped one still exists.
    const machines = await (await boxd(ctx)).machines.list();
    return machines.filter((m) => m.name.startsWith("sbr-") && m.status !== "destroyed" && m.status !== "failed").map((m) => m.id);
  },
});
