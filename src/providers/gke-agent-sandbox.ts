// Agent Sandbox (kubernetes-sigs/agent-sandbox; GKE's "Agent Sandbox"): sandboxes as Kubernetes
// resources in your own cluster. A SandboxClaim takes a pod from a SandboxWarmPool; sandboxd in
// the pod runs commands (gRPC :9090) and moves files (REST :8080), reached through the
// project's sandbox-router, which you expose outside the cluster (a Gateway or LoadBalancer).
// It is a cloud provider here, not "your own hardware": on GKE Autopilot each sandbox pod is
// billed at the pod rate, which is what the pricing below uses. On a cluster whose nodes you
// already pay for, set its pricing to 0 in config.
//   https://github.com/kubernetes-sigs/agent-sandbox (extensions/api/v1beta1/sandboxclaim_types.go)
//   clients/typescript/agentic-sandbox-client (sandbox-client.ts: claim create, Ready, status.sandbox.name)
//   sandbox-router/README.md   X-Sandbox-ID/-Namespace/-Port headers; gRPC-Web transcoded to gRPC
//   packages/sandboxd/USER_GUIDE.md, spec/process/v1/process.proto
//     POST   {k8s}/apis/extensions.agents.x-k8s.io/v1beta1/namespaces/{ns}/sandboxclaims
//     GET    …/sandboxclaims/{name}      status.conditions[Ready], status.sandbox.name
//     PATCH  …/sandboxclaims/{name}      spec.lifecycle.shutdownTime (merge patch)
//     DELETE …/sandboxclaims/{name}      the controller deletes the Sandbox and its pod
//     POST   {router}/process.v1.ProcessService/ExecuteWithLimits   (application/grpc-web+proto)
//     GET|PUT {router}/v1/files/{path relative to sandboxd's root}  ; GET /v1/health
//   https://cloud.google.com/kubernetes-engine/pricing   (Autopilot pod vCPU and memory rates)
// Isolation is whatever the warm pool's template uses (gVisor on GKE Sandbox node pools, plain
// containers elsewhere), so it claims the weakest: container.

import { SandboxRouterError } from "../core/errors.js";
import { defineProvider, http, HttpError, httpJson, toBuffer } from "./util.js";
import { ENV_FILE, envFileBody, inline, insideRoots, pollMs, sbrName, shq, sleep, withEnvFile } from "./rest-helpers.js";
import { googleAccessToken, hasGoogleCredentials } from "./google-auth.js";
import { decode, get, grpcWebCall, parseGrpcWeb, pb } from "./grpc-web.js";
import type { ProviderContext } from "../core/types.js";

const ID = "gke-agent-sandbox";
const GROUP = "extensions.agents.x-k8s.io/v1beta1";
const MANAGED_BY = "sandboxrouting";
/** Ready=False reasons the claim controller won't recover from (the SDK's list, plus not-found refs). */
const TERMINAL = new Set([
  "TemplateNotFound",
  "WarmPoolNotFound",
  "InvalidMetadata",
  "EnvVarsInjectionRejected",
  "VolumeClaimTemplatesError",
  "ClaimExpired",
  "SandboxExpired",
  "InvalidConfiguration",
  "PodFailed",
  "PodSucceeded",
]);

const k8s = (ctx: ProviderContext) => String(ctx.env["AGENT_SANDBOX_K8S_API"] ?? "").replace(/\/+$/, "");
const router = (ctx: ProviderContext) => String(ctx.env["AGENT_SANDBOX_ROUTER_URL"] ?? "").replace(/\/+$/, "");
const ns = (ctx: ProviderContext) => String(ctx.options["namespace"] ?? ctx.env["AGENT_SANDBOX_NAMESPACE"] ?? "default");
const claims = (ctx: ProviderContext) => `${k8s(ctx)}/apis/${GROUP}/namespaces/${encodeURIComponent(ns(ctx))}/sandboxclaims`;
const claim = (ctx: ProviderContext, id: string) => `${claims(ctx)}/${encodeURIComponent(id)}`;
const rootDir = (ctx: ProviderContext) => String(ctx.options["rootDir"] ?? "/workspace").replace(/\/+$/, "");

/** The cluster token: a Kubernetes bearer token, else a Google access token (GKE accepts both). */
async function token(ctx: ProviderContext): Promise<string> {
  return ctx.env["AGENT_SANDBOX_K8S_TOKEN"] ?? (await googleAccessToken(ctx, ID));
}
const kube = async (ctx: ProviderContext) => ({ authorization: `Bearer ${await token(ctx)}` });

interface Claim {
  metadata: { name: string; labels?: Record<string, string>; deletionTimestamp?: string };
  status?: { conditions?: { type: string; status: string; reason?: string; message?: string }[]; sandbox?: { name?: string } };
}

// ---- ExecuteWithLimits, over the shared protobuf and gRPC-Web helpers ----

/** ExecuteWithLimitsRequest{config: ProcessConfig{command: argv}, time_limit: Duration{seconds}}. */
export function encodeExecuteRequest(argv: string[], timeLimitSec?: number): Uint8Array {
  const fields = pb.msg(1, pb.strs(1, argv));
  if (timeLimitSec && timeLimitSec > 0) fields.push(...pb.msg(4, pb.uint(1, Math.ceil(timeLimitSec))));
  return new Uint8Array(fields);
}

/** A protobuf message's top-level fields, as [number, value] pairs (repeats in order). */
export function protoFields(buf: Uint8Array): [number, bigint | Uint8Array][] {
  return [...decode(buf)].flatMap(([no, values]) => values.map((v): [number, bigint | Uint8Array] => [no, v]));
}

export { parseGrpcWeb };

// ---- data plane through the router ----

async function routed(ctx: ProviderContext, sandbox: string, port: number): Promise<Record<string, string>> {
  const h: Record<string, string> = { "x-sandbox-id": sandbox, "x-sandbox-namespace": ns(ctx), "x-sandbox-port": String(port) };
  // The router consumes Authorization (TokenReview checks the cluster token; scoped-token mode
  // wants AGENT_SANDBOX_ROUTER_TOKEN) and strips it; sandboxd reads X-Sandboxd-Token.
  h["authorization"] = `Bearer ${ctx.env["AGENT_SANDBOX_ROUTER_TOKEN"] ?? (await token(ctx))}`;
  if (ctx.env["AGENT_SANDBOX_SANDBOXD_TOKEN"]) h["x-sandboxd-token"] = ctx.env["AGENT_SANDBOX_SANDBOXD_TOKEN"];
  return h;
}

/** The Sandbox a claim was given (warm-pool names differ from the claim's), kept per claim. */
const sandboxNames = new Map<string, string>();
async function sandboxOf(ctx: ProviderContext, id: string): Promise<string> {
  const key = `${k8s(ctx)} ${ns(ctx)} ${id}`;
  let name = sandboxNames.get(key);
  if (!name) {
    const c = await httpJson<Claim>(claim(ctx, id), { headers: await kube(ctx) });
    name = c.status?.sandbox?.name;
    if (!name) throw new SandboxRouterError("transient", `${ID} claim ${id} has no sandbox yet`, ID);
    sandboxNames.set(key, name);
  }
  return name;
}

async function grpcExec(ctx: ProviderContext, id: string, argv: string[], timeoutSec?: number): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const sandbox = await sandboxOf(ctx, id);
  const f = await grpcWebCall(
    `${router(ctx)}/process.v1.ProcessService/ExecuteWithLimits`,
    await routed(ctx, sandbox, 9090),
    [...encodeExecuteRequest(argv, timeoutSec)],
    ((timeoutSec ?? 3600) + 30) * 1000,
  );
  let exitCode = get.int(f, 1);
  // TIME_LIMIT_EXCEEDED with a clean status still means the command was cut off.
  if (get.int(f, 4) === 2 && exitCode === 0) exitCode = 124;
  return { stdout: get.str(f, 2), stderr: get.str(f, 3), exitCode: exitCode < 0 ? 137 : exitCode };
}

async function waitHealthy(ctx: ProviderContext, id: string, deadline: number): Promise<void> {
  for (;;) {
    try {
      const sandbox = await sandboxOf(ctx, id);
      await http(`${router(ctx)}/v1/health`, { headers: await routed(ctx, sandbox, 8080), timeoutMs: 10_000 });
      return;
    } catch (err) {
      if (err instanceof HttpError && (err.status === 401 || err.status === 403)) throw err;
      if (Date.now() > deadline) throw err;
      await sleep(pollMs(ctx, 1000));
    }
  }
}

/** Polls the claim until Ready with a sandbox; a terminal reason throws. */
async function waitClaim(ctx: ProviderContext, id: string, deadline: number): Promise<void> {
  for (;;) {
    const c = await httpJson<Claim>(claim(ctx, id), { headers: await kube(ctx) });
    const ready = c.status?.conditions?.find((x) => x.type === "Ready");
    if (ready?.status === "True" && c.status?.sandbox?.name) {
      sandboxNames.set(`${k8s(ctx)} ${ns(ctx)} ${id}`, c.status.sandbox.name);
      return;
    }
    if (ready?.status === "False" && ready.reason && TERMINAL.has(ready.reason)) throw new Error(`${ID} claim ${id}: ${ready.reason} ${ready.message ?? ""}`.trim());
    if (c.metadata.deletionTimestamp) throw new Error(`${ID} claim ${id} is being deleted`);
    if (Date.now() > deadline) throw new SandboxRouterError("transient", `${ID} claim ${id} not ready in time`, ID);
    await sleep(pollMs(ctx, 1000));
  }
}

async function removeClaim(ctx: ProviderContext, id: string): Promise<void> {
  sandboxNames.delete(`${k8s(ctx)} ${ns(ctx)} ${id}`);
  try {
    await http(claim(ctx, id), { method: "DELETE", headers: await kube(ctx), body: { propagationPolicy: "Foreground" } });
  } catch (err) {
    if (err instanceof HttpError && (err.status === 404 || err.status === 410)) return;
    throw err;
  }
}

/** A path under sandboxd's root as its REST API wants it (relative, segments encoded). */
function filePath(ctx: ProviderContext, path: string): string {
  insideRoots(ID, path, [rootDir(ctx)]);
  return path
    .slice(rootDir(ctx).length)
    .split("/")
    .filter((s) => s && s !== ".")
    .map(encodeURIComponent)
    .join("/");
}

export const gkeAgentSandboxProvider = defineProvider({
  info: {
    id: ID,
    name: "GKE Agent Sandbox (Kubernetes agent-sandbox)",
    homepage: "https://github.com/kubernetes-sigs/agent-sandbox",
    // Plus a cluster credential: AGENT_SANDBOX_K8S_TOKEN, or Google credentials on GKE.
    env: ["AGENT_SANDBOX_K8S_API", "AGENT_SANDBOX_ROUTER_URL", "AGENT_SANDBOX_WARM_POOL"],
    capabilities: ["fileList", "extendTimeout"],
    isolation: "container",
    freeTier: {
      tier: { kind: "none" },
      notes: "GKE's $74.40 monthly credit covers one cluster's management fee, not pod compute. You need a cluster with agent-sandbox, a warm pool and the sandbox-router installed.",
      source: "https://cloud.google.com/kubernetes-engine/pricing",
      checked: "2026-11-21",
    },
    // Autopilot general-purpose pods: $0.0445 per vCPU-hour, $0.0049225 per GiB-hour.
    pricing: { vcpuSecondUsd: 0.0445 / 3600, gibSecondUsd: 0.0049225 / 3600, defaultCpu: 2, defaultMemoryMiB: 4096, source: "https://cloud.google.com/kubernetes-engine/pricing" },
    surfaces: {
      rest: "Kubernetes API (SandboxClaim) + sandbox-router",
      sdk: ["agentic-sandbox-client (TypeScript, Python, Go in the repo)"],
      cli: "kubectl",
    },
  },

  isConfigured(ctx) {
    return Boolean(
      ctx.env["AGENT_SANDBOX_K8S_API"] &&
        ctx.env["AGENT_SANDBOX_ROUTER_URL"] &&
        (ctx.options["warmPool"] || ctx.env["AGENT_SANDBOX_WARM_POOL"]) &&
        (ctx.env["AGENT_SANDBOX_K8S_TOKEN"] || hasGoogleCredentials(ctx)),
    );
  },

  async create(spec, ctx) {
    // The router id names the claim, so a retried create finds the claim the first try made.
    const id = sbrName(spec);
    const pool = spec.nativeTemplate ?? String(ctx.options["warmPool"] ?? ctx.env["AGENT_SANDBOX_WARM_POOL"]);
    const manifest = {
      apiVersion: GROUP,
      kind: "SandboxClaim",
      metadata: { name: id, labels: { "app.kubernetes.io/managed-by": MANAGED_BY } },
      spec: {
        warmPoolRef: { name: pool },
        // The controller deletes the claim (and its pod) at this time even if the router is gone.
        lifecycle: { shutdownTime: new Date(Date.now() + spec.timeoutSec * 1000).toISOString(), shutdownPolicy: "Delete" },
      },
    };
    try {
      await httpJson(claims(ctx), { headers: await kube(ctx), body: manifest });
    } catch (err) {
      if (!(err instanceof HttpError && err.status === 409)) throw err;
    }
    try {
      const deadline = Date.now() + Number(ctx.options["readyTimeoutSec"] ?? 300) * 1000;
      await waitClaim(ctx, id, deadline);
      await waitHealthy(ctx, id, deadline);
      // Claim env needs the template to allow injection; a file every command loads doesn't.
      if (Object.keys(spec.env).length) {
        const r = await grpcExec(ctx, id, ["sh", "-c", `umask 077; printf %s ${shq(envFileBody(spec.env))} > ${ENV_FILE}`]);
        if (r.exitCode !== 0) throw new Error(`${ID}: could not write the sandbox env: ${r.stderr}`);
      }
    } catch (err) {
      await removeClaim(ctx, id).catch(() => undefined);
      throw err;
    }
    return { providerSandboxId: id };
  },

  async exec(id, command, o, ctx) {
    // sandboxd confines its own cwd field to its root, so cd and exports go in the command.
    const r = await grpcExec(ctx, id, ["sh", "-c", withEnvFile(inline(command, { cwd: o.cwd, env: o.env }))], o.timeoutSec);
    if (r.stdout) o.onStdout?.(r.stdout);
    if (r.stderr) o.onStderr?.(r.stderr);
    return r;
  },

  async readFile(id, path, ctx) {
    const rel = filePath(ctx, path);
    const sandbox = await sandboxOf(ctx, id);
    const res = await http(`${router(ctx)}/v1/files/${rel}?type=file`, { headers: await routed(ctx, sandbox, 8080) });
    return new Uint8Array(await res.arrayBuffer());
  },

  async writeFile(id, path, data, ctx) {
    const rel = filePath(ctx, path);
    const sandbox = await sandboxOf(ctx, id);
    // Atomic (temp file + rename) and creates missing parents.
    await http(`${router(ctx)}/v1/files/${rel}`, {
      method: "PUT",
      headers: { ...(await routed(ctx, sandbox, 8080)), "content-type": "application/octet-stream" },
      raw: toBuffer(data),
    });
  },

  async listFiles(id, path, ctx) {
    const rel = filePath(ctx, path);
    const sandbox = await sandboxOf(ctx, id);
    const r = await httpJson<{ entries?: { name: string; size?: number; type?: string }[] }>(`${router(ctx)}/v1/files/${rel}?type=directory`, {
      headers: await routed(ctx, sandbox, 8080),
    });
    const dir = path.endsWith("/") ? path : `${path}/`;
    return (r.entries ?? []).map((e) => ({ name: e.name, path: `${dir}${e.name}`, isDir: e.type === "directory", size: e.size }));
  },

  async setTimeout(id, timeoutSec, ctx) {
    await http(claim(ctx, id), {
      method: "PATCH",
      headers: { ...(await kube(ctx)), "content-type": "application/merge-patch+json" },
      raw: JSON.stringify({ spec: { lifecycle: { shutdownTime: new Date(Date.now() + timeoutSec * 1000).toISOString(), shutdownPolicy: "Delete" } } }),
    });
  },

  async kill(id, ctx) {
    await removeClaim(ctx, id);
  },

  async listAlive(ctx) {
    const ids: string[] = [];
    let cont = "";
    do {
      const q = new URLSearchParams({ labelSelector: `app.kubernetes.io/managed-by=${MANAGED_BY}`, limit: "200", ...(cont ? { continue: cont } : {}) });
      const page = await httpJson<{ items: Claim[]; metadata?: { continue?: string } }>(`${claims(ctx)}?${q}`, { headers: await kube(ctx) });
      ids.push(...page.items.filter((c) => !c.metadata.deletionTimestamp).map((c) => c.metadata.name));
      cont = page.metadata?.continue ?? "";
    } while (cont);
    return ids;
  },
});
