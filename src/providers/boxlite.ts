// BoxLite Cloud: hosted microVM boxes (the open-source BoxLite runtime, as a service). No
// standing free tier; connecting a card adds $100 of credit (treated as one-time). Boxes
// stop after 15 idle minutes by default and have no wall-clock TTL, so the router deletes
// them at the deadline (enforcesTimeout: false).
// SDK: npm `@boxlite-ai/boxlite` (native binding: macOS arm64 and Linux glibc only).
// REST: https://api.boxlite.ai (Bearer blk_live_…). CLI: `boxlite`. MCP server documented.

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineProvider, loadSdk } from "./util.js";
import type { ProviderContext } from "../core/types.js";

type BoxliteSdk = typeof import("@boxlite-ai/boxlite");
type Runtime = ReturnType<BoxliteSdk["JsBoxlite"]["rest"]>;
type Box = NonNullable<Awaited<ReturnType<Runtime["get"]>>>;

let runtime: Runtime | undefined;
const cache = new Map<string, Box>();

async function rt(ctx: ProviderContext): Promise<Runtime> {
  if (runtime) return runtime;
  const sdk = await loadSdk<BoxliteSdk>("@boxlite-ai/boxlite", "boxlite");
  runtime = sdk.JsBoxlite.rest(
    new sdk.BoxliteRestOptions({
      url: ctx.env["BOXLITE_REST_URL"] ?? "https://api.boxlite.ai",
      credential: new sdk.ApiKeyCredential(String(ctx.env["BOXLITE_API_KEY"])),
    }),
  );
  return runtime;
}

async function get(id: string, ctx: ProviderContext): Promise<Box> {
  const hit = cache.get(id);
  if (hit) return hit;
  const box = await (await rt(ctx)).get(id);
  if (!box) throw Object.assign(new Error(`boxlite box ${id} not found`), { status: 404 });
  cache.set(id, box);
  return box;
}

/** Drains one of BoxLite's pull streams (`next()` until null). */
async function drain(stream: { next(): Promise<string | null> }, onChunk?: (s: string) => void): Promise<string> {
  let out = "";
  for (let chunk = await stream.next(); chunk !== null; chunk = await stream.next()) {
    out += chunk;
    onChunk?.(chunk);
  }
  return out;
}

export const boxliteProvider = defineProvider({
  info: {
    id: "boxlite",
    name: "BoxLite Cloud",
    homepage: "https://boxlite.ai",
    env: ["BOXLITE_API_KEY"],
    sdkPackage: "@boxlite-ai/boxlite",
    capabilities: ["customImage", "snapshot"],
    isolation: "microvm",
    enforcesTimeout: false,
    freeTier: {
      tier: { kind: "one-time-credit", usd: 100 },
      requiresCard: true,
      notes: "Connecting a card adds $100 of credit (one-time UNVERIFIED). Plans set concurrency.",
      source: "https://docs.boxlite.ai/cloud/billing",
      checked: "2026-11-11",
    },
    pricing: { vcpuSecondUsd: 0.0504 / 3600, gibSecondUsd: 0.0144 / 3600, defaultCpu: 1, defaultMemoryMiB: 1024, source: "https://docs.boxlite.ai/cloud/pricing" },
    surfaces: { rest: "https://api.boxlite.ai", sdk: ["@boxlite-ai/boxlite (npm)", "boxlite (PyPI)"], cli: "boxlite", mcp: "boxlite MCP server" },
  },

  async create(spec, ctx) {
    const box = await (await rt(ctx)).create({
      image: spec.nativeTemplate ?? spec.image ?? "ghcr.io/boxlite-ai/boxlite-agent-base:v0.1.0",
      cpus: Math.max(1, Math.round(spec.cpu)),
      memoryMib: spec.memoryMiB,
      env: Object.entries(spec.env).map(([key, value]) => ({ key, value })),
      // Idle auto-stop would pause a box while the caller still holds it; keep it up until the deadline.
      autoStop: spec.timeoutSec,
    });
    const info = await box.info();
    cache.set(info.id, box);
    return { providerSandboxId: info.id, cpu: info.cpus, memoryMiB: info.memoryMib };
  },

  async exec(id, command, o, ctx) {
    const box = await get(id, ctx);
    const env = Object.entries(o.env ?? {}) as [string, string][];
    const execution = await box.exec("sh", ["-c", command], env.length ? env : null, false, null, o.timeoutSec ?? null, o.cwd ?? null);
    const [stdout, stderr, result] = await Promise.all([
      execution.stdout().then((s) => drain(s, o.onStdout)),
      execution.stderr().then((s) => drain(s, o.onStderr)),
      execution.wait(),
    ]);
    return { stdout, stderr, exitCode: result.exitCode };
  },

  async readFile(id, path, ctx) {
    const dir = await mkdtemp(join(tmpdir(), "sbr-boxlite-"));
    try {
      const local = join(dir, "file");
      await (await get(id, ctx)).copyOut(path, local);
      return new Uint8Array(await readFile(local));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },

  async writeFile(id, path, data, ctx) {
    const dir = await mkdtemp(join(tmpdir(), "sbr-boxlite-"));
    try {
      const local = join(dir, "file");
      await writeFile(local, data);
      await (await get(id, ctx)).copyIn(local, path);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },

  async kill(id, ctx) {
    cache.delete(id);
    await (await rt(ctx)).remove(id, true);
  },

  async listAlive(ctx) {
    return (await (await rt(ctx)).listInfo()).filter((b) => b.state.running).map((b) => b.id);
  },
});
