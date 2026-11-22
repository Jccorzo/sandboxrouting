// Depot Sandboxes: ephemeral microVMs next to Depot CI. No permanent free tier (a 7-day
// trial; the Developer plan is $20/month with 2,000 minutes at 2 vCPU). CPU-only billing.
// The SDK reference still says private beta in places; the pricing page lists it on every plan.
//
// API: the Connect service depot.sandbox.v1.SandboxService at https://api.depot.dev, with a
// Bearer token, spoken here with the JSON codec as the calls the official SDK (npm
// `@depot/sandbox` 0.1.0-beta.7, MIT, https://github.com/depot/sandbox-sdk) makes. Docs:
// https://depot.dev/docs/sandboxes. DEPOT_API_URL points it elsewhere (the SDK's `endpoint`).

import { connectError, connectStream, connectUnary, type ConnectError } from "./connect-rpc.js";
import { defineProvider, http } from "./util.js";
import type { ProviderContext } from "../core/types.js";

const DEFAULT_ENDPOINT = "https://api.depot.dev";
const SERVICE = "depot.sandbox.v1.SandboxService";
/** WriteFile data chunks: under the server's 4 MiB message limit, as the SDK sends them. */
const WRITE_CHUNK_BYTES = 4 * 1024 * 1024 - 64 * 1024;
/** A command with no timeout still needs a deadline: the longest a sandbox lives. */
const NO_EXEC_TIMEOUT_MS = 24 * 3600 * 1000;
/** Sandbox statuses after which nothing runs (the SDK's lowercased SandboxStatus names). */
const ENDED = ["finished", "cancelled", "failed"];

interface SandboxProto {
  sandboxId: string;
  status?: string | number;
  resources?: { vcpus?: number; memoryMb?: number };
}

/** RunCommand stream events (proto3 JSON: bytes are base64, int64 a string, zero values left out). */
interface CommandEvent {
  started?: { cmdId?: string };
  stdout?: { data?: string };
  stderr?: { data?: string };
  finished?: { exitCode?: number };
  error?: { reason?: string };
  evicted?: Record<string, unknown>;
}

const endpoint = (ctx: ProviderContext) => (ctx.env["DEPOT_API_URL"] || DEFAULT_ENDPOINT).replace(/\/+$/, "");
// The SDK sends whatever token it was given; the router passes DEPOT_TOKEN as is.
const headers = (ctx: ProviderContext) => ({ Authorization: `Bearer ${String(ctx.env["DEPOT_TOKEN"])}` });
const ref = (id: string) => ({ sandbox: { id } });

function rpc<T>(ctx: ProviderContext, method: string, request: unknown, timeoutMs = 60_000): Promise<T> {
  return connectUnary<T>(endpoint(ctx), `${SERVICE}/${method}`, request, { headers: headers(ctx), timeoutMs });
}

/** The SDK's status strings: the proto enum name, lowercased, without its prefix. Unknown ones are undefined. */
export function depotStatus(status: string | number | undefined): string | undefined {
  if (typeof status !== "string" || !status.startsWith("SANDBOX_STATUS_") || status === "SANDBOX_STATUS_UNSPECIFIED") return undefined;
  return status.slice("SANDBOX_STATUS_".length).toLowerCase();
}

function envelope(message: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(message));
  const head = Buffer.alloc(5);
  head.writeUInt32BE(json.length, 1);
  return Buffer.concat([head, json]);
}

/**
 * A client-streaming call (WriteFile): every request envelope goes in one body, then the reply
 * comes back as a message envelope and an end-of-stream one. Connect runs client streams over
 * HTTP/1.1 (only bidi streams need HTTP/2), so fetch can carry it once the data is all in hand.
 */
async function connectClientStream(ctx: ProviderContext, method: string, requests: unknown[], timeoutMs: number): Promise<void> {
  const res = await http(`${endpoint(ctx)}/${SERVICE}/${method}`, {
    method: "POST",
    headers: { ...headers(ctx), "content-type": "application/connect+json", "connect-protocol-version": "1", "connect-timeout-ms": String(timeoutMs) },
    raw: Buffer.concat(requests.map(envelope)),
    timeoutMs: timeoutMs + 5_000,
  });
  const body = Buffer.from(await res.arrayBuffer());
  for (let i = 0; i + 5 <= body.length; ) {
    const flags = body[i]!;
    const len = body.readUInt32BE(i + 1);
    const json = body.subarray(i + 5, i + 5 + len).toString();
    i += 5 + len;
    if (flags & 0x02) {
      const end = (json ? JSON.parse(json) : {}) as { error?: ConnectError };
      if (end.error) throw connectError(`${SERVICE}/${method}`, end.error);
      return;
    }
  }
  throw new Error(`${SERVICE}/${method}: the stream ended without an end-of-stream message`);
}

export const depotProvider = defineProvider({
  info: {
    id: "depot",
    name: "Depot Sandboxes",
    homepage: "https://depot.dev/docs/sandboxes",
    env: ["DEPOT_TOKEN"],
    capabilities: ["fileList", "extendTimeout", "snapshot"],
    isolation: "microvm",
    maxTimeoutSec: 24 * 3600,
    freeTier: {
      tier: { kind: "none" },
      notes: "7-day trial only. Developer plan $20/mo includes 2,000 minutes at 2 vCPU.",
      source: "https://depot.dev/pricing",
      checked: "2026-11-11",
    },
    // $0.00005 per vCPU-second; memory and disk are not billed.
    pricing: { vcpuSecondUsd: 0.00005, gibSecondUsd: 0, defaultCpu: 2, defaultMemoryMiB: 4096, source: "https://depot.dev/pricing" },
    surfaces: { rest: "https://api.depot.dev (Connect)", sdk: ["@depot/sandbox (npm)"], cli: "depot" },
  },

  async create(spec, ctx) {
    const r = await rpc<{ sandbox?: SandboxProto }>(ctx, "CreateSandbox", {
      name: spec.metadata["sandboxrouting.id"],
      resources: { vcpus: Math.max(2, Math.round(spec.cpu)), memoryMb: spec.memoryMiB },
      env: spec.env,
      timeoutMinutes: Math.max(1, Math.ceil(spec.timeoutSec / 60)),
      snapshot: spec.nativeTemplate !== undefined ? { id: spec.nativeTemplate } : undefined,
    });
    if (!r.sandbox) throw new Error("depot: CreateSandbox response missing `sandbox`");
    return { providerSandboxId: r.sandbox.sandboxId, cpu: r.sandbox.resources?.vcpus, memoryMiB: r.sandbox.resources?.memoryMb };
  },

  async exec(id, command, o, ctx) {
    // Depot runs argv with no shell, so wrap in sh -c.
    const request = { ...ref(id), cmd: "/bin/sh", args: ["-c", command], cwd: o.cwd, env: o.env ?? {} };
    const timeoutMs = o.timeoutSec ? o.timeoutSec * 1000 : NO_EXEC_TIMEOUT_MS;
    const out = new TextDecoder();
    const err = new TextDecoder();
    let stdout = "";
    let stderr = "";
    let cmdId: string | undefined;
    let reason: string | undefined;
    let exitCode: number | undefined;
    for await (const ev of connectStream<CommandEvent>(endpoint(ctx), `${SERVICE}/RunCommand`, request, { headers: headers(ctx), timeoutMs })) {
      // The SDK builds the command from the first event, which must say it started.
      if (cmdId === undefined) {
        if (!ev.started) throw new Error(`depot: RunCommand stream first event was ${Object.keys(ev)[0] ?? "unknown"}, expected started`);
        cmdId = ev.started.cmdId ?? "";
        continue;
      }
      if (ev.stdout?.data) stdout += out.decode(Buffer.from(ev.stdout.data, "base64"), { stream: true });
      if (ev.stderr?.data) stderr += err.decode(Buffer.from(ev.stderr.data, "base64"), { stream: true });
      if (ev.error) reason = ev.error.reason;
      if (ev.finished) {
        exitCode = ev.finished.exitCode ?? 0;
        break;
      }
    }
    if (cmdId === undefined) throw new Error("depot: RunCommand stream closed before Started event");
    if (exitCode === undefined) throw new Error(`depot: command ${cmdId} ${reason !== undefined ? `failed: ${reason}` : "stream closed without Finished event"}`);
    stdout += out.decode();
    stderr += err.decode();
    if (stdout) o.onStdout?.(stdout);
    if (stderr) o.onStderr?.(stderr);
    return { stdout, stderr, exitCode };
  },

  async readFile(id, path, ctx) {
    const chunks: Buffer[] = [];
    for await (const c of connectStream<{ data?: string }>(endpoint(ctx), `${SERVICE}/ReadFile`, { ...ref(id), path }, { headers: headers(ctx), timeoutMs: 300_000 })) {
      if (c.data) chunks.push(Buffer.from(c.data, "base64"));
    }
    return new Uint8Array(Buffer.concat(chunks));
  },

  async writeFile(id, path, data, ctx) {
    const requests: unknown[] = [{ init: { ...ref(id), path, append: false } }];
    for (let at = 0; at < data.byteLength; at += WRITE_CHUNK_BYTES) {
      requests.push({ data: Buffer.from(data.buffer, data.byteOffset + at, Math.min(WRITE_CHUNK_BYTES, data.byteLength - at)).toString("base64") });
    }
    await connectClientStream(ctx, "WriteFile", requests, 300_000);
  },

  async listFiles(id, path, ctx) {
    const r = await rpc<{ entries?: { name: string; type?: string | number }[] }>(ctx, "ReadDir", { ...ref(id), path, withFileTypes: true });
    const dir = path.endsWith("/") ? path : `${path}/`;
    return (r.entries ?? []).map((e) => ({ name: e.name, path: `${dir}${e.name}`, isDir: e.type === "FILE_TYPE_DIRECTORY" || e.type === 2 }));
  },

  async setTimeout(id, timeoutSec, ctx) {
    await rpc(ctx, "SetSandboxTimeout", { ...ref(id), timeoutMinutes: Math.max(1, Math.ceil(timeoutSec / 60)) });
  },

  async kill(id, ctx) {
    await rpc(ctx, "KillSandbox", ref(id));
  },

  async listAlive(ctx) {
    const ids: string[] = [];
    let pageToken: string | undefined;
    do {
      const page = await rpc<{ sandboxes?: SandboxProto[]; nextPageToken?: string }>(ctx, "ListSandboxes", { pageToken });
      for (const s of page.sandboxes ?? []) {
        const status = depotStatus(s.status);
        if (status && !ENDED.includes(status)) ids.push(s.sandboxId);
      }
      pageToken = page.nextPageToken || undefined;
    } while (pageToken);
    return ids;
  },
});
