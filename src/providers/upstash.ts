// Upstash Box (developer preview): containers with an agent harness. Free (monthly): 5 CPU
// hours, 10 concurrent boxes, up to 2 vCPU / 4 GB. The router uses EphemeralBox, which has a
// TTL (max 3 days) and supports exec and files, but no public URL or pause.
// SDK: npm `@upstash/box` (REST at https://us-east-1.box.upstash.com, X-Box-Api-Key).
// CLI: `@upstash/box-cli`. Runtimes only (node, python, golang, ruby, rust), no arbitrary images.

import { defineProvider, loadSdk } from "./util.js";
import { shellQuote } from "../core/sandbox.js";
import type { ProviderContext } from "../core/types.js";

type UpstashSdk = typeof import("@upstash/box");
type UBox = Awaited<ReturnType<UpstashSdk["Box"]["get"]>>;

const cache = new Map<string, UBox>();
const sdk = () => loadSdk<UpstashSdk>("@upstash/box", "upstash");
const conn = (ctx: ProviderContext) => ({ apiKey: ctx.env["UPSTASH_BOX_API_KEY"], baseUrl: ctx.env["UPSTASH_BOX_BASE_URL"] });

async function get(id: string, ctx: ProviderContext): Promise<UBox> {
  const hit = cache.get(id);
  if (hit) return hit;
  const box = await (await sdk()).Box.get(id, conn(ctx));
  cache.set(id, box);
  return box;
}

const RUNTIMES = ["node", "python", "golang", "ruby", "rust", "node-alpine", "python-alpine", "golang-alpine", "ruby-alpine", "rust-alpine"] as const;
type Runtime = (typeof RUNTIMES)[number];

export const upstashProvider = defineProvider({
  info: {
    id: "upstash",
    name: "Upstash Box",
    homepage: "https://upstash.com/docs/box",
    env: ["UPSTASH_BOX_API_KEY"],
    sdkPackage: "@upstash/box",
    capabilities: ["fileList", "snapshot"],
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
    pricing: { vcpuSecondUsd: 0.05 / 3600, gibSecondUsd: 0, defaultCpu: 2, defaultMemoryMiB: 4096, source: "https://upstash.com/docs/box/overall/pricing" },
    surfaces: { rest: "https://us-east-1.box.upstash.com", sdk: ["@upstash/box (npm)", "upstash-box (PyPI)"], cli: "@upstash/box-cli" },
  },

  async create(spec, ctx) {
    const { EphemeralBox } = await sdk();
    // A template names a runtime here; an OCI image can't be used.
    const runtime = (RUNTIMES as readonly string[]).includes(spec.nativeTemplate ?? "") ? (spec.nativeTemplate as Runtime) : "python";
    const size = spec.cpu > 4 ? "large" : spec.cpu > 2 ? "medium" : "small";
    const box = await EphemeralBox.create({ ...conn(ctx), runtime, size, env: spec.env, ttl: Math.min(259_200, spec.timeoutSec) });
    return { providerSandboxId: box.id, cpu: size === "small" ? 2 : size === "medium" ? 4 : 8 };
  },

  async exec(id, command, o, ctx) {
    const env = Object.entries(o.env ?? {}).map(([k, v]) => `export ${k}=${shellQuote(v)}; `).join("");
    const cd = o.cwd ? `cd ${shellQuote(o.cwd)} && ` : "";
    const run = await (await get(id, ctx)).exec.command(`sh -c ${shellQuote(`${env}${cd}${command}`)}`);
    const stdout = run.stdout;
    const stderr = run.stderr;
    if (stdout) o.onStdout?.(stdout);
    if (stderr) o.onStderr?.(stderr);
    return { stdout, stderr, exitCode: run.exitCode ?? -1 };
  },

  async readFile(id, path, ctx) {
    return Buffer.from(await (await get(id, ctx)).files.read(path, { encoding: "base64" }), "base64");
  },

  async writeFile(id, path, data, ctx) {
    await (await get(id, ctx)).files.write({ path, content: Buffer.from(data).toString("base64"), encoding: "base64" });
  },

  async listFiles(id, path, ctx) {
    return (await (await get(id, ctx)).files.list(path)).map((f) => ({ name: f.name, path: f.path, isDir: f.is_dir, size: f.size }));
  },

  async kill(id, ctx) {
    const box = await get(id, ctx);
    cache.delete(id);
    await box.delete();
  },

  async listAlive(ctx) {
    return (await (await sdk()).Box.list(conn(ctx))).map((b) => b.id);
  },
});
