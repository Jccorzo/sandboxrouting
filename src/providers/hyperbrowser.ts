// Hyperbrowser Sandboxes: Firecracker microVMs next to Hyperbrowser's cloud browsers. Billed
// per allocated vCPU and GiB while running: 45 credits/vCPU-h + 15 credits/GiB-h, and
// 1,000 credits = $1, so $0.045/vCPU-h + $0.015/GiB-h ($0.15/h at 2 vCPU / 4 GiB). A free
// account gets 5,000 credits ($5) once; plan credits (Startup $30, Scale $100) reset monthly.
// Docs: https://hyperbrowser.ai/docs/sandboxes/create.md, .../sandboxes/lifecycle.md,
//   .../sandboxes/runtime.md, .../sandboxes/processes.md, .../sandboxes/filesystem/read-write.md,
//   https://hyperbrowser.ai/docs/pricing.md, https://www.hyperbrowser.ai/pricing,
//   OpenAPI https://hyperbrowser.ai/docs/openapi.json.
// Control plane: https://api.hyperbrowser.ai/api (x-api-key). Each sandbox has its own runtime
// URL (`runtime.baseUrl`) and token (24 h, refreshed by reading the sandbox again) for commands
// and files; the runtime paths (/exec, /files/read, /files/write, /files) are the ones the docs'
// curl example and npm `@hyperbrowser/sdk` 1.5.6 use. Create takes no env and no idempotency key.
// macOS (beta) and GPU sandboxes need access granted by Hyperbrowser and aren't routed here.

import { defineProvider, http, httpJson, HttpError } from "./util.js";
import { ENV_FILE, envFileBody, grantCache, pollMs, sleep, withEnvFile } from "./rest-helpers.js";
import type { FileInfo, ProviderContext } from "../core/types.js";

const base = (ctx: ProviderContext) => String(ctx.env["HYPERBROWSER_API_URL"] ?? "https://api.hyperbrowser.ai/api").replace(/\/+$/, "");
const auth = (ctx: ProviderContext) => ({ "x-api-key": String(ctx.env["HYPERBROWSER_API_KEY"]) });

const REGIONS = new Set(["us", "us-central", "us-west", "us-east", "asia-south", "europe-west"]);

interface Sandbox {
  id: string;
  status: "provisioning" | "active" | "stopping" | "closed" | "close-error" | "error" | string;
  closeReason?: string | null;
  vcpus?: number | null;
  memMiB?: number | null;
  runtime?: { baseUrl: string } | null;
  token?: string | null;
  tokenExpiresAt?: string | null;
}

/** Per-sandbox runtime URL and token, kept until shortly before the token expires. */
const runtimes = grantCache<{ url: string; token: string }>();
const grantOf = (s: Sandbox) => {
  if (!s.runtime?.baseUrl || !s.token) throw new Error(`hyperbrowser sandbox ${s.id} has no runtime (${s.status})`);
  const expiresAt = s.tokenExpiresAt ? Date.parse(s.tokenExpiresAt) : Date.now() + 3600_000;
  return { value: { url: s.runtime.baseUrl.replace(/\/+$/, ""), token: s.token }, expiresAt };
};
const getSandbox = (ctx: ProviderContext, id: string) => httpJson<Sandbox>(`${base(ctx)}/sandbox/${encodeURIComponent(id)}`, { headers: auth(ctx) });

/** A runtime request, minting the grant again once if the token was refused. */
async function runtime(ctx: ProviderContext, id: string, path: string, opts: Parameters<typeof http>[1] = {}): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const g = await runtimes.get(id, async () => grantOf(await getSandbox(ctx, id)));
    try {
      return await http(`${g.url}${path}`, { ...opts, headers: { ...opts.headers, authorization: `Bearer ${g.token}` } });
    } catch (err) {
      if (attempt === 0 && err instanceof HttpError && err.status === 401) {
        runtimes.drop(id);
        continue;
      }
      throw err;
    }
  }
}

export const hyperbrowserProvider = defineProvider({
  info: {
    id: "hyperbrowser",
    name: "Hyperbrowser Sandboxes",
    homepage: "https://www.hyperbrowser.ai",
    env: ["HYPERBROWSER_API_KEY"],
    capabilities: ["ports", "fileList"],
    isolation: "microvm",
    maxTimeoutSec: 1440 * 60,
    freeTier: {
      tier: { kind: "one-time-credit", usd: 5 },
      concurrency: 1,
      requiresCard: false,
      notes:
        "Free account: 5,000 credits ($5) shared by browsers, sandboxes, web APIs and agents, 1 concurrent session. The pricing page names no card. Paid plans' included credits reset monthly; bought credits expire after 12 months.",
      source: "https://www.hyperbrowser.ai/pricing",
      checked: "2026-11-21",
    },
    pricing: { vcpuSecondUsd: 0.045 / 3600, gibSecondUsd: 0.015 / 3600, defaultCpu: 2, defaultMemoryMiB: 2048, source: "https://hyperbrowser.ai/docs/pricing.md" },
    surfaces: { rest: "https://api.hyperbrowser.ai/api", sdk: ["@hyperbrowser/sdk (npm)", "hyperbrowser (PyPI)"], cli: "hx" },
  },

  async create(spec, ctx) {
    const vcpus = Math.min(32, Math.max(1, Math.round(spec.cpu || 2)));
    const memMiB = Math.min(262144, Math.max(512, Math.round(spec.memoryMiB || 2048)));
    let s = await httpJson<Sandbox>(`${base(ctx)}/sandbox`, {
      headers: auth(ctx),
      body: {
        imageName: spec.nativeTemplate ?? String(ctx.options["image"] ?? "node"),
        vcpus,
        memMiB,
        // Total lifetime from when the VM starts.
        timeoutMinutes: Math.min(1440, Math.max(1, Math.ceil(spec.timeoutSec / 60))),
        region: spec.region && REGIONS.has(spec.region) ? spec.region : undefined,
      },
    });
    try {
      for (let i = 0; i < 300 && s.status === "provisioning"; i++) {
        await sleep(pollMs(ctx, 1000));
        s = await getSandbox(ctx, s.id);
      }
      if (s.status !== "active") throw new Error(`hyperbrowser sandbox ${s.id} is ${s.status}${s.closeReason ? ` (${s.closeReason})` : ""}`);
      const grant = grantOf(s);
      await runtimes.get(s.id, async () => grant);
      if (Object.keys(spec.env).length) await this.writeFile(s.id, ENV_FILE, new TextEncoder().encode(envFileBody(spec.env)), ctx);
    } catch (err) {
      await this.kill(s.id, ctx).catch(() => undefined);
      throw err;
    }
    return { providerSandboxId: s.id, cpu: s.vcpus ?? vcpus, memoryMiB: s.memMiB ?? memMiB };
  },

  async exec(id, command, o, ctx) {
    const timeoutSec = Math.max(1, Math.ceil(o.timeoutSec ?? 600));
    const res = await runtime(ctx, id, "/exec", {
      body: { command: withEnvFile(command), cwd: o.cwd, env: o.env, timeoutMs: timeoutSec * 1000 },
      timeoutMs: (timeoutSec + 30) * 1000,
    });
    const r = (await res.json()) as { result?: Record<string, unknown> } & Record<string, unknown>;
    const out = (r.result ?? r) as { stdout?: string; stderr?: string; exitCode?: number | null; exit_code?: number | null };
    const stdout = out.stdout ?? "";
    const stderr = out.stderr ?? "";
    if (stdout) o.onStdout?.(stdout);
    if (stderr) o.onStderr?.(stderr);
    return { stdout, stderr, exitCode: out.exitCode ?? out.exit_code ?? 124 };
  },

  async readFile(id, path, ctx) {
    const res = await runtime(ctx, id, "/files/read", { body: { path, encoding: "base64" } });
    const r = (await res.json()) as { content: string };
    return new Uint8Array(Buffer.from(r.content, "base64"));
  },

  async writeFile(id, path, data, ctx) {
    await runtime(ctx, id, "/files/write", { body: { path, data: Buffer.from(data).toString("base64"), encoding: "base64" } });
  },

  async listFiles(id, path, ctx) {
    const res = await runtime(ctx, id, `/files?path=${encodeURIComponent(path)}&depth=1`);
    const r = (await res.json()) as { entries: { name: string; path?: string; type?: string; size?: number }[] };
    const dir = path.endsWith("/") ? path : `${path}/`;
    return r.entries.map((e): FileInfo => ({ name: e.name, path: e.path ?? `${dir}${e.name}`, isDir: /^dir/i.test(e.type ?? ""), size: e.size }));
  },

  async getUrl(id, port, ctx) {
    const r = await httpJson<{ url: string }>(`${base(ctx)}/sandbox/${encodeURIComponent(id)}/expose`, { headers: auth(ctx), body: { port, auth: false } });
    return r.url;
  },

  async kill(id, ctx) {
    runtimes.drop(id);
    try {
      await http(`${base(ctx)}/sandbox/${encodeURIComponent(id)}/stop`, { method: "PUT", headers: auth(ctx) });
    } catch (err) {
      if (err instanceof HttpError && (err.status === 404 || err.status === 410)) return;
      // Stopping one that already ended may be refused: ended is what kill wants.
      if (err instanceof HttpError && (err.status === 400 || err.status === 409)) {
        const s = await getSandbox(ctx, id).catch(() => undefined);
        if (s && /closed|error/.test(s.status)) return;
      }
      throw err;
    }
  },

  async listAlive(ctx) {
    const ids: string[] = [];
    for (let page = 1; page <= 100; page++) {
      const r = await httpJson<{ sandboxes: Sandbox[]; totalCount: number; perPage: number }>(`${base(ctx)}/sandboxes?status=active&page=${page}&limit=100`, {
        headers: auth(ctx),
      });
      ids.push(...r.sandboxes.filter((s) => s.status === "active" || s.status === "provisioning").map((s) => s.id));
      if (r.sandboxes.length === 0 || page * (r.perPage || 100) >= r.totalCount) break;
    }
    return ids;
  },
});
