// agental (agental.io): a Linux VM of your own over HTTP, Ubuntu 24.04 with Docker, root.
// REST: https://agental.io/v1, Bearer AGENTAL_API_KEY. Docs (checked 2026-11-21), every page
// Markdown: https://agental.io/llms.txt, https://agental.io/openapi.json (OpenAPI 3.1),
//   https://agental.io/docs/lifecycle.md   statuses, create (Idempotency-Key required; 201
//     running, 200 replay, 202 not made yet: resend in 10 s), ttlSeconds + onTimeout, stop/start,
//     auto-stop, delete (X-Agental-Confirm-Delete)
//   https://agental.io/docs/commands.md    POST …/exec (argv, ≤ 90 s), POST …/commands (≤ 10 min)
//   https://agental.io/docs/files.md       PUT|GET …/files (text or base64, 10 MB), GET …/folders
//   https://agental.io/docs/ports.md       POST …/host {port, public} → {url}
//   https://agental.io/docs/billing.md     plans, the free plan's $5 a month, units
//   https://agental.io/docs/errors.md, https://agental.io/docs/retries.md
// Sizes: tiny 1 vCPU / 2 GiB, small 2 / 4, medium 4 / 8 (the $100 plan), large 8 / 16 ($500).
// Create takes no env (variables live on templates), so env is kept in a file commands load.
// Commands over 85 s run as a background command that is polled; its output is the last
// 64 KB of each stream.

import { randomUUID } from "node:crypto";
import { HttpError, defineProvider, http, httpJson, refusals, shArgv } from "./util.js";
import { ENV_FILE, envFileBody, pollMs, sleep, withEnvFile } from "./rest-helpers.js";
import type { ProviderContext, ResolvedSpec } from "../core/types.js";

const ID = "agental";
const base = (ctx: ProviderContext) => String(ctx.env["AGENTAL_API_URL"] ?? "https://agental.io").replace(/\/+$/, "");
const auth = (ctx: ProviderContext) => ({ authorization: `Bearer ${ctx.env["AGENTAL_API_KEY"]}` });
const box = (ctx: ProviderContext, id: string, path = "") => `${base(ctx)}/v1/sandboxes/${encodeURIComponent(id)}${path}`;
const refused = refusals(ID, [
  { status: 429, body: /burst_budget_reached/, kind: "quota", why: "this month's burst-fee budget is spent" },
  { status: 409, body: /account_limit_reached/, kind: "rate_limit", why: "the account holds as many sandboxes as it may" },
]);

const SIZES = [
  { size: "tiny", cpu: 1, memoryMiB: 2048 },
  { size: "small", cpu: 2, memoryMiB: 4096 },
  { size: "medium", cpu: 4, memoryMiB: 8192 },
  { size: "large", cpu: 8, memoryMiB: 16384 },
];
/** The smallest agental size that fits the request. */
export function agentalSize(cpu: number, memoryMiB: number) {
  return SIZES.find((s) => s.cpu >= cpu && s.memoryMiB >= memoryMiB) ?? SIZES[SIZES.length - 1]!;
}

/** Metadata agental takes: at most 50 keys of a-z, 0-9, `_`, `.`, `-` up to 40 characters, values up to 500. */
export function agentalMetadata(metadata: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(metadata).filter(([k, v]) => /^[a-z0-9_.-]{1,40}$/.test(k) && v.length <= 500).slice(0, 50));
}

/** An Idempotency-Key of 8 to 200 visible characters from the router id. */
const idemKey = (spec: ResolvedSpec) => `sbr-${spec.metadata["sandboxrouting.id"] ?? randomUUID()}`.slice(0, 200);

interface Sandbox {
  id: string;
  status: string;
  error?: string | null;
}

export const agentalProvider = defineProvider({
  info: {
    id: ID,
    name: "agental",
    homepage: "https://agental.io",
    env: ["AGENTAL_API_KEY"],
    capabilities: ["ports", "pause", "fileList", "extendTimeout", "snapshot"],
    isolation: "vm",
    maxTimeoutSec: 86_400,
    maxExecSec: 600,
    freeTier: {
      tier: { kind: "monthly-credit", usd: 5 },
      // Until the first top-up an account runs 4 units at once: two small sandboxes.
      concurrency: 2,
      maxLifetimeSec: 86_400,
      requiresCard: true,
      notes: "Free plan: the first $5 of each month's use, once a card is saved (one allowance per card); tiny and small sizes only; 2 small sandboxes at once until the first top-up.",
      source: "https://agental.io/docs/billing.md",
      checked: "2026-11-21",
    },
    // Flat per size; small ($0.027/h for 2 vCPU / 4 GiB) split 2:1 vCPU-hour to GiB-hour reproduces every size.
    pricing: { vcpuSecondUsd: 0.027 / 4 / 3600, gibSecondUsd: 0.027 / 8 / 3600, defaultCpu: 2, defaultMemoryMiB: 4096, source: "https://agental.io/docs/lifecycle.md" },
    surfaces: { rest: "https://agental.io/v1", sdk: ["agental (npm)", "agental (PyPI)"], cli: "agental", mcp: "https://agental.io/v1/mcp" },
  },

  async create(spec, ctx) {
    const size = agentalSize(spec.cpu, spec.memoryMiB);
    const key = idemKey(spec);
    const body = {
      size: size.size,
      templateId: spec.nativeTemplate ?? (ctx.options["template"] as string | undefined),
      ttlSeconds: Math.min(86_400, Math.max(60, Math.ceil(spec.timeoutSec))),
      onTimeout: "delete",
      metadata: agentalMetadata(spec.metadata),
    };
    let sbx: Sandbox | undefined;
    // 202 (not made yet) and 503 admission_unavailable both mean: send the same request again.
    for (let i = 0; i < 30 && !sbx; i++) {
      try {
        const res = await http(`${base(ctx)}/v1/sandboxes`, { headers: { ...auth(ctx), "idempotency-key": key }, body, timeoutMs: 200_000 });
        if (res.status === 202) await sleep(pollMs(ctx, 10_000));
        else sbx = (await res.json()) as Sandbox;
      } catch (err) {
        if (!(err instanceof HttpError && err.status === 503 && /admission_unavailable/.test(err.message))) throw refused(err);
        await sleep(pollMs(ctx, 1000));
      }
    }
    if (!sbx) throw new Error(`agental: create ${key} was not made in time`);
    const id = sbx.id;
    try {
      let s = sbx;
      for (let i = 0; i < 300 && s.status !== "running"; i++) {
        if (s.status === "error" || s.status === "deleted" || s.status === "stopped") throw new Error(`agental sandbox ${id} is ${s.status}${s.error ? `: ${s.error}` : ""}`);
        await sleep(pollMs(ctx, 2000));
        s = await httpJson<Sandbox>(box(ctx, id), { headers: auth(ctx) });
      }
      if (s.status !== "running") throw new Error(`agental sandbox ${id} did not start`);
      if (Object.keys(spec.env).length) {
        await http(box(ctx, id, "/files"), { method: "PUT", headers: auth(ctx), body: { path: ENV_FILE, text: envFileBody(spec.env) } });
      }
    } catch (err) {
      await this.kill(id, ctx).catch(() => undefined);
      throw err;
    }
    return { providerSandboxId: id, cpu: size.cpu, memoryMiB: size.memoryMiB };
  },

  async exec(id, command, o, ctx) {
    const argv = shArgv(withEnvFile(command), { cwd: o.cwd, env: o.env });
    const limitSec = Math.min(600, Math.max(1, Math.ceil(o.timeoutSec ?? 600)));
    let r: { exitCode: number | null; stdout: string; stderr: string };
    if (limitSec <= 85) {
      // Answers when the command ends; 124 when it timed out.
      r = await httpJson(box(ctx, id, "/exec"), { headers: auth(ctx), body: { command: argv, timeoutMs: limitSec * 1000 }, timeoutMs: (limitSec + 15) * 1000 });
    } else {
      const started = await httpJson<{ id: string }>(box(ctx, id, "/commands"), { headers: auth(ctx), body: { command: argv, timeoutMs: limitSec * 1000 } });
      const deadline = Date.now() + (limitSec + 60) * 1000;
      for (;;) {
        await sleep(pollMs(ctx, 2000));
        const c = await httpJson<{ status: string; exitCode: number | null; stdout: string; stderr: string }>(box(ctx, id, `/commands/${encodeURIComponent(started.id)}`), {
          headers: auth(ctx),
        });
        if (c.status !== "running") {
          r = { ...c, exitCode: c.exitCode ?? (c.status === "timed_out" ? 124 : null) };
          break;
        }
        if (Date.now() > deadline) throw new Error(`agental exec: command ${started.id} still running past its deadline`);
      }
    }
    if (r.exitCode === null) throw new Error("agental exec: the command's end is not known");
    if (r.stdout) o.onStdout?.(r.stdout);
    if (r.stderr) o.onStderr?.(r.stderr);
    return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode };
  },

  async readFile(id, path, ctx) {
    const r = await httpJson<{ base64?: string; text?: string }>(`${box(ctx, id, "/files")}?path=${encodeURIComponent(path)}&encoding=base64`, { headers: auth(ctx) });
    return r.base64 !== undefined ? new Uint8Array(Buffer.from(r.base64, "base64")) : new TextEncoder().encode(r.text ?? "");
  },

  async writeFile(id, path, data, ctx) {
    await http(box(ctx, id, "/files"), { method: "PUT", headers: auth(ctx), body: { path, base64: Buffer.from(data).toString("base64") } });
  },

  async listFiles(id, path, ctx) {
    const r = await httpJson<{ path: string; entries: { name: string; kind: string; bytes?: number }[] }>(`${box(ctx, id, "/folders")}?path=${encodeURIComponent(path)}`, {
      headers: auth(ctx),
    });
    const dir = (r.path || path).replace(/\/+$/, "");
    return r.entries.map((e) => ({ name: e.name, path: `${dir}/${e.name}`, isDir: e.kind === "folder", size: e.bytes }));
  },

  async getUrl(id, port, ctx) {
    const r = await httpJson<{ url: string | null }>(box(ctx, id, "/host"), { headers: auth(ctx), body: { port, title: "sandboxrouting", public: true } });
    if (!r.url) throw new Error(`agental: port ${port} got no public address`);
    return r.url;
  },

  async setTimeout(id, timeoutSec, ctx) {
    await http(box(ctx, id, "/auto-stop"), { method: "PUT", headers: auth(ctx), body: { inSeconds: Math.min(86_400, Math.max(60, Math.ceil(timeoutSec))) } });
  },

  async pause(id, ctx) {
    await http(box(ctx, id, "/stop"), { headers: auth(ctx), body: {} });
  },

  async resume(id, ctx) {
    // 202 for an archived sandbox, whose disk comes back from storage first.
    try {
      await http(box(ctx, id, "/start"), { method: "POST", headers: auth(ctx) });
    } catch (err) {
      throw refused(err);
    }
    for (let i = 0; i < 180; i++) {
      const s = await httpJson<Sandbox>(box(ctx, id), { headers: auth(ctx) });
      if (s.status === "running") return;
      if (s.status === "error" || (s.status === "stopped" && s.error)) throw new Error(`agental sandbox ${id} did not start: ${s.error ?? s.status}`);
      await sleep(pollMs(ctx, 10_000));
    }
    throw new Error(`agental sandbox ${id} did not start`);
  },

  async kill(id, ctx) {
    // 204 also when it was already gone; pauseJobs so a job using it can't block the delete.
    try {
      await http(`${box(ctx, id)}?pauseJobs=true`, { method: "DELETE", headers: { ...auth(ctx), "x-agental-confirm-delete": id } });
    } catch (err) {
      if (!(err instanceof HttpError && (err.status === 404 || err.status === 410))) throw err;
    }
  },

  async listAlive(ctx) {
    const r = await httpJson<{ sandboxes: Sandbox[] }>(`${base(ctx)}/v1/sandboxes?status=creating,running,stopped,restoring,migrating`, { headers: auth(ctx) });
    return r.sandboxes.map((s) => s.id);
  },
});
