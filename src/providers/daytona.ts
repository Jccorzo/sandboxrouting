// Daytona: containers (VMs and GPUs optional). Free: $200 compute credit, 10 vCPU total on Tier 1.
// Spoken over HTTP, no SDK, with the calls the official SDK (npm `@daytona/sdk`) makes:
// - REST: https://app.daytona.io/api (Bearer), OpenAPI https://www.daytona.io/docs/openapi.json;
// - the toolbox inside each sandbox, at `{toolboxProxyUrl}/{sandboxId}` with the same Bearer key,
//   OpenAPI https://www.daytona.io/docs/toolbox-openapi.json. MCP: `daytona mcp start`.

import { createHash } from "node:crypto";
import { defineProvider, http, httpJson } from "./util.js";
import { pollMs, sleep } from "./rest-helpers.js";
import type { ProviderContext } from "../core/types.js";

/** The SDK labels every sandbox with its code-run language; `python` when none is asked for. */
const LANGUAGE_LABEL = "code-toolbox-language";
/** How long create, start and stop wait for the state they ask for, as the SDK's default (60 s). */
const WAIT_SEC = 60;

interface SandboxDto {
  id: string;
  state?: string;
  errorReason?: string;
  toolboxProxyUrl?: string;
}

const apiUrl = (ctx: ProviderContext) => (ctx.env["DAYTONA_API_URL"] || "https://app.daytona.io/api").replace(/\/+$/, "");
const headers = (ctx: ProviderContext) => ({ Authorization: `Bearer ${ctx.env["DAYTONA_API_KEY"] ?? ""}` });

function api<T>(ctx: ProviderContext, path: string, init: { method?: string; body?: unknown; timeoutMs?: number } = {}): Promise<T> {
  return httpJson<T>(`${apiUrl(ctx)}${path}`, { ...init, headers: headers(ctx), timeoutMs: init.timeoutMs ?? 60_000 });
}

/**
 * Toolbox base URL per sandbox: it doesn't change while the sandbox lives. Keyed by the control
 * plane and a hash of the key as well as the sandbox, so a process serving several people (the
 * hosted router) never hands one key's answer to a caller with another key.
 */
const toolboxes = new Map<string, string>();
const toolboxKey = (id: string, ctx: ProviderContext) =>
  `${apiUrl(ctx)}\0${createHash("sha256").update(ctx.env["DAYTONA_API_KEY"] ?? "").digest("hex")}\0${id}`;

async function toolbox(id: string, ctx: ProviderContext, dto?: SandboxDto): Promise<string> {
  const key = toolboxKey(id, ctx);
  const hit = toolboxes.get(key);
  if (hit) return hit;
  const proxy = dto?.toolboxProxyUrl ?? (await api<{ url: string }>(ctx, `/sandbox/${encodeURIComponent(id)}/toolbox-proxy-url`)).url;
  const base = `${proxy.replace(/\/+$/, "")}/${id}`;
  toolboxes.set(key, base);
  return base;
}

/** Polls the sandbox until it reaches one of `want`; `failed` states and the deadline throw. */
async function waitFor(id: string, ctx: ProviderContext, want: string[], dto?: SandboxDto): Promise<SandboxDto> {
  const failed = ["error", "build_failed"];
  const deadline = Date.now() + WAIT_SEC * 1000;
  let s = dto ?? (await api<SandboxDto>(ctx, `/sandbox/${encodeURIComponent(id)}`));
  while (!want.includes(s.state ?? "")) {
    if (failed.includes(s.state ?? "")) throw new Error(`daytona sandbox ${id} is ${s.state}${s.errorReason ? `: ${s.errorReason}` : ""}`);
    if (Date.now() > deadline) throw new Error(`daytona sandbox ${id} did not become ${want.join(" or ")} within ${WAIT_SEC} s (state ${s.state})`);
    await sleep(pollMs(ctx, 1000));
    s = await api<SandboxDto>(ctx, `/sandbox/${encodeURIComponent(id)}`);
  }
  return s;
}

export const daytonaProvider = defineProvider({
  info: {
    id: "daytona",
    name: "Daytona",
    homepage: "https://www.daytona.io",
    env: ["DAYTONA_API_KEY"],
    capabilities: ["customImage", "ports", "fileList", "extendTimeout", "pause", "gpu"],
    isolation: "container",
    freeTier: {
      // The pricing page does not say whether the $200 recurs; treated as one-time.
      tier: { kind: "one-time-credit", usd: 200 },
      concurrency: 10,
      requiresCard: false,
      notes: "$200 compute credit (no GPU). Tier 1: 10 vCPU total. Max 4 vCPU / 8 GiB per sandbox.",
      source: "https://www.daytona.io/pricing",
      checked: "2026-11-11",
    },
    pricing: {
      vcpuSecondUsd: 0.0504 / 3600,
      gibSecondUsd: 0.0162 / 3600,
      defaultCpu: 1,
      defaultMemoryMiB: 1024,
      source: "https://www.daytona.io/pricing",
    },
    surfaces: { rest: "https://app.daytona.io/api", sdk: ["@daytona/sdk (npm)", "daytona (PyPI)"], cli: "daytona", mcp: "daytona mcp start" },
  },

  async create(spec, ctx) {
    const custom = !spec.nativeTemplate && spec.image;
    const dto = await api<SandboxDto>(ctx, "/sandbox", {
      method: "POST",
      body: {
        snapshot: spec.nativeTemplate,
        // An image by name is built from a one-line Dockerfile, as the SDK's Image.base does.
        buildInfo: custom ? { dockerfileContent: `FROM ${spec.image}\n` } : undefined,
        env: spec.env,
        labels: { ...spec.metadata, [LANGUAGE_LABEL]: "python" },
        target: spec.region ?? ctx.env["DAYTONA_TARGET"],
        cpu: custom ? Math.ceil(spec.cpu) : undefined,
        memory: custom ? Math.max(1, Math.round(spec.memoryMiB / 1024)) : undefined,
        // Wall-clock TTL: destroyed when it elapses, matching the router's deadline.
        ttlMinutes: Math.max(1, Math.ceil(spec.timeoutSec / 60)),
        autoStopInterval: 0,
        // Ephemeral: deleted as soon as it stops.
        autoDeleteInterval: 0,
      },
      timeoutMs: WAIT_SEC * 1000,
    });
    await toolbox(dto.id, ctx, dto);
    await waitFor(dto.id, ctx, ["started"], dto);
    return { providerSandboxId: dto.id };
  },

  async exec(id, command, o, ctx) {
    const base = await toolbox(id, ctx);
    const r = await httpJson<{ exitCode?: number; code?: number; result?: string }>(`${base}/process/execute`, {
      method: "POST",
      headers: headers(ctx),
      body: { command, timeout: o.timeoutSec, cwd: o.cwd, envs: o.env && Object.keys(o.env).length ? o.env : undefined },
      // The SDK waits the command's own timeout plus a margin; with none, the toolbox's.
      timeoutMs: o.timeoutSec ? o.timeoutSec * 1000 + 30_000 : 3600_000,
    });
    // Daytona returns stdout and stderr combined.
    const result = r.result ?? "";
    o.onStdout?.(result);
    return { stdout: result, stderr: "", exitCode: r.exitCode ?? r.code ?? 0 };
  },

  async readFile(id, path, ctx) {
    const base = await toolbox(id, ctx);
    const res = await http(`${base}/files/download?${new URLSearchParams({ path })}`, { headers: headers(ctx), timeoutMs: 30 * 60_000 });
    return new Uint8Array(await res.arrayBuffer());
  },

  async writeFile(id, path, data, ctx) {
    const base = await toolbox(id, ctx);
    const form = new FormData();
    form.append("files[0].path", path);
    form.append("files[0].file", new Blob([data.slice()]), path);
    await http(`${base}/files/bulk-upload`, { method: "POST", headers: headers(ctx), raw: form, timeoutMs: 30 * 60_000 });
  },

  async listFiles(id, path, ctx) {
    const base = await toolbox(id, ctx);
    const items = await httpJson<{ name: string; isDir?: boolean; size?: number }[]>(`${base}/files?${new URLSearchParams({ path })}`, { headers: headers(ctx), timeoutMs: 60_000 });
    const dir = path.endsWith("/") ? path : `${path}/`;
    return items.map((f) => ({ name: f.name, path: `${dir}${f.name}`, isDir: Boolean(f.isDir), size: f.size }));
  },

  async getUrl(id, port, ctx) {
    return (await api<{ url: string }>(ctx, `/sandbox/${encodeURIComponent(id)}/ports/${port}/preview-url`)).url;
  },

  async setTimeout(id, _timeoutSec, ctx) {
    // ttlMinutes is fixed at create; keep it alive by refreshing activity instead.
    await api(ctx, `/sandbox/${encodeURIComponent(id)}/last-activity`, { method: "POST" });
  },

  async pause(id, ctx) {
    await api(ctx, `/sandbox/${encodeURIComponent(id)}/stop`, { method: "POST", timeoutMs: WAIT_SEC * 1000 });
    // An ephemeral sandbox may be deleted as it stops; destroyed counts as stopped.
    await waitFor(id, ctx, ["stopped", "destroyed"]);
  },

  async resume(id, ctx) {
    const dto = await api<SandboxDto>(ctx, `/sandbox/${encodeURIComponent(id)}/start`, { method: "POST", timeoutMs: WAIT_SEC * 1000 });
    await waitFor(id, ctx, ["started"], dto?.state ? dto : undefined);
  },

  async kill(id, ctx) {
    toolboxes.delete(toolboxKey(id, ctx));
    await api(ctx, `/sandbox/${encodeURIComponent(id)}`, { method: "DELETE", timeoutMs: WAIT_SEC * 1000 });
  },

  async listAlive(ctx) {
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await api<{ items: SandboxDto[]; nextCursor?: string | null }>(ctx, `/sandbox${cursor ? `?${new URLSearchParams({ cursor })}` : ""}`);
      for (const s of page.items) if (s.state === "started" || s.state === "starting" || s.state === "stopped") ids.push(s.id);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return ids;
  },
});
