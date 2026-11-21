// Runloop devboxes: VMs. Free: $50 one-time trial credit, 3 running devboxes, 48 h max.
// Winding down: Runloop's docs (docs.runloop.ai/docs/transitions/overview) say transition
// support for existing customers ended 2026-11-13. On 2026-11-21 api.runloop.ai no longer
// resolved and platform.runloop.ai answered 503, though runloop.ai still offered sign-up.
// SDK: npm `@runloop/api-client`. REST: https://api.runloop.ai (Bearer). CLI + MCP: `rli mcp start`.

import { defineProvider, loadSdk } from "./util.js";
import { SandboxRouterError } from "../core/errors.js";
import type { ProviderContext } from "../core/types.js";

type RunloopSdk = typeof import("@runloop/api-client");
type RClient = InstanceType<RunloopSdk["Runloop"]>;

let client: RClient | undefined;

async function runloop(ctx: ProviderContext): Promise<{ sdk: RunloopSdk; client: RClient }> {
  const sdk = await loadSdk<RunloopSdk>("@runloop/api-client", "runloop");
  client ??= new sdk.Runloop({ bearerToken: ctx.env["RUNLOOP_API_KEY"] });
  return { sdk, client };
}

async function devbox(id: string, ctx: ProviderContext) {
  const { sdk, client } = await runloop(ctx);
  return sdk.Devbox.fromId(client, id);
}

export const runloopProvider = defineProvider({
  info: {
    id: "runloop",
    name: "Runloop",
    homepage: "https://www.runloop.ai",
    env: ["RUNLOOP_API_KEY"],
    sdkPackage: "@runloop/api-client",
    capabilities: ["ports", "pause", "snapshot"],
    isolation: "vm",
    maxTimeoutSec: 48 * 3600,
    freeTier: {
      tier: { kind: "one-time-credit", usd: 50 },
      concurrency: 3,
      maxLifetimeSec: 48 * 3600,
      requiresCard: false,
      notes: "$50 one-time trial credit; 3 running devboxes. Winding down: transition support ended 2026-11-13 and the API host stopped resolving by 2026-11-21.",
      source: "https://docs.runloop.ai/docs/transitions/overview",
      checked: "2026-11-21",
    },
    pricing: { vcpuSecondUsd: 0.00003, gibSecondUsd: 0.000007, defaultCpu: 1, defaultMemoryMiB: 2048, source: "https://www.runloop.ai/pricing" },
    surfaces: { rest: "https://api.runloop.ai", sdk: ["@runloop/api-client (npm)", "runloop_api_client (PyPI)"], cli: "rli", mcp: "rli mcp start" },
  },

  async create(spec, ctx) {
    const { sdk, client } = await runloop(ctx);
    const custom = spec.cpu !== 1 || spec.memoryMiB !== 2048;
    const box = await sdk.Devbox.create(client, {
      blueprint_name: spec.nativeTemplate ?? null,
      environment_variables: spec.env,
      metadata: spec.metadata,
      launch_parameters: {
        keep_alive_time_seconds: spec.timeoutSec,
        ...(custom
          ? {
              resource_size_request: "CUSTOM_SIZE" as const,
              custom_cpu_cores: Math.max(1, Math.round(spec.cpu)),
              custom_gb_memory: Math.max(1, Math.round(spec.memoryMiB / 1024)),
            }
          : { resource_size_request: "SMALL" as const }),
      },
    });
    return { providerSandboxId: box.id };
  },

  async exec(id, command, o, ctx) {
    const box = await devbox(id, ctx);
    const r = await box.cmd.exec(
      `${o.env ? Object.entries(o.env).map(([k, v]) => `export ${k}='${v.replace(/'/g, `'\\''`)}'; `).join("") : ""}${o.cwd ? `cd '${o.cwd}' && ` : ""}${command}`,
      { stdout: o.onStdout, stderr: o.onStderr },
    );
    const [stdout, stderr] = await Promise.all([r.stdout(), r.stderr()]);
    return { stdout, stderr, exitCode: r.exitCode ?? -1 };
  },

  async readFile(id, path, ctx) {
    const text = await (await devbox(id, ctx)).file.read({ file_path: path });
    return new TextEncoder().encode(text);
  },

  async writeFile(id, path, data, ctx) {
    // write takes text; binary goes through the router's exec fallback via base64.
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(data);
    } catch {
      throw new SandboxRouterError("unsupported", "binary write", "runloop");
    }
    await (await devbox(id, ctx)).file.write({ file_path: path, contents: text });
  },

  async getUrl(id, port, ctx) {
    const box = await devbox(id, ctx);
    if (!(await box.getTunnel())) await box.net.enableTunnel({ auth_mode: "open" });
    return box.getTunnelUrl(port);
  },

  async setTimeout(id, _timeoutSec, ctx) {
    await (await devbox(id, ctx)).keepAlive();
  },

  async pause(id, ctx) {
    await (await devbox(id, ctx)).suspend();
  },

  async resume(id, ctx) {
    await (await devbox(id, ctx)).resume();
  },

  async kill(id, ctx) {
    await (await devbox(id, ctx)).shutdown();
  },

  async listAlive(ctx) {
    const { client } = await runloop(ctx);
    const ids: string[] = [];
    for await (const d of client.devboxes.list({ status: "running" })) ids.push(d.id);
    return ids;
  },
});
