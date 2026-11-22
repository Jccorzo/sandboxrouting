// Together Code Sandbox (formerly the CodeSandbox SDK): Firecracker VMs that boot from a
// snapshot. The new SDK is on Together's custom plans (no self-serve free tier); the legacy
// CodeSandbox Build plan had free credits but that SDK is deprecated.
// Spoken over HTTP, no SDK, with the calls the official SDK (npm `together-sandbox` 4.1.1, MIT) makes:
// - the management API, https://api.bartender.codesandbox.io/v1 (Bearer TOGETHER_API_KEY), OpenAPI
//   https://github.com/togethercomputer/together-sandbox/blob/main/api-openapi.json;
// - the agent inside each running sandbox, at its `agent.url` with its `agent.token` (Bearer), OpenAPI
//   https://github.com/togethercomputer/together-sandbox/blob/main/sandbox-openapi.json. Commands
//   run as execs whose output is a Server-Sent Events stream;
// - the image builder (`builder.` in place of `api.bartender.`), which turns an image into a snapshot.
// Docs: https://docs.together.ai/docs/together-code-sandbox. TOGETHER_BASE_URL overrides the API
// host, as it does for the SDK. CLI: `together-sandbox`.

import { createHash, randomUUID } from "node:crypto";
import { defineProvider, http, httpJson, HttpError } from "./util.js";
import { pollMs, sleep, sse } from "./rest-helpers.js";
import { tarGz } from "./vercel.js";
import { SandboxRouterError } from "../core/errors.js";
import type { ProviderContext } from "../core/types.js";

const API = "https://api.bartender.codesandbox.io";
/** An exec stream has no deadline in the SDK; this only bounds a hung connection. */
const NO_EXEC_TIMEOUT_MS = 24 * 3600 * 1000;
/** The SDK reconnects a dropped exec stream without limit; this caps it. */
const STREAM_ATTEMPTS = 5;
/** Statuses the SDK retries a call on (up to three attempts), besides a failed connection. */
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

interface SandboxDto {
  id: string;
  status?: string;
  status_reason?: string | null;
  agent?: { url?: string | null; token?: string | null };
}

interface Agent {
  url: string;
  token: string;
}

const baseUrl = (ctx: ProviderContext) => (ctx.env["TOGETHER_BASE_URL"] || API).replace(/\/+$/, "");
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const keyHeaders = (ctx: ProviderContext) => bearer(ctx.env["TOGETHER_API_KEY"] ?? "");

/**
 * The SDK's retry: three attempts, backing off from 500 ms with jitter, on a failed connection
 * or a retryable status (or on any error, for the image builder's own calls).
 */
async function retrying<T>(ctx: ProviderContext, fn: () => Promise<T>, retryAny = false): Promise<T> {
  const base = pollMs(ctx, 500);
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const retryable = retryAny || !(err instanceof HttpError) || RETRYABLE.has(err.status);
      if (attempt >= 3 || !retryable) throw err;
      await sleep(base * 2 ** (attempt - 1) + Math.random() * (base / 2));
    }
  }
}

function api<T>(ctx: ProviderContext, path: string, init: { method?: string; body?: unknown; timeoutMs?: number } = {}): Promise<T> {
  return retrying(ctx, () => httpJson<T>(`${baseUrl(ctx)}/v1${path}`, { ...init, headers: keyHeaders(ctx), timeoutMs: init.timeoutMs ?? 120_000 }));
}

const sbxPath = (id: string) => `/sandboxes/${encodeURIComponent(id)}`;
/** Holds until the sandbox settles; the SDK waits on it without a deadline of its own. */
const waitFor = (id: string, ctx: ProviderContext) => api<SandboxDto>(ctx, `${sbxPath(id)}/wait`, { method: "POST", timeoutMs: 300_000 });

/** The SDK's lifecycle error: what the sandbox ended up as, and why. */
function lifecycleError(s: SandboxDto, expected: "running" | "terminated"): Error {
  const reason = s.status_reason ? ` (status_reason: '${s.status_reason}')` : "";
  return new Error(`together sandbox '${s.id}' is ${s.status ?? "<unknown>"}${reason}, expected '${expected}'`);
}

/** Agent connection per sandbox, kept while the process lives, as the SDK's connected Sandbox is. */
const agents = new Map<string, Agent>();

/** Waits out a starting sandbox, then keeps its agent's URL and token. */
async function connect(dto: SandboxDto, ctx: ProviderContext): Promise<Agent> {
  const s = dto.status === "starting" || dto.status === "terminating" ? await waitFor(dto.id, ctx) : dto;
  if (s.status !== "running") throw lifecycleError(s, "running");
  if (!s.agent?.url || !s.agent.token) throw new Error("Sandbox has no agent connection details");
  const agent = { url: s.agent.url.replace(/\/+$/, ""), token: s.agent.token };
  agents.set(dto.id, agent);
  return agent;
}

async function agent(id: string, ctx: ProviderContext): Promise<Agent> {
  return agents.get(id) ?? connect(await api<SandboxDto>(ctx, sbxPath(id)), ctx);
}

const filePath = (a: Agent, kind: "files" | "directories", path: string) => `${a.url}/api/v1/${kind}/${encodeURIComponent(path)}`;

/** A `text/event-stream` body, with each event's `id:` kept so a dropped stream can resume. */
async function* events(body: AsyncIterable<Uint8Array>): AsyncGenerator<{ id?: string; data: string }> {
  const decoder = new TextDecoder();
  let buffer = "";
  const parse = (block: string) => {
    let id: string | undefined;
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("data:")) data.push(line.replace(/^data:\s*/, ""));
      else if (line.startsWith("id:")) id = line.replace(/^id:\s*/, "");
    }
    return { id, data: data.length ? data.join("\n") : undefined };
  };
  for await (const chunk of body) {
    buffer = (buffer + decoder.decode(chunk, { stream: true })).replace(/\r\n/g, "\n");
    let end: number;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const ev = parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 2);
      if (ev.data !== undefined) yield { id: ev.id, data: ev.data };
    }
  }
}

/** image → snapshot id, so each image is built once per process. */
const imageSnapshots = new Map<string, Promise<string>>();

/**
 * Builds a snapshot from an image as the SDK does: a build context holding only `FROM <image>`
 * goes to the image builder, whose log stream ends with `{"done": true}`; the image it pushed is
 * registered as a snapshot and given `alias`.
 */
async function snapshotFromImage(image: string, alias: string, ctx: ProviderContext): Promise<string> {
  const builder = baseUrl(ctx).replace("api.bartender.", "builder.");
  const auth = keyHeaders(ctx);
  const context = tarGz("Dockerfile", new TextEncoder().encode(`FROM ${image}\n`));
  // A fresh name per build, so concurrent builds can't collide.
  const imageName = `image-${randomUUID().toLowerCase()}:${randomUUID().toLowerCase()}`;
  const submitted = await retrying(
    ctx,
    () => {
      const form = new FormData();
      form.append("image_name", imageName);
      form.append("dockerfile", "Dockerfile");
      form.append("build_args", "{}");
      form.append("nydus_convert", "true");
      form.append("context", new Blob([new Uint8Array(context)], { type: "application/gzip" }), "context.tar.gz");
      return httpJson<{ build_id?: string }>(`${builder}/builds`, { method: "POST", headers: auth, raw: form, timeoutMs: 600_000 });
    },
    true,
  );
  const buildId = submitted.build_id;
  if (!buildId) throw new Error(`No build_id in response: ${JSON.stringify(submitted)}`);
  await followBuild(`${builder}/builds/${encodeURIComponent(buildId)}`, buildId, ctx);
  const status = await retrying(ctx, () => httpJson<{ image_ref?: string }>(`${builder}/builds/${encodeURIComponent(buildId)}`, { headers: auth }), true);
  if (!status.image_ref) throw new Error(`Build succeeded but no image_ref in status: ${JSON.stringify(status)}`);
  const arch = ctx.env["TOGETHER_REMOTE_ARCHITECTURE"] || "amd64";
  if (arch !== "amd64" && arch !== "arm64") throw new Error(`Invalid TOGETHER_REMOTE_ARCHITECTURE=${JSON.stringify(arch)}; expected one of: ["amd64","arm64"]`);
  const snapshot = await api<{ id: string }>(ctx, "/snapshots", { method: "POST", body: { image: status.image_ref, architecture: arch } });
  await api(ctx, `/snapshots/${encodeURIComponent(snapshot.id)}/aliases`, { method: "POST", body: { alias } });
  return snapshot.id;
}

/**
 * Reads a build's log stream until it reports done. A stream that closes early is reopened (big
 * builds take long); 404 (the build pod isn't up yet) and retryable statuses are retried 5 times.
 */
async function followBuild(build: string, buildId: string, ctx: ProviderContext): Promise<void> {
  for (let attempt = 1; ; ) {
    try {
      const res = await http(`${build}/logs`, { headers: { ...keyHeaders(ctx), Accept: "text/event-stream" }, timeoutMs: NO_EXEC_TIMEOUT_MS });
      for await (const ev of sse(res.body as unknown as AsyncIterable<Uint8Array>)) {
        if (ev.event !== "message" || !ev.data.startsWith("{") || !/"(done|error)"/.test(ev.data)) continue;
        let msg: { done?: boolean; error?: string };
        try {
          msg = JSON.parse(ev.data) as typeof msg;
        } catch {
          continue;
        }
        if (msg.done) return;
        if (msg.error) throw new SandboxRouterError("invalid", `Build ${buildId} failed: ${msg.error}`, "together");
      }
      attempt = 1;
    } catch (err) {
      if (err instanceof SandboxRouterError) throw err;
      if (err instanceof HttpError) {
        if (!(RETRYABLE.has(err.status) || err.status === 404) || attempt >= 5) throw err;
        attempt++;
      } else attempt = 1; // the connection dropped: the stream ended
    }
    await sleep(pollMs(ctx, 1000));
  }
}

export const togetherProvider = defineProvider({
  info: {
    id: "together",
    name: "Together Code Sandbox",
    homepage: "https://docs.together.ai/docs/together-code-sandbox",
    env: ["TOGETHER_API_KEY"],
    capabilities: ["customImage", "fileList", "snapshot"],
    isolation: "microvm",
    freeTier: {
      tier: { kind: "none" },
      notes: "Available on Together's custom plans; no self-serve free usage for the new SDK.",
      source: "https://docs.together.ai/docs/together-code-sandbox",
      checked: "2026-11-11",
    },
    // $0.01486 per credit; works out to $0.0446/vCPU-h + $0.0149/GiB-h.
    pricing: { vcpuSecondUsd: 0.0446 / 3600, gibSecondUsd: 0.0149 / 3600, defaultCpu: 1, defaultMemoryMiB: 2048, source: "https://docs.together.ai/docs/together-code-sandbox" },
    surfaces: { rest: "https://api.bartender.codesandbox.io", sdk: ["together-sandbox (npm)", "together-sandbox (PyPI)"], cli: "together-sandbox" },
  },

  async create(spec, ctx) {
    let snapshot: { snapshot_id?: string; snapshot_alias?: string };
    const alias = spec.nativeTemplate ?? (ctx.options["snapshot"] as string | undefined);
    if (alias) snapshot = { snapshot_alias: alias };
    else {
      const image = spec.image ?? String(ctx.options["image"] ?? "python:3.12-slim");
      let pending = imageSnapshots.get(image);
      if (!pending) {
        pending = snapshotFromImage(image, `sbr-${createHash("sha256").update(image).digest("hex").slice(0, 12)}`, ctx);
        imageSnapshots.set(image, pending);
        pending.catch(() => imageSnapshots.delete(image));
      }
      snapshot = { snapshot_id: await pending };
    }
    const dto = await api<SandboxDto>(ctx, "/sandboxes", {
      method: "POST",
      body: {
        ...snapshot,
        cpu: spec.cpu,
        memory_bytes: Math.max(1024, spec.memoryMiB) * 1024 * 1024,
        ttl: spec.timeoutSec,
        tags: spec.metadata,
      },
    });
    // The SDK hands back a sandbox only once it runs.
    await connect(dto, ctx);
    return { providerSandboxId: dto.id };
  },

  async exec(id, command, o, ctx) {
    const a = await agent(id, ctx);
    const exec = await retrying(ctx, () =>
      httpJson<{ id: string }>(`${a.url}/api/v1/execs`, { method: "POST", headers: bearer(a.token), body: { cwd: o.cwd, env: o.env, command: "sh", args: ["-c", command], autostart: true } }),
    );
    // Output comes back merged into one stream, as the SDK returns it; it ends with the exit code.
    let output = "";
    let lastId: string | undefined;
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await http(`${a.url}/api/v1/stream/execs/${encodeURIComponent(exec.id)}/io`, {
          headers: { ...bearer(a.token), ...(lastId !== undefined ? { "Last-Event-ID": lastId } : {}) },
          timeoutMs: NO_EXEC_TIMEOUT_MS,
        });
        for await (const ev of events(res.body as unknown as AsyncIterable<Uint8Array>)) {
          if (ev.id !== undefined) lastId = ev.id;
          let msg: { output?: unknown; exitCode?: unknown };
          try {
            msg = JSON.parse(ev.data) as typeof msg;
          } catch {
            continue;
          }
          if (typeof msg.output === "string" && msg.output) {
            output += msg.output;
            o.onStdout?.(msg.output);
          }
          if (typeof msg.exitCode === "number") return { stdout: output, stderr: "", exitCode: msg.exitCode };
        }
        break;
      } catch (err) {
        // A refusal won't change on reconnecting; a dropped connection or a busy server might.
        const final = err instanceof HttpError && err.status < 500 && !RETRYABLE.has(err.status);
        if (final || attempt >= STREAM_ATTEMPTS) throw err;
        await sleep(Math.min(pollMs(ctx, 3000) * 2 ** (attempt - 1), 30_000));
      }
    }
    throw new Error("exec(sh) stream ended without an exit code — the process may have been killed externally or the sandbox shut down");
  },

  async readFile(id, path, ctx) {
    const a = await agent(id, ctx);
    const r = await retrying(ctx, () => httpJson<{ content: string; encoding?: string }>(filePath(a, "files", path), { headers: bearer(a.token), timeoutMs: 600_000 }));
    // The agent sends a file that isn't UTF-8 text as base64.
    return r.encoding === "base64" ? new Uint8Array(Buffer.from(r.content, "base64")) : new TextEncoder().encode(r.content);
  },

  async writeFile(id, path, data, ctx) {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(data);
    } catch {
      throw new SandboxRouterError("unsupported", "binary write", "together"); // exec fallback
    }
    const a = await agent(id, ctx);
    await retrying(ctx, () =>
      http(filePath(a, "files", path), { method: "POST", headers: { ...bearer(a.token), "content-type": "application/octet-stream" }, raw: data.slice(), timeoutMs: 600_000 }),
    );
  },

  async listFiles(id, path, ctx) {
    const a = await agent(id, ctx);
    const r = await retrying(ctx, () =>
      httpJson<{ files: { name: string; path: string; isDir: boolean; size: number }[] }>(filePath(a, "directories", path), { headers: bearer(a.token), timeoutMs: 120_000 }),
    );
    return r.files.map((f) => ({ name: f.name, path: f.path, isDir: f.isDir, size: f.size }));
  },

  async kill(id, ctx) {
    agents.delete(id);
    await api(ctx, `${sbxPath(id)}/terminate`, { method: "POST", body: {} });
    const s = await waitFor(id, ctx);
    if (s.status !== "terminated") throw lifecycleError(s, "terminated");
  },

  async listAlive(ctx) {
    const ids: string[] = [];
    let cursor: string | null | undefined;
    do {
      const q = new URLSearchParams({ limit: "100", ...(cursor ? { cursor } : {}) });
      const page = await api<{ data: { id: string }[]; next_cursor?: string | null }>(ctx, `/sandboxes?${q}`);
      ids.push(...page.data.map((s) => s.id));
      cursor = page.next_cursor;
    } while (cursor);
    return ids;
  },
});
