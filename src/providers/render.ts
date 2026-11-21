// Render Sandboxes (public beta since 2026-11-04): Firecracker microVMs in Oregon. No free
// allowance. Bills CPU actually used plus provisioned memory; a suspended sandbox costs no
// compute. Render terminates the sandbox at `timeoutSeconds`.
// REST: https://api.render.com/v1 (Bearer rnd_…), OpenAPI at
// api-docs.render.com/openapi/render-public-api-1.json. Exec and file transfer take two
// steps: mint a connect token on the API, then call the sandbox's own data-plane URL with it.
// npm `@renderinc/sdk` ≥ 1.8.0, CLI `render sandboxes`. No public URLs, no directory listing
// and no way to change the timeout after create yet.

import { defineProvider, http, httpJson } from "./util.js";
import { inline, pollMs, sbrName, sleep, sse } from "./rest-helpers.js";
import type { ProviderContext } from "../core/types.js";

const base = (ctx: ProviderContext) => String(ctx.env["RENDER_API_URL"] ?? "https://api.render.com/v1").replace(/\/+$/, "");
const auth = (ctx: ProviderContext) => ({ authorization: `Bearer ${ctx.env["RENDER_API_KEY"]}` });
const owner = (ctx: ProviderContext) => String(ctx.env["RENDER_WORKSPACE_ID"]);
const box = (ctx: ProviderContext, id: string, path = "") => `${base(ctx)}/sandboxes/${encodeURIComponent(id)}${path}`;

/** Render plans: the smallest that fits the request. */
export function renderPlan(cpu: number, memoryMiB: number): { plan: string; cpu: number; memoryMiB: number } {
  const plans = [1, 2, 4, 8].map((c) => ({ plan: `${c}c-${c * 2}g`, cpu: c, memoryMiB: c * 2048 }));
  return plans.find((p) => p.cpu >= cpu && p.memoryMiB >= memoryMiB) ?? plans[plans.length - 1]!;
}

interface Sandbox {
  id: string;
  name?: string;
  status: "creating" | "running" | "suspending" | "suspended" | "resuming" | "errored" | "terminated";
}
/** A short-lived grant to call the sandbox's data plane. */
interface ConnectToken {
  token: string;
  uri: string;
  method: string;
}

const connect = (ctx: ProviderContext, id: string, path: string, query: Record<string, string>, body?: unknown) =>
  httpJson<ConnectToken>(`${box(ctx, id, path)}?${new URLSearchParams({ ownerId: owner(ctx), ...query })}`, { method: "POST", headers: auth(ctx), body });

export const renderProvider = defineProvider({
  info: {
    id: "render",
    name: "Render Sandboxes",
    homepage: "https://render.com/sandboxes",
    env: ["RENDER_API_KEY", "RENDER_WORKSPACE_ID"],
    capabilities: ["snapshot"],
    isolation: "microvm",
    maxTimeoutSec: 2_592_000,
    freeTier: {
      tier: { kind: "none" },
      notes: "Beta, on every workspace plan; no free allowance. 100 concurrent on the lowest plan.",
      source: "https://render.com/pricing",
      checked: "2026-11-12",
    },
    // $0.12 per active CPU-hour plus $0.019 per provisioned GB-hour.
    pricing: { vcpuSecondUsd: 0.12 / 3600, gibSecondUsd: 0.019 / 3600, defaultCpu: 1, defaultMemoryMiB: 2048, billing: "active-cpu", source: "https://render.com/pricing" },
    surfaces: { rest: "https://api.render.com/v1", sdk: ["@renderinc/sdk (npm)", "render (PyPI)"], cli: "render sandboxes" },
  },

  async create(spec, ctx) {
    const size = renderPlan(spec.cpu, spec.memoryMiB);
    let sandbox = await httpJson<Sandbox>(`${base(ctx)}/sandboxes`, {
      headers: auth(ctx),
      body: {
        ownerId: owner(ctx),
        sandboxGroupId: ctx.options["sandboxGroupId"],
        name: sbrName(spec),
        plan: size.plan,
        timeoutSeconds: Math.max(60, Math.ceil(spec.timeoutSec)),
        // Idle suspension stops background processes, so it is off unless asked for (300–86400).
        idleTimeoutSeconds: Number(ctx.options["idleTimeoutSeconds"] ?? 0),
        env: spec.env,
        // A build is Render's imported OCI image; a template names one.
        buildName: spec.nativeTemplate,
      },
    });
    try {
      for (let i = 0; i < 600 && sandbox.status !== "running"; i++) {
        if (sandbox.status === "errored" || sandbox.status === "terminated") throw new Error(`render sandbox ${sandbox.id} is ${sandbox.status}`);
        await sleep(pollMs(ctx, 250));
        sandbox = await httpJson<Sandbox>(box(ctx, sandbox.id), { headers: auth(ctx) });
      }
      if (sandbox.status !== "running") throw new Error(`render sandbox ${sandbox.id} did not start`);
    } catch (err) {
      // The router never learned this id, so nothing else would end it.
      await http(box(ctx, sandbox.id, "/terminate"), { method: "POST", headers: auth(ctx) }).catch(() => undefined);
      throw err;
    }
    return { providerSandboxId: sandbox.id, cpu: size.cpu, memoryMiB: size.memoryMiB };
  },

  async exec(id, command, o, ctx) {
    // No cwd, env or timeout fields: each command is a fresh `bash -c` in the home directory.
    const line = inline(command, o);
    const grant = await connect(ctx, id, "/runs/stream/token", {}, { command: line });
    const res = await http(grant.uri, {
      method: grant.method,
      headers: { authorization: `Bearer ${grant.token}`, accept: "text/event-stream" },
      body: { command: line },
      timeoutMs: ((o.timeoutSec ?? 3600) + 30) * 1000,
    });
    let stdout = "";
    let stderr = "";
    for await (const ev of sse(res.body as unknown as AsyncIterable<Uint8Array>)) {
      const data = JSON.parse(ev.data || "{}") as { stream?: string; data?: string; exit_code?: number; status?: number; message?: string };
      if (ev.event === "output" && data.stream === "stderr") {
        stderr += data.data ?? "";
        o.onStderr?.(data.data ?? "");
      } else if (ev.event === "output") {
        stdout += data.data ?? "";
        o.onStdout?.(data.data ?? "");
      } else if (ev.event === "exit") {
        return { stdout, stderr, exitCode: data.exit_code ?? -1 };
      } else if (ev.event === "error") {
        throw new Error(`render exec: ${data.status ?? ""} ${data.message ?? ""}`.trim());
      }
    }
    throw new Error("render exec: the stream ended without an exit event");
  },

  async readFile(id, path, ctx) {
    const grant = await connect(ctx, id, "/files/download/token", { path });
    const res = await http(grant.uri, { method: grant.method, headers: { authorization: `Bearer ${grant.token}` } });
    return new Uint8Array(await res.arrayBuffer());
  },

  async writeFile(id, path, data, ctx) {
    const grant = await connect(ctx, id, "/files/upload/token", { path });
    await http(grant.uri, { method: grant.method, headers: { authorization: `Bearer ${grant.token}`, "content-type": "application/octet-stream" }, raw: data });
  },

  async kill(id, ctx) {
    await http(box(ctx, id, "/terminate"), { method: "POST", headers: auth(ctx) });
  },

  async listAlive(ctx) {
    // Terminated sandboxes are left out unless asked for; suspended ones still exist.
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const q = new URLSearchParams({ ownerId: owner(ctx), limit: "100", ...(cursor ? { cursor } : {}) });
      const page = await httpJson<{ sandbox: Sandbox; cursor: string }[]>(`${base(ctx)}/sandboxes?${q}`, { headers: auth(ctx) });
      for (const x of page) if (x.sandbox.status !== "errored" && x.sandbox.status !== "terminated") ids.push(x.sandbox.id);
      cursor = page.length === 100 ? page[page.length - 1]!.cursor : undefined;
    } while (cursor);
    return ids;
  },
});
