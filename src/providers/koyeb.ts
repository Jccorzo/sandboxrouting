// Koyeb sandboxes (public preview). No free tier for sandboxes (Starter plan, card required),
// but the cheapest paid option: `small` (1 vCPU / 1 GB) is $0.0144/h.
// SDK: npm `@koyeb/sandbox-sdk` (snake_case methods). CLI: `koyeb`.

import { defineProvider, loadSdk } from "./util.js";
import type { ProviderContext } from "../core/types.js";

type KoyebSdk = typeof import("@koyeb/sandbox-sdk");
const sdk = () => loadSdk<KoyebSdk>("@koyeb/sandbox-sdk", "koyeb");
const token = (ctx: ProviderContext) => ctx.env["KOYEB_API_TOKEN"];
// list() handles cannot exec, so reconnect by id.
const get = async (id: string, ctx: ProviderContext) => (await sdk()).Sandbox.get_from_id(id, token(ctx));

/** Koyeb sizes: vCPU → instance type (memory follows the type). */
function instanceType(cpu: number): { type: string; cpu: number; memoryMiB: number } {
  if (cpu <= 0.25) return { type: "nano", cpu: 0.25, memoryMiB: 256 };
  if (cpu <= 0.5) return { type: "micro", cpu: 0.5, memoryMiB: 512 };
  if (cpu <= 1) return { type: "small", cpu: 1, memoryMiB: 1024 };
  if (cpu <= 2) return { type: "medium", cpu: 2, memoryMiB: 2048 };
  return { type: "large", cpu: 4, memoryMiB: 4096 };
}

export const koyebProvider = defineProvider({
  info: {
    id: "koyeb",
    name: "Koyeb",
    homepage: "https://www.koyeb.com/docs/sandboxes",
    env: ["KOYEB_API_TOKEN"],
    sdkPackage: "@koyeb/sandbox-sdk",
    capabilities: ["customImage", "ports", "snapshot"],
    isolation: "microvm",
    maxTimeoutSec: 24 * 3600,
    freeTier: {
      tier: { kind: "none" },
      requiresCard: true,
      notes: "Sandboxes need the Starter plan or above; the free instance does not cover them.",
      source: "https://www.koyeb.com/docs/reference/instances",
      checked: "2026-11-11",
    },
    // $0.000004/s for 1 vCPU + 1 GB, split evenly between CPU and memory.
    pricing: { vcpuSecondUsd: 0.000002, gibSecondUsd: 0.000002, defaultCpu: 1, defaultMemoryMiB: 1024, source: "https://www.koyeb.com/pricing" },
    surfaces: { rest: "https://app.koyeb.com/v1", sdk: ["@koyeb/sandbox-sdk (npm)", "koyeb-sdk (PyPI)"], cli: "koyeb" },
  },

  async create(spec, ctx) {
    const { Sandbox } = await sdk();
    const size = instanceType(spec.cpu);
    const sbx = await Sandbox.create({
      image: spec.image ?? "koyeb/sandbox",
      name: `sbr-${(spec.metadata["sandboxrouting.id"] ?? "").replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 20)}`,
      instance_type: size.type,
      env: spec.env,
      region: spec.region ?? "was",
      api_token: token(ctx),
      wait_ready: true,
      delete_after_delay: Math.min(spec.timeoutSec, 24 * 3600),
    });
    return { providerSandboxId: sbx.id, cpu: size.cpu, memoryMiB: size.memoryMiB };
  },

  async exec(id, command, o, ctx) {
    const sbx = await get(id, ctx);
    const r = await sbx.exec(command, {
      cwd: o.cwd,
      env: o.env,
      timeout: o.timeoutSec,
      on_stdout: o.onStdout,
      on_stderr: o.onStderr,
    });
    return { stdout: r.stdout, stderr: r.stderr, exitCode: r.code };
  },

  async writeFile(id, path, data, ctx) {
    // write_file takes text; binary falls back to exec.
    const text = Buffer.from(data).toString("utf8");
    if (Buffer.from(text, "utf8").length !== data.length) {
      const { SandboxRouterError } = await import("../core/errors.js");
      throw new SandboxRouterError("unsupported", "binary write", "koyeb");
    }
    await (await get(id, ctx)).filesystem.write_file(path, text);
  },

  async getUrl(id, port, ctx) {
    const { exposed_at } = await (await get(id, ctx)).expose_port(port);
    return exposed_at;
  },

  async kill(id, ctx) {
    await (await get(id, ctx)).delete();
  },
});
