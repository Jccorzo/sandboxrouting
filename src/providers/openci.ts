// openci: your self-hosted sandbox service (../openci). Free and unlimited on your own
// workers (Firecracker microVMs, Docker+gVisor, Hyper-V). Written against the contract in
// openci/docs/architecture.md and openci/pkg/api/api.go:
//   POST   /v1/sandboxes                 CreateSandboxRequest{wait:true} → Sandbox
//   GET    /v1/sandboxes                 → Sandbox[]
//   POST   /v1/sandboxes/{id}/exec       ExecRequest → NDJSON ExecEvent stream
//   GET    /v1/sandboxes/{id}/files?path=…   → bytes
//   PUT    /v1/sandboxes/{id}/files?path=…   bytes
//   GET    /v1/sandboxes/{id}/files/list?path=… → FileInfo[]
//   POST   /v1/sandboxes/{id}/timeout    {timeout_seconds}
//   DELETE /v1/sandboxes/{id}
//   ports: {server}/v1/sandboxes/{id}/proxy/{port}/

import { defineProvider, http, httpJson } from "./util.js";
import type { ProviderContext } from "../core/types.js";

function base(ctx: ProviderContext): string {
  return String(ctx.options["url"] ?? ctx.env["OPENCI_URL"] ?? "").replace(/\/+$/, "");
}
function auth(ctx: ProviderContext): Record<string, string> {
  return { authorization: `Bearer ${ctx.env["OPENCI_TOKEN"] ?? ""}` };
}

interface OpenciSandbox {
  id: string;
  state: string;
  spec: { resources: { cpus: number; memory_mb: number } };
}
interface ExecEvent {
  type: "stdout" | "stderr" | "exit" | "error";
  data?: string;
  exit_code?: number;
  error?: string;
}

export const openciProvider = defineProvider({
  info: {
    id: "openci",
    name: "openci (self-hosted)",
    homepage: "https://github.com/hushrun/openci",
    env: ["OPENCI_URL", "OPENCI_TOKEN"],
    capabilities: ["customImage", "ports", "fileList", "extendTimeout"],
    selfHosted: true,
    freeTier: { tier: { kind: "unlimited" }, notes: "Your own workers: no per-use cost." },
    pricing: { vcpuSecondUsd: 0, gibSecondUsd: 0, defaultCpu: 2, defaultMemoryMiB: 2048 },
    surfaces: { rest: "/v1/sandboxes", sdk: ["openci/pkg/sdk (Go)"], cli: "openci", mcp: "openci mcp" },
  },

  async create(spec, ctx) {
    const sbx = await httpJson<OpenciSandbox>(`${base(ctx)}/v1/sandboxes`, {
      headers: auth(ctx),
      body: {
        image: spec.nativeTemplate ?? spec.image,
        resources: { cpus: Math.max(1, Math.round(spec.cpu)), memory_mb: spec.memoryMiB },
        timeout_seconds: spec.timeoutSec,
        env: spec.env,
        metadata: spec.metadata,
        wait: true,
      },
    });
    if (sbx.state !== "running") throw new Error(`openci sandbox ${sbx.id} is ${sbx.state}`);
    return { providerSandboxId: sbx.id, cpu: sbx.spec.resources.cpus, memoryMiB: sbx.spec.resources.memory_mb };
  },

  async exec(id, command, opts, ctx) {
    const res = await http(`${base(ctx)}/v1/sandboxes/${encodeURIComponent(id)}/exec`, {
      headers: auth(ctx),
      body: { command, cwd: opts.cwd, env: opts.env, timeout_seconds: opts.timeoutSec },
      timeoutMs: (opts.timeoutSec ?? 3600) * 1000 + 30_000,
    });
    let stdout = "";
    let stderr = "";
    let exitCode = -1;
    let buf = "";
    const decoder = new TextDecoder();
    const handle = (line: string) => {
      if (!line.trim()) return;
      const ev = JSON.parse(line) as ExecEvent;
      if (ev.type === "stdout") {
        stdout += ev.data ?? "";
        opts.onStdout?.(ev.data ?? "");
      } else if (ev.type === "stderr") {
        stderr += ev.data ?? "";
        opts.onStderr?.(ev.data ?? "");
      } else if (ev.type === "exit") exitCode = ev.exit_code ?? -1;
      else if (ev.type === "error") throw new Error(ev.error ?? "exec failed");
    };
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        handle(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    }
    handle(buf);
    return { stdout, stderr, exitCode };
  },

  async readFile(id, path, ctx) {
    const res = await http(`${base(ctx)}/v1/sandboxes/${encodeURIComponent(id)}/files?path=${encodeURIComponent(path)}`, { headers: auth(ctx) });
    return new Uint8Array(await res.arrayBuffer());
  },

  async writeFile(id, path, data, ctx) {
    await http(`${base(ctx)}/v1/sandboxes/${encodeURIComponent(id)}/files?path=${encodeURIComponent(path)}`, {
      method: "PUT",
      headers: { ...auth(ctx), "content-type": "application/octet-stream" },
      raw: data,
    });
  },

  async listFiles(id, path, ctx) {
    const items = await httpJson<{ name: string; path: string; size: number; is_dir: boolean }[]>(
      `${base(ctx)}/v1/sandboxes/${encodeURIComponent(id)}/files/list?path=${encodeURIComponent(path)}`,
      { headers: auth(ctx) },
    );
    return items.map((f) => ({ name: f.name, path: f.path, size: f.size, isDir: f.is_dir }));
  },

  async getUrl(id, port, ctx) {
    return `${base(ctx)}/v1/sandboxes/${encodeURIComponent(id)}/proxy/${port}/`;
  },

  async setTimeout(id, timeoutSec, ctx) {
    await http(`${base(ctx)}/v1/sandboxes/${encodeURIComponent(id)}/timeout`, { headers: auth(ctx), body: { timeout_seconds: timeoutSec } });
  },

  async kill(id, ctx) {
    await http(`${base(ctx)}/v1/sandboxes/${encodeURIComponent(id)}`, { method: "DELETE", headers: auth(ctx) });
  },

  async listAlive(ctx) {
    const all = await httpJson<OpenciSandbox[]>(`${base(ctx)}/v1/sandboxes`, { headers: auth(ctx) });
    return all.filter((s) => s.state === "running" || s.state === "starting" || s.state === "pending").map((s) => s.id);
  },
});
