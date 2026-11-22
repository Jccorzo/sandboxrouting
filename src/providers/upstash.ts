// Upstash Box (developer preview): containers with an agent harness. Free (monthly): 5 CPU
// hours, 10 concurrent boxes, up to 2 vCPU / 4 GB. The router uses ephemeral boxes, which have a
// TTL (max 3 days) and support exec and files, but no public URL or pause.
// Spoken over HTTP, no SDK: REST at https://us-east-1.box.upstash.com with an X-Box-Api-Key
// header (docs https://upstash.com/docs/box), with the calls the official SDK (npm `@upstash/box`
// 0.7.10, MIT) makes for `EphemeralBox`. CLI: `@upstash/box-cli`. Runtimes only (node, python,
// golang, ruby, rust), no arbitrary images.

import { defineProvider, httpJson } from "./util.js";
import { inline } from "./rest-helpers.js";
import type { ProviderContext } from "../core/types.js";

/** Where the SDK starts every box's working directory; relative file paths resolve against it. */
const WORKSPACE = "/workspace/home";
/** The SDK's per-request timeout (10 min). */
const TIMEOUT_MS = 600_000;

// UPSTASH_BOX_BASE_URL is the override the SDK itself reads.
const base = (ctx: ProviderContext) => (ctx.env["UPSTASH_BOX_BASE_URL"] ?? "https://us-east-1.box.upstash.com").replace(/\/$/, "");

function api<T>(ctx: ProviderContext, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  return httpJson<T>(`${base(ctx)}${path}`, { ...init, headers: { "X-Box-Api-Key": ctx.env["UPSTASH_BOX_API_KEY"] ?? "" }, timeoutMs: TIMEOUT_MS });
}

const box = (id: string) => `/v2/box/${id}`;
const resolve = (path: string) => (path.startsWith("/") ? path : `${WORKSPACE}/${path}`);

const RUNTIMES = ["node", "python", "golang", "ruby", "rust", "node-alpine", "python-alpine", "golang-alpine", "ruby-alpine", "rust-alpine"] as const;

interface ExecResponse {
  output?: string;
  error?: string;
  exit_code?: number | null;
}

export const upstashProvider = defineProvider({
  info: {
    id: "upstash",
    name: "Upstash Box",
    homepage: "https://upstash.com/docs/box",
    env: ["UPSTASH_BOX_API_KEY"],
    capabilities: ["fileList", "snapshot"],
    isolation: "container",
    maxTimeoutSec: 259_200,
    freeTier: {
      // 5 CPU-hours a month; metered as sandbox-hours, which is conservative for idle boxes.
      tier: { kind: "monthly-hours", hours: 5 },
      concurrency: 10,
      notes: "5 CPU-hours a month, 10 concurrent boxes, up to 2 vCPU / 4 GB. Developer preview.",
      source: "https://upstash.com/docs/box/overall/pricing",
      checked: "2026-11-11",
    },
    // $0.10 per active CPU-hour for a Small box (2 vCPU / 4 GB); memory is free.
    pricing: { vcpuSecondUsd: 0.05 / 3600, gibSecondUsd: 0, defaultCpu: 2, defaultMemoryMiB: 4096, billing: "active-cpu", source: "https://upstash.com/docs/box/overall/pricing" },
    surfaces: { rest: "https://us-east-1.box.upstash.com", sdk: ["@upstash/box (npm)", "upstash-box (PyPI)"], cli: "@upstash/box-cli" },
  },

  async create(spec, ctx) {
    // A template names a runtime here; an OCI image can't be used.
    const runtime = (RUNTIMES as readonly string[]).includes(spec.nativeTemplate ?? "") ? spec.nativeTemplate : "python";
    const size = spec.cpu > 4 ? "large" : spec.cpu > 2 ? "medium" : "small";
    // An ephemeral box answers ready: unlike a regular box there is no "creating" state to poll.
    const created = await api<{ id: string }>(ctx, "/v2/box", {
      method: "POST",
      body: { ephemeral: true, size, ttl: Math.min(259_200, spec.timeoutSec), runtime, env_vars: spec.env },
    });
    return { providerSandboxId: created.id, cpu: size === "small" ? 2 : size === "medium" ? 4 : 8 };
  },

  async exec(id, command, o, ctx) {
    // The box runs argv; `sh -c` gives the command a shell, with cwd and env set inside it.
    const r = await api<ExecResponse>(ctx, `${box(id)}/exec`, { method: "POST", body: { command: ["sh", "-c", inline(command, o)] } });
    const stdout = r.output ?? "";
    const stderr = r.error ?? "";
    if (stdout) o.onStdout?.(stdout);
    if (stderr) o.onStderr?.(stderr);
    return { stdout, stderr, exitCode: r.exit_code ?? -1 };
  },

  async readFile(id, path, ctx) {
    const r = await api<{ content: string }>(ctx, `${box(id)}/files/read?path=${encodeURIComponent(resolve(path))}&encoding=base64`);
    return Buffer.from(r.content, "base64");
  },

  async writeFile(id, path, data, ctx) {
    await api(ctx, `${box(id)}/files/write`, { method: "POST", body: { path: resolve(path), content: Buffer.from(data).toString("base64"), encoding: "base64" } });
  },

  async listFiles(id, path, ctx) {
    const qs = path ? `?folder=${encodeURIComponent(resolve(path))}` : "";
    const r = await api<{ files?: { name: string; path: string; is_dir: boolean; size?: number }[] }>(ctx, `${box(id)}/files/list${qs}`);
    return (r.files ?? []).map((f) => ({ name: f.name, path: f.path, isDir: f.is_dir, size: f.size }));
  },

  async kill(id, ctx) {
    await api(ctx, box(id), { method: "DELETE" });
  },

  async listAlive(ctx) {
    return (await api<{ id: string }[]>(ctx, "/v2/box")).map((b) => b.id);
  },
});
