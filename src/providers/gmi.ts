// GMI Agentbox (gmicloud.ai, early access): GMI Cloud's sandboxes, launched from a template (an
// "Agent" built from a container image in the console or API). Billed per minute by size, disk
// included: Small 1 vCPU / 2 GiB $0.0861/h, Medium 2 vCPU / 4 GiB $0.17/h, Large 4 vCPU / 8 GiB
// $0.34/h; paused sandboxes and snapshots are free during early access. No free tier.
// REST, two planes (docs.gmicloud.ai/agentbox-api/sandbox/overview.md; OpenAPI at
// docs.gmicloud.ai/api-spec/sandbox_api.yaml; pricing gmicloud.ai/en/models/agentbox):
// - control plane https://console.gmicloud.ai/api/v2 (Bearer API key): create, get, connect,
//   timeout, pause, resume, delete; `{request_id, data}` envelopes; create takes an Idempotency-Key.
// - data plane https://{sandbox_key}.{domain} (X-Access-Token from create/connect): /executions
//   (async, polled) and /files. Ports are served at https://{port}-{sandbox_key}.{domain}.
// Size, image and disk come from the template's build, so a request's cpu/memory can't change them.
// Billing refusals arrive late: the sandbox is deleted with a `Sandbox.Billing…` reason.

import { randomUUID } from "node:crypto";
import { SandboxRouterError } from "../core/errors.js";
import { defineProvider, http, httpJson, HttpError, refusals } from "./util.js";
import { grantCache, pollMs, sleep } from "./rest-helpers.js";
import type { ProviderContext } from "../core/types.js";

const base = (ctx: ProviderContext) => String(ctx.env["GMI_SANDBOX_API_URL"] ?? "https://console.gmicloud.ai/api/v2").replace(/\/+$/, "");
const auth = (ctx: ProviderContext) => ({ authorization: `Bearer ${ctx.env["GMI_SANDBOX_API_KEY"]}` });
const box = (ctx: ProviderContext, id: string, path = "") => `${base(ctx)}/sandboxes/${encodeURIComponent(id)}${path}`;
const gone = (err: unknown) => err instanceof HttpError && (err.status === 404 || err.status === 410);

/** 429 Resource.QuotaExceeded is a live instance/vCPU quota: it clears as sandboxes end. */
const refused = refusals("gmi", [{ status: 429, kind: "rate_limit", why: "instance or vCPU limit reached" }]);

interface Access {
  sandbox_key: string;
  domain: string;
  sandbox_access_token: string;
}
interface Sandbox extends Partial<Access> {
  id: string;
  state?: string;
  resources?: { vcpu?: number; memory_mb?: number };
  failure?: { code?: string; message?: string };
  deletion?: { code?: string; message?: string };
}
interface Execution {
  execution_id: string;
  status: string;
  exit_code?: number | null;
  stdout?: string | null;
  stderr?: string | null;
  failure_reason?: string;
}
const TERMINAL = ["succeeded", "failed", "cancelled", "timed_out"];

/** The data plane's host for a sandbox. `GMI_SANDBOX_DATA_URL` replaces it (`{key}` for the key). */
const dataUrl = (ctx: ProviderContext, a: Access) =>
  String(ctx.env["GMI_SANDBOX_DATA_URL"] ?? `https://{key}.${a.domain}`)
    .replace("{key}", a.sandbox_key)
    .replace(/\/+$/, "");

// The access token lasts the sandbox's life, but connect re-signs it after a resume or a new timeout.
const grants = grantCache<Access>();
const access = (ctx: ProviderContext, id: string) =>
  grants.get(id, async () => ({
    value: (await httpJson<{ data: Access }>(box(ctx, id, "/connect"), { headers: auth(ctx), body: {} })).data,
    expiresAt: Date.now() + 3_600_000,
  }));
async function data(ctx: ProviderContext, id: string, path: string, opts: Parameters<typeof http>[1] = {}): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const a = await access(ctx, id);
    try {
      return await http(`${dataUrl(ctx, a)}${path}`, { ...opts, headers: { ...opts.headers, "x-access-token": a.sandbox_access_token } });
    } catch (err) {
      // A re-signed token: connect again once.
      if (attempt === 0 && err instanceof HttpError && err.status === 401) grants.drop(id);
      else throw err;
    }
  }
}

/** Flat per-size prices split as $0.0425 per vCPU-hour + $0.02125 per GiB-hour (Medium is $0.17). */
const VCPU_HOUR = 0.0425;
const GIB_HOUR = 0.02125;

export const gmiProvider = defineProvider({
  info: {
    id: "gmi",
    name: "GMI Agentbox",
    homepage: "https://www.gmicloud.ai/en/models/agentbox",
    env: ["GMI_SANDBOX_API_KEY", "GMI_SANDBOX_TEMPLATE"],
    capabilities: ["ports", "pause", "snapshot", "extendTimeout"],
    maxTimeoutSec: 86_400,
    maxExecSec: 3600,
    freeTier: {
      tier: { kind: "none" },
      notes: "Early access, pay as you go with no platform fee; paused sandboxes and snapshots are free until early access ends.",
      source: "https://www.gmicloud.ai/en/models/agentbox",
      checked: "2026-11-21",
    },
    pricing: { vcpuSecondUsd: VCPU_HOUR / 3600, gibSecondUsd: GIB_HOUR / 3600, defaultCpu: 2, defaultMemoryMiB: 4096, source: "https://www.gmicloud.ai/en/models/agentbox" },
    surfaces: { rest: "https://console.gmicloud.ai/api/v2 + https://{sandbox_key}.{domain}", sdk: ["gmi-agentbox-sdk (PyPI, Go)", "GMI Sandbox SDK (PyPI)"] },
  },

  async create(spec, ctx) {
    const template = spec.nativeTemplate ?? String(ctx.env["GMI_SANDBOX_TEMPLATE"] ?? "");
    const key = (spec.metadata["sandboxrouting.id"] ?? randomUUID()).replace(/[^\x21-\x7e]/g, "").slice(0, 64);
    let r: { data: Sandbox };
    try {
      r = await httpJson<{ data: Sandbox }>(`${base(ctx)}/sandboxes`, {
        headers: { ...auth(ctx), "idempotency-key": key },
        body: {
          template_id: template,
          timeout: Math.min(86_400, Math.max(1, Math.ceil(spec.timeoutSec))),
          env_vars: spec.env,
          metadata: spec.metadata,
          ...(typeof ctx.options["product"] === "string" ? { product: ctx.options["product"] } : {}),
          ...(spec.region ? { idc_name: spec.region } : {}),
        },
        timeoutMs: 180_000,
      });
    } catch (err) {
      throw refused(err);
    }
    const id = r.data.id;
    try {
      let cur = r.data;
      for (let i = 0; i < 600 && cur.state !== "running"; i++) {
        const why = cur.failure ?? cur.deletion;
        if (/Billing/.test(why?.code ?? "")) throw new SandboxRouterError("quota", `gmi: ${why?.code}: ${why?.message ?? ""}`, "gmi");
        // Create's answer carries no state: it is provisioning until a read says otherwise.
        if (cur.state !== undefined && cur.state !== "provisioning") throw new Error(`gmi sandbox ${id} is ${cur.state}${why?.message ? `: ${why.message}` : ""}`);
        await sleep(pollMs(ctx, 1000));
        cur = (await httpJson<{ data: Sandbox }>(box(ctx, id), { headers: auth(ctx) })).data;
      }
      if (cur.state !== "running") throw new Error(`gmi sandbox ${id} did not start`);
      if (r.data.sandbox_key && r.data.domain && r.data.sandbox_access_token) {
        const made = { sandbox_key: r.data.sandbox_key, domain: r.data.domain, sandbox_access_token: r.data.sandbox_access_token };
        await grants.get(id, async () => ({ value: made, expiresAt: Date.now() + 3_600_000 }));
      }
      return { providerSandboxId: id, cpu: cur.resources?.vcpu ?? spec.cpu, memoryMiB: cur.resources?.memory_mb ?? spec.memoryMiB };
    } catch (err) {
      await http(box(ctx, id), { method: "DELETE", headers: auth(ctx) }).catch(() => undefined);
      throw err;
    }
  },

  async exec(id, command, o, ctx) {
    const execution_timeout_seconds = Math.min(3600, Math.max(1, Math.ceil(o.timeoutSec ?? 3600)));
    const started = (await (
      await data(ctx, id, "/executions?wait=true&wait_timeout_seconds=25", {
        headers: { "idempotency-key": randomUUID() },
        body: { action: "exec", parameters: { command, ...(o.env && Object.keys(o.env).length ? { envs: o.env } : {}), ...(o.cwd ? { cwd: o.cwd } : {}), execution_timeout_seconds } },
        timeoutMs: 60_000,
      })
    ).json()) as Execution;
    let r = started;
    while (!TERMINAL.includes(r.status)) {
      await sleep(pollMs(ctx, 1000));
      r = (await (await data(ctx, id, `/executions/${encodeURIComponent(started.execution_id)}`)).json()) as Execution;
    }
    const stdout = r.stdout ?? "";
    let stderr = r.stderr ?? "";
    if (r.failure_reason) stderr += `${stderr && !stderr.endsWith("\n") ? "\n" : ""}gmi: ${r.failure_reason}\n`;
    if (stdout) o.onStdout?.(stdout);
    if (stderr) o.onStderr?.(stderr);
    return { stdout, stderr, exitCode: r.status === "timed_out" ? 124 : r.exit_code ?? (r.status === "succeeded" ? 0 : 1) };
  },

  async readFile(id, path, ctx) {
    return new Uint8Array(await (await data(ctx, id, `/files?path=${encodeURIComponent(path)}`)).arrayBuffer());
  },

  async writeFile(id, path, bytes, ctx) {
    const form = new FormData();
    form.append("file", new Blob([bytes]), path.split("/").pop() || "file");
    await data(ctx, id, `/files?path=${encodeURIComponent(path)}`, { method: "POST", raw: form });
  },

  async getUrl(id, port, ctx) {
    const a = await access(ctx, id);
    return `https://${port}-${a.sandbox_key}.${a.domain}`;
  },

  async setTimeout(id, timeoutSec, ctx) {
    await http(box(ctx, id, "/timeout"), { headers: auth(ctx), body: { timeout: Math.min(86_400, Math.max(1, Math.ceil(timeoutSec))) } });
    grants.drop(id);
  },

  async pause(id, ctx) {
    await http(box(ctx, id, "/pause"), { method: "POST", headers: auth(ctx) });
    await settle(ctx, id, "paused");
  },

  async resume(id, ctx) {
    await http(box(ctx, id, "/resume"), { method: "POST", headers: auth(ctx), body: {} });
    await settle(ctx, id, "running");
    grants.drop(id);
  },

  async kill(id, ctx) {
    grants.drop(id);
    await http(box(ctx, id), { method: "DELETE", headers: auth(ctx) }).catch((err) => {
      if (!gone(err)) throw err;
    });
  },

  async listAlive(ctx) {
    const ids: string[] = [];
    for (let page = 1; ; page++) {
      const r = await httpJson<{ total: number; items: Sandbox[] }>(`${base(ctx)}/sandboxes?page=${page}&page_size=100`, { headers: auth(ctx) });
      ids.push(...r.items.filter((s) => s.state !== "deleting" && s.state !== "deleted").map((s) => s.id));
      if (r.items.length < 100 || page * 100 >= r.total) return ids;
    }
  },
});

async function settle(ctx: ProviderContext, id: string, target: string): Promise<void> {
  for (let i = 0; i < 300; i++) {
    const s = (await httpJson<{ data: Sandbox }>(box(ctx, id), { headers: auth(ctx) })).data;
    if (s.state === target) return;
    if (["failed", "deleting", "deleted"].includes(s.state ?? "")) throw new Error(`gmi sandbox ${id} is ${s.state}`);
    await sleep(pollMs(ctx, 1000));
  }
  throw new Error(`gmi sandbox ${id} did not reach ${target}`);
}
