// Morph Cloud: VMs booted from snapshots (memory included), with branching. Its official pages
// disagree on free usage (Developer plan "300 MCU starting credit" vs Free "0 starting
// MCUs"), so it is treated as having none; set `providers.morph.freeTier` if your account
// has the credit. Spoken over HTTP, no SDK: REST at https://cloud.morph.so/api (Bearer key), docs
// https://cloud.morph.so/docs/api-reference, with the calls the official SDK (npm `morphcloud`
// 0.0.20, Apache-2.0) makes; commands go through its HTTP exec endpoints, not SSH. MORPH_BASE_URL
// overrides the base URL, as it does for the SDK. CLI: `morphcloud`.

import { defineProvider, http, httpJson, shArgv } from "./util.js";
import { pollMs, sleep } from "./rest-helpers.js";
import type { ProviderContext } from "../core/types.js";

/** The SDK's request timeouts: 10 minutes, and 24 hours for exec when the call names none. */
const API_MS = 600_000;
const EXEC_MS = 24 * 3600_000;

interface Instance {
  id: string;
  status: string;
  spec: { vcpus: number; memory: number; disk_size?: number };
  networking?: { http_services?: { name: string; port: number; url: string }[] };
}

const apiUrl = (ctx: ProviderContext) => (ctx.env["MORPH_BASE_URL"] || "https://cloud.morph.so/api").replace(/\/+$/, "");
const headers = (ctx: ProviderContext) => ({ Authorization: `Bearer ${ctx.env["MORPH_API_KEY"] ?? ""}`, Accept: "application/json" });
const box = (id: string, path = "") => `/instance/${encodeURIComponent(id)}${path}`;

function api<T>(ctx: ProviderContext, path: string, init: { method?: string; body?: unknown; timeoutMs?: number } = {}): Promise<T> {
  return httpJson<T>(`${apiUrl(ctx)}${path}`, { ...init, headers: headers(ctx), timeoutMs: init.timeoutMs ?? API_MS });
}
const getInstance = (ctx: ProviderContext, id: string) => api<Instance>(ctx, box(id));

/** size key → snapshot id; Morph dedupes by digest too, this saves the round trip. */
const snapshots = new Map<string, Promise<string>>();

/**
 * Polls until the instance is ready, as the SDK's `instances.start` does: without a deadline,
 * failing only on `error`.
 */
async function untilReady(ctx: ProviderContext, inst: Instance): Promise<Instance> {
  while (inst.status !== "ready") {
    await sleep(pollMs(ctx, 1000));
    inst = await getInstance(ctx, inst.id);
    if (inst.status === "error") throw new Error(`morph: instance ${inst.id} encountered an error`);
  }
  return inst;
}

/** The SDK's message for a command that ran out of time (its timeout is the request's). */
function timedOut(err: unknown, timeoutSec: number | undefined): unknown {
  const name = (err as Error | undefined)?.name;
  if (name !== "TimeoutError" && name !== "AbortError") return err;
  return new Error(`Command execution timed out after ${timeoutSec ? `${timeoutSec} ${timeoutSec === 1 ? "second" : "seconds"}` : "24 hours"}`, { cause: err });
}

interface ExecEvent {
  type?: string;
  content?: string | number;
}

/**
 * The streaming exec: an event stream of `data: {"type": "stdout"|"stderr"|"exit_code",
 * "content": …}` lines, read line by line like the SDK does. A stream that ends without an
 * exit code reads as 0, as in the SDK.
 */
async function execStreaming(
  ctx: ProviderContext,
  id: string,
  command: string[],
  timeoutMs: number,
  onStdout?: (chunk: string) => void,
  onStderr?: (chunk: string) => void,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const res = await http(`${apiUrl(ctx)}${box(id, "/exec/sse")}`, {
    method: "POST",
    headers: { ...headers(ctx), Accept: "text/event-stream" },
    body: { command },
    timeoutMs,
  });
  const out: string[] = [];
  const err: string[] = [];
  let exitCode = 0;
  // As in the SDK, a callback that throws is reported and the stream goes on.
  const emit = (cb: ((chunk: string) => void) | undefined, chunk: string) => {
    try {
      cb?.(chunk);
    } catch (e) {
      console.warn("morph: an output callback threw:", e);
    }
  };
  const line = (l: string) => {
    if (!l.startsWith("data: ")) return;
    let ev: ExecEvent;
    try {
      ev = JSON.parse(l.slice(6)) as ExecEvent;
    } catch {
      return; // the SDK skips malformed events
    }
    const content = ev.content === undefined ? "" : String(ev.content);
    if (ev.type === "stdout") {
      out.push(content);
      emit(onStdout, content);
    } else if (ev.type === "stderr") {
      err.push(content);
      emit(onStderr, content);
    } else if (ev.type === "exit_code") exitCode = parseInt(content, 10);
  };
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    lines.forEach(line);
  }
  line(buf + decoder.decode());
  return { stdout: out.join(""), stderr: err.join(""), exitCode };
}

export const morphProvider = defineProvider({
  info: {
    id: "morph",
    name: "Morph Cloud",
    homepage: "https://cloud.morph.so",
    env: ["MORPH_API_KEY"],
    capabilities: ["ports", "pause", "snapshot", "extendTimeout"],
    isolation: "vm",
    freeTier: {
      tier: { kind: "none" },
      concurrency: 8,
      notes: "Official pages conflict (300 MCU starting credit vs 0); override freeTier if your account has it.",
      source: "https://cloud.morph.so/docs/documentation/setup/plans",
      checked: "2026-11-11",
    },
    // $0.05 per MCU; an MCU is 1 vCPU-hour or 4 GB-hours, billed as the larger of the two.
    pricing: { vcpuSecondUsd: 0.05 / 3600, gibSecondUsd: 0, defaultCpu: 1, defaultMemoryMiB: 4096, source: "https://cloud.morph.so/docs/documentation/setup/plans" },
    surfaces: { rest: "https://cloud.morph.so/api", sdk: ["morphcloud (npm)", "morphcloud (PyPI)"], cli: "morphcloud" },
  },

  async create(spec, ctx) {
    let snapshotId = spec.nativeTemplate;
    if (!snapshotId) {
      const vcpus = Math.max(1, Math.round(spec.cpu));
      const memory = Math.max(1024, spec.memoryMiB);
      const imageId = String(ctx.options["imageId"] ?? "morphvm-minimal");
      const key = `${imageId}:${vcpus}:${memory}`;
      let pending = snapshots.get(key);
      if (!pending) {
        const body = {
          image_id: imageId,
          vcpus,
          memory,
          disk_size: Number(ctx.options["diskSizeMiB"] ?? 8192),
          digest: `sbr-${key}`,
          // What the SDK sends with every snapshot it creates.
          readiness_check: { type: "timeout", timeout: 10.0 },
          metadata: {},
        };
        pending = api<{ id: string }>(ctx, "/snapshot", { method: "POST", body }).then((s) => s.id);
        snapshots.set(key, pending);
        pending.catch(() => snapshots.delete(key));
      }
      snapshotId = await pending;
    }
    const started = await api<Instance>(ctx, `/instance?${new URLSearchParams({ snapshot_id: snapshotId })}`, {
      method: "POST",
      body: { metadata: spec.metadata, ttl_seconds: spec.timeoutSec, ttl_action: "stop" },
    });
    let inst: Instance;
    try {
      inst = await untilReady(ctx, started);
    } catch (err) {
      // The SDK stops an instance that never became ready, then rethrows.
      await api(ctx, box(started.id), { method: "DELETE" }).catch(() => undefined);
      throw err;
    }
    return { providerSandboxId: inst.id, cpu: inst.spec.vcpus, memoryMiB: inst.spec.memory };
  },

  async exec(id, command, o, ctx) {
    const argv = shArgv(command, o);
    const timeoutMs = o.timeoutSec ? o.timeoutSec * 1000 : EXEC_MS;
    try {
      // The SDK streams only when asked for output as it comes.
      if (o.onStdout || o.onStderr) return await execStreaming(ctx, id, argv, timeoutMs, o.onStdout, o.onStderr);
      const r = await api<{ exit_code: number; stdout: string; stderr: string }>(ctx, box(id, "/exec"), { method: "POST", body: { command: argv }, timeoutMs });
      return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exit_code };
    } catch (err) {
      throw timedOut(err, o.timeoutSec);
    }
  },

  async getUrl(id, port, ctx) {
    const name = `p${port}`;
    await api(ctx, box(id, "/http"), { method: "POST", body: { name, port } });
    const service = (await getInstance(ctx, id)).networking?.http_services?.find((s) => s.name === name);
    if (!service) throw new Error("morph: failed to expose HTTP service");
    return service.url;
  },

  async setTimeout(id, timeoutSec, ctx) {
    await api(ctx, box(id, "/ttl"), { method: "POST", body: { ttl_seconds: timeoutSec, ttl_action: "stop" } });
  },

  async pause(id, ctx) {
    await api(ctx, box(id, "/pause"), { method: "POST" });
  },

  async resume(id, ctx) {
    await api(ctx, box(id, "/resume"), { method: "POST" });
  },

  async kill(id, ctx) {
    await api(ctx, box(id), { method: "DELETE" });
  },

  async listAlive(ctx) {
    const res = await api<{ data: Instance[] }>(ctx, "/instance");
    return res.data.filter((i) => String(i.status).toLowerCase() !== "stopped").map((i) => i.id);
  },
});
