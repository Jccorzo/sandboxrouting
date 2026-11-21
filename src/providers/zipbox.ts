// Zipbox: long-lived Linux boxes. Free: $25 of credit for a one-time $5 top-up by card (so $20
// is given). Paid: per second while running, by size: Tiny (1 vCPU / 2 GB) $0.0068/h, Small
// (2 vCPU / 4 GB) $0.0137/h, Medium (4 vCPU / 8 GB) $0.0274/h, Large (6 vCPU / 16 GB) $0.0548/h;
// paused boxes cost nothing. Nothing on a box stops on a timer, so the router deletes it at the
// deadline (enforcesTimeout: false). Zipbox doesn't say how boxes are isolated.
// Control plane: https://api.tribes.xyz (Bearer zb_…); each box serves its own API at its
// `baseUrl` with a per-box token from `GET /sandbox/:id`. OpenAPI at zipbox.ai/openapi.json.
// Docs: https://zipbox.ai/docs/http-api.md, https://zipbox.ai/docs/box-api.md,
// https://zipbox.ai/docs/machine-limit.md, https://zipbox.ai/pricing. SDKs: npm `zipbox`; CLI `zipbox`.
// Names are permanent: an account may ever create 250, deleted ones included. So boxes take
// names from a fixed pool (`options.pool`, default 32) under a prefix derived from the key
// (`options.namePrefix` to choose one); a name in use answers 409 and the next one is tried.
// Create takes no env, so env is kept in a file commands load.
// Tiers are xs/s/m/l; the docs don't pair them with the pricing page's sizes, so xs..l are taken
// to be Tiny..Large.

import { createHash } from "node:crypto";
import { defineProvider, http, HttpError, httpJson, refusals } from "./util.js";
import { ENV_FILE, envFileBody, grantCache, pollMs, sleep, sse, withEnvFile } from "./rest-helpers.js";
import type { ProviderContext } from "../core/types.js";

const base = (ctx: ProviderContext) => String(ctx.env["ZIPBOX_API_URL"] ?? "https://api.tribes.xyz").replace(/\/+$/, "");
const auth = (ctx: ProviderContext) => ({ authorization: `Bearer ${ctx.env["ZIPBOX_API_KEY"]}` });
const box = (ctx: ProviderContext, id: string, path = "") => `${base(ctx)}/sandbox/${encodeURIComponent(id)}${path}`;

const TIERS = [
  { tier: "xs", cpu: 1, memoryMiB: 2048 },
  { tier: "s", cpu: 2, memoryMiB: 4096 },
  { tier: "m", cpu: 4, memoryMiB: 8192 },
  { tier: "l", cpu: 6, memoryMiB: 16384 },
];
/** The smallest Zipbox tier that fits the request. */
export function zipboxTier(cpu: number, memoryMiB: number) {
  return TIERS.find((t) => t.cpu >= cpu && t.memoryMiB >= memoryMiB) ?? TIERS[TIERS.length - 1]!;
}

/** The pool's names: `<prefix>-00` … Names are global, so the prefix comes from the key. */
export function zipboxNames(ctx: ProviderContext): string[] {
  const size = Math.min(250, Math.max(1, Number(ctx.options["pool"] ?? 32)));
  const prefix = String(ctx.options["namePrefix"] ?? `sbr-${createHash("sha256").update(String(ctx.env["ZIPBOX_API_KEY"] ?? "")).digest("hex").slice(0, 10)}`);
  return Array.from({ length: size }, (_, i) => `${prefix}-${String(i).padStart(2, "0")}`);
}

interface Box {
  id?: string;
  sandboxId?: string;
  name?: string;
  status?: string;
  readiness?: string;
  ready?: boolean;
  baseUrl?: string | null;
  boxToken?: string | null;
}
const idOf = (b: Box) => (b.sandboxId ?? b.id)!;
/** `readiness` values a box does not leave by itself. */
const STUCK = new Set(["paused", "start_failed", "deleting", "gone"]);

/** Each box's origin and token, read once it is ready; dropped on a 401 or a failed connection. */
const access = grantCache<{ url: string; token: string }>();
async function reach(ctx: ProviderContext, id: string) {
  return access.get(id, async () => {
    const b = await httpJson<Box>(box(ctx, id), { headers: auth(ctx) });
    if (!b.ready || !b.baseUrl || !b.boxToken) throw new HttpError(409, `zipbox box ${id} is not running (${b.readiness ?? b.status})`);
    // The token has no expiry; the origin can move once, which a failed call recovers from.
    return { value: { url: b.baseUrl.replace(/\/+$/, ""), token: b.boxToken }, expiresAt: Date.now() + 10 * 60_000 };
  });
}
/** A call to the box's own API, retried once with fresh access after a 401 or a failed connection. */
async function onBox(ctx: ProviderContext, id: string, path: string, init: { method?: string; headers?: Record<string, string>; body?: unknown; raw?: RequestInit["body"]; timeoutMs?: number }) {
  for (let attempt = 0; ; attempt++) {
    const a = await reach(ctx, id);
    try {
      return await http(`${a.url}${path}`, { ...init, headers: { ...init.headers, authorization: `Bearer ${a.token}` } });
    } catch (err) {
      // A TypeError is a connection that failed before anything was sent (a moved origin, TLS).
      const retry = attempt === 0 && ((err instanceof HttpError && err.status === 401) || err instanceof TypeError);
      access.drop(id);
      if (!retry) throw err;
    }
  }
}

/**
 * Holds until the box is ready (the server answers within about 50 s either way). An API older
 * than the wait route answers it 404 for a box that exists: then the box is read and polled.
 */
async function waitReady(ctx: ProviderContext, id: string): Promise<Box> {
  try {
    return await httpJson<Box>(`${box(ctx, id, "/wait")}?until=ready`, { headers: auth(ctx), timeoutMs: 70_000 });
  } catch (err) {
    if (!(err instanceof HttpError && err.status === 404)) throw err;
    await sleep(pollMs(ctx, 1000));
    return httpJson<Box>(box(ctx, id), { headers: auth(ctx) });
  }
}

/**
 * A new name past the account's 250 ever answers 403 `machine_limit_reached`, which would read as
 * a bad key. It never clears (deleted names still count), so it is a quota.
 */
const refused = refusals("zipbox", [{ status: 403, body: /machine_limit_reached/, kind: "quota", why: "the account's 250 box names are used up" }]);

export const zipboxProvider = defineProvider({
  info: {
    id: "zipbox",
    name: "Zipbox",
    homepage: "https://zipbox.ai",
    env: ["ZIPBOX_API_KEY"],
    capabilities: ["pause", "fileList"],
    // Isolation is left unset: Zipbox does not publish it, so `minIsolation` requests skip it.
    enforcesTimeout: false,
    freeTier: {
      // Only the part given on top of the $5 top-up is counted.
      tier: { kind: "one-time-credit", usd: 20 },
      requiresCard: true,
      notes: "$25 of credit for a one-time $5 top-up by card. An account may ever create 250 box names.",
      source: "https://zipbox.ai/pricing",
      checked: "2026-11-21",
    },
    pricing: { vcpuSecondUsd: 0.00685 / 3600, gibSecondUsd: 0, defaultCpu: 2, defaultMemoryMiB: 4096, source: "https://zipbox.ai/pricing" },
    surfaces: { rest: "https://api.tribes.xyz", sdk: ["zipbox (npm)", "zipbox (PyPI)", "Go", "Rust"], cli: "zipbox", mcp: "https://mcp.zipbox.ai" },
  },

  async create(spec, ctx) {
    const size = zipboxTier(spec.cpu, spec.memoryMiB);
    const seed = spec.metadata["sandboxrouting.id"] ?? `${Date.now()}-${Math.random()}`;
    // Names are tried in an order that starts where the router id hashes to, so concurrent
    // creates spread over the pool. A name with a box answers 409 and the next is tried; the
    // claim's key is per name, so a retry of this create gets back the box it made (a replay
    // returns the first answer even though the name is now taken).
    const names = zipboxNames(ctx);
    const start = parseInt(createHash("sha256").update(seed).digest("hex").slice(0, 8), 16) % names.length;
    let made: Box | undefined;
    for (const name of [...names.slice(start), ...names.slice(0, start)]) {
      try {
        made = await httpJson<Box>(`${base(ctx)}/sandbox/identity/claim`, {
          headers: { ...auth(ctx), "idempotency-key": `${seed}:${name}` },
          body: { name, tier: size.tier },
          timeoutMs: 120_000,
        });
        break;
      } catch (err) {
        if (err instanceof HttpError && err.status === 409) continue;
        throw refused(err);
      }
    }
    if (!made) throw new HttpError(429, "zipbox: every name in the pool has a box (too many sandboxes at once; raise options.pool)");
    const id = idOf(made);
    try {
      let b = made;
      for (let i = 0; i < 120 && !(b.ready && b.readiness !== "settling"); i++) {
        if (b.readiness && STUCK.has(b.readiness)) throw new Error(`zipbox box ${id} is ${b.readiness}`);
        b = await waitReady(ctx, id);
      }
      if (!b.ready) throw new Error(`zipbox box ${id} did not become ready`);
      if (Object.keys(spec.env).length) await this.writeFile(id, ENV_FILE, new TextEncoder().encode(envFileBody(spec.env)), ctx);
    } catch (err) {
      await http(box(ctx, id), { method: "DELETE", headers: auth(ctx), body: { archiveBeforeDestroy: false } }).catch(() => undefined);
      throw err;
    }
    return { providerSandboxId: id, cpu: size.cpu, memoryMiB: size.memoryMiB };
  },

  async exec(id, command, o, ctx) {
    const res = await onBox(ctx, id, "/exec", {
      headers: { accept: "text/event-stream" },
      body: { cmd: withEnvFile(command), cwd: o.cwd, env: o.env, timeoutMs: o.timeoutSec ? Math.ceil(o.timeoutSec * 1000) : undefined },
      timeoutMs: ((o.timeoutSec ?? 24 * 3600) + 30) * 1000,
    });
    let stdout = "";
    let stderr = "";
    for await (const ev of sse(res.body as unknown as AsyncIterable<Uint8Array>)) {
      const f = ev.data ? (JSON.parse(ev.data) as { data?: string; exitCode?: number | null; signal?: string | number | null; timedOut?: boolean }) : {};
      if (ev.event === "stdout" && f.data) {
        stdout += f.data;
        o.onStdout?.(f.data);
      } else if (ev.event === "stderr" && f.data) {
        stderr += f.data;
        o.onStderr?.(f.data);
      } else if (ev.event === "exit") {
        return { stdout, stderr, exitCode: f.timedOut ? 124 : f.exitCode ?? 137 };
      }
    }
    throw new Error("zipbox exec: the stream ended without an exit event");
  },

  async readFile(id, path, ctx) {
    return new Uint8Array(await (await onBox(ctx, id, `/files/download?path=${encodeURIComponent(path)}`, {})).arrayBuffer());
  },

  async writeFile(id, path, data, ctx) {
    // Written atomically to dir/name; the directory must exist.
    const cut = path.lastIndexOf("/");
    const dir = cut > 0 ? path.slice(0, cut) : "/";
    const name = path.slice(cut + 1);
    await onBox(ctx, id, "/files/mutate", { body: { action: "mkdir", path: dir } }).catch(() => undefined);
    await onBox(ctx, id, `/files/write?dir=${encodeURIComponent(dir)}&name=${encodeURIComponent(name)}`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      raw: data,
    });
  },

  async listFiles(id, path, ctx) {
    const r = await (await onBox(ctx, id, `/files?path=${encodeURIComponent(path)}`, {})).json() as { entries: { name: string; kind: string; sizeBytes?: number }[] };
    const dir = path.endsWith("/") ? path : `${path}/`;
    return r.entries.map((e) => ({ name: e.name, path: `${dir}${e.name}`, isDir: e.kind === "directory", size: e.sizeBytes }));
  },

  async pause(id, ctx) {
    access.drop(id);
    await http(box(ctx, id, "/pause"), { method: "POST", headers: auth(ctx) });
  },

  async resume(id, ctx) {
    access.drop(id);
    let b = await httpJson<Box>(box(ctx, id, "/resume"), { method: "POST", headers: auth(ctx) });
    for (let i = 0; i < 120 && !b.ready; i++) {
      if (b.readiness && STUCK.has(b.readiness)) throw new Error(`zipbox box ${id} is ${b.readiness}`);
      b = await waitReady(ctx, id);
    }
  },

  async kill(id, ctx) {
    access.drop(id);
    // No 30-day recoverable copy: the router's boxes are disposable. A deleted box answers 404.
    await http(box(ctx, id), { method: "DELETE", headers: auth(ctx), body: { archiveBeforeDestroy: false } }).catch((err) => {
      if (err instanceof HttpError && (err.status === 404 || err.status === 410)) return;
      throw err;
    });
  },

  async listAlive(ctx) {
    // Only the pool's boxes: other boxes on the account aren't the router's.
    const names = new Set(zipboxNames(ctx));
    const rows = await httpJson<Box[] | { sandboxes?: Box[] }>(`${base(ctx)}/sandbox`, { headers: auth(ctx) });
    return (Array.isArray(rows) ? rows : rows.sandboxes ?? []).filter((b) => b.status !== "destroyed" && names.has(b.name ?? "")).map(idOf);
  },
});
