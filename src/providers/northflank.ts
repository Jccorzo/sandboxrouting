// Northflank: each sandbox is a deployment service. Free ("Sandbox" plan): up to $20 of
// resources every month, but only 2 services, so 2 sandboxes at a time. Slower to boot
// than microVM providers (create, then wait for the instance).
// Spoken directly, no SDK. Lifecycle: REST at https://api.northflank.com/v1 (Bearer), docs
// https://northflank.com/docs/v1/api/project/services/create-deployment-service, get-service,
// delete-service, list-services. Commands: Northflank documents exec only through its CLI and JS
// client (https://northflank.com/docs/v1/api/execute-command); this speaks the WebSocket that
// client opens (npm `@northflank/js-client` 0.9.5, MIT): wss://…/v1/command-exec/projects/{p}/
// services/{s}, an `init` frame carrying the token and the command, then `init`, `stdOut`,
// `stdErr`, `completion` and `error` frames back. MCP: https://mcp.northflank.com/mcp.
// Needs a project: NORTHFLANK_PROJECT.

import { createHash } from "node:crypto";
import { defineProvider, http, httpJson } from "./util.js";
import { WebSocketClient } from "./websocket.js";
import type { ProviderContext } from "../core/types.js";

const projectId = (ctx: ProviderContext) => String(ctx.options["project"] ?? ctx.env["NORTHFLANK_PROJECT"]);
const apiBase = (ctx: ProviderContext) => String(ctx.env["NORTHFLANK_API_URL"] ?? "https://api.northflank.com").replace(/\/+$/, "");
const services = (ctx: ProviderContext, id = "") => `${apiBase(ctx)}/v1/projects/${encodeURIComponent(projectId(ctx))}/services${id ? `/${encodeURIComponent(id)}` : ""}`;
const auth = (ctx: ProviderContext) => ({ Authorization: `Bearer ${String(ctx.env["NORTHFLANK_TOKEN"])}` });

/** Northflank compute plans: vCPU → plan id and what it gives. */
function plan(cpu: number): { id: string; cpu: number; memoryMiB: number } {
  if (cpu <= 0.1) return { id: "nf-compute-10", cpu: 0.1, memoryMiB: 256 };
  if (cpu <= 0.2) return { id: "nf-compute-20", cpu: 0.2, memoryMiB: 512 };
  if (cpu <= 0.5) return { id: "nf-compute-50", cpu: 0.5, memoryMiB: 1024 };
  if (cpu <= 1) return { id: "nf-compute-100-2", cpu: 1, memoryMiB: 2048 };
  if (cpu <= 2) return { id: "nf-compute-200", cpu: 2, memoryMiB: 4096 };
  return { id: "nf-compute-400", cpu: 4, memoryMiB: 8192 };
}

interface ExecFrame {
  type?: string;
  data?: unknown;
}

/** Runs argv in the service's container over the command-exec socket, as the JS client's execServiceCommand does. */
async function execCommand(ctx: ProviderContext, serviceId: string, command: string[]): Promise<{ stdOut: string; stdErr: string; exitCode: number }> {
  const url = `${services(ctx, serviceId).replace("/v1/projects/", "/v1/command-exec/projects/")}`.replace(/^http/, "ws");
  const fail = (why: string) => new Error(`Command execution failed: ${why}`);
  const ws = await WebSocketClient.connect(url).catch((err: unknown) => {
    throw Object.assign(fail(`WebSocket error: ${(err as Error).message}`), { status: (err as { status?: number }).status });
  });
  let stdOut = "";
  let stdErr = "";
  try {
    // The token rides in the first frame, not the handshake. shell "none": the argv runs as given.
    ws.send(JSON.stringify({ type: "init", data: { auth: { type: "apiToken", apiToken: String(ctx.env["NORTHFLANK_TOKEN"]) }, context: { command, shell: "none" } } }));
    for await (const m of ws.messages()) {
      const f = JSON.parse(m.data.toString("utf8")) as ExecFrame;
      const data = f.data as Record<string, unknown> | string | undefined;
      if (f.type === "init") {
        const d = (data ?? {}) as { auth?: string; message?: string };
        if (d.auth !== "successful") throw fail(`Command initialization failed: ${d.message ?? "Reason unknown"}`);
      } else if (f.type === "stdOut") stdOut += String(data ?? "");
      else if (f.type === "stdErr") stdErr += String(data ?? "");
      else if (f.type === "completion") return { stdOut, stdErr, exitCode: Number((data as { exitCode?: number } | undefined)?.exitCode ?? 0) };
      else if (f.type === "error") throw fail(String((data as { message?: string } | undefined)?.message ?? "Unknown error"));
      else throw fail(`unable to parse message: ${JSON.stringify(f)}`);
    }
    throw fail(ws.closeCode === undefined || [1000, 1005].includes(ws.closeCode) ? "Connection closed before receiving command result" : `WebSocket closed unexpectedly: ${ws.closeCode} ${ws.closeReason || "(no reason)"}`);
  } catch (err) {
    if (err instanceof Error && !err.message.startsWith("Command execution failed")) throw fail(`WebSocket error: ${err.message}`);
    throw err;
  } finally {
    await ws.close().catch(() => undefined);
  }
}

export const northflankProvider = defineProvider({
  info: {
    id: "northflank",
    name: "Northflank",
    homepage: "https://northflank.com/docs/v1/application/sandboxes",
    env: ["NORTHFLANK_TOKEN", "NORTHFLANK_PROJECT"],
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
    const size = plan(spec.cpu);
    const serviceId = `sbr-${createHash("sha256").update(spec.metadata["sandboxrouting.id"] ?? String(Date.now())).digest("hex").slice(0, 12)}`;
    await http(`${services(ctx)}/deployment`, {
      method: "POST",
      headers: auth(ctx),
      body: {
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
      const svc = await httpJson<{ data?: { status?: { deployment?: { status?: string } } } }>(services(ctx, serviceId), { headers: auth(ctx) });
      const status = svc.data?.status?.deployment?.status;
      if (status === "COMPLETED") break;
      if (status === "FAILED") throw new Error(`northflank service ${serviceId} failed to deploy`);
      await new Promise((r) => setTimeout(r, Number(ctx.options["pollMs"] ?? 2000)));
    }
    return { providerSandboxId: serviceId, cpu: size.cpu, memoryMiB: size.memoryMiB };
  },

  async exec(id, command, o, ctx) {
    const env = Object.entries(o.env ?? {}).map(([k, v]) => `export ${k}='${v.replace(/'/g, `'\\''`)}'; `).join("");
    const cd = o.cwd ? `cd '${o.cwd.replace(/'/g, `'\\''`)}' && ` : "";
    const r = await execCommand(ctx, id, ["sh", "-c", `${env}${cd}${command}`]);
    if (r.stdOut) o.onStdout?.(r.stdOut);
    if (r.stdErr) o.onStderr?.(r.stdErr);
    return { stdout: r.stdOut, stderr: r.stdErr, exitCode: r.exitCode };
  },

  async kill(id, ctx) {
    await http(services(ctx, id), { method: "DELETE", headers: auth(ctx) });
  },

  async listAlive(ctx) {
    const res = await httpJson<{ data: { services: { id: string }[] } }>(services(ctx), { headers: auth(ctx) });
    return res.data.services.map((s) => s.id).filter((id) => id.startsWith("sbr-"));
  },
});
