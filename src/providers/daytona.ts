// Daytona: containers (VMs and GPUs optional). Free: $200 compute credit, 10 vCPU total on Tier 1.
// SDK: npm `@daytona/sdk`. REST: https://app.daytona.io/api (Bearer). MCP: `daytona mcp start`.

import { defineProvider, loadSdk, toBuffer } from "./util.js";
import type { ProviderContext } from "../core/types.js";

type DaytonaSdk = typeof import("@daytona/sdk");
type DSandbox = Awaited<ReturnType<InstanceType<DaytonaSdk["Daytona"]>["get"]>>;

let client: InstanceType<DaytonaSdk["Daytona"]> | undefined;
const cache = new Map<string, DSandbox>();

async function daytona(ctx: ProviderContext) {
  if (client) return client;
  const { Daytona } = await loadSdk<DaytonaSdk>("@daytona/sdk", "daytona");
  client = new Daytona({
    apiKey: ctx.env["DAYTONA_API_KEY"],
    apiUrl: ctx.env["DAYTONA_API_URL"],
    target: ctx.env["DAYTONA_TARGET"],
  });
  return client;
}

async function get(id: string, ctx: ProviderContext): Promise<DSandbox> {
  const hit = cache.get(id);
  if (hit) return hit;
  const sbx = await (await daytona(ctx)).get(id);
  cache.set(id, sbx);
  return sbx;
}

export const daytonaProvider = defineProvider({
  info: {
    id: "daytona",
    name: "Daytona",
    homepage: "https://www.daytona.io",
    env: ["DAYTONA_API_KEY"],
    sdkPackage: "@daytona/sdk",
    capabilities: ["customImage", "ports", "fileList", "extendTimeout", "pause", "gpu"],
    freeTier: {
      // The pricing page does not say whether the $200 recurs; treated as one-time.
      tier: { kind: "one-time-credit", usd: 200 },
      concurrency: 10,
      requiresCard: false,
      notes: "$200 compute credit (no GPU). Tier 1: 10 vCPU total. Max 4 vCPU / 8 GiB per sandbox.",
      source: "https://www.daytona.io/pricing",
      checked: "2026-11-11",
    },
    pricing: {
      vcpuSecondUsd: 0.0504 / 3600,
      gibSecondUsd: 0.0162 / 3600,
      defaultCpu: 1,
      defaultMemoryMiB: 1024,
      source: "https://www.daytona.io/pricing",
    },
    surfaces: { rest: "https://app.daytona.io/api", sdk: ["@daytona/sdk (npm)", "daytona (PyPI)"], cli: "daytona", mcp: "daytona mcp start" },
  },

  async create(spec, ctx) {
    const d = await daytona(ctx);
    const base = {
      envVars: spec.env,
      labels: spec.metadata,
      // Wall-clock TTL: destroyed when it elapses, matching the router's deadline.
      ttlMinutes: Math.max(1, Math.ceil(spec.timeoutSec / 60)),
      autoStopInterval: 0,
      ephemeral: true,
      target: spec.region,
    };
    const sbx = spec.nativeTemplate
      ? await d.create({ ...base, snapshot: spec.nativeTemplate })
      : spec.image
        ? await d.create({
            ...base,
            image: spec.image,
            resources: { cpu: Math.ceil(spec.cpu), memory: Math.max(1, Math.round(spec.memoryMiB / 1024)) },
          })
        : await d.create(base);
    cache.set(sbx.id, sbx);
    return { providerSandboxId: sbx.id };
  },

  async exec(id, command, o, ctx) {
    const sbx = await get(id, ctx);
    const r = await sbx.process.executeCommand(command, o.cwd, o.env, o.timeoutSec);
    // Daytona returns stdout and stderr combined.
    o.onStdout?.(r.result);
    return { stdout: r.result, stderr: "", exitCode: r.exitCode };
  },

  async readFile(id, path, ctx) {
    return new Uint8Array(await (await get(id, ctx)).fs.downloadFile(path));
  },

  async writeFile(id, path, data, ctx) {
    await (await get(id, ctx)).fs.uploadFile(toBuffer(data), path);
  },

  async listFiles(id, path, ctx) {
    const items = await (await get(id, ctx)).fs.listFiles(path);
    const base = path.endsWith("/") ? path : `${path}/`;
    return items.map((f) => ({ name: f.name, path: `${base}${f.name}`, isDir: Boolean(f.isDir), size: f.size }));
  },

  async getUrl(id, port, ctx) {
    return (await (await get(id, ctx)).getPreviewLink(port)).url;
  },

  async setTimeout(_id, _timeoutSec, _ctx) {
    // ttlMinutes is fixed at create; keep it alive by refreshing activity instead.
    await (await get(_id, _ctx)).refreshActivity();
  },

  async pause(id, ctx) {
    await (await get(id, ctx)).stop();
  },

  async resume(id, ctx) {
    await (await get(id, ctx)).start();
  },

  async kill(id, ctx) {
    const sbx = await get(id, ctx);
    cache.delete(id);
    await sbx.delete();
  },

  async listAlive(ctx) {
    const ids: string[] = [];
    for await (const s of (await daytona(ctx)).list()) {
      if (s.state === "started" || s.state === "starting" || s.state === "stopped") ids.push(s.id);
    }
    return ids;
  },
});
