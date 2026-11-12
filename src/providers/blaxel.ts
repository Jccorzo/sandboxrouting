// Blaxel sandboxes: microVMs that scale to zero after a few idle seconds. Free: up to $200
// credit, 10 concurrent on Tier 0, 7-day max age. Billed on memory only.
// SDK: npm `@blaxel/core` (reads BL_API_KEY, BL_WORKSPACE). REST: https://api.blaxel.ai/v0.

import { createHash } from "node:crypto";
import { defineProvider, loadSdk } from "./util.js";
import type { ProviderContext } from "../core/types.js";

type BlaxelSdk = typeof import("@blaxel/core");

async function sdk(ctx: ProviderContext): Promise<BlaxelSdk> {
  // The SDK takes credentials from the environment only.
  for (const k of ["BL_API_KEY", "BL_WORKSPACE", "BL_REGION"]) if (ctx.env[k]) process.env[k] = ctx.env[k];
  return loadSdk<BlaxelSdk>("@blaxel/core", "blaxel");
}
const get = async (name: string, ctx: ProviderContext) => (await sdk(ctx)).SandboxInstance.get(name);

export const blaxelProvider = defineProvider({
  info: {
    id: "blaxel",
    name: "Blaxel",
    homepage: "https://blaxel.ai",
    env: ["BL_API_KEY", "BL_WORKSPACE"],
    sdkPackage: "@blaxel/core",
    capabilities: ["customImage", "ports", "fileList", "extendTimeout", "snapshot"],
    maxTimeoutSec: 30 * 86400,
    freeTier: {
      // "Up to $200"; whether it recurs is not stated. Treated as one-time.
      tier: { kind: "one-time-credit", usd: 200 },
      concurrency: 10,
      maxLifetimeSec: 7 * 86400,
      notes: "Up to $200 credit; Tier 0: 10 concurrent, 7-day max age. Idle sandboxes scale to zero (storage only).",
      source: "https://blaxel.ai/pricing",
      checked: "2026-11-11",
    },
    pricing: { vcpuSecondUsd: 0, gibSecondUsd: 0.0000115, defaultCpu: 2, defaultMemoryMiB: 2048, source: "https://blaxel.ai/pricing" },
    surfaces: { rest: "https://api.blaxel.ai/v0", sdk: ["@blaxel/core (npm)", "blaxel (PyPI)"], cli: "bl", mcp: "per-sandbox MCP server" },
  },

  async create(spec, ctx) {
    const { SandboxInstance } = await sdk(ctx);
    // Names: lowercase letters, digits and hyphens.
    const name = `sbr-${createHash("sha256").update(spec.metadata["sandboxrouting.id"] ?? String(Date.now())).digest("hex").slice(0, 16)}`;
    const ports = (ctx.options["ports"] as number[] | undefined) ?? [];
    const sbx = await SandboxInstance.create({
      name,
      image: spec.nativeTemplate ?? spec.image ?? "blaxel/base-image:latest",
      memory: spec.memoryMiB,
      envs: Object.entries(spec.env).map(([name, value]) => ({ name, value })),
      ports: ports.map((target) => ({ target, protocol: "HTTP" })),
      ttl: `${Math.ceil(spec.timeoutSec / 60)}m`,
      region: spec.region ?? ctx.env["BL_REGION"],
    });
    return { providerSandboxId: sbx.metadata.name ?? name };
  },

  async exec(id, command, o, ctx) {
    const sbx = await get(id, ctx);
    const r = (await sbx.process.exec({
      command,
      env: o.env,
      workingDir: o.cwd,
      waitForCompletion: true,
      timeout: o.timeoutSec,
    })) as { stdout?: string; stderr?: string; logs?: string; exitCode?: number };
    const stdout = r.stdout ?? r.logs ?? "";
    const stderr = r.stderr ?? "";
    if (stdout) o.onStdout?.(stdout);
    if (stderr) o.onStderr?.(stderr);
    return { stdout, stderr, exitCode: r.exitCode ?? -1 };
  },

  async readFile(id, path, ctx) {
    const blob = await (await get(id, ctx)).fs.readBinary(path);
    return new Uint8Array(await blob.arrayBuffer());
  },

  async writeFile(id, path, data, ctx) {
    await (await get(id, ctx)).fs.writeBinary(path, data);
  },

  async listFiles(id, path, ctx) {
    const dir = await (await get(id, ctx)).fs.ls(path);
    return [
      ...dir.subdirectories.map((d) => ({ name: d.name, path: d.path, isDir: true })),
      ...dir.files.map((f) => ({ name: f.name, path: f.path, isDir: false, size: f.size })),
    ];
  },

  async getUrl(id, port, ctx) {
    const preview = await (await get(id, ctx)).previews.createIfNotExists({ name: `p${port}`, port, public: true });
    return preview.url;
  },

  async setTimeout(id, timeoutSec, ctx) {
    await (await sdk(ctx)).SandboxInstance.updateTtl(id, `${Math.ceil(timeoutSec / 60)}m`);
  },

  async kill(id, ctx) {
    await (await sdk(ctx)).SandboxInstance.delete(id);
  },
});
