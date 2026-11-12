// Modal Sandboxes: gVisor containers. Free: $30/month recurring credit (Starter), 24 h max.
// SDK: npm `modal` (gRPC; no public REST). CLI: `modal`.

import { defineProvider, loadSdk } from "./util.js";
import type { ProviderContext } from "../core/types.js";

type ModalSdk = typeof import("modal");
type MClient = InstanceType<ModalSdk["ModalClient"]>;
type MSandbox = Awaited<ReturnType<MClient["sandboxes"]["fromId"]>>;

let client: MClient | undefined;
const cache = new Map<string, MSandbox>();

async function modal(ctx: ProviderContext): Promise<MClient> {
  if (client) return client;
  const { ModalClient } = await loadSdk<ModalSdk>("modal", "modal");
  client = new ModalClient({ tokenId: ctx.env["MODAL_TOKEN_ID"], tokenSecret: ctx.env["MODAL_TOKEN_SECRET"] });
  return client;
}

async function get(id: string, ctx: ProviderContext): Promise<MSandbox> {
  const hit = cache.get(id);
  if (hit) return hit;
  const sbx = await (await modal(ctx)).sandboxes.fromId(id);
  cache.set(id, sbx);
  return sbx;
}

const appName = (ctx: ProviderContext) => String(ctx.options["app"] ?? "sandboxrouting");

export const modalProvider = defineProvider({
  info: {
    id: "modal",
    name: "Modal",
    homepage: "https://modal.com",
    env: ["MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET"],
    sdkPackage: "modal",
    capabilities: ["customImage", "ports", "fileList", "gpu", "snapshot"],
    isolation: "gvisor",
    maxTimeoutSec: 24 * 3600,
    freeTier: {
      tier: { kind: "monthly-credit", usd: 30 },
      concurrency: 100,
      maxLifetimeSec: 24 * 3600,
      notes: "Starter: $30 of compute every month; unused credit does not roll over.",
      source: "https://modal.com/pricing",
      checked: "2026-11-11",
    },
    pricing: {
      // Sandboxes bill per physical core (2 vCPU) at $0.00003942/s.
      vcpuSecondUsd: 0.00003942 / 2,
      gibSecondUsd: 0.00000667,
      defaultCpu: 2,
      defaultMemoryMiB: 2048,
      source: "https://modal.com/pricing",
    },
    surfaces: { sdk: ["modal (npm)", "modal (PyPI)"], cli: "modal" },
  },

  async create(spec, ctx) {
    const m = await modal(ctx);
    const app = await m.apps.fromName(appName(ctx), { createIfMissing: true });
    const image = spec.nativeTemplate
      ? await m.images.fromName(spec.nativeTemplate)
      : m.images.fromRegistry(spec.image ?? String(ctx.options["image"] ?? "python:3.12-slim"));
    const ports = (ctx.options["ports"] as number[] | undefined) ?? [];
    const sbx = await m.sandboxes.create(app, image, {
      cpu: spec.cpu / 2, // Modal sizes in physical cores
      memoryMiB: spec.memoryMiB,
      timeoutMs: spec.timeoutSec * 1000,
      env: spec.env,
      encryptedPorts: ports.length ? ports : undefined,
      regions: spec.region ? [spec.region] : undefined,
    });
    await sbx.setTags(spec.metadata).catch(() => undefined);
    cache.set(sbx.sandboxId, sbx);
    return { providerSandboxId: sbx.sandboxId };
  },

  async exec(id, command, o, ctx) {
    const sbx = await get(id, ctx);
    const p = await sbx.exec(["sh", "-c", command], {
      workdir: o.cwd,
      env: o.env,
      timeoutMs: o.timeoutSec ? o.timeoutSec * 1000 : undefined,
    });
    const [stdout, stderr] = await Promise.all([p.stdout.readText(), p.stderr.readText()]);
    const exitCode = await p.wait();
    if (stdout) o.onStdout?.(stdout);
    if (stderr) o.onStderr?.(stderr);
    return { stdout, stderr, exitCode };
  },

  async readFile(id, path, ctx) {
    return (await get(id, ctx)).filesystem.readBytes(path);
  },

  async writeFile(id, path, data, ctx) {
    await (await get(id, ctx)).filesystem.writeBytes(data, path);
  },

  async listFiles(id, path, ctx) {
    const items = await (await get(id, ctx)).filesystem.listFiles(path);
    return items.map((f) => ({ name: f.name, path: f.path, isDir: f.type === "directory", size: f.size }));
  },

  async getUrl(id, port, ctx) {
    const tunnels = await (await get(id, ctx)).tunnels();
    const t = tunnels[port];
    if (!t) throw new Error(`port ${port} is not exposed; set providers.modal.options.ports`);
    return t.url;
  },

  async kill(id, ctx) {
    const sbx = await get(id, ctx);
    cache.delete(id);
    await sbx.terminate();
  },

  async listAlive(ctx) {
    const ids: string[] = [];
    for await (const s of (await modal(ctx)).sandboxes.list()) ids.push(s.sandboxId);
    return ids;
  },
});
