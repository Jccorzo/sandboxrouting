// Tenki: disposable Linux microVM sessions for agents. Free: $100 one-time credit (card
// required, $0 auth), 5 concurrent sessions on Starter.
// SDK: npm `@tenkicloud/sandbox` (ConnectRPC at https://api.tenki.cloud). CLI: `tenki`.
// MCP: https://mcp.tenki.cloud/mcp.

import { defineProvider, loadSdk } from "./util.js";
import type { ProviderContext } from "../core/types.js";

type TenkiSdk = typeof import("@tenkicloud/sandbox");
type TClient = InstanceType<TenkiSdk["TenkiSandbox"]>;
type TSession = Awaited<ReturnType<TClient["get"]>>;

let client: TClient | undefined;
let sdkMod: TenkiSdk | undefined;
const cache = new Map<string, TSession>();

async function tenki(ctx: ProviderContext): Promise<{ client: TClient; sdk: TenkiSdk }> {
  sdkMod ??= await loadSdk<TenkiSdk>("@tenkicloud/sandbox", "tenki");
  client ??= new sdkMod.TenkiSandbox({
    apiKey: ctx.env["TENKI_API_KEY"],
    authToken: ctx.env["TENKI_AUTH_TOKEN"],
    baseUrl: ctx.env["TENKI_API_ENDPOINT"],
  });
  return { client, sdk: sdkMod };
}

async function get(id: string, ctx: ProviderContext): Promise<TSession> {
  const hit = cache.get(id);
  if (hit) return hit;
  const s = await (await tenki(ctx)).client.get(id);
  cache.set(id, s);
  return s;
}

export const tenkiProvider = defineProvider({
  info: {
    id: "tenki",
    name: "Tenki",
    homepage: "https://tenki.cloud",
    env: ["TENKI_API_KEY"],
    sdkPackage: "@tenkicloud/sandbox",
    capabilities: ["customImage", "ports", "pause", "fileList", "extendTimeout", "snapshot"],
    isolation: "microvm",
    freeTier: {
      tier: { kind: "one-time-credit", usd: 100 },
      concurrency: 5,
      requiresCard: true,
      notes: "$100 one-time credit; card required ($0 auth, auto-reload on by default). 5 concurrent on Starter.",
      source: "https://tenki.cloud/docs/account/free-credits",
      checked: "2026-11-11",
    },
    pricing: { vcpuSecondUsd: 0.000014, gibSecondUsd: 0.0000045, defaultCpu: 2, defaultMemoryMiB: 4096, source: "https://tenki.cloud/docs/pricing" },
    surfaces: { rest: "https://api.tenki.cloud (ConnectRPC)", sdk: ["@tenkicloud/sandbox (npm)", "tenki (PyPI)"], cli: "tenki", mcp: "https://mcp.tenki.cloud/mcp" },
  },

  isConfigured(ctx) {
    return Boolean(ctx.env["TENKI_API_KEY"] || ctx.env["TENKI_AUTH_TOKEN"]);
  },

  async create(spec, ctx) {
    const { client } = await tenki(ctx);
    const s = await client.create({
      cpuCores: Math.max(1, Math.round(spec.cpu)),
      memoryMb: spec.memoryMiB,
      image: spec.image,
      snapshotId: spec.nativeTemplate,
      env: spec.env,
      metadata: spec.metadata,
      maxDurationMs: spec.timeoutSec * 1000,
      allowOutbound: true,
    });
    await s.waitReady(180_000);
    cache.set(s.id, s);
    return { providerSandboxId: s.id, cpu: s.cpuCores, memoryMiB: s.memoryMb };
  },

  async exec(id, command, o, ctx) {
    const { sdk } = await tenki(ctx);
    const s = await get(id, ctx);
    // Tenki's own exec timeout defaults to 30 s; pass ours, or an hour.
    const r = await s.exec("sh", { args: ["-c", command], cwd: o.cwd, env: o.env, timeoutMs: (o.timeoutSec ?? 3600) * 1000 });
    const stdout = sdk.stdoutText(r);
    const stderr = sdk.stderrText(r);
    if (stdout) o.onStdout?.(stdout);
    if (stderr) o.onStderr?.(stderr);
    return { stdout, stderr, exitCode: r.exitCode };
  },

  async readFile(id, path, ctx) {
    return (await get(id, ctx)).readFile(path);
  },

  async writeFile(id, path, data, ctx) {
    await (await get(id, ctx)).writeFile(path, data);
  },

  async listFiles(id, path, ctx) {
    const items = await (await get(id, ctx)).list(path);
    return items.map((f) => ({ name: f.path.split("/").filter(Boolean).pop() ?? f.path, path: f.path, isDir: f.isDir, size: Number(f.size) }));
  },

  async getUrl(id, port, ctx) {
    return (await (await get(id, ctx)).exposePort(port)).previewUrl;
  },

  async setTimeout(id, timeoutSec, ctx) {
    // Tenki extends by a duration from the current deadline; the router asks for "from now".
    const s = await get(id, ctx);
    const remaining = Math.max(0, s.timeoutAt.getTime() - Date.now());
    const want = timeoutSec * 1000;
    if (want > remaining) await s.extend(want - remaining);
  },

  async pause(id, ctx) {
    await (await get(id, ctx)).pause();
  },

  async resume(id, ctx) {
    await (await get(id, ctx)).resume();
  },

  async kill(id, ctx) {
    const s = await get(id, ctx);
    cache.delete(id);
    await s.close();
  },

  async listAlive(ctx) {
    const sessions = await (await tenki(ctx)).client.list();
    return sessions.filter((s) => !["TERMINATED", "TERMINATING", "USER_SHUTDOWN"].includes(s.state)).map((s) => s.id);
  },
});
