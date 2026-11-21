// Kubi (trykubi.com): cloud Linux desktops ("screens") for agents, each its own virtual
// machine with 4 vCPU, 8 GB and 50 GB of disk, one size only. Private beta: accounts are
// approved by hand, and until then every call answers 403 ACCOUNT_PENDING. No free tier:
// disposable screens run on prepaid credit ($10 to $500, which needs a paid persistent screen
// first) at $0.035 an hour, by the minute. The router uses disposable screens only.
// A disposable screen takes an end time (`ends_in_s`, 5 minutes to 30 days); shorter lives are
// ended by the router at the deadline (enforcesTimeout: false).
// REST: https://api.trykubi.com/v1 (Bearer kubi_…), OpenAPI at docs.trykubi.com/openapi.json;
// docs docs.trykubi.com/concepts/screens.md, docs.trykubi.com/guides/commands-and-files.md,
// docs.trykubi.com/concepts/billing-and-history.md, docs.trykubi.com/errors.md,
// trykubi.com/pricing. npm `@trykubi/sdk`, MCP https://mcp.trykubi.com.
// Create, stop, start and delete answer 202 with an operation to poll. Commands run with
// `bash -lc`; one call holds up to 25 s, then the exec is polled.

import { randomUUID } from "node:crypto";
import { defineProvider, http, httpJson, HttpError } from "./util.js";
import { envFileBody, pollMs, sbrName, sleep } from "./rest-helpers.js";
import type { ProviderContext } from "../core/types.js";

const base = (ctx: ProviderContext) => String(ctx.env["KUBI_API_URL"] ?? "https://api.trykubi.com/v1").replace(/\/+$/, "");
const auth = (ctx: ProviderContext) => ({ authorization: `Bearer ${ctx.env["KUBI_API_KEY"]}` });
const screen = (ctx: ProviderContext, id: string, path = "") => `${base(ctx)}/screens/${encodeURIComponent(id)}${path}`;
const gone = (err: unknown) => err instanceof HttpError && (err.status === 404 || err.status === 410);
/** Idempotency keys are 8–255 printable characters. */
const key = (seed?: string) => `sbr-${seed ?? randomUUID()}`.slice(0, 255);
const SIZE = { cpu: 4, memoryMiB: 8192 };
/** Create-time env, loaded by every command: screens take no env at create. */
const ENV_FILE = "/home/user/.sbr-env";

interface Operation {
  id: string;
  status: string;
  screen_id: string;
  error?: { code: string; message: string } | null;
}
interface Exec {
  id: string;
  status: string;
  exit_code?: number | null;
  stdout: string;
  stderr: string;
  stdout_bytes: number;
  stderr_bytes: number;
}

/** Labels: at most 20, keys `[a-z0-9_.-]{1,40}`, values up to 100 characters. */
const labels = (m: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(m)
      .filter(([k, v]) => /^[a-z0-9_.-]{1,40}$/.test(k) && v.length <= 100)
      .slice(0, 20),
  );

/** Waits for an operation; "reconciling" is not a failure, so it keeps waiting. */
async function settle(ctx: ProviderContext, op: Operation): Promise<void> {
  const waitS = ctx.options["pollMs"] === undefined ? 25 : 0;
  for (let i = 0; i < 300 && op.status !== "succeeded"; i++) {
    if (op.status === "failed") throw new Error(`kubi ${op.id} failed${op.error ? `: ${op.error.code} ${op.error.message}` : ""}`);
    if (i) await sleep(pollMs(ctx, 0));
    op = await httpJson<Operation>(`${base(ctx)}/operations/${encodeURIComponent(op.id)}?wait_s=${waitS}`, { headers: auth(ctx), timeoutMs: 40_000 });
  }
  if (op.status !== "succeeded") throw new Error(`kubi ${op.id} did not finish`);
}

export const kubiProvider = defineProvider({
  info: {
    id: "kubi",
    name: "Kubi",
    homepage: "https://trykubi.com",
    env: ["KUBI_API_KEY"],
    capabilities: ["pause", "fileList", "extendTimeout"],
    isolation: "vm",
    enforcesTimeout: false,
    maxTimeoutSec: 2_592_000,
    freeTier: {
      tier: { kind: "none" },
      requiresCard: true,
      notes: "No free tier. Private beta, accounts approved by hand. Disposable screens run on prepaid credit from $10; buying credit needs a paid persistent screen ($20 a month, founding price) first.",
      source: "https://trykubi.com/pricing",
      checked: "2026-11-21",
    },
    // One size, flat: $0.035 an hour for 4 vCPU / 8 GB.
    pricing: { vcpuSecondUsd: 0.035 / 4 / 3600, gibSecondUsd: 0, sandboxSecondUsd: 0.035 / 3600, defaultCpu: SIZE.cpu, defaultMemoryMiB: SIZE.memoryMiB, source: "https://trykubi.com/pricing" },
    surfaces: { rest: "https://api.trykubi.com/v1", sdk: ["@trykubi/sdk (npm)"], mcp: "https://mcp.trykubi.com" },
  },

  async create(spec, ctx) {
    const op = await httpJson<Operation>(`${base(ctx)}/screens`, {
      headers: { ...auth(ctx), "idempotency-key": key(spec.metadata["sandboxrouting.id"]) },
      body: {
        kind: "disposable",
        name: sbrName(spec),
        labels: labels(spec.metadata),
        template_id: spec.nativeTemplate,
        ends_in_s: Math.min(2_592_000, Math.max(300, Math.ceil(spec.timeoutSec))),
      },
    });
    const id = op.screen_id;
    try {
      await settle(ctx, op);
      if (Object.keys(spec.env).length) {
        await this.writeFile(id, ENV_FILE, new TextEncoder().encode(envFileBody(spec.env)), ctx);
      }
    } catch (err) {
      await http(screen(ctx, id), { method: "DELETE", headers: { ...auth(ctx), "idempotency-key": key(`delete-${id}`) } }).catch(() => undefined);
      throw err;
    }
    return { providerSandboxId: id, ...SIZE };
  },

  async exec(id, command, o, ctx) {
    const full = `[ -f ${ENV_FILE} ] && . ${ENV_FILE}; ${command}`;
    const waitS = ctx.options["pollMs"] === undefined ? 25 : 0;
    const res = await http(screen(ctx, id, "/exec"), {
      headers: { ...auth(ctx), "idempotency-key": key() },
      body: { command: full, cwd: o.cwd, env: o.env, timeout_s: Math.min(86_400, Math.max(1, Math.ceil(o.timeoutSec ?? 3600))), wait_s: waitS, max_bytes: 1_048_576 },
      timeoutMs: 40_000,
    });
    let x = (await res.json()) as Exec;
    let stdout = x.stdout;
    let stderr = x.stderr;
    if (stdout) o.onStdout?.(stdout);
    if (stderr) o.onStderr?.(stderr);
    let outAt = Buffer.byteLength(stdout);
    let errAt = Buffer.byteLength(stderr);
    while (x.status === "running") {
      await sleep(pollMs(ctx, 0));
      const q = new URLSearchParams({ until: "exit", wait_s: String(waitS), stdout_from: String(outAt), stderr_from: String(errAt), max_bytes: "1048576" });
      x = await httpJson<Exec>(`${screen(ctx, id, "/exec")}/${encodeURIComponent(x.id)}?${q}`, { headers: auth(ctx), timeoutMs: 40_000 });
      if (x.stdout) o.onStdout?.(x.stdout);
      if (x.stderr) o.onStderr?.(x.stderr);
      stdout += x.stdout;
      stderr += x.stderr;
      outAt += Buffer.byteLength(x.stdout);
      errAt += Buffer.byteLength(x.stderr);
    }
    if (x.status === "lost") throw new Error(`kubi exec ${x.id}: the screen restarted mid-run, its outcome is unknown`);
    const exitCode = x.status === "timed_out" ? 124 : x.status === "killed" ? (x.exit_code ?? 137) : (x.exit_code ?? 1);
    return { stdout, stderr, exitCode };
  },

  async readFile(id, path, ctx) {
    return new Uint8Array(await (await http(`${screen(ctx, id, "/files")}?path=${encodeURIComponent(path)}`, { headers: auth(ctx) })).arrayBuffer());
  },

  async writeFile(id, path, data, ctx) {
    await http(`${screen(ctx, id, "/files")}?path=${encodeURIComponent(path)}`, { method: "PUT", headers: { ...auth(ctx), "content-type": "application/octet-stream" }, raw: data });
  },

  async listFiles(id, path, ctx) {
    const out: { name: string; path: string; isDir: boolean; size?: number }[] = [];
    const dir = path.endsWith("/") ? path : `${path}/`;
    let after: string | null = null;
    do {
      const q = new URLSearchParams({ path, limit: "100", ...(after ? { after } : {}) });
      const page: { data: { name: string; type: string; size_bytes?: number }[]; next: string | null } = await httpJson(`${screen(ctx, id, "/dir")}?${q}`, { headers: auth(ctx) });
      out.push(...page.data.map((e) => ({ name: e.name, path: `${dir}${e.name}`, isDir: e.type === "dir", size: e.size_bytes })));
      after = page.next;
    } while (after);
    return out;
  },

  async setTimeout(id, timeoutSec, ctx) {
    await http(screen(ctx, id), { method: "PATCH", headers: auth(ctx), body: { ends_at: new Date(Date.now() + Math.max(300, timeoutSec) * 1000).toISOString() } });
  },

  async pause(id, ctx) {
    // A stopped disposable screen keeps its disk (a small fee) and is deleted after 7 days.
    await settle(ctx, await httpJson<Operation>(screen(ctx, id, "/stop"), { method: "POST", headers: { ...auth(ctx), "idempotency-key": key() } }));
  },

  async resume(id, ctx) {
    await settle(ctx, await httpJson<Operation>(screen(ctx, id, "/start"), { method: "POST", headers: { ...auth(ctx), "idempotency-key": key() } }));
  },

  async kill(id, ctx) {
    // A disposable screen's delete is final; a repeat while it runs returns the same operation.
    await http(screen(ctx, id), { method: "DELETE", headers: { ...auth(ctx), "idempotency-key": key(`delete-${id}`) } }).catch((err) => {
      if (!gone(err)) throw err;
    });
  },

  async listAlive(ctx) {
    const ids: string[] = [];
    let after: string | null = null;
    do {
      const q = new URLSearchParams({ kind: "disposable", limit: "100", ...(after ? { after } : {}) });
      const page: { data: { id: string; state: string }[]; next: string | null } = await httpJson(`${base(ctx)}/screens?${q}`, { headers: auth(ctx) });
      ids.push(...page.data.filter((s) => !["deleting", "deleted", "failed"].includes(s.state)).map((s) => s.id));
      after = page.next;
    } while (after);
    return ids;
  },
});
