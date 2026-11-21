// briq (briq.cloud): one OCI image per Firecracker microVM ("a briq"), hosted in the EU by
// default. Every new account gets €10 of credits, no card; the free Hobby plan runs 5 briqs at
// once, sizes up to medium (shared 2 vCPU / 4 GB). Billed per second while running, in euros:
// small (1 vCPU / 2 GB) €0.016/h, medium €0.03/h, large €0.058/h: about €0.0075 per GB-hour.
// A briq has no time limit: it sleeps after its `sleep` window unused (not billed asleep) and
// is never deleted for time, so the router deletes it at the deadline (enforcesTimeout: false).
// REST: https://api.briq.cloud/v1 (Bearer key from the dashboard), OpenAPI at
// api.briq.cloud/v1/openapi.json; docs briq.cloud/docs/api/overview.md,
// briq.cloud/docs/concepts/lifecycle-and-sleep.md, briq.cloud/docs/cost.md,
// briq.cloud/cookbook/sandbox.md. npm `@briq-cloud/cli`, MCP https://api.briq.cloud/mcp.
// The sandbox is the `sandbox` recipe (ghcr.io/briq-cloud/sandbox, /work, waits for commands).
// A synchronous exec answers within 60 s; longer commands run async and are polled.

import { randomUUID } from "node:crypto";
import { defineProvider, http, httpJson, HttpError, refusals } from "./util.js";
import { inline, pollMs, sbrName, sleep } from "./rest-helpers.js";
import type { ProviderContext } from "../core/types.js";
import { USD_PER_EUR } from "./currency.js";

const base = (ctx: ProviderContext) => String(ctx.env["BRIQ_API_URL"] ?? "https://api.briq.cloud").replace(/\/+$/, "");
const auth = (ctx: ProviderContext) => ({ authorization: `Bearer ${ctx.env["BRIQ_API_KEY"]}` });
const box = (ctx: ProviderContext, id: string, path = "") => `${base(ctx)}/v1/briqs/${encodeURIComponent(id)}${path}`;
const gone = (err: unknown) => err instanceof HttpError && (err.status === 404 || err.status === 410);
const SYNC_EXEC_SEC = 60;

const SIZES = [
  { size: "nano", cpu: 1, memoryMiB: 512 },
  { size: "small", cpu: 1, memoryMiB: 2048 },
  { size: "medium", cpu: 2, memoryMiB: 4096 },
  { size: "large", cpu: 4, memoryMiB: 8192 },
  { size: "xlarge", cpu: 8, memoryMiB: 16384 },
];
/** briq sizes, smallest first: the first that fits the request. */
export function briqSize(cpu: number, memoryMiB: number) {
  return SIZES.find((s) => s.cpu >= cpu && s.memoryMiB >= memoryMiB) ?? SIZES[SIZES.length - 1]!;
}

interface Briq {
  id: string;
  state: string;
  error?: string | null;
  name?: string;
}

/** `plan_limit` is a 403, which would read as a bad key: it is the plan's size or count limit. */
const refusal = refusals("briq", [{ status: 403, body: /plan_limit/, kind: "quota", why: "the plan's size or count limit" }]);

export const briqProvider = defineProvider({
  info: {
    id: "briq",
    name: "briq",
    homepage: "https://briq.cloud",
    env: ["BRIQ_API_KEY"],
    capabilities: ["ports", "pause", "customImage"],
    isolation: "microvm",
    enforcesTimeout: false,
    freeTier: {
      tier: { kind: "one-time-credit", usd: 10 * USD_PER_EUR },
      concurrency: 5,
      requiresCard: false,
      notes: "€10 of credits on every new account, no card. Hobby (free): 5 briqs at once, 16 GB across live briqs, sizes up to medium; large needs a card on file.",
      source: "https://briq.cloud/docs/cost.md",
      checked: "2026-11-21",
    },
    // Priced per size and close to linear in memory: €0.03/h for medium (2 vCPU / 4 GB).
    pricing: { vcpuSecondUsd: 0, gibSecondUsd: ((0.03 / 4) * USD_PER_EUR) / 3600, defaultCpu: 2, defaultMemoryMiB: 4096, source: "https://briq.cloud/docs/cost.md" },
    surfaces: { rest: "https://api.briq.cloud/v1", cli: "briq (@briq-cloud/cli)", mcp: "https://api.briq.cloud/mcp" },
  },

  async create(spec, ctx) {
    const size = briqSize(spec.cpu, spec.memoryMiB);
    let r: { briqs: Briq[]; ready?: boolean; message?: string };
    try {
      r = await httpJson(`${base(ctx)}/v1/briqs`, {
        headers: { ...auth(ctx), "idempotency-key": spec.metadata["sandboxrouting.id"] ?? randomUUID() },
        body: {
          recipe: "sandbox",
          name: sbrName(spec),
          size: size.size,
          image: spec.nativeTemplate ?? spec.image,
          env: spec.env,
          // It sleeps after this long unused; the router deletes it at the deadline.
          sleep: `${Math.min(10_080, Math.max(5, Math.ceil(spec.timeoutSec / 60)))}m`,
          wait: true,
        },
        timeoutMs: 180_000,
      });
    } catch (err) {
      throw refusal(err);
    }
    const made = r.briqs[0];
    if (!made) throw new Error(`briq create made no briq${r.message ? `: ${r.message}` : ""}`);
    try {
      let cur = made;
      for (let i = 0; i < 600 && cur.state !== "running"; i++) {
        if (["error", "destroying", "destroyed", "stopped"].includes(cur.state)) throw new Error(`briq ${made.id} is ${cur.state}${cur.error ? `: ${cur.error}` : ""}`);
        await sleep(pollMs(ctx, 1000));
        cur = (await httpJson<{ briq: Briq }>(box(ctx, made.id), { headers: auth(ctx) })).briq;
      }
      if (cur.state !== "running") throw new Error(`briq ${made.id} did not start`);
    } catch (err) {
      await http(`${box(ctx, made.id)}?wait=false`, { method: "DELETE", headers: auth(ctx) }).catch(() => undefined);
      throw err;
    }
    return { providerSandboxId: made.id, cpu: size.cpu, memoryMiB: size.memoryMiB };
  },

  async exec(id, command, o, ctx) {
    const cmd = ["sh", "-c", inline(command, { cwd: o.cwd })];
    const timeoutSec = o.timeoutSec ?? 3600;
    if (timeoutSec <= SYNC_EXEC_SEC) {
      const r = await httpJson<{ stdout: string; stderr: string; exitCode: number; timedOut?: boolean }>(box(ctx, id, "/exec"), {
        headers: auth(ctx),
        body: { cmd, env: o.env, timeoutMs: Math.max(1000, Math.ceil(timeoutSec * 1000)) },
        timeoutMs: (SYNC_EXEC_SEC + 30) * 1000,
      });
      if (r.stdout) o.onStdout?.(r.stdout);
      if (r.stderr) o.onStderr?.(r.stderr);
      return { stdout: r.stdout, stderr: r.stderr, exitCode: r.timedOut ? 124 : r.exitCode };
    }
    // Longer than a synchronous call allows: start it async, wait for its end, then read
    // each stream whole from byte offsets.
    const started = await httpJson<{ exec: { id: string } }>(box(ctx, id, "/exec"), {
      headers: auth(ctx),
      body: { cmd, env: o.env, async: true, timeoutMs: Math.min(86_400_000, Math.ceil(timeoutSec * 1000)) },
    });
    const execUrl = box(ctx, id, `/execs/${encodeURIComponent(started.exec.id)}`);
    const waitMs = ctx.options["pollMs"] === undefined ? 45_000 : 0;
    let state: { state: string; exitCode: number | null };
    for (;;) {
      state = (await httpJson<{ exec: { state: string; exitCode: number | null } }>(`${execUrl}?waitMs=${waitMs}`, { headers: auth(ctx), timeoutMs: waitMs + 30_000 })).exec;
      if (state.state !== "running") break;
      await sleep(pollMs(ctx, 0));
    }
    if (state.state === "lost") throw new Error(`briq exec ${started.exec.id}: the machine restarted without it`);
    const read = async (stream: "stdout" | "stderr") => {
      let text = "";
      for (let offset = 0; ; ) {
        const r = (await httpJson<{ exec: { read?: { data: string; nextOffset: number; eof: boolean } } }>(`${execUrl}?offset=${offset}&stream=${stream}`, { headers: auth(ctx) })).exec.read;
        if (!r) break;
        text += r.data;
        if (r.eof || r.nextOffset <= offset) break;
        offset = r.nextOffset;
      }
      return text;
    };
    const stdout = await read("stdout");
    const stderr = await read("stderr");
    if (stdout) o.onStdout?.(stdout);
    if (stderr) o.onStderr?.(stderr);
    const exitCode = state.state === "timed_out" ? 124 : state.state === "stopped" ? 137 : (state.exitCode ?? 1);
    return { stdout, stderr, exitCode };
  },

  async readFile(id, path, ctx) {
    return new Uint8Array(await (await http(`${box(ctx, id, "/files/raw")}?path=${encodeURIComponent(path)}`, { headers: auth(ctx) })).arrayBuffer());
  },

  async writeFile(id, path, data, ctx) {
    await http(`${box(ctx, id, "/files")}?path=${encodeURIComponent(path)}`, { method: "PUT", headers: { ...auth(ctx), "content-type": "application/octet-stream" }, raw: data });
  },

  async getUrl(id, port, ctx) {
    // Exposing a port other than the front door moves the URL there and restarts the machine.
    return (await httpJson<{ url: string }>(box(ctx, id, "/expose"), { headers: auth(ctx), body: { port, mode: "public", additional: true } })).url;
  },

  async pause(id, ctx) {
    await http(box(ctx, id, "/stop"), { method: "POST", headers: auth(ctx), body: {} });
  },

  async resume(id, ctx) {
    await http(box(ctx, id, "/start"), { method: "POST", headers: auth(ctx) });
  },

  async kill(id, ctx) {
    // Safe to repeat; a destroyed briq may also answer 404.
    await http(box(ctx, id), { method: "DELETE", headers: auth(ctx), timeoutMs: 60_000 }).catch((err) => {
      if (!gone(err)) throw err;
    });
  },

  async listAlive(ctx) {
    const r = await httpJson<{ briqs: Briq[] }>(`${base(ctx)}/v1/briqs`, { headers: auth(ctx) });
    return r.briqs.filter((b) => !["destroying", "destroyed", "error"].includes(b.state)).map((b) => b.id);
  },
});
