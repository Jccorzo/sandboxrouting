// Docker Sandboxes, cloud (Docker Agentic Platform): sandboxes on Docker-managed compute, each
// in its own microVM, from any OCI image with /bin/sh. Experimental. Pay-as-you-go (a card at
// checkout) with a $250 promotional credit. Per second by size, memory included: micro (1 CPU /
// 2 GiB) $0.07/h, small (2 / 4) $0.14/h, up to xl (16 / 32) $1.12/h; a stopped sandbox costs
// nothing. Default quota: 10 concurrent sandboxes. A sandbox's TTL can't pass 24 h from its
// creation; at expiry this adapter asks for delete.
// REST: management API https://connect.docker.com/sandboxes/v1 with a Docker Hub access token
// exchanged from a Docker ID and a PAT with the `sandbox:use` scope (hub.docker.com/v2/auth/token).
// Commands and files go to the sandbox's own endpoint (`core.endpoint.uri`) with a short-lived
// scoped credential from POST /v1/sandboxes/{id}/endpoint-credentials. OpenAPI at
// docs.docker.com/reference/api/sandboxes/api.yaml; docs docs.docker.com/ai/sandboxes-api/,
// …/concepts.md, …/authentication.md, …/limits.md, …/errors.md,
// docs.docker.com/ai/sandboxes/cloud/usage.md, docker.com/pricing. npm `@docker/sandboxes`,
// CLI `sbx --cloud`. Mutations of a sandbox need its current ETag in If-Match.

import { randomUUID } from "node:crypto";
import { defineProvider, http, httpJson, HttpError } from "./util.js";
import { ENV_FILE, envFileBody, grantCache, inline, pollMs, sleep, withEnvFile } from "./rest-helpers.js";
import type { ProviderContext } from "../core/types.js";

const base = (ctx: ProviderContext) => String(ctx.env["DOCKER_SANDBOXES_API_URL"] ?? "https://connect.docker.com/sandboxes").replace(/\/+$/, "");
const hubAuth = (ctx: ProviderContext) => String(ctx.env["DOCKER_HUB_AUTH_URL"] ?? "https://hub.docker.com/v2/auth/token");
const box = (ctx: ProviderContext, id: string, path = "") => `${base(ctx)}/v1/sandboxes/${encodeURIComponent(id)}${path}`;
const gone = (err: unknown) => err instanceof HttpError && (err.status === 404 || err.status === 410);
const MAX_TTL_SEC = 86_400;

const SIZES = [
  { size: "micro", cpu: 1, memoryMiB: 2048 },
  { size: "small", cpu: 2, memoryMiB: 4096 },
  { size: "medium", cpu: 4, memoryMiB: 8192 },
  { size: "large", cpu: 8, memoryMiB: 16384 },
  { size: "xl", cpu: 16, memoryMiB: 32768 },
];
/** The supported CPU and memory pairs, smallest first: the first that fits the request. */
export function dockerCloudSize(cpu: number, memoryMiB: number) {
  return SIZES.find((s) => s.cpu >= cpu && s.memoryMiB >= memoryMiB) ?? SIZES[SIZES.length - 1]!;
}

interface Sandbox {
  name: string;
  uid?: string;
  core: { status: string; etag: string; endpoint?: { uri?: string } };
  failure?: { code: string; message?: string } | null;
}
const uidOf = (s: Sandbox) => s.uid ?? s.name.replace(/^sandboxes\//, "");

/** The management token, exchanged from the PAT and kept until shortly before it expires. */
const tokens = grantCache<string>();
const management = async (ctx: ProviderContext) => ({
  authorization: `Bearer ${await tokens.get(`${hubAuth(ctx)}|${ctx.env["DOCKER_ID"]}`, async () => {
    const r = await httpJson<{ access_token: string; expires_in?: number }>(hubAuth(ctx), { body: { identifier: ctx.env["DOCKER_ID"], secret: ctx.env["DOCKER_PAT"] } });
    // The answer may not say how long it lives: assume ten minutes.
    return { value: r.access_token, expiresAt: Date.now() + (r.expires_in ?? 600) * 1000 };
  })}`,
});

/** One sandbox's endpoint and a scoped credential for it, renewed before it expires. */
const endpoints = grantCache<{ uri: string; headers: { authorization: string } }>();
const endpoint = (ctx: ProviderContext, id: string) =>
  endpoints.get(`${base(ctx)}|${id}`, async () => {
    const s = await httpJson<Sandbox>(box(ctx, id), { headers: await management(ctx) });
    const uri = s.core.endpoint?.uri;
    if (!uri) throw new Error(`docker sandbox ${id} has no endpoint`);
    const c = await httpJson<{ token: string; expireTime: string }>(box(ctx, id, "/endpoint-credentials"), {
      headers: await management(ctx),
      body: { permissions: ["sandboxesExec", "sandboxesFilesRead", "sandboxesFilesWrite"], ttl: "3600s" },
    });
    const expires = Date.parse(c.expireTime);
    return { value: { uri: uri.replace(/\/+$/, ""), headers: { authorization: `Bearer ${c.token}` } }, expiresAt: Number.isFinite(expires) ? expires : 0 };
  });

async function remove(ctx: ProviderContext, id: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    let etag: string;
    try {
      etag = (await httpJson<Sandbox>(box(ctx, id), { headers: await management(ctx) })).core.etag;
    } catch (err) {
      if (gone(err)) return;
      throw err;
    }
    try {
      await http(`${box(ctx, id)}?force=true`, { method: "DELETE", headers: { ...(await management(ctx)), "if-match": etag, "idempotency-key": randomUUID() } });
      endpoints.drop(`${base(ctx)}|${id}`);
      return;
    } catch (err) {
      if (gone(err)) return;
      // 412: it changed since the read; read its ETag again.
      if (!(err instanceof HttpError && err.status === 412)) throw err;
    }
  }
  throw new Error(`docker sandbox ${id}: delete kept losing to concurrent changes`);
}

export const dockerCloudProvider = defineProvider({
  info: {
    id: "docker-cloud",
    name: "Docker Sandboxes (cloud)",
    homepage: "https://www.docker.com/products/docker-sandboxes/",
    env: ["DOCKER_ID", "DOCKER_PAT"],
    capabilities: ["ports", "pause", "customImage", "fileList", "extendTimeout"],
    isolation: "microvm",
    maxTimeoutSec: MAX_TTL_SEC,
    freeTier: {
      tier: { kind: "one-time-credit", usd: 250 },
      concurrency: 10,
      maxLifetimeSec: MAX_TTL_SEC,
      requiresCard: true,
      notes: "Pay-as-you-go Docker Agentic Platform subscription (payment details at checkout) with a $250 promotional credit; experimental. Default quotas: 10 concurrent and 50 stored sandboxes. TTL at most 24 h from creation.",
      source: "https://www.docker.com/pricing/",
      checked: "2026-11-21",
    },
    // Linear in size: $0.07 per CPU-hour with 2 GiB per CPU included.
    pricing: { vcpuSecondUsd: 0.07 / 3600, gibSecondUsd: 0, defaultCpu: 2, defaultMemoryMiB: 4096, source: "https://www.docker.com/pricing/" },
    surfaces: { rest: "https://connect.docker.com/sandboxes/v1", sdk: ["@docker/sandboxes (npm)"], cli: "sbx --cloud" },
  },

  async create(spec, ctx) {
    const size = dockerCloudSize(spec.cpu, spec.memoryMiB);
    const imageSource = spec.nativeTemplate?.startsWith("images/")
      ? { image: spec.nativeTemplate }
      : { imageRef: spec.nativeTemplate ?? spec.image ?? String(ctx.options["image"] ?? "ubuntu:24.04"), resources: { cpus: size.cpu, memoryMib: size.memoryMiB } };
    const made = await httpJson<Sandbox>(`${base(ctx)}/v1/sandboxes`, {
      headers: { ...(await management(ctx)), "idempotency-key": spec.metadata["sandboxrouting.id"] ?? randomUUID() },
      body: {
        ...imageSource,
        labels: spec.metadata,
        features: { timeouts: { timeout: `${Math.min(MAX_TTL_SEC, Math.max(1, Math.ceil(spec.timeoutSec)))}s`, onTimeout: "delete" } },
      },
      timeoutMs: 120_000,
    });
    const id = uidOf(made);
    try {
      let cur = made;
      for (let i = 0; i < 600 && cur.core.status !== "running"; i++) {
        if (["failed", "deleting", "stopped"].includes(cur.core.status)) throw new Error(`docker sandbox ${id} is ${cur.core.status}${cur.failure ? `: ${cur.failure.code} ${cur.failure.message ?? ""}` : ""}`);
        await sleep(pollMs(ctx, 1000));
        cur = await httpJson<Sandbox>(box(ctx, id), { headers: await management(ctx) });
      }
      if (cur.core.status !== "running") throw new Error(`docker sandbox ${id} did not start`);
      if (Object.keys(spec.env).length) await this.writeFile(id, ENV_FILE, new TextEncoder().encode(envFileBody(spec.env)), ctx);
    } catch (err) {
      await remove(ctx, id).catch(() => undefined);
      throw err;
    }
    return { providerSandboxId: id, cpu: size.cpu, memoryMiB: size.memoryMiB };
  },

  async exec(id, command, o, ctx) {
    // Runs to completion with no timeout of its own; output comes back base64.
    const e = await endpoint(ctx, id);
    const r = await httpJson<{ exitCode?: number; stdout?: string; stderr?: string }>(`${e.uri}/v1/processes/exec`, {
      headers: e.headers,
      body: { cmd: ["sh", "-c", withEnvFile(inline(command, { env: o.env }))], ...(o.cwd ? { workingDir: o.cwd } : {}) },
      timeoutMs: ((o.timeoutSec ?? 3600) + 60) * 1000,
    });
    const stdout = Buffer.from(r.stdout ?? "", "base64").toString("utf8");
    const stderr = Buffer.from(r.stderr ?? "", "base64").toString("utf8");
    if (stdout) o.onStdout?.(stdout);
    if (stderr) o.onStderr?.(stderr);
    return { stdout, stderr, exitCode: r.exitCode ?? 0 };
  },

  async readFile(id, path, ctx) {
    const e = await endpoint(ctx, id);
    return new Uint8Array(await (await http(`${e.uri}/v1/files/content?path=${encodeURIComponent(path)}`, { headers: e.headers })).arrayBuffer());
  },

  async writeFile(id, path, data, ctx) {
    const e = await endpoint(ctx, id);
    await http(`${e.uri}/v1/files/content?path=${encodeURIComponent(path)}`, { method: "PUT", headers: { ...e.headers, "content-type": "application/octet-stream" }, raw: data });
  },

  async listFiles(id, path, ctx) {
    const e = await endpoint(ctx, id);
    const out: { name: string; path: string; isDir: boolean; size?: number }[] = [];
    let token = "";
    do {
      const q = new URLSearchParams({ path, ...(token ? { pageToken: token } : {}) });
      const page: { entries?: { path: string; isDir?: boolean; size?: number | string }[]; nextPageToken?: string } = await httpJson(`${e.uri}/v1/files?${q}`, { headers: e.headers });
      out.push(...(page.entries ?? []).map((f) => ({ name: f.path.split("/").pop() ?? f.path, path: f.path, isDir: !!f.isDir, size: f.size === undefined ? undefined : Number(f.size) })));
      token = page.nextPageToken ?? "";
    } while (token);
    return out;
  },

  async getUrl(id, port, ctx) {
    try {
      return (await httpJson<{ url: string }>(box(ctx, id, "/ports"), { headers: { ...(await management(ctx)), "idempotency-key": randomUUID() }, body: { port: { number: port } } })).url;
    } catch (err) {
      // Already published: read it back.
      if (!(err instanceof HttpError && err.status === 409)) throw err;
      return (await httpJson<{ url: string }>(box(ctx, id, `/ports/${port}`), { headers: await management(ctx) })).url;
    }
  },

  async setTimeout(id, timeoutSec, ctx) {
    // The TTL restarts when accepted; it can't pass 24 h from creation.
    await http(box(ctx, id, "/renew-timeout"), { headers: await management(ctx), body: { timeout: `${Math.max(1, Math.ceil(timeoutSec))}s` } });
  },

  async pause(id, ctx) {
    const etag = (await httpJson<Sandbox>(box(ctx, id), { headers: await management(ctx) })).core.etag;
    await http(box(ctx, id, "/stop"), { headers: { ...(await management(ctx)), "if-match": etag, "idempotency-key": randomUUID() }, body: {} });
  },

  async resume(id, ctx) {
    const etag = (await httpJson<Sandbox>(box(ctx, id), { headers: await management(ctx) })).core.etag;
    await http(box(ctx, id, "/start"), { headers: { ...(await management(ctx)), "if-match": etag, "idempotency-key": randomUUID() }, body: {} });
  },

  async kill(id, ctx) {
    await remove(ctx, id);
  },

  async listAlive(ctx) {
    const ids: string[] = [];
    let token = "";
    do {
      const q = new URLSearchParams(token ? { pageToken: token } : {});
      const page: { sandboxes?: Sandbox[]; nextPageToken?: string } = await httpJson(`${base(ctx)}/v1/sandboxes?${q}`, { headers: await management(ctx) });
      ids.push(...(page.sandboxes ?? []).filter((s) => !["failed", "deleting"].includes(s.core.status)).map(uidOf));
      token = page.nextPageToken ?? "";
    } while (token);
    return ids;
  },
});
