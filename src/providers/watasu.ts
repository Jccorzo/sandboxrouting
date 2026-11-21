// Watasu Sandboxes (watasu.io): Linux sandboxes from reusable templates, next to Watasu's app
// platform. Billed in euros by the second while `ready`: €0.000020 per vCPU-second + €0.000004
// per GiB-second of what is requested (€0.2016/h for 2 vCPU / 4 GiB). Prepaid: the billing
// account needs a positive balance to start one (402 `sandbox_balance_required`); no free usage.
// Basic plan: free, 20 concurrent, 24 h, the template's CPU/RAM shape.
// Control plane: https://api.watasu.io/v1 (Bearer Watasu API key); docs
// docs.watasu.io/sandboxes/overview.md, docs.watasu.io/sandboxes/files-and-commands.md,
// docs.watasu.io/sandboxes/billing.md, docs.watasu.io/sandboxes/networking.md.
// Commands run only over the data plane's process WebSocket (/runtime/v1/process), so `exec`
// loads the official SDK, npm `@watasu/sdk` (optional peer dependency). Reaching the data plane
// means `resume`, which refreshes the deadline, so exec passes the time the sandbox has left and
// the router also deletes it at its deadline (enforcesTimeout false). Files go through the
// router's exec fallback. Create takes an Idempotency-Key and answers once a data-plane session
// is ready; `lifecycle.on_timeout: "kill"` destroys the sandbox at its timeout. Over the team's
// quota a create answers 422 `sandbox_quota_exceeded`.

import { randomUUID } from "node:crypto";
import { defineProvider, http, httpJson, HttpError, loadSdk, refusals } from "./util.js";
import { pollMs, sleep } from "./rest-helpers.js";
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

interface WatasuSdk {
  Sandbox: {
    connect(
      id: string,
      opts: { apiKey?: string; apiUrl?: string; timeoutMs?: number },
    ): Promise<{
      commands: {
        run(
          cmd: string,
          opts: { cwd?: string; envs?: Record<string, string>; timeoutMs?: number; onStdout?: (d: string) => void; onStderr?: (d: string) => void },
        ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
      };
    }>;
  };
}

export const watasuProvider = defineProvider({
  info: {
    id: "watasu",
    name: "Watasu Sandboxes",
    homepage: "https://watasu.io",
    env: ["WATASU_API_KEY"],
    sdkPackage: "@watasu/sdk",
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
    const { Sandbox } = await loadSdk<WatasuSdk>("@watasu/sdk", "watasu");
    const sbx = await Sandbox.connect(id, { apiKey: String(ctx.env["WATASU_API_KEY"]), apiUrl: base(ctx), timeoutMs });
    try {
      // A string command runs through a login shell.
      const r = await sbx.commands.run(command, {
        cwd: o.cwd,
        envs: o.env,
        timeoutMs: o.timeoutSec === undefined ? undefined : o.timeoutSec * 1000,
        onStdout: o.onStdout,
        onStderr: o.onStderr,
      });
      return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode };
    } catch (err) {
      // A non-zero exit is thrown as CommandExitError, which carries the result.
      const e = err as { name?: string; exitCode?: unknown; stdout?: string; stderr?: string };
      if (e?.name === "CommandExitError" && typeof e.exitCode === "number") return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", exitCode: e.exitCode };
      throw err;
    }
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
