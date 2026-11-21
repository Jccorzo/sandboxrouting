// Cyqle: cloud Linux desktops (shell, browser, mouse and keyboard) for agents, driven over REST.
// Plans are per desktop ("slot"): Free (1 vCPU / 1 GB, 60-minute sessions, 60 minutes a day,
// one desktop, no card), then Lite $6, Standard $12 (2 vCPU / 4 GB), Turbo $23, Max $45 a month
// per desktop with unlimited session time, or the same tiers pay as you go in credits deducted
// per minute (1 credit = 10 desktop-hours; Standard $0.40 a credit = $0.04/h).
// Free usage is modelled as hours; a paid monthly desktop is usage included in its plan: set
// `providers.cyqle.freeTier` to `{ "tier": { "kind": "monthly-hours", "hours": 744 },
// "concurrency": <your desktops> }` and `options.slotId` (and `options.plan`) to use it.
// Pricing below is the pay-as-you-go Standard rate. Sizes come from the slot's plan, not the request.
// Docs: https://api.cyqle.in/v1/agent-guide.md, OpenAPI https://api.cyqle.in/v1/openapi.json,
//   pricing https://cyqle.in/en/#pricing (plan table in the page data), llms.txt https://cyqle.in/llms.txt.
// REST: https://api.cyqle.in/v1 (X-API-Key). A desktop lives in one region and is driven through
// that region's address (api-us / api-eu), so the router's id is "<region>:<session id>".
// No TTL: a free desktop sleeps (PAUSED) after 15 idle minutes and ends at 60; the router deletes
// it at its deadline. Exec runs up to 300 s; files go through exec with stdin, as the guide does.
// Cyqle doesn't publish how desktops are isolated ("its own isolated environment").

import { defineProvider, http, httpJson, HttpError, refusals } from "./util.js";
import { ENV_FILE, envFileBody, pollMs, shq, sleep, withEnvFile } from "./rest-helpers.js";
import type { ExecOptions, ExecResult, ProviderContext } from "../core/types.js";

/** Plan sizes from the pricing page's plan table. */
export const CYQLE_PLANS: Record<string, { cpu: number; memoryMiB: number }> = {
  free: { cpu: 1, memoryMiB: 1024 },
  lite: { cpu: 1, memoryMiB: 2048 },
  standard: { cpu: 2, memoryMiB: 4096 },
  turbo: { cpu: 4, memoryMiB: 8192 },
  max: { cpu: 8, memoryMiB: 16384 },
};

const override = (ctx: ProviderContext) => (ctx.env["CYQLE_API_URL"] ? String(ctx.env["CYQLE_API_URL"]).replace(/\/+$/, "") : undefined);
/** The address for a region (`us`, `eu`), or the default one. `CYQLE_API_URL` replaces them all. */
const regionBase = (ctx: ProviderContext, region?: string) =>
  override(ctx) ?? (region && /^[a-z]{2,8}$/.test(region) ? `https://api-${region}.cyqle.in/v1` : "https://api.cyqle.in/v1");
const auth = (ctx: ProviderContext) => ({ "x-api-key": String(ctx.env["CYQLE_API_KEY"]) });

/** "<region>:<id>" → where to send it, and the session id. */
function locate(ctx: ProviderContext, routerId: string) {
  const i = routerId.indexOf(":");
  return i < 0 ? { url: regionBase(ctx), id: routerId } : { url: regionBase(ctx, routerId.slice(0, i)), id: routerId.slice(i + 1) };
}
const session = (ctx: ProviderContext, routerId: string, path = "") => {
  const { url, id } = locate(ctx, routerId);
  return `${url}/sessions/${encodeURIComponent(id)}${path}`;
};

interface Session {
  id: string;
  region?: string;
  status?: "IDLE" | "INITIATING" | "RUNNING" | "PAUSED" | "SUSPENDED" | "DESTROYING" | string;
}
const routerIdOf = (s: Session) => (s.region ? `${s.region}:${s.id}` : s.id);

const refused = refusals("cyqle", [
  { status: 429, body: /DAILY_LIMIT_EXCEEDED|SUBSCRIPTION_EXPIRED/, kind: "quota", why: "the plan's allowance is used up" },
]);

async function waitRunning(ctx: ProviderContext, routerId: string): Promise<void> {
  for (let i = 0; i < 150; i++) {
    const s = (await httpJson<{ data: Session }>(session(ctx, routerId), { headers: auth(ctx) })).data;
    if (s.status === "RUNNING") return;
    if (s.status === "DESTROYING") throw new Error(`cyqle desktop ${routerId} is being destroyed`);
    await sleep(pollMs(ctx, 2000));
  }
  throw new Error(`cyqle desktop ${routerId} did not start`);
}

async function run(ctx: ProviderContext, routerId: string, body: Record<string, unknown>, timeoutMs: number): Promise<{ stdout?: string; stderr?: string; exitCode?: number }> {
  const send = () => httpJson<{ data: { stdout?: string; stderr?: string; exitCode?: number } }>(session(ctx, routerId, "/exec"), { headers: auth(ctx), body, timeoutMs: timeoutMs + 30_000 });
  try {
    return (await send()).data;
  } catch (err) {
    // A desktop that slept while idle: wake it, then retry once.
    if (!(err instanceof HttpError && err.status === 409 && /SESSION_PAUSED|not running/i.test(err.message))) throw err;
    if (/SESSION_PAUSED/.test(err.message)) await http(session(ctx, routerId, "/resume"), { method: "PUT", headers: auth(ctx) });
    await waitRunning(ctx, routerId);
    return (await send()).data;
  }
}

export const cyqleProvider = defineProvider({
  info: {
    id: "cyqle",
    name: "Cyqle",
    homepage: "https://cyqle.in",
    env: ["CYQLE_API_KEY"],
    capabilities: ["pause"],
    enforcesTimeout: false,
    maxExecSec: 300,
    freeTier: {
      // 60 minutes a day.
      tier: { kind: "monthly-hours", hours: 30 },
      concurrency: 1,
      maxLifetimeSec: 3600,
      requiresCard: false,
      notes:
        "Free plan: one desktop, 1 vCPU / 1 GB, 60-minute sessions and 60 minutes a day (resets 00:00 UTC; counted here as 30 h a month), no persistence, low-priority queue, no card. Paid desktops ($6–$45 a month each) have unlimited session time: model one as monthly-hours 744 per desktop in config.",
      source: "https://cyqle.in/en/#pricing",
      checked: "2026-11-21",
    },
    // Pay-as-you-go Standard (2 vCPU / 4 GB): $0.40 a credit, 10 h a credit = $0.04/h, split 2:1 vCPU:GiB.
    pricing: { vcpuSecondUsd: (0.04 * 2) / 3 / 2 / 3600, gibSecondUsd: 0.04 / 3 / 4 / 3600, defaultCpu: 2, defaultMemoryMiB: 4096, source: "https://cyqle.in/en/#pricing" },
    surfaces: { rest: "https://api.cyqle.in/v1", mcp: "https://api.cyqle.in/mcp" },
  },

  async create(spec, ctx) {
    const slotId = ctx.options["slotId"] === undefined ? undefined : String(ctx.options["slotId"]);
    const plan = CYQLE_PLANS[String(ctx.options["plan"] ?? (slotId ? "standard" : "free"))] ?? CYQLE_PLANS["free"]!;
    let created: Session;
    try {
      created = (await httpJson<{ data: Session }>(`${regionBase(ctx, spec.region)}/sessions`, { headers: auth(ctx), body: { slotId, snapshotId: spec.nativeTemplate } })).data;
    } catch (err) {
      throw refused(err);
    }
    // Sent to the default address, the desktop is driven through its region's from now on.
    const id = routerIdOf(created);
    try {
      if (created.status !== "RUNNING") await waitRunning(ctx, id);
      if (Object.keys(spec.env).length) {
        const r = await this.exec(id, `cat > ${ENV_FILE} <<'SBR_ENV'\n${envFileBody(spec.env)}SBR_ENV`, {}, ctx);
        if (r.exitCode !== 0) throw new Error(`cyqle desktop ${id}: could not write its environment: ${r.stderr}`);
      }
    } catch (err) {
      await this.kill(id, ctx).catch(() => undefined);
      throw err;
    }
    return { providerSandboxId: id, cpu: plan.cpu, memoryMiB: plan.memoryMiB };
  },

  async exec(id, command, o: ExecOptions, ctx): Promise<ExecResult> {
    const timeoutMs = Math.min(300_000, Math.max(1000, Math.ceil((o.timeoutSec ?? 300) * 1000)));
    const r = await run(ctx, id, { command: withEnvFile(command), workdir: o.cwd, env: o.env, timeoutMs }, timeoutMs);
    const stdout = r.stdout ?? "";
    const stderr = r.stderr ?? "";
    if (stdout) o.onStdout?.(stdout);
    if (stderr) o.onStderr?.(stderr);
    // -1: stopped by the timeout or a signal.
    const code = r.exitCode ?? -1;
    return { stdout, stderr, exitCode: code === -1 ? 124 : code };
  },

  async readFile(id, path, ctx) {
    const r = await run(ctx, id, { command: `base64 -w0 ${shq(path)}`, timeoutMs: 120_000 }, 120_000);
    if (r.exitCode !== 0) throw new HttpError(404, `cyqle: cannot read ${path}: ${r.stderr ?? ""}`);
    return new Uint8Array(Buffer.from((r.stdout ?? "").trim(), "base64"));
  },

  async writeFile(id, path, data, ctx) {
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) || "/" : ".";
    const r = await run(ctx, id, { command: `mkdir -p ${shq(dir)} && base64 -d > ${shq(path)}`, stdin: Buffer.from(data).toString("base64"), timeoutMs: 120_000 }, 120_000);
    if (r.exitCode !== 0) throw new Error(`cyqle: cannot write ${path}: ${r.stderr ?? ""}`);
  },

  async pause(id, ctx) {
    await http(session(ctx, id, "/pause"), { method: "PUT", headers: auth(ctx) });
  },

  async resume(id, ctx) {
    await http(session(ctx, id, "/resume"), { method: "PUT", headers: auth(ctx) });
    await waitRunning(ctx, id);
  },

  async kill(id, ctx) {
    try {
      await http(session(ctx, id), { method: "DELETE", headers: auth(ctx) });
    } catch (err) {
      if (err instanceof HttpError && (err.status === 404 || err.status === 410)) return;
      throw err;
    }
  },

  async listAlive(ctx) {
    // Each address lists only its own region's desktops.
    const bases = override(ctx) ? [override(ctx)!] : [regionBase(ctx, "us"), regionBase(ctx, "eu")];
    const ids = new Set<string>();
    for (const b of bases) {
      const r = await httpJson<{ data: Session[] }>(`${b}/sessions`, { headers: auth(ctx) });
      for (const s of r.data ?? []) if (s.status !== "DESTROYING") ids.add(routerIdOf(s));
    }
    return [...ids];
  },
});
