// Nodus Compute (YC F26): containers behind a user-space kernel, on machines dedicated to
// one organization. No free tier (the $30 starter offer has ended): prepaid credit.
// REST: https://api.nodus-compute.ai, Kubernetes-style manifests under /apis/nodus.dev/v1,
// Bearer nodus_sk_live_…. Sandboxes live in a project (a namespace) and are addressed by name.
// The process (exec) routes are not in the published OpenAPI; they are taken from the
// official Python SDK (`nodus-compute` 1.0.85), the only SDK. CLI `nodus`; hosted MCP.
// Nodus deletes the sandbox at `lifecycle.maxLifetime`, which cannot be changed afterwards.

import { randomUUID } from "node:crypto";
import { defineProvider, http, httpJson, HttpError } from "./util.js";
import { pollMs, sbrName, sleep } from "./rest-helpers.js";
import type { ProviderContext } from "../core/types.js";

const base = (ctx: ProviderContext) => String(ctx.env["NODUS_API_URL"] ?? "https://api.nodus-compute.ai").replace(/\/+$/, "");
const auth = (ctx: ProviderContext) => ({ authorization: `Bearer ${ctx.env["NODUS_API_KEY"]}` });
const ns = (ctx: ProviderContext) => `${base(ctx)}/apis/nodus.dev/v1/namespaces/${encodeURIComponent(String(ctx.env["NODUS_PROJECT"]))}`;
const box = (ctx: ProviderContext, name: string, path = "") => `${ns(ctx)}/sandboxes/${encodeURIComponent(name)}${path}`;
const MAX_LIFETIME_SEC = 720 * 3600;
const EXEC_LIMIT_SEC = 24 * 3600;

interface Sandbox {
  metadata: { name: string };
  status?: { phase?: string; endpoints?: { port: number; public?: boolean; url?: string }[] };
}
interface Process {
  metadata: { name: string };
  status?: { phase?: string; exitCode?: number; reason?: string };
}

/** All of one stream's output: NDJSON frames of base64 data, read until the `done` frame. */
async function output(ctx: ProviderContext, process: string, stream: "stdout" | "stderr"): Promise<string> {
  const parts: Buffer[] = [];
  let after = 0;
  for (let i = 0; i < 10_000; i++) {
    const res = await http(`${ns(ctx)}/processes/${encodeURIComponent(process)}/output?${new URLSearchParams({ after: String(after), stream, wait: "0s" })}`, { headers: auth(ctx) });
    let done = false;
    let moved = false;
    for (const line of (await res.text()).split("\n")) {
      if (!line.trim()) continue;
      const frame = JSON.parse(line) as { data?: string; offset?: number; done?: boolean };
      if (frame.data) parts.push(Buffer.from(frame.data, "base64"));
      if (frame.offset !== undefined && frame.offset > after) (after = frame.offset), (moved = true);
      done ||= Boolean(frame.done);
    }
    if (done || !moved) break;
  }
  return Buffer.concat(parts).toString("utf8");
}

export const nodusProvider = defineProvider({
  info: {
    id: "nodus",
    name: "Nodus Compute",
    homepage: "https://www.nodus-compute.ai",
    env: ["NODUS_API_KEY", "NODUS_PROJECT"],
    capabilities: ["customImage", "ports", "fileList", "gpu"],
    isolation: "gvisor",
    maxTimeoutSec: MAX_LIFETIME_SEC,
    maxExecSec: EXEC_LIMIT_SEC,
    freeTier: {
      tier: { kind: "none" },
      notes: "No free offer: prepaid credit on an activated organization. A minimum charge applies per sandbox.",
      source: "https://www.nodus-compute.ai/docs/source/guides/billing/credits.md",
      checked: "2026-11-12",
    },
    // Flat per shape ($0.0357/h for 2 vCPU / 4 GiB, $0.0558/h for 2 / 8); these rates fit the table.
    pricing: { vcpuSecondUsd: 0.0078 / 3600, gibSecondUsd: 0.005 / 3600, defaultCpu: 1, defaultMemoryMiB: 2048, source: "https://www.nodus-compute.ai/pricing/" },
    surfaces: { rest: "https://api.nodus-compute.ai/apis/nodus.dev/v1", sdk: ["nodus-compute (PyPI)"], cli: "nodus", mcp: "https://api-next.nodus-compute.ai/mcp" },
  },

  async create(spec, ctx) {
    const name = sbrName(spec);
    // Public URLs exist only for ports declared here (`options.ports`).
    const ports = ((ctx.options["ports"] as number[] | undefined) ?? []).map((port) => ({ port, public: true }));
    await http(`${ns(ctx)}/sandboxes`, {
      headers: auth(ctx),
      body: {
        apiVersion: "nodus.dev/v1",
        kind: "Sandbox",
        metadata: { name, labels: { "sandboxrouting.id": spec.metadata["sandboxrouting.id"] ?? name } },
        spec: {
          image: spec.image ?? spec.nativeTemplate ?? String(ctx.options["image"] ?? "nodus/agent-tools"),
          resources: { cpu: String(spec.cpu), memory: `${spec.memoryMiB}Mi` },
          env: Object.entries(spec.env).map(([k, value]) => ({ name: k, value })),
          placement: spec.region ? { regions: [spec.region] } : undefined,
          // The default is no outbound network at all.
          network: { egress: { policy: String(ctx.options["egress"] ?? "Open") } },
          // Idle stop is off: a stop keeps only the state directory.
          lifecycle: { idleTimeout: "0s", maxLifetime: `${Math.min(MAX_LIFETIME_SEC, Math.max(60, Math.ceil(spec.timeoutSec)))}s` },
          ingress: ports.length ? { ports } : undefined,
        },
      },
    });
    try {
      for (let i = 0; i < 600; i++) {
        const cur = await httpJson<Sandbox>(box(ctx, name), { headers: auth(ctx) });
        const phase = cur.status?.phase;
        if (phase === "Running") return { providerSandboxId: name };
        if (phase === "Failed" || phase === "Terminating") throw new Error(`nodus sandbox ${name} is ${phase}`);
        await sleep(pollMs(ctx, 1000));
      }
      throw new Error(`nodus sandbox ${name} did not start`);
    } catch (err) {
      await http(box(ctx, name), { method: "DELETE", headers: auth(ctx) }).catch(() => undefined);
      throw err;
    }
  },

  async exec(id, command, o, ctx) {
    const limit = Math.min(EXEC_LIMIT_SEC, Math.max(1, Math.ceil(o.timeoutSec ?? 600)));
    const body = {
      apiVersion: "nodus.dev/v1",
      kind: "Process",
      spec: {
        command: ["/bin/sh", "-c", command],
        tty: false,
        stdin: false,
        env: Object.entries(o.env ?? {}).map(([name, value]) => ({ name, value })),
        workingDir: o.cwd,
        timeout: `${limit}s`,
      },
    };
    // One key for every attempt: a retry after 503 starts the same process, not a second one.
    const key = randomUUID();
    let proc: Process | undefined;
    for (let attempt = 0; !proc; attempt++) {
      try {
        proc = await httpJson<Process>(box(ctx, id, "/processes"), { headers: { ...auth(ctx), "idempotency-key": key }, body });
      } catch (err) {
        // 503 SandboxStarting: the sandbox is waking.
        if (!(err instanceof HttpError) || err.status !== 503 || attempt >= 30) throw err;
        await sleep(pollMs(ctx, 2000));
      }
    }
    const name = proc.metadata.name;
    const ended = (p: Process) => ["Succeeded", "Failed", "Cancelled"].includes(p.status?.phase ?? "");
    const wait = ctx.options["pollMs"] === undefined ? "30s" : "0s";
    const deadline = Date.now() + (limit + 60) * 1000;
    while (!ended(proc) && Date.now() < deadline) {
      if (wait === "0s") await sleep(pollMs(ctx, 1000));
      proc = await httpJson<Process>(`${ns(ctx)}/processes/${encodeURIComponent(name)}?wait=${wait}`, { headers: auth(ctx), timeoutMs: 60_000 });
    }
    const [stdout, stderr] = await Promise.all([output(ctx, name, "stdout"), output(ctx, name, "stderr")]);
    if (stdout) o.onStdout?.(stdout);
    if (stderr) o.onStderr?.(stderr);
    const timedOut = !ended(proc) || proc.status?.reason === "DeadlineExceeded";
    return { stdout, stderr, exitCode: proc.status?.exitCode ?? (timedOut ? 124 : proc.status?.phase === "Succeeded" ? 0 : 1) };
  },

  async readFile(id, path, ctx) {
    return new Uint8Array(await (await http(`${box(ctx, id, "/files")}?path=${encodeURIComponent(path)}`, { headers: auth(ctx) })).arrayBuffer());
  },

  async writeFile(id, path, data, ctx) {
    // Creates parent directories and writes atomically; 64 MiB at most.
    await http(`${box(ctx, id, "/files")}?path=${encodeURIComponent(path)}`, { method: "PUT", headers: { ...auth(ctx), "content-type": "application/octet-stream" }, raw: data });
  },

  async listFiles(id, path, ctx) {
    const r = await httpJson<{ items?: { name: string; type?: string; isDir?: boolean; size?: number }[] }>(`${box(ctx, id, "/files")}?path=${encodeURIComponent(path)}`, {
      headers: { ...auth(ctx), accept: "application/json" },
    });
    const dir = path.endsWith("/") ? path : `${path}/`;
    return (r.items ?? []).map((e) => ({ name: e.name, path: `${dir}${e.name}`, isDir: e.isDir ?? /dir/i.test(e.type ?? ""), size: e.size }));
  },

  async getUrl(id, port, ctx) {
    const cur = await httpJson<Sandbox>(box(ctx, id), { headers: auth(ctx) });
    const url = cur.status?.endpoints?.find((e) => e.port === port && e.public !== false)?.url;
    if (!url) throw new Error(`nodus: port ${port} is not public; list it in providers.nodus.options.ports before creating`);
    return url;
  },

  async kill(id, ctx) {
    await http(box(ctx, id), { method: "DELETE", headers: auth(ctx) });
  },

  async listAlive(ctx) {
    const names: string[] = [];
    let token: string | undefined;
    do {
      const q = new URLSearchParams({ limit: "200", ...(token ? { continue: token } : {}) });
      const page = await httpJson<{ items: Sandbox[]; metadata?: { continue?: string } }>(`${ns(ctx)}/sandboxes?${q}`, { headers: auth(ctx) });
      for (const s of page.items) if (s.metadata.name.startsWith("sbr-") && !["Failed", "Terminating"].includes(s.status?.phase ?? "")) names.push(s.metadata.name);
      token = page.metadata?.continue || undefined;
    } while (token);
    return names;
  },
});
