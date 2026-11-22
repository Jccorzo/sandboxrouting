// Koyeb sandboxes (public preview). No free tier for sandboxes (Starter plan, card required),
// but the cheapest paid option: `small` (1 vCPU / 1 GB) is $0.0144/h.
// Spoken over HTTP, no SDK, with the calls the official SDK (npm `@koyeb/sandbox-sdk` 1.1.0,
// Apache-2.0) makes:
// - the public REST API, https://app.koyeb.com/v1 (Bearer API token), docs
//   https://www.koyeb.com/docs/reference/api: a sandbox is a SANDBOX-typed service in an app of its own;
// - the executor inside each sandbox, at `{public_url}/koyeb-sandbox` from the deployment's metadata
//   with `X-Routing-Key` and `Bearer <SANDBOX_SECRET>`, the secret create puts in the service's env.
// CLI: `koyeb`.

import { randomBytes } from "node:crypto";
import { defineProvider, dispatcherFor, http, HttpError, httpJson } from "./util.js";
import { pollMs, sleep, sse } from "./rest-helpers.js";
import { SandboxRouterError } from "../core/errors.js";
import type { ExecOptions, ExecResult, ProviderContext } from "../core/types.js";

/** How long create waits for the sandbox to answer, the SDK's default (300 s). */
const READY_SEC = 300;
/** Readiness polls start at 100 ms and double up to the interval (500 ms), as the SDK's do. */
const READY_POLL_MS = 500;
const READY_FIRST_POLL_MS = 100;
/** The SDK's default command timeout: seconds without output before the command is abandoned. */
const COMMAND_TIMEOUT_SEC = 30;
/** Executor calls other than exec are retried this many times on 5xx or a network error, 1 s backoff doubling. */
const EXECUTOR_RETRIES = 3;
/** The SDK's sandbox defaults: idle sleep after 300 s, and the executor's ports and routes. */
const IDLE_TIMEOUT_SEC = 300;

interface Service {
  id: string;
  app_id: string;
  name?: string;
  active_deployment_id?: string;
  latest_deployment_id?: string;
}
interface Deployment {
  status?: string;
  definition?: { env?: { key: string; value?: string }[] };
  metadata?: { sandbox?: { public_url?: string; routing_key?: string } };
}
/** Where a sandbox's executor answers: `base` ends in /koyeb-sandbox. */
interface Executor {
  base: string;
  secret: string;
  routingKey?: string;
}

const apiHost = (ctx: ProviderContext) => (ctx.env["KOYEB_API_HOST"] || "https://app.koyeb.com").replace(/\/+$/, "");

function token(ctx: ProviderContext): string {
  const t = ctx.env["KOYEB_API_TOKEN"];
  if (!t) throw new SandboxRouterError("auth", "koyeb: API token is required. Set KOYEB_API_TOKEN", "koyeb");
  return t;
}

function api<T>(ctx: ProviderContext, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  return httpJson<T>(`${apiHost(ctx)}/v1${path}`, { ...init, headers: { Authorization: `Bearer ${token(ctx)}` }, timeoutMs: 60_000 });
}

const getService = async (ctx: ProviderContext, id: string) => (await api<{ service: Service }>(ctx, `/services/${encodeURIComponent(id)}`)).service;
const getDeployment = async (ctx: ProviderContext, id: string) => (await api<{ deployment: Deployment }>(ctx, `/deployments/${encodeURIComponent(id)}`)).deployment;
const deleteApp = (ctx: ProviderContext, id: string) => api(ctx, `/apps/${encodeURIComponent(id)}`, { method: "DELETE" });

async function appDomain(ctx: ProviderContext, appId: string): Promise<string> {
  const { app } = await api<{ app: { domains?: { name?: string }[] } }>(ctx, `/apps/${encodeURIComponent(appId)}`);
  const name = app.domains?.[0]?.name;
  if (!name) throw new Error(`koyeb: app ${appId} has no domain`);
  return name;
}

/** The deployment publishes the executor's address once it is up; without it the SDK uses the app's domain. */
const address = (d: Deployment | undefined) => {
  const s = d?.metadata?.sandbox;
  return s?.public_url && s.routing_key ? { publicUrl: s.public_url, routingKey: s.routing_key } : undefined;
};

async function executorFor(ctx: ProviderContext, appId: string, secret: string, deployment: Deployment | undefined): Promise<Executor> {
  const a = address(deployment);
  if (a) return { base: `${a.publicUrl}/koyeb-sandbox`, secret, routingKey: a.routingKey };
  return { base: `https://${await appDomain(ctx, appId)}/koyeb-sandbox`, secret };
}

const executorHeaders = (exe: Executor): Record<string, string> => ({
  Authorization: `Bearer ${exe.secret}`,
  ...(exe.routingKey ? { "X-Routing-Key": exe.routingKey } : {}),
});

/** A 32-character secret over the SDK's alphabet (64 symbols, so a byte mod 64 is uniform). */
function sandboxSecret(): string {
  const alphabet = "-_0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  return Array.from(randomBytes(32), (b) => alphabet[b % 64]).join("");
}

/**
 * Reconnects to a sandbox by its service id, as `Sandbox.get_from_id` does: the live deployment
 * (active, else latest) holds the SANDBOX_SECRET create put in its env, and its metadata the
 * executor's address.
 */
async function connect(id: string, ctx: ProviderContext): Promise<{ exe: Executor; deployment: Deployment; appId: string }> {
  const service = await getService(ctx, id);
  const deploymentId = service.active_deployment_id ?? service.latest_deployment_id;
  const noSecret = () => new Error(`koyeb: sandbox '${id}' has no SANDBOX_SECRET in its deployment definition, so the executor cannot be reached`);
  if (!deploymentId) throw noSecret();
  const deployment = await getDeployment(ctx, deploymentId);
  const secret = deployment.definition?.env?.find(({ key }) => key === "SANDBOX_SECRET")?.value;
  if (!secret) throw noSecret();
  return { exe: await executorFor(ctx, service.app_id, secret, deployment), deployment, appId: service.app_id };
}

/** One executor call with the SDK's retries: 5xx answers and network errors are tried again. */
async function executorPost(exe: Executor, path: string, body: unknown, ctx: ProviderContext): Promise<unknown> {
  let backoff = pollMs(ctx, 1000);
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await http(`${exe.base}${path}`, { method: "POST", headers: executorHeaders(exe), body, timeoutMs: 600_000 });
      const text = await res.text();
      return res.headers.get("content-type")?.startsWith("application/json") ? (text ? JSON.parse(text) : undefined) : text;
    } catch (err) {
      const retryable = !(err instanceof HttpError) || err.status >= 500;
      if (!retryable || attempt >= EXECUTOR_RETRIES) throw err;
      await sleep(backoff);
      backoff *= 2;
    }
  }
}

/** The executor answers file failures as a 200 carrying `error`. */
function checkExecutorError(reply: unknown, path: string, what: string): void {
  const error = (reply as { error?: unknown } | undefined)?.error;
  if (typeof error === "string" && error.length > 0) throw new Error(`koyeb: ${what} failed: ${error} (path: ${path})`);
}

/** Like the SDK's parser, an unreadable event payload becomes one carrying `error`. */
function eventData(raw: string): Record<string, unknown> {
  try {
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    return { error: `Failed to parse event data: ${raw}` };
  }
}

/**
 * Runs a command through the executor's /run_streaming, an SSE stream of `output` events
 * ({stream, data}) and a final `complete` ({code}) or `error` ({error}). As in the SDK: the
 * timeout is re-armed on every chunk, so it bounds silence, not the whole run; output goes to the
 * callbacks when either is given and is only collected when neither is; a failed start (an
 * `error` without a code) discards the output and exits 1.
 */
async function runStreaming(exe: Executor, command: string, o: ExecOptions): Promise<ExecResult> {
  const timeoutSec = o.timeoutSec ?? COMMAND_TIMEOUT_SEC;
  const ctrl = new AbortController();
  let fired = false;
  let timer: NodeJS.Timeout | undefined;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      fired = true;
      ctrl.abort();
    }, timeoutSec * 1000);
    timer.unref();
  };
  // Output is always collected, as every other adapter does; the callbacks see it as it streams.
  const out = { stdout: [] as string[], stderr: [] as string[] };
  let code = 0;
  let startError: string | undefined;
  const exit = (d: Record<string, unknown>) => {
    if (typeof d["code"] === "number") code = d["code"];
    else if (typeof d["error"] === "string") startError = d["error"];
  };
  const url = `${exe.base}/run_streaming`;
  arm();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { ...executorHeaders(exe), "content-type": "application/json" },
      body: JSON.stringify({ cmd: command, cwd: o.cwd, env: o.env }),
      signal: ctrl.signal,
      // Past our own idle timer, so undici's 300 s limits never end a long command first.
      dispatcher: dispatcherFor(timeoutSec * 1000 + 1000) as unknown as RequestInit["dispatcher"],
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new HttpError(res.status, `POST ${new URL(url).pathname}: ${res.status} ${text.slice(0, 500)}`);
    }
    if (!res.body) throw new Error("koyeb: run_streaming answered without a body");
    const body = res.body as unknown as AsyncIterable<Uint8Array>;
    async function* rearming() {
      for await (const chunk of body) {
        arm();
        yield chunk;
      }
    }
    for await (const ev of sse(rearming())) {
      if (ev.event === "output") {
        const d = eventData(ev.data);
        const stream = d["stream"];
        if (typeof stream !== "string") {
          exit({ error: `Failed to parse event data: ${ev.data}` });
          continue;
        }
        if (stream !== "stdout" && stream !== "stderr") continue;
        const chunk = typeof d["data"] === "string" ? d["data"] : "";
        out[stream].push(chunk);
        (stream === "stdout" ? o.onStdout : o.onStderr)?.(chunk);
      } else if (ev.event === "complete" || ev.event === "error") {
        exit(eventData(ev.data));
      }
    }
  } catch (err) {
    if (fired) throw new Error(`koyeb: Request timed out after ${timeoutSec}s`, { cause: err });
    if (err instanceof HttpError || err instanceof SandboxRouterError) throw err;
    throw new Error(`koyeb: Connection to sandbox lost: ${String(err)}`, { cause: err });
  } finally {
    clearTimeout(timer);
  }
  if (startError !== undefined) return { stdout: "", stderr: startError, exitCode: 1 };
  return { stdout: out.stdout.join(""), stderr: out.stderr.join(""), exitCode: code };
}

const READY = ["HEALTHY", "DEGRADED"];
const IN_PROGRESS = ["PENDING", "PROVISIONING", "SCHEDULED", "ALLOCATING", "STARTING"];

/**
 * Waits until the sandbox answers, as `wait_ready` does: first until its deployment is healthy
 * (any status outside the ready and in-progress sets, unknown ones included, is a failure),
 * then until the executor's /health is OK. Other errors while polling just mean "not yet".
 */
async function waitReady(ctx: ProviderContext, service: Service, secret: string): Promise<void> {
  const deadline = Date.now() + READY_SEC * 1000;
  const interval = pollMs(ctx, READY_POLL_MS);
  let delay = Math.min(READY_FIRST_POLL_MS, interval);
  let deploymentId = service.latest_deployment_id;
  let healthy: Deployment | undefined;
  let exe: Executor | undefined;
  while (Date.now() < deadline) {
    if (!healthy) {
      try {
        if (!deploymentId) {
          const s = await getService(ctx, service.id);
          deploymentId = s.active_deployment_id ?? s.latest_deployment_id;
        }
        if (deploymentId) {
          const d = await getDeployment(ctx, deploymentId);
          if (READY.includes(d.status ?? "")) healthy = d;
          else if (!IN_PROGRESS.includes(d.status ?? "")) {
            throw new SandboxRouterError("transient", `koyeb: sandbox '${service.name}' deployment reached status ${d.status ?? "UNKNOWN"}; it will not become ready`, "koyeb");
          }
        }
      } catch (err) {
        if (err instanceof SandboxRouterError) throw err;
      }
      if (healthy) continue;
    } else {
      try {
        // The healthy deployment usually carries the address; if not, look again, then fall back to the app's domain.
        exe ??= await executorFor(ctx, service.app_id, secret, address(healthy) ? healthy : await getDeployment(ctx, deploymentId!).catch(() => undefined));
        const res = await fetch(`${exe.base}/health`, { headers: executorHeaders(exe), signal: AbortSignal.timeout(5000) });
        await res.body?.cancel().catch(() => undefined);
        if (res.ok) return;
      } catch {
        // not up yet
      }
    }
    await sleep(delay);
    delay = Math.min(interval, delay * 2);
  }
  throw new SandboxRouterError("transient", `koyeb: sandbox '${service.name}' did not become ready within ${READY_SEC} seconds`, "koyeb");
}

/** Koyeb sizes: vCPU → instance type (memory follows the type). */
function instanceType(cpu: number): { type: string; cpu: number; memoryMiB: number } {
  if (cpu <= 0.25) return { type: "nano", cpu: 0.25, memoryMiB: 256 };
  if (cpu <= 0.5) return { type: "micro", cpu: 0.5, memoryMiB: 512 };
  if (cpu <= 1) return { type: "small", cpu: 1, memoryMiB: 1024 };
  if (cpu <= 2) return { type: "medium", cpu: 2, memoryMiB: 2048 };
  return { type: "large", cpu: 4, memoryMiB: 4096 };
}

export const koyebProvider = defineProvider({
  info: {
    id: "koyeb",
    name: "Koyeb",
    homepage: "https://www.koyeb.com/docs/sandboxes",
    env: ["KOYEB_API_TOKEN"],
    capabilities: ["customImage", "ports", "snapshot"],
    isolation: "microvm",
    maxTimeoutSec: 24 * 3600,
    freeTier: {
      tier: { kind: "none" },
      requiresCard: true,
      notes: "Sandboxes need the Starter plan or above; the free instance does not cover them.",
      source: "https://www.koyeb.com/docs/reference/instances",
      checked: "2026-11-21",
    },
    // Standard instances are $0.0144/h per vCPU with memory included (1 GB per vCPU, nano to
    // large), which is what `instanceType` creates: medium (2 vCPU / 2 GB) is $0.0288/h.
    pricing: { vcpuSecondUsd: 0.0144 / 3600, gibSecondUsd: 0, defaultCpu: 1, defaultMemoryMiB: 1024, source: "https://www.koyeb.com/docs/reference/instances" },
    surfaces: { rest: "https://app.koyeb.com/v1", sdk: ["@koyeb/sandbox-sdk (npm)", "koyeb-sdk (PyPI)"], cli: "koyeb" },
  },

  async create(spec, ctx) {
    token(ctx);
    const size = instanceType(spec.cpu);
    const name = `sbr-${(spec.metadata["sandboxrouting.id"] ?? "").replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 20)}`;
    const secret = sandboxSecret();
    // The definition the SDK builds for a SANDBOX service with these options.
    const definition = {
      name,
      type: "SANDBOX",
      docker: { image: spec.image ?? "koyeb/sandbox" },
      instance_types: [{ type: size.type }],
      regions: [spec.region ?? "was"],
      ports: [
        { port: 3030, protocol: "http" },
        { port: 3031, protocol: "http" },
      ],
      routes: [
        { port: 3030, path: "/koyeb-sandbox/" },
        { port: 3031, path: "/" },
      ],
      env: [{ key: "SANDBOX_SECRET", value: secret }, ...Object.entries(spec.env ?? {}).map(([key, value]) => ({ key, value }))],
      mesh: "DEPLOYMENT_MESH_AUTO",
      scalings: [{ min: 0, max: 1, targets: [{ sleep_idle_delay: { deep_sleep_value: IDLE_TIMEOUT_SEC } }] }],
    };
    const { app } = await api<{ app: { id: string } }>(ctx, "/apps", {
      method: "POST",
      body: { name: `sandbox-app-${name}-${Date.now()}`, life_cycle: { delete_when_empty: true } },
    });
    let service: Service;
    try {
      ({ service } = await api<{ service: Service }>(ctx, "/services", {
        method: "POST",
        body: { app_id: app.id, definition, life_cycle: { delete_after_create: Math.min(spec.timeoutSec, 24 * 3600) } },
      }));
    } catch (err) {
      // The app is ours and empty: remove it, without hiding why the service failed.
      await deleteApp(ctx, app.id).catch(() => undefined);
      throw err;
    }
    try {
      await waitReady(ctx, service, secret);
    } catch (err) {
      const deleted = await deleteApp(ctx, service.app_id).then(
        () => true,
        () => false,
      );
      if (err instanceof Error) err.message += deleted ? " The sandbox was deleted." : " The sandbox could not be deleted and may still exist.";
      throw err;
    }
    return { providerSandboxId: service.id, cpu: size.cpu, memoryMiB: size.memoryMiB };
  },

  async exec(id, command, o, ctx) {
    return runStreaming((await connect(id, ctx)).exe, command, o);
  },

  async writeFile(id, path, data, ctx) {
    // write_file takes text; binary falls back to exec.
    const text = Buffer.from(data).toString("utf8");
    if (Buffer.from(text, "utf8").length !== data.length) throw new SandboxRouterError("unsupported", "binary write", "koyeb");
    const { exe } = await connect(id, ctx);
    checkExecutorError(await executorPost(exe, "/write_file", { path, content: text }, ctx), path, "write_file");
  },

  async getUrl(id, port, ctx) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new SandboxRouterError("invalid", `koyeb: port must be an integer between 1 and 65535, got ${port}`, "koyeb");
    const { exe, deployment, appId } = await connect(id, ctx);
    // expose_port: unbind whatever port was exposed (no port in the body), then bind this one.
    await executorPost(exe, "/unbind_port", {}, ctx);
    await executorPost(exe, "/bind_port", { port: String(port) }, ctx);
    const a = address(deployment);
    if (!a) return `https://${await appDomain(ctx, appId)}`;
    const url = new URL(a.publicUrl.includes("://") ? a.publicUrl : `https://${a.publicUrl}`);
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/r/${a.routingKey}/`;
    return url.toString();
  },

  async kill(id, ctx) {
    // The sandbox owns its app (create made it), so deleting the app deletes everything.
    const service = await getService(ctx, id);
    await deleteApp(ctx, service.app_id);
  },
});
