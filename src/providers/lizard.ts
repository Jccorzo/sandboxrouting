// Lizard Sandboxes (lizard.build): Firecracker microVMs. Free: a 7-day Pro trial with $5 of
// usage, card required, US regions, 1 h per sandbox. Flat per size, $0.0162/h for 2 vCPU /
// 4 GB. With `timeoutMs` set, Lizard stops the sandbox and deletes its disk at the deadline;
// the raw API's default is no expiration, so this adapter always sends one.
// REST: https://lizard.build/api (Bearer liz_…). There is no OpenAPI: the docs list routes,
// and the request shapes here are the ones the official SDK (`@lizard-build/sdk` 1.0.19)
// sends. Every sandbox belongs to a project. CLI `lizard`.

import { defineProvider, http, httpJson } from "./util.js";
import { pollMs, sleep } from "./rest-helpers.js";
import type { ProviderContext } from "../core/types.js";

const base = (ctx: ProviderContext) => String(ctx.env["LIZARD_API_URL"] ?? "https://lizard.build").replace(/\/+$/, "");
const auth = (ctx: ProviderContext) => ({ authorization: `Bearer ${ctx.env["LIZARD_API_KEY"]}` });
const box = (ctx: ProviderContext, id: string, path = "") => `${base(ctx)}/api/sandboxes/${encodeURIComponent(id)}${path}`;
const EXEC_LIMIT_SEC = 600;

const SIZES = [
  { size: "mini", cpu: 1, memoryMiB: 2048 },
  { size: "small", cpu: 2, memoryMiB: 4096 },
  { size: "medium", cpu: 4, memoryMiB: 8192 },
  { size: "large", cpu: 8, memoryMiB: 16384 },
];
/** Lizard sizes: the smallest that fits the request. */
export function lizardSize(cpu: number, memoryMiB: number) {
  return SIZES.find((s) => s.cpu >= cpu && s.memoryMiB >= memoryMiB) ?? SIZES[SIZES.length - 1]!;
}

interface Info {
  sandboxId?: string;
  id?: string;
  status?: "none" | "running" | "crashed" | "stopped" | "paused";
  pauseError?: string | null;
}

/** Waits for a status: pause and resume are queued and answer at once. */
async function settle(ctx: ProviderContext, id: string, want: "running" | "paused"): Promise<void> {
  for (let i = 0; i < 300; i++) {
    const info = await httpJson<Info>(box(ctx, id), { headers: auth(ctx) });
    if (info.status === want) return;
    if (info.status === "crashed" || info.status === "stopped") throw new Error(`lizard sandbox ${id} is ${info.status}`);
    if (want === "paused" && info.pauseError) throw new Error(`lizard sandbox ${id} could not pause: ${info.pauseError}`);
    await sleep(pollMs(ctx, 500));
  }
  throw new Error(`lizard sandbox ${id} did not become ${want}`);
}

export const lizardProvider = defineProvider({
  info: {
    id: "lizard",
    name: "Lizard",
    homepage: "https://lizard.build",
    env: ["LIZARD_API_KEY", "LIZARD_PROJECT_ID"],
    capabilities: ["pause", "extendTimeout", "snapshot"],
    isolation: "microvm",
    maxExecSec: EXEC_LIMIT_SEC,
    freeTier: {
      tier: { kind: "one-time-credit", usd: 5 },
      // The trial runs one Small (plus two Mini) at a time.
      concurrency: 1,
      maxLifetimeSec: 3600,
      requiresCard: true,
      notes: "7-day Pro trial with $5 of usage; card required. 1 Small + 2 Mini running, US regions, 1 h per sandbox. Then Pro at $19/mo with $19 of usage.",
      source: "https://lizard.build/pricing",
      checked: "2026-11-12",
    },
    // $0.0081 per vCPU-hour with its 2 GB included.
    pricing: { vcpuSecondUsd: 0.0081 / 3600, gibSecondUsd: 0, defaultCpu: 2, defaultMemoryMiB: 4096, source: "https://lizard.build/pricing" },
    surfaces: { rest: "https://lizard.build/api", sdk: ["@lizard-build/sdk (npm)", "lizard-sdk (PyPI)"], cli: "lizard", mcp: "Lizard MCP" },
  },

  async create(spec, ctx) {
    const size = lizardSize(spec.cpu, spec.memoryMiB);
    const made = await httpJson<Info>(`${base(ctx)}/api/sandboxes`, {
      headers: auth(ctx),
      body: {
        template: spec.nativeTemplate ?? String(ctx.options["template"] ?? "base"),
        projectId: ctx.env["LIZARD_PROJECT_ID"],
        size: size.size,
        timeoutMs: Math.max(1000, Math.ceil(spec.timeoutSec * 1000)),
        envs: spec.env,
        metadata: spec.metadata,
        region: spec.region,
      },
      timeoutMs: 180_000,
    });
    const id = made.sandboxId ?? made.id;
    if (!id) throw new Error("lizard create returned no sandbox id");
    try {
      // The docs don't say whether create waits for the sandbox, so its status is checked.
      if (made.status !== "running") await settle(ctx, id, "running");
    } catch (err) {
      await http(box(ctx, id), { method: "DELETE", headers: auth(ctx) }).catch(() => undefined);
      throw err;
    }
    return { providerSandboxId: id, cpu: size.cpu, memoryMiB: size.memoryMiB };
  },

  async exec(id, command, o, ctx) {
    // Without `timeoutMs` the server stops a command after 150 s.
    const timeoutMs = Math.min(EXEC_LIMIT_SEC, Math.max(1, o.timeoutSec ?? 150)) * 1000;
    const r = await httpJson<{ stdout: string; stderr: string; exitCode: number }>(box(ctx, id, "/exec"), {
      headers: auth(ctx),
      body: { cmd: command, envs: o.env, workdir: o.cwd, timeoutMs },
      timeoutMs: timeoutMs + 30_000,
    });
    if (r.stdout) o.onStdout?.(r.stdout);
    if (r.stderr) o.onStderr?.(r.stderr);
    return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", exitCode: r.exitCode };
  },

  async readFile(id, path, ctx) {
    return new Uint8Array(await (await http(`${box(ctx, id, "/files")}?path=${encodeURIComponent(path)}`, { headers: auth(ctx) })).arrayBuffer());
  },

  async writeFile(id, path, data, ctx) {
    await http(box(ctx, id, "/files"), { method: "POST", headers: auth(ctx), body: { path, content: Buffer.from(data).toString("base64"), encoding: "base64" } });
  },

  async setTimeout(id, timeoutSec, ctx) {
    // Sets the remaining lifetime.
    await http(box(ctx, id, "/timeout"), { headers: auth(ctx), body: { timeoutMs: Math.max(1000, Math.ceil(timeoutSec * 1000)) } });
  },

  async pause(id, ctx) {
    await http(box(ctx, id, "/pause"), { method: "POST", headers: auth(ctx) });
    await settle(ctx, id, "paused");
  },

  async resume(id, ctx) {
    await http(box(ctx, id, "/resume"), { method: "POST", headers: auth(ctx) });
    await settle(ctx, id, "running");
  },

  async kill(id, ctx) {
    await http(box(ctx, id), { method: "DELETE", headers: auth(ctx) });
  },

  async listAlive(ctx) {
    // The response shape is undocumented. Anything but a list of sandboxes with ids throws,
    // which makes the sweep skip Lizard instead of taking live sandboxes for gone.
    const r = await httpJson<Info[] | { sandboxes?: Info[] }>(`${base(ctx)}/api/projects/${encodeURIComponent(String(ctx.env["LIZARD_PROJECT_ID"]))}/sandboxes`, { headers: auth(ctx) });
    const rows = Array.isArray(r) ? r : r?.sandboxes;
    if (!Array.isArray(rows)) throw new Error("lizard list: unexpected response shape");
    return rows
      .filter((s) => s.status !== "stopped" && s.status !== "crashed")
      .map((s) => {
        const id = s.sandboxId ?? s.id;
        if (!id) throw new Error("lizard list: a sandbox without an id");
        return id;
      });
  },
});
