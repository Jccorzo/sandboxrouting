// InstaVM: microVMs attached to a session. Free: $50 of credit, card on file (not charged);
// 5 VMs active at once on Free. Paid: $0.000014 per vCPU-second and $0.0000045 per GB-second
// while the VM runs.
// REST: https://api.instavm.io (X-API-Key), OpenAPI at api.instavm.io/openapi.json. Docs:
// https://instavm.io/docs/api (sessions, execution, vms, files, shares), https://instavm.io/pricing.
// SDKs: npm `instavm`, PyPI `instavm`; CLI `instavm`.
// The router's id is the session id: a session keeps its id while its VM is suspended and
// resumed, which mints a new VM id. A VM is killed `vm_lifetime_seconds` after it starts, which
// can't be changed later. Note that an exec on a session whose VM has ended starts a fresh VM.
// `/execute` answers stdout, stderr and a success flag but no exit code, so the command's code
// is printed after its output and read back.

import { randomUUID } from "node:crypto";
import { defineProvider, http, HttpError, httpJson } from "./util.js";
import { inline, pollMs, shq, sleep } from "./rest-helpers.js";
import type { ProviderContext } from "../core/types.js";

const base = (ctx: ProviderContext) => String(ctx.env["INSTAVM_API_URL"] ?? "https://api.instavm.io").replace(/\/+$/, "");
const auth = (ctx: ProviderContext) => ({ "x-api-key": String(ctx.env["INSTAVM_API_KEY"] ?? "") });
/** Printed after a command's output with its exit code; stripped from what's returned. */
const EXIT_MARK = "__sbr_exit__";
const EXIT_RE = new RegExp(`\\n?${EXIT_MARK}(\\d+)\\n?$`);

/** InstaVM sizes: vCPUs are 1, 2, 4, 6 or 8; memory 128-8192 MB, an even number. */
export function instavmSize(cpu: number, memoryMiB: number): { vcpu_count: number; memory_mb: number } {
  const vcpu_count = [1, 2, 4, 6, 8].find((c) => c >= cpu) ?? 8;
  const memory_mb = Math.min(8192, Math.max(128, Math.ceil(memoryMiB / 2) * 2));
  return { vcpu_count, memory_mb };
}

interface Status {
  exists: boolean;
  vm_assigned: boolean;
  vm_id?: string | null;
  vm_status?: string | null;
  vm_alive?: boolean;
}
const status = (ctx: ProviderContext, id: string) => httpJson<Status>(`${base(ctx)}/v1/sessions/status/${encodeURIComponent(id)}`, { headers: auth(ctx) });
async function vmOf(ctx: ProviderContext, id: string): Promise<string> {
  const s = await status(ctx, id);
  if (!s.exists || !s.vm_id) throw new HttpError(404, `instavm session ${id} has no VM`);
  return s.vm_id;
}
const failed = (s?: string | null) => /fail|error|terminat|dead|killed|stopped/i.test(s ?? "");

export const instavmProvider = defineProvider({
  info: {
    id: "instavm",
    name: "InstaVM",
    homepage: "https://instavm.io",
    env: ["INSTAVM_API_KEY"],
    capabilities: ["ports", "pause"],
    isolation: "microvm",
    freeTier: {
      tier: { kind: "one-time-credit", usd: 50 },
      concurrency: 5,
      requiresCard: true,
      notes: "$50 of free credit plus 10 GB of volumes; a card is kept on file but not charged. Free: 5 VMs active at once.",
      source: "https://instavm.io/pricing",
      checked: "2026-11-21",
    },
    pricing: { vcpuSecondUsd: 0.000014, gibSecondUsd: 0.0000045, defaultCpu: 2, defaultMemoryMiB: 4096, source: "https://instavm.io/pricing" },
    surfaces: { rest: "https://api.instavm.io", sdk: ["instavm (npm)", "instavm (PyPI)"], cli: "instavm" },
  },

  async create(spec, ctx) {
    const size = instavmSize(spec.cpu, spec.memoryMiB);
    const vm_lifetime_seconds = Math.max(20, Math.ceil(spec.timeoutSec));
    const { session_id } = await httpJson<{ session_id: string }>(`${base(ctx)}/v1/sessions/session`, {
      headers: auth(ctx),
      body: { ...size, vm_lifetime_seconds, metadata: spec.metadata, env: spec.env },
    });
    try {
      // Starts the session's VM and answers once it runs; the key makes a retry return the first VM.
      const r = await httpJson<{ vm_id?: string | null; status: string }>(`${base(ctx)}/v1/vms?wait=true`, {
        headers: { ...auth(ctx), "idempotency-key": spec.metadata["sandboxrouting.id"] ?? randomUUID() },
        body: { session_id, ...size, vm_lifetime_seconds, metadata: spec.metadata, env: spec.env, snapshot_id: spec.nativeTemplate },
        timeoutMs: 300_000,
      });
      if (failed(r.status)) throw new Error(`instavm VM for session ${session_id} is ${r.status}`);
      let s = await status(ctx, session_id);
      for (let i = 0; i < 300 && !s.vm_alive; i++) {
        if (failed(s.vm_status)) throw new Error(`instavm VM for session ${session_id} is ${s.vm_status}`);
        await sleep(pollMs(ctx, 1000));
        s = await status(ctx, session_id);
      }
      if (!s.vm_alive) throw new Error(`instavm VM for session ${session_id} did not become active`);
    } catch (err) {
      await http(`${base(ctx)}/kill`, { headers: auth(ctx), body: { session_id } }).catch(() => undefined);
      throw err;
    }
    return { providerSandboxId: session_id, cpu: size.vcpu_count, memoryMiB: size.memory_mb };
  },

  async exec(id, command, o, ctx) {
    // `timeout` (1-600 s) bounds the wait for the answer, not the VM.
    const timeout = Math.min(600, Math.max(1, Math.ceil(o.timeoutSec ?? 600)));
    // Its own shell, so an `exit` in the command still reaches the printf.
    const wrapped = `sh -c ${shq(inline(command, { cwd: o.cwd, env: o.env }))}; printf '\\n${EXIT_MARK}%d\\n' $?`;
    const r = await httpJson<{ stdout?: string; stderr?: string; success?: boolean; error?: string }>(`${base(ctx)}/execute`, {
      headers: auth(ctx),
      body: { command: wrapped, language: "bash", session_id: id, timeout },
      timeoutMs: (timeout + 30) * 1000,
    });
    let stdout = r.stdout ?? "";
    const stderr = r.stderr ?? "";
    const m = EXIT_RE.exec(stdout);
    let exitCode: number;
    if (m) {
      exitCode = Number(m[1]);
      stdout = stdout.slice(0, m.index);
    } else {
      // No code printed: the shell itself was cut off (the timeout, or the VM went away).
      if (r.error && r.success === false && !stdout && !stderr) throw new Error(`instavm exec: ${r.error}`);
      exitCode = r.success === false ? 1 : 0;
    }
    if (stdout) o.onStdout?.(stdout);
    if (stderr) o.onStderr?.(stderr);
    return { stdout, stderr, exitCode };
  },

  async readFile(id, path, ctx) {
    const r = await httpJson<{ content: string }>(`${base(ctx)}/download`, { headers: auth(ctx), body: { session_id: id, file_path: path } });
    return new Uint8Array(Buffer.from(r.content ?? "", "base64"));
  },

  async writeFile(id, path, data, ctx) {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(data)]), path.split("/").pop() || "file");
    form.append("remote_path", path);
    form.append("session_id", id);
    await http(`${base(ctx)}/upload`, { method: "POST", headers: auth(ctx), raw: form });
  },

  async getUrl(id, port, ctx) {
    // A public share answers anyone with the URL, while the VM stays active.
    return (await httpJson<{ url: string }>(`${base(ctx)}/v1/shares`, { headers: auth(ctx), body: { session_id: id, port, is_public: true } })).url;
  },

  async pause(id, ctx) {
    await http(`${base(ctx)}/v1/vms/${encodeURIComponent(await vmOf(ctx, id))}/suspend`, { method: "POST", headers: auth(ctx) });
  },

  async resume(id, ctx) {
    // Mints a new VM id; the session id stays.
    await http(`${base(ctx)}/v1/vms/${encodeURIComponent(await vmOf(ctx, id))}/resume?wait=true`, { method: "POST", headers: auth(ctx), timeoutMs: 300_000 });
  },

  async kill(id, ctx) {
    // A VM that already ended is reported as `already_terminated`; a suspended one loses its state.
    await http(`${base(ctx)}/kill`, { headers: auth(ctx), body: { session_id: id } }).catch((err) => {
      if (err instanceof HttpError && (err.status === 404 || err.status === 410)) return;
      throw err;
    });
  },

  async listAlive(ctx) {
    // Lists ended VMs too; a live one is active or suspended.
    const vms = await httpJson<{ session_id?: string | null; status?: string | null }[]>(`${base(ctx)}/v1/vms`, { headers: auth(ctx) });
    return [...new Set(vms.filter((v) => v.session_id && !failed(v.status)).map((v) => v.session_id!))];
  },
});
