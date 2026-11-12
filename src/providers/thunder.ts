// Thunder Compute sandboxes: Firecracker microVMs, optional GPUs. Access is gated: you get
// 403 sandbox_access_denied until sales enables your org. No free tier.
// REST: https://api.thundercompute.com:8443/v1 (Bearer), OpenAPI at :8443/openapi.json.
// There is no exec endpoint: commands run over SSH with a short-lived certificate from
// POST /sandboxes/ssh-certificate, so this adapter needs `ssh` and `ssh-keygen` on PATH.
// Files go through the router's exec fallback. Python SDK `thunder-sandbox`; no npm SDK.

import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineProvider, http, httpJson } from "./util.js";
import { pollMs, sleep, shq, inline } from "./rest-helpers.js";
import { SandboxRouterError } from "../core/errors.js";
import type { ProviderContext } from "../core/types.js";

const base = (ctx: ProviderContext) => String(ctx.env["TNR_API_URL"] ?? "https://api.thundercompute.com:8443/v1").replace(/\/+$/, "");
const auth = (ctx: ProviderContext) => ({ authorization: `Bearer ${ctx.env["TNR_API_TOKEN"]}` });
const workspace = (ctx: ProviderContext) => (ctx.env["TNR_WORKSPACE"] ? `?workspace_id=${encodeURIComponent(ctx.env["TNR_WORKSPACE"])}` : "");

interface ThunderSandbox {
  id: string;
  status: "created" | "ready" | "finished" | "failed";
  ssh?: { host: string; port: number; user: string };
  failure?: string;
}

/** The ssh argv for one command. Pure, so it can be tested without a network. */
export function thunderSshArgs(o: { keyPath: string; certPath: string; knownHosts: string; host: string; port: number; user: string; command: string }): string[] {
  return [
    "-i", o.keyPath,
    "-o", `CertificateFile=${o.certPath}`,
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", `UserKnownHostsFile=${o.knownHosts}`,
    "-o", "BatchMode=yes",
    "-o", "IdentitiesOnly=yes",
    "-p", String(o.port),
    `${o.user}@${o.host}`,
    `sh -c ${shq(o.command)}`,
  ];
}

function run(bin: string, args: string[], timeoutMs?: number, onStdout?: (s: string) => void, onStderr?: (s: string) => void) {
  return new Promise<{ stdout: string; stderr: string; code: number }>((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = timeoutMs ? setTimeout(() => child.kill("SIGKILL"), timeoutMs) : undefined;
    child.stdout.on("data", (b: Buffer) => ((stdout += b), onStdout?.(b.toString())));
    child.stderr.on("data", (b: Buffer) => ((stderr += b), onStderr?.(b.toString())));
    child.on("error", (err) =>
      reject(
        (err as NodeJS.ErrnoException).code === "ENOENT"
          ? new SandboxRouterError("auth", "thunder needs ssh and ssh-keygen on PATH", "thunder")
          : err,
      ),
    );
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? 255 });
    });
  });
}

/** One throwaway key per process, re-certified when the certificate expires. */
let identity: { dir: string; keyPath: string; certPath: string; knownHosts: string; expiresAt: number } | undefined;

async function sshIdentity(ctx: ProviderContext) {
  if (identity && identity.expiresAt - Date.now() > 60_000) return identity;
  const dir = identity?.dir ?? (await mkdtemp(join(tmpdir(), "sbr-thunder-")));
  const keyPath = join(dir, "k");
  if (!identity) {
    const gen = await run("ssh-keygen", ["-t", "ed25519", "-N", "", "-f", keyPath, "-q"]);
    if (gen.code !== 0) throw new Error(`ssh-keygen failed: ${gen.stderr}`);
  }
  const pub = (await readFile(`${keyPath}.pub`, "utf8")).trim();
  const cert = await httpJson<{ ssh_certificate?: string; expires_at?: string }>(`${base(ctx)}/sandboxes/ssh-certificate`, {
    headers: auth(ctx),
    body: { ssh_public_key: pub, workspace_id: ctx.env["TNR_WORKSPACE"] },
  });
  if (!cert.ssh_certificate) throw new Error("thunder returned no ssh certificate");
  const certPath = `${keyPath}-cert.pub`;
  await writeFile(certPath, `${cert.ssh_certificate.trim()}\n`, { mode: 0o600 });
  identity = {
    dir,
    keyPath,
    certPath,
    knownHosts: join(dir, "known_hosts"),
    expiresAt: cert.expires_at ? Date.parse(cert.expires_at) : Date.now() + 10 * 60_000,
  };
  return identity;
}

const sshTargets = new Map<string, { host: string; port: number; user: string }>();

async function target(id: string, ctx: ProviderContext) {
  const hit = sshTargets.get(id);
  if (hit) return hit;
  const sbx = await httpJson<ThunderSandbox>(`${base(ctx)}/sandboxes/${encodeURIComponent(id)}${workspace(ctx)}`, { headers: auth(ctx) });
  if (sbx.status === "finished" || sbx.status === "failed") throw Object.assign(new Error(`thunder sandbox ${id} is ${sbx.status}`), { status: 404 });
  if (!sbx.ssh) throw new Error(`thunder sandbox ${id} has no ssh endpoint yet`);
  sshTargets.set(id, sbx.ssh);
  return sbx.ssh;
}

export const thunderProvider = defineProvider({
  info: {
    id: "thunder",
    name: "Thunder Compute",
    homepage: "https://www.thundercompute.com",
    env: ["TNR_API_TOKEN"],
    capabilities: ["customImage", "gpu"],
    isolation: "microvm",
    freeTier: {
      tier: { kind: "none" },
      notes: "No free tier; sandbox access is enabled per org by sales (403 sandbox_access_denied until then).",
      source: "https://www.thundercompute.com/docs/sandboxes/pricing.md",
      checked: "2026-11-11",
    },
    pricing: { vcpuSecondUsd: 0.051 / 3600, gibSecondUsd: 0.016 / 3600, defaultCpu: 2, defaultMemoryMiB: 4096, source: "https://www.thundercompute.com/docs/sandboxes/pricing.md" },
    surfaces: { rest: "https://api.thundercompute.com:8443/v1", sdk: ["thunder-sandbox (PyPI)"], cli: "tnr (GPU instances only)" },
  },

  async create(spec, ctx) {
    const started = await httpJson<{ id: string }>(`${base(ctx)}/sandboxes/start`, {
      headers: auth(ctx),
      body: {
        name: spec.metadata["sandboxrouting.id"],
        image_id: spec.nativeTemplate ?? spec.image,
        env: spec.env,
        spec: {
          cpu_count: Math.max(1, Math.round(spec.cpu)),
          memory_gib: Math.max(1, Math.round(spec.memoryMiB / 1024)),
          storage_gib: Number(ctx.options["storageGiB"] ?? 10),
        },
        lifetime: { enforce_ttl: true, max_ttl_seconds: spec.timeoutSec, max_grace_seconds: 30 },
        network_policy: { internet_access: String(ctx.options["internet"] ?? "open") },
        workspace_id: ctx.env["TNR_WORKSPACE"],
      },
    });
    for (let i = 0; i < 300; i++) {
      const sbx = await httpJson<ThunderSandbox>(`${base(ctx)}/sandboxes/${encodeURIComponent(started.id)}${workspace(ctx)}`, { headers: auth(ctx) });
      if (sbx.status === "ready") {
        if (sbx.ssh) sshTargets.set(started.id, sbx.ssh);
        return { providerSandboxId: started.id };
      }
      if (sbx.status === "failed" || sbx.status === "finished") throw new Error(`thunder sandbox ${started.id} ${sbx.status}: ${sbx.failure ?? ""}`);
      await sleep(pollMs(ctx, 2000));
    }
    throw new Error(`thunder sandbox ${started.id} did not become ready`);
  },

  async exec(id, command, o, ctx) {
    const [t, ident] = await Promise.all([target(id, ctx), sshIdentity(ctx)]);
    const args = thunderSshArgs({ ...ident, ...t, command: inline(command, o) });
    const r = await run("ssh", args, o.timeoutSec ? o.timeoutSec * 1000 : undefined, o.onStdout, o.onStderr);
    // ssh exits 255 for its own failures (connection, auth), else with the command's code.
    if (r.code === 255 && /Permission denied|Connection (refused|closed|timed out)|Could not resolve/i.test(r.stderr)) {
      throw new Error(`thunder ssh: ${r.stderr.trim()}`);
    }
    return { stdout: r.stdout, stderr: r.stderr, exitCode: r.code };
  },

  async kill(id, ctx) {
    sshTargets.delete(id);
    await http(`${base(ctx)}/sandboxes/${encodeURIComponent(id)}/stop${workspace(ctx)}`, { method: "POST", headers: auth(ctx) });
  },

  async listAlive(ctx) {
    const ids: string[] = [];
    let token: string | undefined;
    do {
      const q = new URLSearchParams({ limit: "100" });
      if (token) q.set("page_token", token);
      if (ctx.env["TNR_WORKSPACE"]) q.set("workspace_id", ctx.env["TNR_WORKSPACE"]);
      const page = await httpJson<{ sandboxes?: ThunderSandbox[]; next_page_token?: string }>(`${base(ctx)}/sandboxes?${q}`, { headers: auth(ctx) });
      for (const s of page.sandboxes ?? []) if (s.status === "created" || s.status === "ready") ids.push(s.id);
      token = page.next_page_token || undefined;
    } while (token);
    return ids;
  },
});
