// exe.dev: persistent VMs whose API is SSH commands sent over HTTPS: `POST https://exe.dev/exec`
// with the command text as the body. Needs a paid plan (7-day trial on Personal). Mint a
// token that may run these commands: `ssh exe.dev generate-api-key --cmds=new,ssh,rm,ls`.
// Limits: each /exec call times out at 30 s (504), no stdin, 64 KB body. No TTL, so the
// router deletes VMs at the deadline (enforcesTimeout: false).

import { defineProvider, http } from "./util.js";
import { inline, sbrName, shq } from "./rest-helpers.js";
import type { ProviderContext } from "../core/types.js";

const url = (ctx: ProviderContext) => String(ctx.env["EXE_API_URL"] ?? "https://exe.dev/exec");
export const EXE_EXEC_LIMIT_SEC = 30;

export interface ExeResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Parses the NDJSON stream: {"stdout": b64}, {"stderr": b64}, {"exit_code": N}. */
export function parseExeNdjson(text: string): ExeResult {
  let stdout = "";
  let stderr = "";
  let exitCode = -1;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const ev = JSON.parse(line) as { stdout?: string; stderr?: string; exit_code?: number; error?: string };
    if (ev.stdout) stdout += Buffer.from(ev.stdout, "base64").toString("utf8");
    if (ev.stderr) stderr += Buffer.from(ev.stderr, "base64").toString("utf8");
    if (typeof ev.exit_code === "number") exitCode = ev.exit_code;
    if (ev.error) throw new Error(`exe.dev: ${ev.error}`);
  }
  if (exitCode < 0) throw new Error("exe.dev: response had no exit code");
  return { stdout, stderr, exitCode };
}

/** Runs one exe.dev command line, e.g. `ls` or `ssh vm 'sh -c …'`. */
export async function exe(ctx: ProviderContext, line: string, timeoutSec = EXE_EXEC_LIMIT_SEC): Promise<ExeResult> {
  const res = await http(url(ctx), {
    method: "POST",
    headers: { authorization: `Bearer ${ctx.env["EXE_API_TOKEN"]}`, accept: "application/x-ndjson", "content-type": "text/plain" },
    raw: line,
    timeoutMs: (Math.min(timeoutSec, EXE_EXEC_LIMIT_SEC) + 10) * 1000,
  });
  return parseExeNdjson(await res.text());
}

async function must(ctx: ProviderContext, line: string): Promise<string> {
  const r = await exe(ctx, line);
  if (r.exitCode !== 0) {
    const msg = (r.stderr || r.stdout).trim();
    throw Object.assign(new Error(`exe.dev ${line.split(" ")[0]}: ${msg}`), /not found|no such/i.test(msg) ? { status: 404 } : {});
  }
  return r.stdout;
}

export const exedevProvider = defineProvider({
  info: {
    id: "exedev",
    name: "exe.dev",
    homepage: "https://exe.dev",
    env: ["EXE_API_TOKEN"],
    capabilities: ["customImage", "pause"],
    isolation: "vm",
    maxExecSec: EXE_EXEC_LIMIT_SEC,
    enforcesTimeout: false,
    freeTier: {
      tier: { kind: "none" },
      notes: "Needs a plan (Personal from $15/mo, 7-day trial); standalone VMs bill per second on top.",
      source: "https://exe.dev/pricing",
      checked: "2026-11-11",
    },
    // $0.105 per 2 vCPU + 4 GiB unit-hour, split between CPU and memory.
    pricing: { vcpuSecondUsd: 0.02625 / 3600, gibSecondUsd: 0.013125 / 3600, defaultCpu: 2, defaultMemoryMiB: 4096, source: "https://exe.dev/pricing" },
    surfaces: { rest: "POST https://exe.dev/exec (SSH command in the body)", cli: "ssh exe.dev", mcp: "https://exe.dev/mcp" },
  },

  async create(spec, ctx) {
    const name = sbrName(spec, 12);
    const image = spec.nativeTemplate ?? spec.image;
    await must(ctx, `new --sandbox --name=${name}${image ? ` --image=${shq(image)}` : ""}`);
    return { providerSandboxId: name };
  },

  async exec(id, command, o, ctx) {
    // Two shell layers: exe.dev parses the line, then the VM's shell runs `sh -c`.
    const r = await exe(ctx, `ssh ${id} ${shq(`sh -c ${shq(inline(command, o))}`)}`, o.timeoutSec);
    if (r.stdout) o.onStdout?.(r.stdout);
    if (r.stderr) o.onStderr?.(r.stderr);
    return r;
  },

  async pause(id, ctx) {
    await must(ctx, `pause ${id}`);
  },

  async resume(id, ctx) {
    await must(ctx, `resume ${id}`);
  },

  async kill(id, ctx) {
    await must(ctx, `rm ${id}`);
  },

  async listAlive(ctx) {
    const out = await must(ctx, "ls");
    const parsed = JSON.parse(out) as { vm_name: string; status?: string }[] | { vms: { vm_name: string; status?: string }[] };
    const vms = Array.isArray(parsed) ? parsed : parsed.vms;
    return vms.map((v) => v.vm_name).filter((n) => n.startsWith("sbr-"));
  },
});
