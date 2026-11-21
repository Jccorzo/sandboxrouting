// Cloudflare Sandboxes (Containers + Durable Objects). Cloudflare has no hosted sandbox API:
// you deploy the bridge Worker in templates/cloudflare-worker, and this adapter talks to it.
// No free plan: Workers Paid ($5/mo) includes 375 vCPU-min, 25 GiB-h memory and 200 GB-h
// disk every month, which the router treats as monthly credit you already pay for.

import { createHash } from "node:crypto";
import { defineProvider, http, httpJson } from "./util.js";
import type { ProviderContext } from "../core/types.js";

const base = (ctx: ProviderContext) => String(ctx.options["url"] ?? ctx.env["CLOUDFLARE_SANDBOX_URL"] ?? "").replace(/\/+$/, "");
const auth = (ctx: ProviderContext) => ({ authorization: `Bearer ${ctx.env["CLOUDFLARE_SANDBOX_TOKEN"]}` });
const at = (ctx: ProviderContext, id: string, path = "") => `${base(ctx)}/sandboxes/${encodeURIComponent(id)}${path}`;

// Included with Workers Paid, at list prices: 375 min × 60 × $0.00002 + 25 GiB-h × 3600 × $0.0000025.
const INCLUDED_USD = 375 * 60 * 0.00002 + 25 * 3600 * 0.0000025;

export const cloudflareProvider = defineProvider({
  info: {
    id: "cloudflare",
    name: "Cloudflare Sandbox",
    homepage: "https://developers.cloudflare.com/sandbox/",
    env: ["CLOUDFLARE_SANDBOX_URL", "CLOUDFLARE_SANDBOX_TOKEN"],
    sdkPackage: "@cloudflare/sandbox (in the bridge Worker)",
    capabilities: ["fileList", "extendTimeout"],
    isolation: "container",
    freeTier: {
      tier: { kind: "monthly-credit", usd: Math.round(INCLUDED_USD * 100) / 100 },
      requiresCard: true,
      notes: "Usage included with Workers Paid ($5/mo): 375 vCPU-min + 25 GiB-h memory a month. Needs the bridge Worker.",
      source: "https://developers.cloudflare.com/containers/pricing/",
      checked: "2026-11-11",
    },
    // CPU is billed only while active (ranked at the expected share); memory while it runs.
    pricing: { vcpuSecondUsd: 0.00002, gibSecondUsd: 0.0000025, defaultCpu: 1, defaultMemoryMiB: 4096, billing: "active-cpu", source: "https://developers.cloudflare.com/containers/pricing/" },
    surfaces: { rest: "your bridge Worker (templates/cloudflare-worker)", sdk: ["@cloudflare/sandbox (npm, inside a Worker)"], cli: "wrangler" },
  },

  isConfigured(ctx) {
    return Boolean((ctx.options["url"] || ctx.env["CLOUDFLARE_SANDBOX_URL"]) && ctx.env["CLOUDFLARE_SANDBOX_TOKEN"]);
  },

  async create(spec, ctx) {
    // The instance type (size) is fixed in wrangler.jsonc; the id names the Durable Object.
    const id = `sbr-${createHash("sha256").update(spec.metadata["sandboxrouting.id"] ?? String(Date.now())).digest("hex").slice(0, 16)}`;
    await http(`${base(ctx)}/sandboxes`, {
      headers: auth(ctx),
      body: { id, env: spec.env, timeoutSec: spec.timeoutSec, internet: ctx.options["internet"] ?? true },
    });
    return { providerSandboxId: id };
  },

  async exec(id, command, o, ctx) {
    const r = await httpJson<{ stdout: string; stderr: string; exitCode: number }>(at(ctx, id, "/exec"), {
      headers: auth(ctx),
      body: { command, cwd: o.cwd, env: o.env },
      timeoutMs: ((o.timeoutSec ?? 3600) + 30) * 1000,
    });
    if (r.stdout) o.onStdout?.(r.stdout);
    if (r.stderr) o.onStderr?.(r.stderr);
    return r;
  },

  async readFile(id, path, ctx) {
    const res = await http(`${at(ctx, id, "/files")}?path=${encodeURIComponent(path)}`, { headers: auth(ctx) });
    return new Uint8Array(await res.arrayBuffer());
  },

  async writeFile(id, path, data, ctx) {
    await http(`${at(ctx, id, "/files")}?path=${encodeURIComponent(path)}`, {
      method: "PUT",
      headers: { ...auth(ctx), "content-type": "application/octet-stream" },
      raw: data,
    });
  },

  async listFiles(id, path, ctx) {
    const items = await httpJson<{ name: string; type: string }[]>(`${at(ctx, id, "/files/list")}?path=${encodeURIComponent(path)}`, { headers: auth(ctx) });
    const dir = path.endsWith("/") ? path : `${path}/`;
    return items.map((e) => ({ name: e.name, path: `${dir}${e.name}`, isDir: /dir/i.test(e.type) }));
  },

  async setTimeout(id, timeoutSec, ctx) {
    await http(at(ctx, id, "/timeout"), { headers: auth(ctx), body: { timeoutSec } });
  },

  async kill(id, ctx) {
    await http(at(ctx, id), { method: "DELETE", headers: auth(ctx) });
  },

  async listAlive(ctx) {
    return (await httpJson<{ id: string }[]>(`${base(ctx)}/sandboxes`, { headers: auth(ctx) })).map((s) => s.id);
  },
});
