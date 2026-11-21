// DigitalOcean Harness Runtime (Managed Agents): hardware-isolated microVM sandboxes. A
// sandbox with no agent in it is a session whose environment spec says `harness: none`; it runs
// commands as root in /workspace (Ubuntu 24.04). Billed per second of active compute: $0.044
// per vCPU-hour of CPU actually used and $0.0095 per GB-hour of memory allocated; a paused
// session pays no compute. Needs a positive Harness Runtime prepayment. No free tier: the $5
// promotional credit comes with the $50-a-month Agent Droplets Pro plan.
// A session has no time limit (it pauses after 15 minutes idle), so the router deletes it at
// the deadline (enforcesTimeout: false). One exec runs at most 240 s.
// REST: https://api.digitalocean.com/v2/harness-runtime (Bearer DigitalOcean API token); docs
// docs.digitalocean.com/reference/api/reference/harness-runtime/,
// docs.digitalocean.com/products/managed-agents/agent-harness-runtime/how-to/run-sandbox/,
// …/reference/environment-spec/, …/details/pricing/, …/details/limits/. CLI
// `doctl harness-runtime`, SDKs PyDo, DoTs, Godo.
// Create takes the YAML spec and answers once the session row exists; the sandbox boots after.
// Each create also saves an Environment Config, which kill deletes. Files go only to the
// workspace (/workspace); other paths use the router's exec fallback. Session names are unique
// among live sessions, so a create retried after a lost answer finds the first one by name.

import { defineProvider, http, httpJson, HttpError } from "./util.js";
import { insideRoots, pollMs, sbrName, sleep, shq, ENV_FILE, envFileBody, withEnvFile, inline } from "./rest-helpers.js";
import type { ProviderContext } from "../core/types.js";

const base = (ctx: ProviderContext) => String(ctx.env["DIGITALOCEAN_API_URL"] ?? "https://api.digitalocean.com").replace(/\/+$/, "");
const auth = (ctx: ProviderContext) => ({ authorization: `Bearer ${ctx.env["DIGITALOCEAN_TOKEN"]}` });
const api = (ctx: ProviderContext, path: string) => `${base(ctx)}/v2/harness-runtime${path}`;
const session = (ctx: ProviderContext, id: string, path = "") => api(ctx, `/sessions/${encodeURIComponent(id)}${path}`);
const gone = (err: unknown) => err instanceof HttpError && (err.status === 404 || err.status === 410);
const EXEC_LIMIT_SEC = 240;
const WORKSPACE = "/workspace";
/** The integrity footer after a download's bytes: `DOWSSHA1`, 64 hex characters, a newline. */
const FOOTER = 73;

const SIZES = [
  { size: "mars-1vcpu-1gb", cpu: 1, memoryMiB: 1024 },
  { size: "mars-2vcpu-2gb", cpu: 2, memoryMiB: 2048 },
  { size: "mars-2vcpu-4gb", cpu: 2, memoryMiB: 4096 },
  { size: "mars-4vcpu-8gb", cpu: 4, memoryMiB: 8192 },
  { size: "mars-16vcpu-32gb", cpu: 16, memoryMiB: 32768 },
];
/** Harness Runtime sizes, smallest first: the first that fits the request. */
export function digitaloceanSize(cpu: number, memoryMiB: number) {
  return SIZES.find((s) => s.cpu >= cpu && s.memoryMiB >= memoryMiB) ?? SIZES[SIZES.length - 1]!;
}

interface Session {
  session_id: string;
  status?: string;
  config_id?: string;
  name?: string;
}
const UP = ["SESSION_STATUS_READY", "SESSION_STATUS_DETACHED"];
const DEAD = ["SESSION_STATUS_FAILED", "SESSION_STATUS_DESTROYED"];

/** The environment spec as YAML: every value is a JSON string, which YAML reads as written. */
export function digitaloceanSpec(name: string, size: string, labels: Record<string, string>, template?: string): string {
  const q = (s: string) => JSON.stringify(s);
  const lines = [`name: ${q(name)}`, "harness: none", `size: ${q(size)}`];
  if (template) lines.push(`template: ${q(template)}`);
  const pairs = Object.entries(labels);
  if (pairs.length) lines.push("labels:", ...pairs.map(([k, v]) => `  ${q(k)}: ${q(v)}`));
  return `${lines.join("\n")}\n`;
}

async function run(ctx: ProviderContext, id: string, argv: string[], extra: { workdir?: string; stdin?: string; timeoutSec?: number } = {}) {
  const timeout_seconds = Math.min(EXEC_LIMIT_SEC, Math.max(1, Math.ceil(extra.timeoutSec ?? EXEC_LIMIT_SEC)));
  return httpJson<{ exit_code?: number; stdout?: string; stderr?: string }>(session(ctx, id, "/sandbox/exec"), {
    headers: auth(ctx),
    body: { argv, timeout_seconds, ...(extra.workdir ? { workdir: extra.workdir } : {}), ...(extra.stdin !== undefined ? { stdin: extra.stdin } : {}) },
    timeoutMs: (timeout_seconds + 60) * 1000,
  });
}

async function destroy(ctx: ProviderContext, id: string, configId?: string): Promise<void> {
  await http(session(ctx, id), { method: "DELETE", headers: auth(ctx) }).catch((err) => {
    if (!gone(err)) throw err;
  });
  // Removing a session keeps the Environment Config its create saved.
  if (configId) await http(api(ctx, `/configs/${encodeURIComponent(configId)}`), { method: "DELETE", headers: auth(ctx) }).catch(() => undefined);
}

export const digitaloceanProvider = defineProvider({
  info: {
    id: "digitalocean",
    name: "DigitalOcean Harness Runtime",
    homepage: "https://www.digitalocean.com/products/managed-agents",
    env: ["DIGITALOCEAN_TOKEN"],
    capabilities: ["pause"],
    isolation: "microvm",
    enforcesTimeout: false,
    maxExecSec: EXEC_LIMIT_SEC,
    freeTier: {
      tier: { kind: "none" },
      concurrency: 100,
      requiresCard: true,
      notes: "Needs a positive Harness Runtime prepayment. The $5 promotional credit is for new customers on the Agent Droplets Pro plan ($50 a month, 15% off). Up to 100 sessions at once, by resource tier.",
      source: "https://docs.digitalocean.com/products/managed-agents/agent-harness-runtime/details/pricing/",
      checked: "2026-11-21",
    },
    pricing: { billing: "active-cpu", vcpuSecondUsd: 0.044 / 3600, gibSecondUsd: 0.0095 / 3600, defaultCpu: 2, defaultMemoryMiB: 4096, source: "https://docs.digitalocean.com/products/managed-agents/agent-harness-runtime/details/pricing/" },
    surfaces: { rest: "https://api.digitalocean.com/v2/harness-runtime", sdk: ["pydo (PyPI)", "@digitalocean/dots (npm)", "godo (Go)"], cli: "doctl harness-runtime" },
  },

  async create(spec, ctx) {
    const size = digitaloceanSize(spec.cpu, spec.memoryMiB);
    const name = sbrName(spec);
    let made: Session;
    try {
      made = (
        await httpJson<{ session: Session }>(api(ctx, "/sessions"), {
          headers: { ...auth(ctx), "content-type": "application/x-yaml" },
          raw: digitaloceanSpec(name, size.size, spec.metadata, spec.nativeTemplate),
        })
      ).session;
    } catch (err) {
      // 409 is a live session of this name (a retried create) or the active-session quota.
      if (!(err instanceof HttpError && err.status === 409)) throw err;
      const found = await httpJson<{ sessions?: Session[] }>(`${api(ctx, "/sessions")}?name=${encodeURIComponent(name)}`, { headers: auth(ctx) });
      const first = found.sessions?.[0];
      if (!first) throw err;
      made = first;
    }
    const id = made.session_id;
    let configId = made.config_id;
    try {
      let status = made.status ?? "";
      for (let i = 0; i < 600 && !UP.includes(status); i++) {
        if (DEAD.includes(status)) throw new Error(`digitalocean session ${id} is ${status}`);
        await sleep(pollMs(ctx, 1000));
        const cur = (await httpJson<{ session: Session }>(session(ctx, id), { headers: auth(ctx) })).session;
        status = cur.status ?? "";
        configId ??= cur.config_id;
      }
      if (!UP.includes(status)) throw new Error(`digitalocean session ${id} did not become ready`);
      if (Object.keys(spec.env).length) {
        // Spec env refuses credential-shaped names, so create-time env goes in a file instead.
        const r = await run(ctx, id, ["sh", "-c", `cat > ${shq(ENV_FILE)}`], { stdin: Buffer.from(envFileBody(spec.env)).toString("base64") });
        if (r.exit_code) throw new Error(`digitalocean session ${id}: writing its environment failed: ${r.stderr ?? ""}`);
      }
    } catch (err) {
      await destroy(ctx, id, configId).catch(() => undefined);
      throw err;
    }
    return { providerSandboxId: id, cpu: size.cpu, memoryMiB: size.memoryMiB };
  },

  async exec(id, command, o, ctx) {
    // argv runs with no shell; per-command env names must be upper case, so they are inlined.
    const r = await run(ctx, id, ["sh", "-c", withEnvFile(inline(command, { env: o.env }))], { workdir: o.cwd, timeoutSec: o.timeoutSec });
    const stdout = r.stdout ?? "";
    const stderr = r.stderr ?? "";
    if (stdout) o.onStdout?.(stdout);
    if (stderr) o.onStderr?.(stderr);
    return { stdout, stderr, exitCode: r.exit_code ?? 0 };
  },

  async readFile(id, path, ctx) {
    insideRoots("digitalocean", path, [WORKSPACE]);
    const res = await http(`${session(ctx, id, "/workspace/download")}?path=${encodeURIComponent(path)}`, { headers: auth(ctx) });
    const body = Buffer.from(await res.arrayBuffer());
    const footer = body.subarray(body.length - FOOTER).toString("latin1");
    if (body.length < FOOTER || !/^DOWSSHA1[0-9a-f]{64}\n$/.test(footer)) throw new Error(`digitalocean download of ${path} ended without its integrity footer`);
    return new Uint8Array(body.subarray(0, body.length - FOOTER));
  },

  async writeFile(id, path, data, ctx) {
    insideRoots("digitalocean", path, [WORKSPACE]);
    await http(`${session(ctx, id, "/workspace/upload")}?path=${encodeURIComponent(path)}`, { method: "POST", headers: { ...auth(ctx), "content-type": "application/octet-stream" }, raw: data });
  },

  async pause(id, ctx) {
    await http(session(ctx, id, "/pause"), { method: "POST", headers: auth(ctx) });
  },

  async resume(id, ctx) {
    await http(session(ctx, id, "/resume"), { method: "POST", headers: auth(ctx) });
  },

  async kill(id, ctx) {
    let configId: string | undefined;
    try {
      configId = (await httpJson<{ session: Session }>(session(ctx, id), { headers: auth(ctx) })).session.config_id;
    } catch (err) {
      if (gone(err)) return;
      throw err;
    }
    await destroy(ctx, id, configId);
  },

  async listAlive(ctx) {
    // Destroyed and failed sessions are left out by default.
    const ids: string[] = [];
    let token = "";
    do {
      const q = new URLSearchParams({ page_size: "200", ...(token ? { page_token: token } : {}) });
      const page: { sessions?: Session[]; next_page_token?: string } = await httpJson(`${api(ctx, "/sessions")}?${q}`, { headers: auth(ctx) });
      ids.push(...(page.sessions ?? []).filter((s) => !DEAD.includes(s.status ?? "")).map((s) => s.session_id));
      token = page.next_page_token ?? "";
    } while (token);
    return ids;
  },
});
