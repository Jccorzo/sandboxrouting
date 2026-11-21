// Oblien (oblien.com): Firecracker microVMs for agents. Pay as you go from a funded wallet:
// $0.03 per active vCPU-hour, $0.008 per reserved GiB-hour of RAM (paused VMs too), $0.05 per
// retained GiB-month of disk; no free tier. CPU is billed only while used.
// Control plane: https://api.oblien.com/v1 (X-Client-ID + X-Client-Secret), docs
// oblien.com/docs/api.md, oblien.com/docs/api/vms.md, oblien.com/docs/api/lifecycle.md,
// oblien.com/docs/api/runtime-api-access.md, oblien.com/docs/api/public-access.md; pricing
// oblien.com/pricing and oblien.com/docs/concepts/compute-billing.md. npm `oblien`, CLI `oblien`.
// Commands and files run on the VM's own server, reached through the gateway vm.oblien.com with
// a short-lived JWT (five minutes; oblien.com/docs/runtime-api/server-setup.md,
// /docs/runtime-api/exec.md, /docs/runtime-api/files.md). Enabling the server returns one;
// GET /v2/vms/:id/runtime-api-access/token renews it. The file API moves text only, so reads
// and writes use the router's exec fallback; listing is native.
// A temporary VM with `ttl_action: "remove"` deletes itself at its TTL; POST /ping renews it.
// Create takes an Idempotency-Key, and with `wait_ready: false` answers 202 while provisioning
// runs (`queued`, `running`, then `ready` or `failed`). Errors are `{success: false, error,
// code, message}`; 402 SANDBOX_LIMIT_REACHED / RUNNING_POOL_REACHED are plan concurrency limits,
// 402 POOL_LIMIT_REACHED the owned resource pool, 403 RESOURCE_NOT_ALLOWED a size over the plan.

import { randomUUID } from "node:crypto";
import { defineProvider, http, httpJson, HttpError, refusals } from "./util.js";
import { grantCache, inline, pollMs, sleep } from "./rest-helpers.js";
import type { ProviderContext } from "../core/types.js";

const api = (ctx: ProviderContext) => String(ctx.env["OBLIEN_API_URL"] ?? "https://api.oblien.com").replace(/\/+$/, "");
const gateway = (ctx: ProviderContext) => String(ctx.env["OBLIEN_RUNTIME_URL"] ?? "https://vm.oblien.com").replace(/\/+$/, "");
const auth = (ctx: ProviderContext) => ({ "x-client-id": String(ctx.env["OBLIEN_CLIENT_ID"]), "x-client-secret": String(ctx.env["OBLIEN_CLIENT_SECRET"]) });
const vmUrl = (ctx: ProviderContext, id: string, path = "", version = "v1") => `${api(ctx)}/${version}/vms/${encodeURIComponent(id)}${path}`;
const gone = (err: unknown) => err instanceof HttpError && (err.status === 404 || err.status === 410);
const refused = refusals("oblien", [
  { status: 402, body: /SANDBOX_LIMIT_REACHED|RUNNING_POOL_REACHED/, kind: "rate_limit", why: "plan limit on VMs at once" },
  { status: 403, body: /RESOURCE_NOT_ALLOWED/, kind: "quota", why: "size over the plan's limit" },
]);

/** Runtime gateway tokens, per VM, kept until shortly before they expire. */
const tokens = grantCache<string>();

async function token(ctx: ProviderContext, id: string): Promise<string> {
  return tokens.get(`${api(ctx)}|${id}`, async () => {
    const r = await httpJson<{ token: string; expires_at?: string }>(vmUrl(ctx, id, "/runtime-api-access/token", "v2"), { headers: auth(ctx) });
    return { value: r.token, expiresAt: Date.parse(r.expires_at ?? "") || Date.now() + 120_000 };
  });
}

interface Vm {
  id: string;
  ready?: boolean;
  info?: { status?: string };
  provisioning?: { state?: string; status?: string; error?: string };
  resources?: { cpus?: number; memory_mb?: number };
}
/** A VM from `{vm, ready?, provisioning?}`; the 202 of a create puts progress beside `vm`. */
const vmOf = (r: { vm?: Vm } & Partial<Vm>): Vm => {
  const v = r.vm ?? (r as Vm);
  return { ...v, provisioning: r.provisioning ?? v.provisioning, ready: r.ready ?? v.ready };
};
const provisioning = (v: Vm) => v.provisioning?.state ?? v.provisioning?.status;
const isReady = (v: Vm) => v.ready === true || provisioning(v) === "ready" || (!v.provisioning && v.info?.status === "running");

export const oblienProvider = defineProvider({
  info: {
    id: "oblien",
    name: "Oblien",
    homepage: "https://oblien.com",
    env: ["OBLIEN_CLIENT_ID", "OBLIEN_CLIENT_SECRET"],
    capabilities: ["ports", "pause", "snapshot", "fileList", "extendTimeout"],
    isolation: "microvm",
    freeTier: { tier: { kind: "none" }, notes: "Pay as you go from a funded wallet; account plans add a balance of unstated size.", source: "https://oblien.com/pricing", checked: "2026-11-21" },
    // CPU billed as used; RAM reserved for every second the VM holds it.
    pricing: { vcpuSecondUsd: 0.03 / 3600, gibSecondUsd: 0.008 / 3600, billing: "active-cpu", defaultCpu: 2, defaultMemoryMiB: 4096, source: "https://oblien.com/pricing" },
    surfaces: { rest: "https://api.oblien.com/v1 + vm.oblien.com", sdk: ["oblien (npm)"], cli: "oblien", mcp: "docs: oblien.com/docs/mcp" },
  },

  async create(spec, ctx) {
    const cpus = Math.min(12, Math.max(0.1, spec.cpu));
    const memory_mb = Math.min(65_536, Math.max(128, Math.ceil(spec.memoryMiB)));
    let first: Vm;
    try {
      first = vmOf(
        await httpJson(`${api(ctx)}/v1/vms`, {
          headers: { ...auth(ctx), "idempotency-key": spec.metadata["sandboxrouting.id"] ?? randomUUID() },
          body: {
            name: spec.metadata["sandboxrouting.id"],
            image: spec.nativeTemplate ?? spec.image,
            mode: "temporary",
            wait_ready: false,
            config: {
              cpus,
              memory_mb,
              ttl: `${Math.max(1, Math.ceil(spec.timeoutSec))}s`,
              ttl_action: "remove",
              env: Object.entries(spec.env).map(([key, value]) => ({ key, value })),
            },
          },
          timeoutMs: 120_000,
        }),
      );
    } catch (err) {
      throw refused(err);
    }
    const id = first.id;
    try {
      let v = first;
      for (let i = 0; i < 600 && !isReady(v); i++) {
        if (provisioning(v) === "failed") throw new Error(`oblien vm ${id} failed to provision${v.provisioning?.error ? `: ${v.provisioning.error}` : ""}`);
        await sleep(pollMs(ctx, 1000));
        v = vmOf(await httpJson(vmUrl(ctx, id), { headers: auth(ctx) }));
      }
      if (!isReady(v)) throw new Error(`oblien vm ${id} did not become ready`);
      // Starts the VM's runtime server; the token it returns is the first gateway grant.
      const access = await httpJson<{ token: string; expires_at?: string }>(vmUrl(ctx, id, "/runtime-api-access/enable", "v2"), { method: "POST", headers: auth(ctx) });
      await tokens.get(`${api(ctx)}|${id}`, async () => ({ value: access.token, expiresAt: Date.parse(access.expires_at ?? "") || Date.now() + 120_000 }));
    } catch (err) {
      // Oblien made it: never leave it running (and billing) when the create fails.
      await http(vmUrl(ctx, id), { method: "DELETE", headers: auth(ctx) }).catch(() => undefined);
      tokens.drop(`${api(ctx)}|${id}`);
      throw err;
    }
    return { providerSandboxId: id, cpu: first.resources?.cpus ?? cpus, memoryMiB: first.resources?.memory_mb ?? memory_mb };
  },

  async exec(id, command, o, ctx) {
    // `shell` mode wraps the one string in /bin/sh -c; there are no cwd or env fields.
    const timeout_seconds = o.timeoutSec === undefined ? 0 : Math.max(1, Math.ceil(o.timeoutSec));
    const r = await httpJson<{ status?: string; exit_code?: number; stdout?: string; stderr?: string }>(`${gateway(ctx)}/exec`, {
      headers: { authorization: `Bearer ${await token(ctx, id)}` },
      body: { cmd: [inline(command, o)], exec_mode: "shell", timeout_seconds },
      timeoutMs: ((o.timeoutSec ?? 3600) + 60) * 1000,
    });
    const stdout = r.stdout ?? "";
    const stderr = r.stderr ?? "";
    if (stdout) o.onStdout?.(stdout);
    if (stderr) o.onStderr?.(stderr);
    // A task killed by its timeout may come back without an exit code.
    return { stdout, stderr, exitCode: r.exit_code ?? 124 };
  },

  async listFiles(id, path, ctx) {
    const q = new URLSearchParams({ path, use_gitignore: "false" });
    const r = await httpJson<{ entries: { name: string; path: string; type: string; size?: number }[] }>(`${gateway(ctx)}/files?${q}`, {
      headers: { authorization: `Bearer ${await token(ctx, id)}` },
    });
    return r.entries.map((e) => ({ name: e.name, path: e.path, isDir: e.type === "directory", size: e.size }));
  },

  async getUrl(id, port, ctx) {
    const r = await httpJson<{ port: { url: string } }>(vmUrl(ctx, id, "/public-access"), { headers: auth(ctx), body: { port } });
    return r.port.url;
  },

  async setTimeout(id, timeoutSec, ctx) {
    // Renews the temporary VM's TTL from now.
    await http(vmUrl(ctx, id, "/ping"), { headers: auth(ctx), body: { ttl_seconds: Math.max(1, Math.ceil(timeoutSec)) } });
  },

  async pause(id, ctx) {
    await http(vmUrl(ctx, id, "/pause"), { method: "POST", headers: auth(ctx) });
  },

  async resume(id, ctx) {
    await http(vmUrl(ctx, id, "/resume"), { method: "POST", headers: auth(ctx) });
  },

  async kill(id, ctx) {
    tokens.drop(`${api(ctx)}|${id}`);
    await http(vmUrl(ctx, id), { method: "DELETE", headers: auth(ctx) }).catch((err) => {
      if (!gone(err)) throw err;
    });
  },

  async listAlive(ctx) {
    const ids: string[] = [];
    for (let page = 1; page <= 100; page++) {
      const r = await httpJson<{ vms: Vm[]; total?: number }>(`${api(ctx)}/v1/vms?page=${page}&limit=100&mode=temporary`, { headers: auth(ctx) });
      ids.push(...r.vms.map((v) => v.id));
      if (r.vms.length < 100 || (r.total !== undefined && ids.length >= r.total)) break;
    }
    return ids;
  },
});
