// Watasu Sandboxes (watasu.io): Linux sandboxes from reusable templates, next to Watasu's app
// platform. Billed in euros by the second while `ready`: €0.000020 per vCPU-second + €0.000004
// per GiB-second of what is requested (€0.2016/h for 2 vCPU / 4 GiB). Prepaid: the billing
// account needs a positive balance to start one (402 `sandbox_balance_required`); no free usage.
// Basic plan: free, 20 concurrent, 24 h, the template's CPU/RAM shape.
// Control plane: https://api.watasu.io/v1 (Bearer Watasu API key); docs
// docs.watasu.io/sandboxes/overview.md, docs.watasu.io/sandboxes/files-and-commands.md,
// docs.watasu.io/sandboxes/billing.md, docs.watasu.io/sandboxes/networking.md.
// Commands run only over the data plane's process WebSocket (/runtime/v1/process), spoken here
// with websocket.ts and the JSON frames the official SDK uses (npm `@watasu/sdk` 0.1.77, MIT OR
// Apache-2.0: dist/processSocket.js, dist/commands.js): a start frame; started, stdout/stderr
// (base64), lagged, exit and error frames, each with a cursor to reconnect from. Reaching the data plane
// means `resume`, which refreshes the deadline, so exec passes the time the sandbox has left and
// the router also deletes it at its deadline (enforcesTimeout false). Files go through the
// router's exec fallback. Create takes an Idempotency-Key and answers once a data-plane session
// is ready; `lifecycle.on_timeout: "kill"` destroys the sandbox at its timeout. Over the team's
// quota a create answers 422 `sandbox_quota_exceeded`.

import { randomUUID } from "node:crypto";
import { defineProvider, http, httpJson, HttpError, refusals } from "./util.js";
import { pollMs, sleep } from "./rest-helpers.js";
import { WebSocketClient } from "./websocket.js";
import { USD_PER_EUR } from "./currency.js";
import type { ProviderContext } from "../core/types.js";

const base = (ctx: ProviderContext) => String(ctx.env["WATASU_API_URL"] ?? "https://api.watasu.io/v1").replace(/\/+$/, "");
const auth = (ctx: ProviderContext) => ({ authorization: `Bearer ${ctx.env["WATASU_API_KEY"]}` });
const sb = (ctx: ProviderContext, id: string, path = "") => `${base(ctx)}/sandboxes/${encodeURIComponent(id)}${path}`;
const gone = (err: unknown) => err instanceof HttpError && (err.status === 404 || err.status === 410);
// The team's running-sandbox quota clears when sandboxes end, though the body says "quota".
const refused = refusals("watasu", [{ status: 422, body: /sandbox_quota_exceeded/, kind: "rate_limit", why: "team sandbox quota (running sandboxes, vCPU or memory)" }]);

interface Sandbox {
  id?: string | number;
  sandbox_id?: string | number;
  state?: string;
  end_at?: string;
  deadline_at?: string;
  deadline?: string;
}
const sandboxOf = (r: { sandbox?: Sandbox } & Sandbox): Sandbox => r.sandbox ?? r;
const idOf = (s: Sandbox) => String(s.id ?? s.sandbox_id ?? "");
const DEAD = ["failed", "lost", "destroyed", "destroying", "killed", "stopped", "stopping"];

// The SDK's process-stream limits.
const SOCKET_TIMEOUT_MS = 60_000;
const KEEPALIVE_MS = 50_000;
const RECONNECTS = 12;
/** The runtime's own ceiling for a command that names none, and the client's grace past it. */
const DEFAULT_COMMAND_MS = 3_600_000;
const WAIT_GRACE_MS = 60_000;

interface ProcessFrame {
  type?: string;
  cursor?: number | string;
  pid?: number | string;
  process?: { pid?: number | string; id?: number | string };
  data?: string;
  exit_code?: number | string | null;
  exitCode?: number | string | null;
  status?: string;
  error?: string;
  message?: string;
  code?: string;
}

/** One process socket: opened with the session token, kept alive with pings, read frame by frame. */
async function openSocket(dataPlane: string, token: string, path: string): Promise<{ ws: WebSocketClient; frames: AsyncGenerator<ProcessFrame> }> {
  const url = new URL(path, dataPlane.replace(/^http/, "ws"));
  const ws = await WebSocketClient.connect(url.toString(), { headers: { Authorization: `Bearer ${token}` }, timeoutMs: SOCKET_TIMEOUT_MS }).catch((err: unknown) => {
    if (err instanceof HttpError && err.status === 404) throw new HttpError(404, `watasu: process not found: ${err.message}`);
    throw err;
  });
  const keepalive = setInterval(() => ws.ping("watasu-sdk"), KEEPALIVE_MS);
  keepalive.unref();
  async function* frames(): AsyncGenerator<ProcessFrame> {
    try {
      for await (const m of ws.messages()) {
        const f = JSON.parse(m.data.toString("utf8")) as ProcessFrame;
        if (f.type === "pong" || f.type === "ready" || f.type === "stdin_ack" || f.type === "close_stdin_ack") continue;
        yield f;
        if (f.type === "error") return;
      }
    } catch (err) {
      // A dropped socket reads as an error frame, which the reader may reconnect from.
      yield { type: "error", message: `process websocket failed: ${(err as Error).message}` };
    } finally {
      clearInterval(keepalive);
      await ws.close().catch(() => undefined);
    }
  }
  return { ws, frames: frames() };
}

const exitOf = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined);

/** Runs `command` on the data plane as `commands.run` does, reconnecting from the last cursor when the stream drops or lags. */
async function runCommand(dataPlane: string, token: string, command: string, o: { cwd?: string; env?: Record<string, string>; timeoutMs?: number; onStdout?: (s: string) => void; onStderr?: (s: string) => void }) {
  const env = { ...(o.env ?? {}) };
  let { ws, frames } = await openSocket(dataPlane, token, "/runtime/v1/process");
  ws.send(JSON.stringify({ type: "start", cmd: "/bin/bash", args: ["-l", "-c", command], cwd: o.cwd, environment: env, envs: env, stdin: false, timeout_ms: o.timeoutMs ?? 60_000 }));
  let pid: string | number | undefined;
  let cursor = 0;
  let stdout = "";
  let stderr = "";
  const work = async () => {
    for (;;) {
      let streamError: string | undefined;
      for await (const f of frames) {
        // The runtime dropped frames: replay them from the next undelivered cursor.
        if (f.type === "lagged") break;
        const c = exitOf(f.cursor);
        if (c !== undefined) cursor = Math.max(cursor, c + 1);
        if (f.type === "started") {
          pid ??= f.pid ?? f.process?.pid ?? f.process?.id;
          continue;
        }
        if (f.type === "stdout" || f.type === "stderr") {
          const text = Buffer.from(f.data ?? "", "base64").toString("utf8");
          if (f.type === "stdout") {
            stdout += text;
            o.onStdout?.(text);
          } else {
            stderr += text;
            o.onStderr?.(text);
          }
        } else if (f.type === "exit") {
          // A command that ends without an exit code (killed, failed) reports -1, as the SDK does.
          return { exitCode: exitOf(f.exit_code ?? f.exitCode) ?? -1, stdout, stderr };
        } else if (f.type === "error") {
          streamError = String(f.message ?? f.code ?? "process error");
          if (!/websocket|closed/i.test(streamError)) throw new Error(`watasu: ${streamError}`);
          break;
        }
      }
      if (pid === undefined) throw new Error(`watasu: ${streamError ?? "process ended before started frame"}`);
      // Reconnect to the same process from the next undelivered event.
      let last: unknown;
      let opened = false;
      for (let attempt = 0; attempt < RECONNECTS && !opened; attempt++) {
        if (attempt > 0) await sleep(Math.min(2000, 250 * 2 ** (attempt - 1)));
        try {
          ({ ws, frames } = await openSocket(dataPlane, token, `/runtime/v1/process/${encodeURIComponent(String(pid))}/connect?since=${cursor}`));
          opened = true;
        } catch (err) {
          last = err;
        }
      }
      if (!opened) throw last instanceof Error ? last : new Error("watasu: process websocket closed before exit and could not reconnect");
    }
  };
  const limit = (o.timeoutMs && o.timeoutMs > 0 ? o.timeoutMs : DEFAULT_COMMAND_MS) + WAIT_GRACE_MS;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`watasu: timed out waiting for command ${pid ?? ""} to exit; it may still be running`)), limit);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    await ws.close().catch(() => undefined);
  }
}

export const watasuProvider = defineProvider({
  info: {
    id: "watasu",
    name: "Watasu Sandboxes",
    homepage: "https://watasu.io",
    env: ["WATASU_API_KEY"],
    // Preview ports are declared at create (`exposed_ports`), so `ports` is not offered.
    capabilities: ["pause", "snapshot", "extendTimeout"],
    maxTimeoutSec: 86_400,
    enforcesTimeout: false,
    // Isolation is left unset: Watasu does not publish it, so `minIsolation` requests skip it.
    freeTier: {
      tier: { kind: "none" },
      concurrency: 20,
      maxLifetimeSec: 86_400,
      notes: "No free usage: the Basic plan has no base fee, but sandboxes start only with a positive prepaid balance. 20 concurrent, 24 h, the template's CPU/RAM shape.",
      source: "https://docs.watasu.io/sandboxes/billing/",
      checked: "2026-11-21",
    },
    pricing: {
      vcpuSecondUsd: 0.00002 * USD_PER_EUR,
      gibSecondUsd: 0.000004 * USD_PER_EUR,
      defaultCpu: 2,
      defaultMemoryMiB: 4096,
      source: "https://docs.watasu.io/sandboxes/billing/",
    },
    surfaces: { rest: "https://api.watasu.io/v1 (+ data-plane WebSocket)", sdk: ["@watasu/sdk (npm)"], cli: "watasu", mcp: "docs: docs.watasu.io/workflows/mcp" },
  },

  async create(spec, ctx) {
    let made: Sandbox;
    try {
      made = sandboxOf(
        await httpJson(`${base(ctx)}/sandboxes`, {
          headers: { ...auth(ctx), "idempotency-key": spec.metadata["sandboxrouting.id"] ?? randomUUID() },
          body: {
            team: ctx.options["team"],
            template: spec.nativeTemplate ?? "base",
            timeout: Math.min(86_400, Math.max(1, Math.ceil(spec.timeoutSec))),
            lifecycle: { on_timeout: "kill", auto_resume: false },
            metadata: spec.metadata,
            envs: spec.env,
          },
          timeoutMs: 300_000,
        }),
      );
    } catch (err) {
      throw refused(err);
    }
    const id = idOf(made);
    if (!id) throw new Error("watasu create returned no sandbox id");
    try {
      let state = made.state ?? "creating";
      for (let i = 0; i < 600 && state !== "ready"; i++) {
        if (DEAD.includes(state)) throw new Error(`watasu sandbox ${id} is ${state}`);
        await sleep(pollMs(ctx, 1000));
        state = sandboxOf(await httpJson(sb(ctx, id), { headers: auth(ctx) })).state ?? "";
      }
      if (state !== "ready") throw new Error(`watasu sandbox ${id} did not become ready`);
    } catch (err) {
      // Watasu made it: never leave it running (and billing) when the create fails.
      await http(sb(ctx, id), { method: "DELETE", headers: auth(ctx) }).catch(() => undefined);
      throw err;
    }
    return { providerSandboxId: id };
  },

  async exec(id, command, o, ctx) {
    // Connecting resumes the sandbox and resets its deadline: hand it what is left of the old one.
    const cur = sandboxOf(await httpJson(sb(ctx, id), { headers: auth(ctx) }));
    const deadline = Date.parse(cur.end_at ?? cur.deadline_at ?? cur.deadline ?? "");
    const timeoutMs = Number.isFinite(deadline) ? Math.max(1000, deadline - Date.now()) : undefined;
    // Resuming hands out the data-plane session (URL and token), as the SDK's Sandbox.connect does.
    const r = await httpJson<{ session?: { data_plane_url?: string; token?: string; access_token?: string } }>(sb(ctx, id, "/resume"), {
      method: "POST",
      headers: auth(ctx),
      body: timeoutMs ? { timeout: Math.ceil(timeoutMs / 1000) } : {},
    });
    const token = r.session?.token ?? r.session?.access_token;
    const dataPlane = ctx.env["WATASU_SANDBOX_URL"] ?? r.session?.data_plane_url;
    if (!token || !dataPlane) throw new Error("watasu: the sandbox session did not include data_plane_url and token");
    // A string command runs through a login shell; a non-zero exit is a result, not an error.
    return runCommand(dataPlane, token, command, {
      cwd: o.cwd,
      env: o.env,
      timeoutMs: o.timeoutSec === undefined ? undefined : o.timeoutSec * 1000,
      onStdout: o.onStdout,
      onStderr: o.onStderr,
    });
  },

  async setTimeout(id, timeoutSec, ctx) {
    await http(sb(ctx, id, "/timeout"), { headers: auth(ctx), body: { timeout: Math.min(86_400, Math.max(1, Math.ceil(timeoutSec))) } });
  },

  async pause(id, ctx) {
    await http(sb(ctx, id, "/pause"), { method: "POST", headers: auth(ctx) });
  },

  async resume(id, ctx) {
    await http(sb(ctx, id, "/resume"), { headers: auth(ctx), body: {} });
  },

  async kill(id, ctx) {
    await http(sb(ctx, id), { method: "DELETE", headers: auth(ctx) }).catch((err) => {
      if (!gone(err)) throw err;
    });
  },

  async listAlive(ctx) {
    const ids: string[] = [];
    let next: string | undefined;
    for (let page = 0; page < 100; page++) {
      const q = new URLSearchParams({ limit: "100" });
      q.append("query[state][]", "running");
      if (ctx.options["team"]) q.set("team", String(ctx.options["team"]));
      if (next) q.set("next_token", next);
      const r: { sandboxes?: Sandbox[]; next_token?: string | number | null } = await httpJson(`${base(ctx)}/sandboxes?${q}`, { headers: auth(ctx) });
      for (const s of r.sandboxes ?? []) if (!DEAD.includes(s.state ?? "")) ids.push(idOf(s));
      next = r.next_token == null ? undefined : String(r.next_token);
      if (!next) break;
    }
    return ids;
  },
});
