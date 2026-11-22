// Blaxel sandboxes: microVMs that scale to zero after a few idle seconds. Free: up to $200
// credit, 10 concurrent on Tier 0, 7-day max age. Billed on memory only.
// Spoken over HTTP, no SDK, with the calls the official SDK (npm `@blaxel/core` 0.3.37, MIT) makes:
// - the control plane, https://api.blaxel.ai/v0 (docs https://docs.blaxel.ai/api-reference/introduction),
//   with `X-Blaxel-Authorization: Bearer <BL_API_KEY>`, `X-Blaxel-Workspace` and `Blaxel-Version`;
// - each sandbox's own API (processes, files) at the sandbox's `metadata.url`, else
//   `https://run.blaxel.ai/{workspace}/sandboxes/{name}`, with the same headers.
// BL_API_URL, BL_RUN_URL, BL_ENV and BL_API_VERSION are honoured as the SDK honours them.

import { createHash } from "node:crypto";
import { defineProvider, http, httpJson, HttpError } from "./util.js";
import { pollMs, sleep } from "./rest-helpers.js";
import type { ProviderContext } from "../core/types.js";

/** The API version the SDK pins its requests to. */
const API_VERSION = "2026-09-22";
const DEFAULT_IMAGE = "blaxel/base-image:latest";
/** The SDK fills this in when no memory is asked for. */
const DEFAULT_MEMORY_MIB = 4096;
/** Files over 5 MiB go up in 5 MiB parts, three at a time, as the SDK sends them. */
const PART_BYTES = 5 * 1024 * 1024;
const PART_WORKERS = 3;
/** How long the SDK polls a create the edge cut off with a 504 (the control plane keeps deploying). */
const CREATE_504_WAIT_MS = 120_000;
/** Retries of a create refused by a credential check that failed for a moment. */
const CREATE_AUTH_RETRIES = 2;

interface SandboxRecord {
  metadata?: { name?: string; url?: string };
  status?: string;
  spec?: { runtime?: Record<string, unknown> } & Record<string, unknown>;
}

function urls(ctx: ProviderContext): { api: string; run: string } {
  const dev = (ctx.env["BL_ENV"] || "prod") !== "prod";
  const api = ctx.env["BL_API_URL"] || (dev ? "https://api.blaxel.dev/v0" : "https://api.blaxel.ai/v0");
  const run = ctx.env["BL_RUN_URL"] || (dev ? "https://run.blaxel.dev" : "https://run.blaxel.ai");
  return { api: api.replace(/\/+$/, ""), run: run.replace(/\/+$/, "") };
}

const headers = (ctx: ProviderContext): Record<string, string> => ({
  "x-blaxel-authorization": `Bearer ${ctx.env["BL_API_KEY"] ?? ""}`,
  "x-blaxel-workspace": ctx.env["BL_WORKSPACE"] ?? "",
  "blaxel-version": ctx.env["BL_API_VERSION"] || API_VERSION,
});

function api<T>(ctx: ProviderContext, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  return httpJson<T>(`${urls(ctx).api}${path}`, { ...init, headers: headers(ctx), timeoutMs: 120_000 });
}

const sbxPath = (name: string) => `/sandboxes/${encodeURIComponent(name)}`;

/** The SDK's backoff: exponential from `base`, capped at `max`, plus up to `base` of jitter. */
const backoff = (attempt: number, base: number, max: number) => Math.min(base * 2 ** (attempt - 1), max) + Math.floor(Math.random() * base);

/** A dropped connection (no HTTP status), which the SDK retries on idempotent sandbox calls. */
function transportReset(err: unknown): boolean {
  if (err instanceof HttpError) return false;
  for (let e = err as { code?: unknown; cause?: unknown } | undefined, depth = 0; e && typeof e === "object" && depth < 5; e = e.cause as typeof e, depth++) {
    if (typeof e.code === "string" && ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE"].includes(e.code)) return true;
  }
  return false;
}

/**
 * Runs an idempotent sandbox call as the SDK does: an edge gateway error (502/503/504, a sandbox
 * waking from standby) is retried twice, a dropped connection up to `resets` times.
 */
async function idempotent<T>(ctx: ProviderContext, fn: () => Promise<T>, resets = 5): Promise<T> {
  const base = pollMs(ctx, 200);
  let gateway = 0;
  let reset = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof HttpError && [502, 503, 504].includes(err.status)) {
        if (++gateway > 2) throw err;
        await sleep(backoff(gateway, base, base * 10));
        continue;
      }
      if (!transportReset(err) || ++reset > resets) throw err;
      await sleep(backoff(reset, base, base * 10));
    }
  }
}

/** Sandbox API base URL per sandbox: it doesn't change while the sandbox lives. */
const sandboxUrls = new Map<string, string>();

function remember(name: string, record: SandboxRecord, ctx: ProviderContext): string {
  const url = (record.metadata?.url || `${urls(ctx).run}/${ctx.env["BL_WORKSPACE"] ?? ""}/sandboxes/${name}`).replace(/\/+$/, "");
  sandboxUrls.set(name, url);
  return url;
}

async function sandboxUrl(name: string, ctx: ProviderContext): Promise<string> {
  return sandboxUrls.get(name) ?? remember(name, await api<SandboxRecord>(ctx, sbxPath(name)), ctx);
}

/** A create the control plane refused before creating anything, which a new attempt can fix. */
const transientAuthRefusal = (err: unknown) =>
  err instanceof HttpError &&
  ((err.status === 403 && /"code"\s*:\s*"UNAUTHORIZED"/.test(err.message)) || (err.status === 503 && /"code"\s*:\s*"AUTHENTICATION_UNAVAILABLE"/.test(err.message)));

async function sendCreate(body: unknown, ctx: ProviderContext): Promise<SandboxRecord> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await api<SandboxRecord>(ctx, "/sandboxes", { method: "POST", body });
    } catch (err) {
      if (attempt > CREATE_AUTH_RETRIES || !transientAuthRefusal(err)) throw err;
      await sleep(backoff(attempt, pollMs(ctx, 500), pollMs(ctx, 500) * 4));
    }
  }
}

/** After an edge 504 on create, polls the record until it is DEPLOYED, as the SDK does. */
async function waitAfterGatewayTimeout(name: string, cause: unknown, ctx: ProviderContext): Promise<SandboxRecord> {
  const deadline = Date.now() + CREATE_504_WAIT_MS;
  for (let attempt = 1; Date.now() < deadline; attempt++) {
    await sleep(backoff(attempt, pollMs(ctx, 1000), pollMs(ctx, 1000) * 5));
    let record: SandboxRecord;
    try {
      record = await api<SandboxRecord>(ctx, sbxPath(name));
    } catch (err) {
      // The record can lag behind the accepted create.
      if (err instanceof HttpError && err.status === 404) continue;
      throw err;
    }
    if (record.status === "DEPLOYED") return record;
    if (record.status === "FAILED") throw new Error(`Sandbox ${name} failed to deploy after the create timed out at the edge (504).`);
  }
  throw cause;
}

/** Uploads a large file through the multipart API: initiate, parts, complete (abort on failure). */
async function uploadParts(base: string, path: string, data: Uint8Array, ctx: ProviderContext): Promise<void> {
  const h = headers(ctx);
  const init = await httpJson<{ uploadId?: string }>(`${base}/filesystem-multipart/initiate/${encodeURIComponent(path)}`, { method: "POST", headers: h, body: { permissions: "0644" } });
  if (!init.uploadId) throw new Error("Failed to get upload ID from initiate response");
  const upload = `${base}/filesystem-multipart/${encodeURIComponent(init.uploadId)}`;
  try {
    const total = Math.ceil(data.length / PART_BYTES);
    const parts: { etag?: string; partNumber?: number; size?: number }[] = [];
    let next = 1;
    let failure: { err: unknown } | undefined;
    const worker = async () => {
      while (!failure) {
        const partNumber = next++;
        if (partNumber > total) return;
        const chunk = data.slice((partNumber - 1) * PART_BYTES, partNumber * PART_BYTES);
        try {
          parts.push(
            await idempotent(
              ctx,
              () => {
                const form = new FormData();
                form.append("file", new Blob([chunk]));
                return httpJson<{ etag?: string; partNumber?: number; size?: number }>(`${upload}/part?partNumber=${partNumber}`, { method: "PUT", headers: h, raw: form, timeoutMs: 600_000 });
              },
              3,
            ),
          );
        } catch (err) {
          failure ??= { err };
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(total, PART_WORKERS) }, worker));
    if (failure) throw failure.err;
    parts.sort((a, b) => (a.partNumber ?? 0) - (b.partNumber ?? 0));
    await httpJson(`${upload}/complete`, { method: "POST", headers: h, body: { parts } });
  } catch (err) {
    await http(`${upload}/abort`, { method: "DELETE", headers: h }).catch(() => undefined);
    throw err;
  }
}

export const blaxelProvider = defineProvider({
  info: {
    id: "blaxel",
    name: "Blaxel",
    homepage: "https://blaxel.ai",
    env: ["BL_API_KEY", "BL_WORKSPACE"],
    capabilities: ["customImage", "ports", "fileList", "extendTimeout", "snapshot"],
    isolation: "microvm",
    maxTimeoutSec: 30 * 86400,
    freeTier: {
      // "Up to $200"; whether it recurs is not stated. Treated as one-time.
      tier: { kind: "one-time-credit", usd: 200 },
      concurrency: 10,
      maxLifetimeSec: 7 * 86400,
      notes: "Up to $200 credit; Tier 0: 10 concurrent, 7-day max age. Idle sandboxes scale to zero (storage only).",
      source: "https://blaxel.ai/pricing",
      checked: "2026-11-11",
    },
    pricing: { vcpuSecondUsd: 0, gibSecondUsd: 0.0000115, defaultCpu: 2, defaultMemoryMiB: 2048, source: "https://blaxel.ai/pricing" },
    surfaces: { rest: "https://api.blaxel.ai/v0", sdk: ["@blaxel/core (npm)", "blaxel (PyPI)"], cli: "bl", mcp: "per-sandbox MCP server" },
  },

  async create(spec, ctx) {
    // Names: lowercase letters, digits and hyphens.
    const name = `sbr-${createHash("sha256").update(spec.metadata["sandboxrouting.id"] ?? String(Date.now())).digest("hex").slice(0, 16)}`;
    const ports = (ctx.options["ports"] as number[] | undefined) ?? [];
    const envs = Object.entries(spec.env).map(([name, value]) => ({ name, value }));
    // The SDK's shorthand, expanded as it expands it (empty lists are left out).
    const body = {
      metadata: { name },
      spec: {
        region: spec.region ?? ctx.env["BL_REGION"],
        runtime: {
          image: spec.nativeTemplate ?? spec.image ?? DEFAULT_IMAGE,
          memory: spec.memoryMiB || DEFAULT_MEMORY_MIB,
          ports: ports.length ? ports.map((target) => ({ target, protocol: "HTTP" })) : undefined,
          envs: envs.length ? envs : undefined,
          generation: "mk3",
          ttl: `${Math.ceil(spec.timeoutSec / 60)}m`,
        },
      },
    };
    let record: SandboxRecord;
    try {
      record = await sendCreate(body, ctx);
    } catch (err) {
      // The edge gave up on the connection while the control plane keeps deploying.
      if (!(err instanceof HttpError && err.status === 504)) throw err;
      record = await waitAfterGatewayTimeout(name, err, ctx);
    }
    const id = record.metadata?.name ?? name;
    remember(id, record, ctx);
    return { providerSandboxId: id };
  },

  async exec(id, command, o, ctx) {
    const base = await sandboxUrl(id, ctx);
    // Not retried: a second POST would run the command twice.
    const r = await httpJson<{ stdout?: string; stderr?: string; logs?: string; exitCode?: number }>(`${base}/process`, {
      method: "POST",
      headers: headers(ctx),
      body: { command, env: o.env, workingDir: o.cwd, waitForCompletion: true, timeout: o.timeoutSec },
      timeoutMs: (o.timeoutSec ?? 3600) * 1000 + 30_000,
    });
    const stdout = r.stdout ?? r.logs ?? "";
    const stderr = r.stderr ?? "";
    if (stdout) o.onStdout?.(stdout);
    if (stderr) o.onStderr?.(stderr);
    return { stdout, stderr, exitCode: r.exitCode ?? -1 };
  },

  async readFile(id, path, ctx) {
    const base = await sandboxUrl(id, ctx);
    return idempotent(ctx, async () => {
      const res = await http(`${base}/filesystem/${encodeURIComponent(path)}`, { headers: { ...headers(ctx), Accept: "application/octet-stream" }, timeoutMs: 600_000 });
      return new Uint8Array(await res.arrayBuffer());
    });
  },

  async writeFile(id, path, data, ctx) {
    const base = await sandboxUrl(id, ctx);
    if (data.length > PART_BYTES) return uploadParts(base, path, data, ctx);
    // The SDK puts the path into this URL as is, not encoded.
    await idempotent(
      ctx,
      async () => {
        const form = new FormData();
        form.append("file", new Blob([data.slice()]), "test-binary.bin");
        form.append("permissions", "0644");
        form.append("path", path);
        await http(`${base}/filesystem/${path}`, { method: "PUT", headers: headers(ctx), raw: form, timeoutMs: 600_000 });
      },
      3,
    );
  },

  async listFiles(id, path, ctx) {
    const base = await sandboxUrl(id, ctx);
    const dir = await idempotent(ctx, () =>
      httpJson<{ files?: { name: string; path: string; size?: number }[]; subdirectories?: { name: string; path: string }[] }>(`${base}/filesystem/${encodeURIComponent(path)}`, {
        headers: headers(ctx),
        timeoutMs: 120_000,
      }),
    );
    if (!dir || !("files" in dir || "subdirectories" in dir)) throw new Error(JSON.stringify({ error: "Directory not found" }));
    return [
      ...(dir.subdirectories ?? []).map((d) => ({ name: d.name, path: d.path, isDir: true })),
      ...(dir.files ?? []).map((f) => ({ name: f.name, path: f.path, isDir: false, size: f.size })),
    ];
  },

  async getUrl(id, port, ctx) {
    // createIfNotExists: the preview by name, else create it; a 409 means a concurrent create won.
    const name = `p${port}`;
    const previews = `${sbxPath(id)}/previews`;
    const one = () => api<{ spec?: { url?: string } }>(ctx, `${previews}/${encodeURIComponent(name)}`);
    const is = (err: unknown, status: number) => err instanceof HttpError && err.status === status;
    let preview: { spec?: { url?: string } };
    try {
      preview = await one();
    } catch (err) {
      if (!is(err, 404)) throw err;
      try {
        preview = await api(ctx, previews, { method: "POST", body: { metadata: { name }, spec: { port, public: true } } });
      } catch (err2) {
        if (!is(err2, 409)) throw err2;
        preview = await one();
      }
    }
    return preview.spec?.url ?? "";
  },

  async setTimeout(id, timeoutSec, ctx) {
    // Read, then write the whole record back with the new TTL, as the SDK's updateTtl does.
    const record = await api<SandboxRecord>(ctx, sbxPath(id));
    const body = { ...record, spec: { ...record.spec, runtime: { ...record.spec?.runtime, ttl: `${Math.ceil(timeoutSec / 60)}m` } } };
    await api(ctx, sbxPath(id), { method: "PUT", body });
  },

  async kill(id, ctx) {
    sandboxUrls.delete(id);
    await api(ctx, sbxPath(id), { method: "DELETE" });
  },
});
