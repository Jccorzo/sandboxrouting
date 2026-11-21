// OpenReward Sandboxes (openreward.ai): containers for agent code in ORS environments. A sandbox
// belongs to an environment workspace made on openreward.ai (`OPENREWARD_ENVIRONMENT`, e.g.
// "user/env"), which provisions the compute. No free tier (researchers can ask for credits).
// $0.0504 per vCPU-hour and $0.0162 per GiB-hour, billed by the second ($0.1656/h for 2:4).
// Docs: https://docs.openreward.ai/concepts/sandboxes.md, prices https://openreward.ai/pricing.
// No REST reference is published: the wire format comes from the official SDK (PyPI `openreward`
// 0.1.169, openreward/api/sandboxes/client.py and openreward/api/_session/). A sandbox is a session
// on https://sessions.openreward.ai: POST /create_sandbox streams Server-Sent Events (`task_id`,
// then `chunk`s and an `end` holding {"sid"}), POST /run runs a command the same way (base64 output,
// stdout and stderr together, and its return code), POST /delete_session ends it, POST /ping keeps
// it alive; X-API-Key authenticates and X-Session-ID names the session.
// The SDK pings every 10 s and the server reaps a session that stops pinging (its comments name a
// 900 s reaper), so this adapter pings before each command, and a sandbox left without commands
// for that long may be gone (the next command then fails as not found). There is no lifetime
// setting, so the router deletes the sandbox at the deadline (enforcesTimeout: false). Files use
// the router's exec fallback; there is no list call. Isolation: "an isolated container".

import { defineProvider, http, HttpError } from "./util.js";
import { inline, sse } from "./rest-helpers.js";
import type { ProviderContext } from "../core/types.js";

const base = (ctx: ProviderContext) => String(ctx.env["OPENREWARD_SESSION_URL"] ?? "https://sessions.openreward.ai").replace(/\/+$/, "");
const headers = (ctx: ProviderContext, sid?: string) => ({ "x-api-key": String(ctx.env["OPENREWARD_API_KEY"]), ...(sid ? { "x-session-id": sid } : {}) });

/** Machine sizes "CPU:GiB": 0.5–16 CPUs with 1, 2 or 4 GiB per CPU. */
const CPUS = [0.5, 1, 2, 4, 8, 16];
export function openrewardSize(cpu: number, memoryMiB: number): { size: string; cpu: number; memoryMiB: number } {
  for (const c of CPUS) {
    if (c < cpu && c !== 16) continue;
    for (const ratio of [1, 2, 4]) {
      if (c * ratio * 1024 >= memoryMiB || (c === 16 && ratio === 4)) return { size: `${c}:${c * ratio}`, cpu: c, memoryMiB: c * ratio * 1024 };
    }
  }
  return { size: "16:64", cpu: 16, memoryMiB: 65536 };
}

/**
 * One request whose answer is an event stream ending in `end` (the result, as JSON) or `error`.
 * `onTask` hears the task id the server sends first.
 */
async function streamed<T>(url: string, init: { headers: Record<string, string>; body: unknown; timeoutMs: number }, onTask?: (id: string) => void): Promise<T> {
  const res = await http(url, { headers: { ...init.headers, accept: "text/event-stream" }, body: init.body, timeoutMs: init.timeoutMs });
  let chunks = "";
  for await (const ev of sse(res.body as unknown as AsyncIterable<Uint8Array>)) {
    if (ev.event === "task_id") onTask?.(ev.data.trim());
    else if (ev.event === "chunk") chunks += ev.data;
    else if (ev.event === "end") {
      const text = chunks + ev.data;
      return (text ? JSON.parse(text) : undefined) as T;
    } else if (ev.event === "error") throw new Error(`openreward ${new URL(url).pathname}: ${ev.data || "error"}`);
  }
  throw new Error(`openreward ${new URL(url).pathname}: the stream ended without a result`);
}

export const openrewardProvider = defineProvider({
  info: {
    id: "openreward",
    name: "OpenReward",
    homepage: "https://openreward.ai",
    env: ["OPENREWARD_API_KEY", "OPENREWARD_ENVIRONMENT"],
    capabilities: ["customImage"],
    isolation: "container",
    enforcesTimeout: false,
    freeTier: {
      tier: { kind: "none" },
      notes: "No free tier; pay as you go (researchers can ask for credits). Sandboxes run in an environment workspace made on openreward.ai first.",
      source: "https://openreward.ai/pricing",
      checked: "2026-11-21",
    },
    pricing: { vcpuSecondUsd: 0.0504 / 3600, gibSecondUsd: 0.0162 / 3600, defaultCpu: 2, defaultMemoryMiB: 4096, source: "https://openreward.ai/pricing" },
    surfaces: { rest: "https://sessions.openreward.ai (session API, from the SDK)", sdk: ["openreward (PyPI)"], cli: "orwd" },
  },

  async create(spec, ctx) {
    const size = openrewardSize(spec.cpu, spec.memoryMiB);
    let task: string | undefined;
    let r: { sid?: string } | undefined;
    try {
      r = await streamed<{ sid?: string }>(
        `${base(ctx)}/create_sandbox`,
        {
          headers: headers(ctx),
          body: {
            environment: String(ctx.env["OPENREWARD_ENVIRONMENT"]),
            image: spec.image ?? spec.nativeTemplate ?? String(ctx.options["image"] ?? "python:3.11-slim"),
            machine_size: size.size,
            env: spec.env,
            block_network: false,
          },
          timeoutMs: 30 * 60_000,
        },
        (id) => (task = id),
      );
    } catch (err) {
      // A create the server started: end it rather than leave it running.
      if (task) await http(`${base(ctx)}/delete_session`, { method: "POST", headers: headers(ctx, task) }).catch(() => undefined);
      throw err;
    }
    const sid = r?.sid ?? task;
    if (!sid) throw new Error("openreward: create_sandbox returned no session id");
    return { providerSandboxId: sid, cpu: size.cpu, memoryMiB: size.memoryMiB };
  },

  async exec(id, command, o, ctx) {
    // Keep the session from being reaped; a gone session answers 410 here.
    await http(`${base(ctx)}/ping`, { method: "POST", headers: headers(ctx, id) });
    const timeout = Math.max(1, Math.ceil(o.timeoutSec ?? 3600));
    const r = await streamed<{ return_code: number; output: string; timed_out?: boolean }>(`${base(ctx)}/run`, {
      headers: headers(ctx, id),
      body: { cmd: inline(command, { cwd: o.cwd, env: o.env }), timeout_s: timeout, max_bytes: 16 * 1024 * 1024, shell: "/bin/sh" },
      timeoutMs: (timeout + 60) * 1000,
    });
    // stdout and stderr come back as one stream.
    const stdout = Buffer.from(r.output ?? "", "base64").toString("utf8");
    if (stdout) o.onStdout?.(stdout);
    return { stdout, stderr: "", exitCode: r.timed_out ? 124 : r.return_code };
  },

  async kill(id, ctx) {
    try {
      await http(`${base(ctx)}/delete_session`, { method: "POST", headers: headers(ctx, id) });
    } catch (err) {
      if (!(err instanceof HttpError && (err.status === 404 || err.status === 410))) throw err;
    }
  },
});
