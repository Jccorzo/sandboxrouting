// Northflank: each sandbox is a deployment service. Free ("Sandbox" plan): up to $20 of
// resources every month, but only 2 services, so 2 sandboxes at a time. Slower to boot
// than microVM providers (create, then wait for the instance).
// SDK: npm `@northflank/js-client`. REST: https://api.northflank.com/v1 (Bearer).
// MCP: https://mcp.northflank.com/mcp. Needs a project: NORTHFLANK_PROJECT.

import { createHash } from "node:crypto";
import { defineProvider, loadSdk } from "./util.js";
import type { ProviderContext } from "../core/types.js";

type NfSdk = typeof import("@northflank/js-client");
type NfClient = InstanceType<NfSdk["ApiClient"]>;

let client: NfClient | undefined;

async function nf(ctx: ProviderContext): Promise<NfClient> {
  if (client) return client;
  const { ApiClient, ApiClientInMemoryContextProvider } = await loadSdk<NfSdk>("@northflank/js-client", "northflank");
  const contexts = new ApiClientInMemoryContextProvider();
  await contexts.addContext({ name: "sandboxrouting", token: String(ctx.env["NORTHFLANK_TOKEN"]) });
  client = new ApiClient(contexts, { throwErrorOnHttpErrorCode: true });
  return client;
}

const projectId = (ctx: ProviderContext) => String(ctx.options["project"] ?? ctx.env["NORTHFLANK_PROJECT"]);

/** Northflank compute plans: vCPU → plan id and what it gives. */
function plan(cpu: number): { id: string; cpu: number; memoryMiB: number } {
  if (cpu <= 0.1) return { id: "nf-compute-10", cpu: 0.1, memoryMiB: 256 };
  if (cpu <= 0.2) return { id: "nf-compute-20", cpu: 0.2, memoryMiB: 512 };
  if (cpu <= 0.5) return { id: "nf-compute-50", cpu: 0.5, memoryMiB: 1024 };
  if (cpu <= 1) return { id: "nf-compute-100-2", cpu: 1, memoryMiB: 2048 };
  if (cpu <= 2) return { id: "nf-compute-200", cpu: 2, memoryMiB: 4096 };
  return { id: "nf-compute-400", cpu: 4, memoryMiB: 8192 };
}

export const northflankProvider = defineProvider({
  info: {
    id: "northflank",
    name: "Northflank",
    homepage: "https://northflank.com/docs/v1/application/sandboxes",
    env: ["NORTHFLANK_TOKEN", "NORTHFLANK_PROJECT"],
    sdkPackage: "@northflank/js-client",
    capabilities: ["customImage"],
    isolation: "container",
    // A service restarts its container when `sleep` ends, so the router deletes it instead.
    enforcesTimeout: false,
    freeTier: {
      tier: { kind: "monthly-credit", usd: 20 },
      concurrency: 2,
      notes: "Sandbox plan: up to $20 of resources a month; 2 services (one per sandbox).",
      source: "https://northflank.com/pricing",
      checked: "2026-11-11",
    },
    pricing: { vcpuSecondUsd: 0.01667 / 3600, gibSecondUsd: 0.00833 / 3600, defaultCpu: 0.5, defaultMemoryMiB: 1024, source: "https://northflank.com/pricing" },
    surfaces: { rest: "https://api.northflank.com/v1", sdk: ["@northflank/js-client (npm)", "northflank (PyPI)"], cli: "northflank", mcp: "https://mcp.northflank.com/mcp" },
  },

  isConfigured(ctx) {
    return Boolean(ctx.env["NORTHFLANK_TOKEN"] && (ctx.options["project"] || ctx.env["NORTHFLANK_PROJECT"]));
  },

  async create(spec, ctx) {
    const api = await nf(ctx);
    const size = plan(spec.cpu);
    const serviceId = `sbr-${createHash("sha256").update(spec.metadata["sandboxrouting.id"] ?? String(Date.now())).digest("hex").slice(0, 12)}`;
    await api.create.service.deployment({
      parameters: { projectId: projectId(ctx) },
      data: {
        name: serviceId,
        billing: { deploymentPlan: size.id },
        deployment: {
          instances: 1,
          external: { imagePath: spec.nativeTemplate ?? spec.image ?? "python:3.12-slim" },
          docker: { configType: "customEntrypointCustomCommand", customEntrypoint: "/bin/sh", customCommand: `-c "sleep ${spec.timeoutSec}"` },
        },
        runtimeEnvironment: spec.env,
      },
    });
    // Wait until an instance runs, so the first exec works.
    for (let i = 0; i < 90; i++) {
      const svc = await api.get.service({ parameters: { projectId: projectId(ctx), serviceId } });
      const status = (svc.data as { status?: { deployment?: { status?: string } } }).status?.deployment?.status;
      if (status === "COMPLETED") break;
      if (status === "FAILED") throw new Error(`northflank service ${serviceId} failed to deploy`);
      await new Promise((r) => setTimeout(r, 2000));
    }
    return { providerSandboxId: serviceId, cpu: size.cpu, memoryMiB: size.memoryMiB };
  },

  async exec(id, command, o, ctx) {
    const api = await nf(ctx);
    const env = Object.entries(o.env ?? {}).map(([k, v]) => `export ${k}='${v.replace(/'/g, `'\\''`)}'; `).join("");
    const cd = o.cwd ? `cd '${o.cwd.replace(/'/g, `'\\''`)}' && ` : "";
    const r = await api.exec.execServiceCommand({ projectId: projectId(ctx), serviceId: id }, { command: ["sh", "-c", `${env}${cd}${command}`] });
    if (r.stdOut) o.onStdout?.(r.stdOut);
    if (r.stdErr) o.onStderr?.(r.stdErr);
    return { stdout: r.stdOut, stderr: r.stdErr, exitCode: r.commandResult.exitCode };
  },

  async kill(id, ctx) {
    await (await nf(ctx)).delete.service({ parameters: { projectId: projectId(ctx), serviceId: id } });
  },

  async listAlive(ctx) {
    const res = await (await nf(ctx)).list.services({ parameters: { projectId: projectId(ctx) } });
    return res.data.services.map((s) => s.id).filter((id) => id.startsWith("sbr-"));
  },
});
