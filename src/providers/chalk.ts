// Chalk Sandboxes (chalk.ai): gVisor-hardened containers on Chalk Serverless, self-serve and pay as
// you go, no free tier. Preemptible by default at $0.0249 per vCPU-hour and $0.0080 per GiB-hour
// ($0.082/h for 2 vCPU / 4 GiB); non-preemptible work, on request, is $0.0747 and $0.0240 and runs
// up to 24 h. Per-second billing.
// API: Connect/gRPC services on the API server (https://api.chalk.ai): chalk.sandbox.v2.SandboxService
// (CreateSandbox, GetSandbox, ListSandboxes, TerminateSandbox) and SandboxProcessService
// (ExecCommand), as the official SDK calls them (PyPI `chalkcompute` 2.14.3, chalkcompute/_sandbox.py
// and the generated chalkcompute/_gen/chalk/sandbox/v2 stubs). Docs: https://docs.chalk.ai/docs/compute/sandbox,
// https://docs.chalk.ai/compute-docs/sandbox.md, prices https://chalk.ai/pricing. Credentials are a
// client id and secret exchanged at POST /v1/oauth/token (as chalkpy does), then scoped to one
// environment; calls carry the token and X-Chalk-Env-Id.
// Doubts, none checked against the service: the SDK speaks gRPC, and this adapter speaks the Connect
// protocol's JSON form to the same paths, which Connect servers accept alongside gRPC. The SDK runs a
// command on the default host compute class only through a bidirectional stream, which fetch can't
// open, and through the unary ExecCommand on the K8S class ("one-shot execution"); so sandboxes are
// created with compute class K8S, though one docs page says a k8s sandbox does not support exec.
// Isolation on that class isn't documented, so the adapter claims `container`. The spec's `lifetime`
// ends the sandbox at its deadline. Files use the router's exec fallback.

import { createHash } from "node:crypto";
import { defineProvider, httpJson, HttpError } from "./util.js";
import { grantCache, pollMs, sbrName, sleep } from "./rest-helpers.js";
import { connectUnary } from "./connect-rpc.js";
import type { ProviderContext } from "../core/types.js";

const server = (ctx: ProviderContext) => String(ctx.env["CHALK_API_SERVER"] ?? "https://api.chalk.ai").replace(/\/+$/, "");
const SANDBOX = "chalk.sandbox.v2.SandboxService";
const PROCESS = "chalk.sandbox.v2.SandboxProcessService";

interface Token {
  access_token: string;
  expires_in?: number;
  primary_environment?: string | null;
  environment_id_to_name?: Record<string, string> | null;
}
interface Session {
  token: string;
  envId: string;
}

/** Tokens per client id, scoped to the chosen environment, exchanged again before they expire. */
const sessions = grantCache<Session>();
async function session(ctx: ProviderContext): Promise<Session> {
  const clientId = String(ctx.env["CHALK_CLIENT_ID"]);
  const secret = String(ctx.env["CHALK_CLIENT_SECRET"]);
  const wanted = ctx.env["CHALK_ENVIRONMENT"] ?? "";
  const key = createHash("sha256").update(`${clientId}\0${secret}\0${wanted}`).digest("hex");
  return sessions.get(key, async () => {
    const exchange = (scope?: string) =>
      httpJson<Token>(`${server(ctx)}/v1/oauth/token`, {
        headers: { accept: "application/json" },
        body: { client_id: clientId, client_secret: secret, grant_type: "client_credentials", ...(scope ? { scope } : {}) },
      });
    let t = await exchange();
    // An environment may be named by id or by name; the primary one when unset.
    const names = t.environment_id_to_name ?? {};
    const asked = wanted || t.primary_environment || "";
    const envId = names[asked] !== undefined ? asked : (Object.entries(names).find(([, n]) => n.toLowerCase() === asked.toLowerCase())?.[0] ?? asked);
    if (envId) t = await exchange(`env:${envId}`);
    return { value: { token: t.access_token, envId }, expiresAt: Date.now() + (t.expires_in ?? 3600) * 1000 };
  });
}

async function call<T>(ctx: ProviderContext, method: string, request: unknown, timeoutMs?: number): Promise<T> {
  const s = await session(ctx);
  return connectUnary<T>(server(ctx), method, request, {
    headers: { authorization: `Bearer ${s.token}`, "x-chalk-env-id": s.envId, "x-chalk-server": "go-api" },
    timeoutMs,
  });
}

interface SandboxInfo {
  id: string;
  name?: string;
  status?: string | number;
  statusMessage?: string;
  status_message?: string;
}
/** SandboxStatus by name; proto3 JSON writes the name, and may write the number. */
const STATUS = ["UNSPECIFIED", "PENDING", "RUNNING", "SUCCEEDED", "FAILED", "TERMINATED", "ERROR", "UNKNOWN", "SUSPENDED"];
const statusOf = (s: SandboxInfo) => (typeof s.status === "number" ? (STATUS[s.status] ?? "UNKNOWN") : String(s.status ?? "UNSPECIFIED").replace(/^SANDBOX_STATUS_/, ""));
const ENDED = new Set(["SUCCEEDED", "FAILED", "TERMINATED", "ERROR", "UNKNOWN"]);

/** Kubernetes quantities for a size. */
export function chalkResources(cpu: number, memoryMiB: number): { cpu: string; memory: string } {
  return { cpu: String(Math.max(0.25, cpu)), memory: `${Math.max(256, Math.ceil(memoryMiB))}Mi` };
}

const b64 = (s?: string) => (s ? Buffer.from(s, "base64").toString("utf8") : "");

export const chalkProvider = defineProvider({
  info: {
    id: "chalk",
    name: "Chalk Sandboxes",
    homepage: "https://chalk.ai",
    env: ["CHALK_CLIENT_ID", "CHALK_CLIENT_SECRET"],
    capabilities: ["customImage"],
    isolation: "container",
    freeTier: {
      tier: { kind: "none" },
      notes: "No free tier; pay as you go with no up-front cost. Preemptible by default: a sandbox can be stopped early.",
      source: "https://chalk.ai/pricing",
      checked: "2026-11-21",
    },
    // Preemptible rates, which apply by default.
    pricing: { vcpuSecondUsd: 0.0249 / 3600, gibSecondUsd: 0.008 / 3600, defaultCpu: 2, defaultMemoryMiB: 4096, source: "https://chalk.ai/pricing" },
    surfaces: { rest: "Connect/gRPC at https://api.chalk.ai (chalk.sandbox.v2)", sdk: ["chalkcompute (PyPI)"], cli: "chalk" },
  },

  async create(spec, ctx) {
    const r = await call<{ sandbox?: SandboxInfo }>(ctx, `${SANDBOX}/CreateSandbox`, {
      spec: {
        name: sbrName(spec),
        image: spec.image ?? spec.nativeTemplate ?? String(ctx.options["image"] ?? "python:3.12-slim"),
        entrypoint: ["sleep", "infinity"],
        tags: { "managed-by": "sandboxrouting" },
        lifetime: `${Math.max(1, Math.ceil(spec.timeoutSec))}s`,
        resources: chalkResources(spec.cpu, spec.memoryMiB),
        envVars: spec.env,
        computeClass: "COMPUTE_CLASS_K8S",
      },
    });
    if (!r.sandbox?.id) throw new Error("chalk: CreateSandbox returned no sandbox");
    const id = r.sandbox.id;
    try {
      let s = r.sandbox;
      for (let i = 0; i < 600 && statusOf(s) !== "RUNNING"; i++) {
        if (ENDED.has(statusOf(s))) throw new Error(`chalk sandbox ${id} is ${statusOf(s)}${(s.statusMessage ?? s.status_message) ? `: ${s.statusMessage ?? s.status_message}` : ""}`);
        await sleep(pollMs(ctx, 1000));
        const got = await call<{ sandbox?: SandboxInfo }>(ctx, `${SANDBOX}/GetSandbox`, { id });
        if (!got.sandbox) throw new Error(`chalk: GetSandbox returned no sandbox for ${id}`);
        s = got.sandbox;
      }
      if (statusOf(s) !== "RUNNING") throw new Error(`chalk sandbox ${id} did not start (${statusOf(s)})`);
    } catch (err) {
      await this.kill(id, ctx).catch(() => undefined);
      throw err;
    }
    return { providerSandboxId: id };
  },

  async exec(id, command, o, ctx) {
    const timeoutSec = Math.max(1, Math.ceil(o.timeoutSec ?? 3600));
    const r = await call<{ stdout?: string; stderr?: string; exitCode?: number; exit_code?: number }>(
      ctx,
      `${PROCESS}/ExecCommand`,
      { sandboxId: id, command: "sh", args: ["-c", command], workdir: o.cwd, envVars: o.env ?? {}, timeout: `${timeoutSec}s` },
      (timeoutSec + 60) * 1000,
    );
    const stdout = b64(r.stdout);
    const stderr = b64(r.stderr);
    if (stdout) o.onStdout?.(stdout);
    if (stderr) o.onStderr?.(stderr);
    // proto3 JSON leaves out a zero exit code.
    return { stdout, stderr, exitCode: r.exitCode ?? r.exit_code ?? 0 };
  },

  async kill(id, ctx) {
    try {
      await call(ctx, `${SANDBOX}/TerminateSandbox`, { id });
    } catch (err) {
      // Already gone: not_found, or failed_precondition for one that already ended (as the SDK reads it).
      const gone = err instanceof HttpError && (err.status === 404 || err.status === 410 || (err.status === 400 && /failed_precondition/.test(err.message)));
      if (!gone) throw err;
    }
  },

  async listAlive(ctx) {
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await call<{ sandboxes?: SandboxInfo[]; nextCursor?: string; next_cursor?: string }>(ctx, `${SANDBOX}/ListSandboxes`, { limit: 100, ...(cursor ? { cursor } : {}) });
      ids.push(...(page.sandboxes ?? []).filter((s) => !ENDED.has(statusOf(s))).map((s) => s.id));
      cursor = page.nextCursor || page.next_cursor || undefined;
    } while (cursor);
    return ids;
  },
});
