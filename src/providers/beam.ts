// Beam (beam.cloud) sandboxes: containers on the open-source beta9 engine (a microVM is an
// option the TypeScript SDK doesn't expose). No free tier: the entry plan is $20/month and
// includes $20 of credit. $0.05 per vCPU-hour + $0.01 per GiB-hour while running.
// `keepWarmSeconds` is a lifetime, not an idle timer: Beam terminates the sandbox when it ends.
// SDK: npm `@beamcloud/beam-js` (its REST gateway doesn't document creating a sandbox).
// The SDK keeps its token in one module-wide object, so one process serves one Beam account.
// CLI `beam`; MCP https://app.beam.cloud/api/v1/mcp.

import { defineProvider, loadSdk, withCwdEnv } from "./util.js";
import { sbrName } from "./rest-helpers.js";
import type { ProviderContext } from "../core/types.js";

type BeamSdk = typeof import("@beamcloud/beam-js");
type Instance = InstanceType<BeamSdk["SandboxInstance"]>;

async function beam(ctx: ProviderContext): Promise<BeamSdk> {
  const sdk = await loadSdk<BeamSdk>("@beamcloud/beam-js", "beam");
  // Set on every call: the options object is shared by everything in the process.
  sdk.beamOpts.token = String(ctx.env["BEAM_TOKEN"]);
  sdk.beamOpts.workspaceId = String(ctx.env["BEAM_WORKSPACE_ID"]);
  if (ctx.env["BEAM_GATEWAY_URL"]) sdk.beamOpts.gatewayUrl = ctx.env["BEAM_GATEWAY_URL"];
  return sdk;
}

// Connected instances, so each call doesn't reconnect. Dropped on kill.
const instances = new Map<string, Instance>();
async function get(id: string, ctx: ProviderContext): Promise<Instance> {
  const hit = instances.get(id);
  if (hit && !hit.terminated) return hit;
  const instance = await (await beam(ctx)).Sandbox.connect(id);
  instances.set(id, instance);
  return instance;
}

export const beamProvider = defineProvider({
  info: {
    id: "beam",
    name: "Beam",
    homepage: "https://www.beam.cloud",
    env: ["BEAM_TOKEN", "BEAM_WORKSPACE_ID"],
    sdkPackage: "@beamcloud/beam-js",
    capabilities: ["customImage", "ports", "fileList", "extendTimeout", "gpu", "snapshot"],
    isolation: "container",
    freeTier: {
      tier: { kind: "none" },
      notes: "No free tier found: the Developer plan is $20/mo with $20 of credit a month. 30 concurrent vCPUs.",
      source: "https://www.beam.cloud/pricing",
      checked: "2026-11-12",
    },
    pricing: { vcpuSecondUsd: 0.05 / 3600, gibSecondUsd: 0.01 / 3600, defaultCpu: 1, defaultMemoryMiB: 1024, source: "https://docs.beam.cloud/v2/resources/pricing-and-billing.md" },
    surfaces: { rest: "https://app.beam.cloud/api/v1/gateway (partial)", sdk: ["@beamcloud/beam-js (npm)", "beam-client (PyPI)"], cli: "beam", mcp: "https://app.beam.cloud/api/v1/mcp" },
  },

  async create(spec, ctx) {
    const sdk = await beam(ctx);
    const image = spec.image ? new sdk.Image({ baseImage: spec.image }) : spec.nativeTemplate ? new sdk.Image({ imageId: spec.nativeTemplate }) : undefined;
    const sandbox = new sdk.Sandbox({
      name: sbrName(spec),
      cpu: spec.cpu,
      memory: spec.memoryMiB,
      image,
      env: Object.entries(spec.env).map(([k, v]) => `${k}=${v}`),
      // The SDK's default lifetime is 60 seconds.
      keepWarmSeconds: Math.max(1, Math.ceil(spec.timeoutSec)),
      gpu: ctx.options["gpu"],
    } as ConstructorParameters<BeamSdk["Sandbox"]>[0]);
    const instance = await sandbox.create();
    instances.set(instance.sandboxId, instance);
    return { providerSandboxId: instance.sandboxId };
  },

  async exec(id, command, o, ctx) {
    // There is no per-command timeout: a command is bounded only by the sandbox's lifetime.
    const instance = await get(id, ctx);
    const proc = await instance.exec(["sh", "-c", withCwdEnv(command, { cwd: o.cwd })], { env: o.env });
    const exitCode = await proc.wait();
    const [stdout, stderr] = await Promise.all([proc.stdout.read(), proc.stderr.read()]);
    if (stdout) o.onStdout?.(stdout);
    if (stderr) o.onStderr?.(stderr);
    return { stdout, stderr, exitCode };
  },

  async readFile(id, path, ctx) {
    return new Uint8Array(await (await get(id, ctx)).fs.readBytes(path));
  },

  async writeFile(id, path, data, ctx) {
    await (await get(id, ctx)).fs.writeBytes(path, data);
  },

  async listFiles(id, path, ctx) {
    const files = await (await get(id, ctx)).fs.listFiles(path);
    const dir = path.endsWith("/") ? path : `${path}/`;
    return files.map((f) => ({ name: f.name, path: `${dir}${f.name}`, isDir: f.isDir, size: f.size }));
  },

  async getUrl(id, port, ctx) {
    // The URL is public, with no auth.
    return (await get(id, ctx)).exposePort(port);
  },

  async setTimeout(id, timeoutSec, ctx) {
    // Resets the remaining lifetime.
    await (await get(id, ctx)).updateTtl(Math.max(1, Math.ceil(timeoutSec)));
  },

  async kill(id, ctx) {
    const sdk = await beam(ctx);
    instances.delete(id);
    await sdk.Sandbox.terminate(id);
  },
});
