// offstage cloud (Exla): macOS sandboxes on Apple silicon Mac Studios. A sandbox is one macOS
// user account on a shared Mac, wiped when it closes; the slot's account is the isolation
// boundary (processes of other slots are visible, localhost servers reachable), so it is
// claimed as `container`, the weakest level the router knows. `info.os` is "macos": only a
// request with `os: "macos"` routes here.
// $1.10 an hour per sandbox, billed per second from `ready` to closed; $5 signup credit once
// per personal account, no card. Work is prepaid: each create reserves its worst case
// (`timeoutMs` at $1.10/h) and is refused with 402 when the credit can't cover it.
// REST: https://api.offstage.cloud/v1 (Bearer sk_offstage_…). Docs:
//   https://api.offstage.cloud/llms.txt (full API guide), https://offstage.cloud/openapi.json,
//   https://api.offstage.cloud/v1/pricing (JSON, no key). JS SDK as a tarball from
//   api.offstage.cloud/sdk; CLI `offstage`.
// Create takes an Idempotency-Key, no env; commands run as `zsh -lc` and answer within ~50 s
// (202 + follow with ?wait=50 for longer ones, 30 min at most). File paths and `cwd` are
// relative to the sandbox root, so absolute paths go through the router's exec fallback.

import { randomUUID } from "node:crypto";
import { SandboxRouterError } from "../core/errors.js";
import { defineProvider, http, httpJson, HttpError, refusals } from "./util.js";
import { envFileBody, inline, pollMs, sleep } from "./rest-helpers.js";
import type { ProviderContext } from "../core/types.js";

const base = (ctx: ProviderContext) => String(ctx.env["OFFSTAGE_API_URL"] ?? "https://api.offstage.cloud/v1").replace(/\/+$/, "");
const auth = (ctx: ProviderContext) => ({ authorization: `Bearer ${ctx.env["OFFSTAGE_API_KEY"]}` });
const sbx = (ctx: ProviderContext, id: string, path = "") => `${base(ctx)}/sandboxes/${encodeURIComponent(id)}${path}`;

/** Macs online but no slot free (or GUI work paused by the operator): clears as work ends. */
const refused = refusals("offstage", [{ status: 409, body: /no-capacity|gui-paused/, kind: "rate_limit", why: "no Mac slot free" }]);

interface Sandbox {
  id: string;
  state: "pending" | "ready" | "closed" | string;
  closeReason?: string;
}
interface Command {
  commandId: string;
  state: "running" | "finished" | string;
  exitCode?: number | null;
  timedOut?: boolean;
  stdout?: string;
  stderr?: string;
}

/** A path the file API takes: relative to the sandbox root, letters, digits, `._-/` only. */
function relPath(path: string): string {
  if (path.startsWith("/") || path.startsWith("~") || !/^[A-Za-z0-9._/-]+$/.test(path) || path.split("/").includes("..")) {
    throw new SandboxRouterError("unsupported", "offstage's file API only takes paths relative to the sandbox root", "offstage");
  }
  return path;
}

const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

export const offstageProvider = defineProvider({
  info: {
    id: "offstage",
    name: "offstage cloud",
    homepage: "https://offstage.cloud",
    env: ["OFFSTAGE_API_KEY"],
    os: "macos",
    capabilities: ["extendTimeout"],
    isolation: "container",
    maxTimeoutSec: 24 * 3600,
    maxExecSec: 1800,
    freeTier: {
      tier: { kind: "one-time-credit", usd: 5 },
      requiresCard: false,
      notes:
        "$5 signup credit, once per person, personal accounts only (organization teams get none). Prepaid: a create reserves its whole timeout at $1.10/h, so the $5 covers at most about 4.5 h of reservations at once. No fixed limit on open sandboxes; they queue for a free Mac slot (queued time is free).",
      source: "https://api.offstage.cloud/llms.txt",
      checked: "2026-11-21",
    },
    // Priced per sandbox, not per size: sandboxSecondUsd only. The slot's cores and memory
    // aren't published; 4 vCPU / 8 GiB is a placeholder.
    pricing: { vcpuSecondUsd: 0, gibSecondUsd: 0, sandboxSecondUsd: 1.1 / 3600, defaultCpu: 4, defaultMemoryMiB: 8192, source: "https://api.offstage.cloud/v1/pricing" },
    surfaces: { rest: "https://api.offstage.cloud/v1", sdk: ["offstage-cloud (npm tarball from api.offstage.cloud/sdk)"], cli: "offstage" },
  },

  async create(spec, ctx) {
    const timeoutMs = Math.min(24 * 3600, Math.max(1, Math.ceil(spec.timeoutSec))) * 1000;
    let s: Sandbox;
    try {
      s = await httpJson<Sandbox>(`${base(ctx)}/sandboxes`, {
        headers: { ...auth(ctx), "idempotency-key": spec.metadata["sandboxrouting.id"] ?? randomUUID() },
        // The idle timeout would otherwise close a sandbox left alone for 10 minutes.
        body: { session: String(ctx.options["session"] ?? "headless"), timeoutMs, idleTimeoutMs: timeoutMs },
      });
    } catch (err) {
      throw refused(err);
    }
    try {
      // A pending sandbox waits for a free Mac slot; offstage closes it as `no-capacity` after 15 min.
      for (let i = 0; i < 1000 && s.state === "pending"; i++) {
        await sleep(pollMs(ctx, 2000));
        s = await httpJson<Sandbox>(sbx(ctx, s.id), { headers: auth(ctx) });
      }
      if (s.state !== "ready") throw new Error(`offstage sandbox ${s.id} is ${s.state}${s.closeReason ? ` (${s.closeReason})` : ""}`);
      if (Object.keys(spec.env).length) {
        // Create takes no env. Every command is a new `zsh -lc`, which reads ~/.zprofile.
        const r = await this.exec(s.id, `cat >> ~/.zprofile <<'SBR_ENV'\n${envFileBody(spec.env)}SBR_ENV`, {}, ctx);
        if (r.exitCode !== 0) throw new Error(`offstage sandbox ${s.id}: could not set its environment: ${r.stderr}`);
      }
    } catch (err) {
      await this.kill(s.id, ctx).catch(() => undefined);
      throw err;
    }
    return { providerSandboxId: s.id };
  },

  async exec(id, command, o, ctx) {
    // `cwd` must be relative to the sandbox root, and `envs` names like NAME_1: anything else is inlined.
    const relCwd = o.cwd && !o.cwd.startsWith("/") && !o.cwd.startsWith("~") ? o.cwd : undefined;
    const env = o.env ?? {};
    const envsOk = Object.keys(env).length <= 64 && Object.keys(env).every((k) => ENV_NAME.test(k));
    const cmd = inline(command, { cwd: relCwd ? undefined : o.cwd, env: envsOk ? undefined : env });
    const timeoutMs = Math.min(1800, Math.max(1, Math.ceil(o.timeoutSec ?? 600))) * 1000;
    let r: Command = await httpJson<Command>(sbx(ctx, id, "/commands"), {
      headers: auth(ctx),
      body: { cmd, cwd: relCwd, envs: envsOk && Object.keys(env).length ? env : undefined, timeoutMs },
      timeoutMs: 90_000,
    });
    // Answers within ~50 s; a longer command is followed, each follow held up to 50 s.
    while (r.state !== "finished") {
      r = await httpJson<Command>(`${sbx(ctx, id, `/commands/${encodeURIComponent(r.commandId)}`)}?wait=50`, { headers: auth(ctx), timeoutMs: 90_000 });
    }
    const stdout = r.stdout ?? "";
    const stderr = r.stderr ?? "";
    if (stdout) o.onStdout?.(stdout);
    if (stderr) o.onStderr?.(stderr);
    // Killed at its timeout: exitCode null, timedOut true.
    return { stdout, stderr, exitCode: r.exitCode ?? (r.timedOut ? 124 : 1) };
  },

  async readFile(id, path, ctx) {
    const res = await http(`${sbx(ctx, id, "/files")}?path=${encodeURIComponent(relPath(path))}`, { headers: auth(ctx), timeoutMs: 600_000 });
    return new Uint8Array(await res.arrayBuffer());
  },

  async writeFile(id, path, data, ctx) {
    await http(`${sbx(ctx, id, "/files")}?path=${encodeURIComponent(relPath(path))}`, {
      method: "PUT",
      headers: { ...auth(ctx), "content-type": "application/octet-stream" },
      raw: Buffer.from(data),
      timeoutMs: 600_000,
    });
  },

  async setTimeout(id, timeoutSec, ctx) {
    // Keeps it open `timeoutMs` from now, at most 24 h from creation.
    await http(sbx(ctx, id, "/timeout"), { headers: auth(ctx), body: { timeoutMs: Math.max(1, Math.ceil(timeoutSec)) * 1000 } });
  },

  async kill(id, ctx) {
    // Deleting a closed sandbox is a no-op that returns it.
    try {
      await http(sbx(ctx, id), { method: "DELETE", headers: auth(ctx) });
    } catch (err) {
      if (err instanceof HttpError && (err.status === 404 || err.status === 410)) return;
      throw err;
    }
  },

  async listAlive(ctx) {
    const ids: string[] = [];
    for (const state of ["pending", "ready"]) {
      let cursor: string | null | undefined;
      do {
        const q = `state=${state}&limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
        const page = await httpJson<{ sandboxes: Sandbox[]; nextCursor?: string | null }>(`${base(ctx)}/sandboxes?${q}`, { headers: auth(ctx) });
        ids.push(...page.sandboxes.map((x) => x.id));
        cursor = page.nextCursor;
      } while (cursor);
    }
    return ids;
  },
});
