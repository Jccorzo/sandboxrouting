// Azure Container Apps Sandboxes (Microsoft.App/SandboxGroups; preview at Build 2026, GA at
// Ignite 2026): microVM sandboxes with create, exec, files, ports and stop/resume, inside a
// sandbox group you create once. Chosen over dynamic sessions, whose pool allocates a session
// on first request, caps code runs at 220 s and has no create or stop call for one session.
//   https://learn.microsoft.com/azure/container-apps/sandboxes-overview
//   https://sandboxes.azure.com/docs/sandboxes
//   npm @azure/containerapps-sandbox 1.0.0-beta.1 (the wire calls below are what it sends),
//   specification/app/data-plane/ContainerApps in Azure/azure-rest-api-specs
//     https://management.{region}.azuredevcompute.io, token audience https://dynamicsessions.io,
//     api-version 2026-02-01-preview, all under
//     /subscriptions/{s}/resourceGroups/{rg}/sandboxGroups/{group}
//     PUT    /sandboxes                         {sourcesRef, resources, labels, environment, lifecycle} → Sandbox
//     GET    /sandboxes/{id}                    {id, state: Creating|Running|Stopping|Stopped|Idle|StopFailed}
//     GET    /sandboxes?labels=k=v              {value, nextLink}
//     DELETE /sandboxes/{id}
//     POST   /sandboxes/{id}/executeShellCommand {command, environment, workingDirectory} → {exitCode, stdout, stderr}
//     GET|PUT /sandboxes/{id}/files?path=…      raw bytes (PUT takes createDirs=true)
//     GET    /sandboxes/{id}/files/list?path=…  {path, entries: [{name, path, size, isDirectory}]}
//     POST   /sandboxes/{id}/ports/add          {port, auth: {anonymous}} → the port's url
//     POST   /sandboxes/{id}/stop | /resume
// Pricing: "Sandboxes follow the same pay-per-second pricing as Consumption Plan"
// (azure.microsoft.com/pricing/details/container-apps); the retail prices API has no separate
// sandbox meter, so the Consumption active rates and free grant are used.

import { SandboxRouterError } from "../core/errors.js";
import { defineProvider, http, HttpError, httpJson, toBuffer } from "./util.js";
import { pollMs, shq, sleep } from "./rest-helpers.js";
import { azureToken, hasAzureCredentials } from "./azure-auth.js";
import type { ProviderContext, ResolvedSpec } from "../core/types.js";

const ID = "azure-sandboxes";
const RESOURCE = "https://dynamicsessions.io";
const LABEL = "sandboxrouting";

const base = (ctx: ProviderContext) =>
  String(ctx.env["AZURE_SANDBOX_API_URL"] ?? `https://management.${ctx.env["AZURE_REGION"]}.azuredevcompute.io`).replace(/\/+$/, "");
const group = (ctx: ProviderContext) =>
  `/subscriptions/${ctx.env["AZURE_SUBSCRIPTION_ID"]}/resourceGroups/${ctx.env["AZURE_RESOURCE_GROUP"]}/sandboxGroups/${ctx.env["AZURE_SANDBOX_GROUP"]}`;
const apiVersion = (ctx: ProviderContext) => String(ctx.options["apiVersion"] ?? "2026-02-01-preview");
const url = (ctx: ProviderContext, path: string, query: Record<string, string> = {}) =>
  `${base(ctx)}${group(ctx)}${path}?${new URLSearchParams({ "api-version": apiVersion(ctx), ...query })}`;
const box = (id: string, path = "") => `/sandboxes/${encodeURIComponent(id)}${path}`;
const auth = async (ctx: ProviderContext) => ({ authorization: `Bearer ${await azureToken(ctx, ID, RESOURCE)}` });

/** The sandbox tiers: the smallest that covers the request. */
const TIERS: [cpu: number, gib: number][] = [
  [0.25, 0.5],
  [0.5, 1],
  [1, 2],
  [2, 4],
  [4, 8],
  [8, 16],
  [16, 32],
];
export function azureTier(cpu: number, memoryMiB: number): { cpu: string; memory: string; vcpu: number; memoryMiB: number } {
  const [c, g] = TIERS.find(([c, g]) => c >= cpu && g * 1024 >= memoryMiB) ?? TIERS[TIERS.length - 1]!;
  return { cpu: String(c), memory: `${g}Gi`, vcpu: c, memoryMiB: g * 1024 };
}

interface Sandbox {
  id: string;
  state?: string;
  labels?: Record<string, string>;
  ports?: { port: number; url?: string }[];
}

/** The create body. A native template is a sandbox-group disk image id; else a public image. */
export function azureCreateBody(spec: ResolvedSpec, ctx: ProviderContext) {
  const tier = azureTier(spec.cpu, spec.memoryMiB);
  const diskImage = spec.nativeTemplate ? { id: spec.nativeTemplate, isPublic: false } : { name: String(ctx.options["image"] ?? "ubuntu"), isPublic: true };
  const routerId = spec.metadata["sandboxrouting.id"];
  return {
    body: {
      sourcesRef: { diskImage },
      resources: { cpu: tier.cpu, memory: tier.memory },
      labels: { [LABEL]: "sbr", ...(routerId ? { "sandboxrouting-id": routerId } : {}) },
      environment: spec.env,
      // Idle for the whole lifetime → suspended (no compute charge); deleted a day after it stops.
      // The router deletes it at the deadline; these only bound what a lost router leaves behind.
      lifecycle: {
        autoSuspendPolicy: { enabled: true, interval: Math.max(60, Math.ceil(spec.timeoutSec)) },
        autoDeletePolicy: { enabled: true, deleteIntervalInSeconds: 86_400 },
      },
    },
    tier,
  };
}

async function get(ctx: ProviderContext, id: string): Promise<Sandbox> {
  return httpJson<Sandbox>(url(ctx, box(id)), { headers: await auth(ctx) });
}

/** Polls until `want`; a failed state on the way throws. */
async function waitFor(ctx: ProviderContext, id: string, want: string[], limitMs: number): Promise<void> {
  const deadline = Date.now() + limitMs;
  for (;;) {
    const s = await get(ctx, id);
    const state = s.state ?? "";
    if (want.includes(state)) return;
    if (/fail|delet/i.test(state) || (!want.includes("Stopped") && state === "Stopped")) throw new Error(`${ID} sandbox ${id} is ${state}`);
    if (Date.now() > deadline) throw new SandboxRouterError("transient", `${ID} sandbox ${id} still ${state} after ${limitMs / 1000} s`, ID);
    await sleep(pollMs(ctx, 1000));
  }
}

async function remove(ctx: ProviderContext, id: string): Promise<void> {
  try {
    await http(url(ctx, box(id)), { method: "DELETE", headers: await auth(ctx) });
  } catch (err) {
    if (err instanceof HttpError && (err.status === 404 || err.status === 410)) return;
    throw err;
  }
}

export const azureSandboxesProvider = defineProvider({
  info: {
    id: ID,
    name: "Azure Container Apps Sandboxes",
    homepage: "https://learn.microsoft.com/azure/container-apps/sandboxes-overview",
    // Plus a credential: AZURE_ACCESS_TOKEN, or AZURE_TENANT_ID + AZURE_CLIENT_ID + AZURE_CLIENT_SECRET.
    env: ["AZURE_SUBSCRIPTION_ID", "AZURE_RESOURCE_GROUP", "AZURE_SANDBOX_GROUP", "AZURE_REGION"],
    capabilities: ["ports", "pause", "fileList"],
    isolation: "microvm",
    // Lifecycle policies are idle-based, not a deadline: the router deletes at the deadline.
    enforcesTimeout: false,
    freeTier: {
      // 180,000 vCPU-s × $0.000024 + 360,000 GiB-s × $0.000003.
      tier: { kind: "monthly-credit", usd: 5.4 },
      requiresCard: true,
      notes:
        "Consumption-plan grant, 180,000 vCPU-seconds + 360,000 GiB-seconds per subscription a month (≈ 25 h at 2 vCPU / 4 GiB); Azure says sandboxes bill like the Consumption plan but doesn't list them separately. Stopped sandboxes have no compute charge.",
      source: "https://azure.microsoft.com/en-us/pricing/details/container-apps/",
      checked: "2026-11-21",
    },
    pricing: { vcpuSecondUsd: 0.000024, gibSecondUsd: 0.000003, defaultCpu: 2, defaultMemoryMiB: 4096, source: "https://azure.microsoft.com/en-us/pricing/details/container-apps/" },
    surfaces: {
      rest: "https://management.{region}.azuredevcompute.io",
      sdk: ["@azure/containerapps-sandbox (npm)", "azure-containerapps-sandbox (PyPI)", ".NET"],
      cli: "az containerapp sandbox",
    },
  },

  isConfigured(ctx) {
    return ["AZURE_SUBSCRIPTION_ID", "AZURE_RESOURCE_GROUP", "AZURE_SANDBOX_GROUP", "AZURE_REGION"].every((k) => ctx.env[k]) && hasAzureCredentials(ctx);
  },

  async create(spec, ctx) {
    // The API takes no client name or idempotency key; the sandboxrouting-id label lets the
    // sweep find a sandbox whose create response was lost.
    const { body, tier } = azureCreateBody(spec, ctx);
    const created = await httpJson<Sandbox>(url(ctx, "/sandboxes"), { method: "PUT", headers: await auth(ctx), body });
    try {
      if (created.state !== "Running") await waitFor(ctx, created.id, ["Running"], Number(ctx.options["readyTimeoutSec"] ?? 300) * 1000);
    } catch (err) {
      await remove(ctx, created.id).catch(() => undefined);
      throw err;
    }
    return { providerSandboxId: created.id, cpu: tier.vcpu, memoryMiB: tier.memoryMiB };
  },

  async exec(id, command, o, ctx) {
    const limit = o.timeoutSec && o.timeoutSec > 0 ? Math.ceil(o.timeoutSec) : 0;
    // The call has no timeout field: `timeout` ends the command inside the sandbox.
    const line = limit ? `timeout -k 5 ${limit} sh -c ${shq(command)}` : command;
    const r = await httpJson<{ exitCode: number; stdout?: string; stderr?: string }>(url(ctx, box(id, "/executeShellCommand")), {
      headers: await auth(ctx),
      body: { command: line, ...(o.env && Object.keys(o.env).length ? { environment: o.env } : {}), ...(o.cwd ? { workingDirectory: o.cwd } : {}) },
      timeoutMs: ((limit || 3600) + 30) * 1000,
    });
    const stdout = r.stdout ?? "";
    const stderr = r.stderr ?? "";
    if (stdout) o.onStdout?.(stdout);
    if (stderr) o.onStderr?.(stderr);
    return { stdout, stderr, exitCode: r.exitCode };
  },

  async readFile(id, path, ctx) {
    const res = await http(url(ctx, box(id, "/files"), { path }), { headers: { ...(await auth(ctx)), accept: "application/octet-stream" } });
    return new Uint8Array(await res.arrayBuffer());
  },

  async writeFile(id, path, data, ctx) {
    await http(url(ctx, box(id, "/files"), { path, createDirs: "true" }), {
      method: "PUT",
      headers: { ...(await auth(ctx)), "content-type": "application/octet-stream" },
      raw: toBuffer(data),
    });
  },

  async listFiles(id, path, ctx) {
    const r = await httpJson<{ entries?: { name: string; path?: string; size?: number; isDirectory?: boolean }[] }>(url(ctx, box(id, "/files/list"), { path }), {
      headers: await auth(ctx),
    });
    const dir = path.endsWith("/") ? path : `${path}/`;
    return (r.entries ?? []).map((e) => ({ name: e.name, path: e.path ?? `${dir}${e.name}`, isDir: Boolean(e.isDirectory), size: e.size }));
  },

  async getUrl(id, port, ctx) {
    const r = await httpJson<{ url?: string; port?: number; ports?: { port: number; url?: string }[] }>(url(ctx, box(id, "/ports/add")), {
      headers: await auth(ctx),
      body: { port, auth: { anonymous: true } },
    });
    const found = r.url ?? r.ports?.find((p) => p.port === port)?.url ?? (await get(ctx, id)).ports?.find((p) => p.port === port)?.url;
    if (!found) throw new Error(`${ID} sandbox ${id} returned no URL for port ${port}`);
    return found;
  },

  async pause(id, ctx) {
    await http(url(ctx, box(id, "/stop")), { headers: await auth(ctx), body: {} });
    await waitFor(ctx, id, ["Stopped", "Idle"], 300_000);
  },

  async resume(id, ctx) {
    await http(url(ctx, box(id, "/resume")), { headers: await auth(ctx), body: {} });
    await waitFor(ctx, id, ["Running"], 300_000);
  },

  async kill(id, ctx) {
    await remove(ctx, id);
  },

  async listAlive(ctx) {
    const ids: string[] = [];
    let next: string | undefined = url(ctx, "/sandboxes", { labels: `${LABEL}=sbr` });
    const origin = new URL(base(ctx)).origin;
    while (next) {
      const page: { value?: Sandbox[]; nextLink?: string } = await httpJson(next, { headers: await auth(ctx) });
      for (const s of page.value ?? []) if (s.labels?.[LABEL] === "sbr" && !/delet/i.test(s.state ?? "")) ids.push(s.id);
      // Only follow a next link on the same host, so the token never goes elsewhere.
      next = page.nextLink && new URL(page.nextLink, origin).origin === origin ? new URL(page.nextLink, origin).toString() : undefined;
    }
    return ids;
  },
});
