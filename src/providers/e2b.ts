// E2B: Firecracker microVMs. Free: $100 one-time credit (Hobby), 10 concurrent, 1 h max run.
// SDK: npm `e2b`. REST: https://api.e2b.app (X-API-Key). MCP: @e2b/mcp-server.

import { defineProvider, loadSdk } from "./util.js";
import type { ProviderContext } from "../core/types.js";

type E2B = typeof import("e2b");
type E2BSandbox = InstanceType<E2B["Sandbox"]>;

const cache = new Map<string, E2BSandbox>();
const sdk = () => loadSdk<E2B>("e2b", "e2b");
const opts = (ctx: ProviderContext) => ({ apiKey: ctx.env["E2B_API_KEY"] });

async function get(id: string, ctx: ProviderContext): Promise<E2BSandbox> {
  const hit = cache.get(id);
  if (hit) return hit;
  const { Sandbox } = await sdk();
  const sbx = await Sandbox.connect(id, opts(ctx));
  cache.set(id, sbx);
  return sbx;
}

export const e2bProvider = defineProvider({
  info: {
    id: "e2b",
    name: "E2B",
    homepage: "https://e2b.dev",
    env: ["E2B_API_KEY"],
    sdkPackage: "e2b",
    capabilities: ["ports", "pause", "fileList", "extendTimeout", "snapshot"],
    maxTimeoutSec: 24 * 3600,
    freeTier: {
      tier: { kind: "one-time-credit", usd: 100 },
      concurrency: 10,
      maxLifetimeSec: 3600,
      requiresCard: false,
      notes: "Hobby: $100 one-time credit, 10 concurrent, 1 h max continuous run.",
      source: "https://e2b.dev/pricing",
      checked: "2026-11-11",
    },
    pricing: { vcpuSecondUsd: 0.000014, gibSecondUsd: 0.0000045, defaultCpu: 2, defaultMemoryMiB: 512, source: "https://e2b.dev/pricing" },
    surfaces: { rest: "https://api.e2b.app", sdk: ["e2b (npm)", "e2b (PyPI)"], cli: "e2b", mcp: "@e2b/mcp-server" },
  },

  async create(spec, ctx) {
    const { Sandbox } = await sdk();
    const params = { ...opts(ctx), envs: spec.env, metadata: spec.metadata, timeoutMs: spec.timeoutSec * 1000 };
    const sbx = spec.nativeTemplate ? await Sandbox.create(spec.nativeTemplate, params) : await Sandbox.create(params);
    cache.set(sbx.sandboxId, sbx);
    return { providerSandboxId: sbx.sandboxId };
  },

  async exec(id, command, o, ctx) {
    const sbx = await get(id, ctx);
    try {
      const r = await sbx.commands.run(command, {
        cwd: o.cwd,
        envs: o.env,
        timeoutMs: o.timeoutSec ? o.timeoutSec * 1000 : 0,
        onStdout: o.onStdout,
        onStderr: o.onStderr,
      });
      return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode };
    } catch (err) {
      // A non-zero exit throws CommandExitError, which carries the result.
      const e = err as { exitCode?: number; stdout?: string; stderr?: string };
      if (typeof e.exitCode === "number") return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", exitCode: e.exitCode };
      throw err;
    }
  },

  async readFile(id, path, ctx) {
    return (await get(id, ctx)).files.read(path, { format: "bytes" });
  },

  async writeFile(id, path, data, ctx) {
    await (await get(id, ctx)).files.write(path, data.slice().buffer as ArrayBuffer);
  },

  async listFiles(id, path, ctx) {
    const entries = await (await get(id, ctx)).files.list(path);
    return entries.map((e) => ({ name: e.name, path: e.path, isDir: e.type === "dir", size: e.size }));
  },

  async getUrl(id, port, ctx) {
    return `https://${(await get(id, ctx)).getHost(port)}`;
  },

  async setTimeout(id, timeoutSec, ctx) {
    await (await get(id, ctx)).setTimeout(timeoutSec * 1000);
  },

  async pause(id, ctx) {
    await (await get(id, ctx)).pause();
    cache.delete(id);
  },

  async resume(id, ctx) {
    cache.delete(id);
    await get(id, ctx); // connect() resumes a paused sandbox
  },

  async kill(id, ctx) {
    const { Sandbox } = await sdk();
    cache.delete(id);
    await Sandbox.kill(id, opts(ctx));
  },

  async listAlive(ctx) {
    const { Sandbox } = await sdk();
    const pages = Sandbox.list({ ...opts(ctx), query: { state: ["running", "paused"] } });
    const ids: string[] = [];
    while (pages.hasNext) for (const s of await pages.nextItems()) ids.push(s.sandboxId);
    return ids;
  },
});
