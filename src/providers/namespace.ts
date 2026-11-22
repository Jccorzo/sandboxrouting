// Namespace (namespace.so) Compute: micro-VM instances with a deadline, running one managed
// container that commands go into. No free tier (the Developer plan is $0 base, pay as you
// go, capped at 32 vCPU and 3 h per instance).
// Spoken over HTTP, no SDK: the Connect (JSON) calls the official SDK (npm `@namespacelabs/sdk`
// 1.6.0, Apache-2.0) makes to https://{us|eu}.compute.namespaceapis.com, services
// namespace.cloud.compute.v1beta.ComputeService and CommandService. API docs:
// https://buf.build/namespace/cloud/docs/main:namespace.cloud.compute.v1beta. CLI: `nsc`.
// NSC_API_URL overrides the base URL.
// Credentials: NSC_TOKEN (bearer), else the token file the SDK's `loadDefaults` reads
// (NSC_TOKEN_FILE, /var/run/nsc/token.json, or the `nsc login` file in the user config dir).

import { access, readFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { defineProvider } from "./util.js";
import { connectUnary } from "./connect-rpc.js";
import { SandboxRouterError } from "../core/errors.js";
import type { ProviderContext } from "../core/types.js";

const CONTAINER = "sandbox";
const COMPUTE = "namespace.cloud.compute.v1beta.ComputeService";
const COMMAND = "namespace.cloud.compute.v1beta.CommandService";
const ISSUE_FROM_SESSION = "namespace.private.sessions.v1beta.UserSessionsService/IssueTenantTokenFromSession";
/** The validity the SDK wants left on a token it sends (TOKEN_MIN_VALIDITY_MS). */
const MIN_VALIDITY_MS = 5 * 60_000;

const region = (ctx: ProviderContext) => String(ctx.env["NSC_REGION"] || ctx.options["region"] || "us");
const baseUrl = (ctx: ProviderContext) => ctx.env["NSC_API_URL"] || `https://${region(ctx)}.compute.namespaceapis.com`;
const iamUrl = (ctx: ProviderContext) => ctx.env["NSC_IAM_ENDPOINT"] || ctx.env["NSC_GLOBAL_ENDPOINT"] || "https://private-api.global.namespaceapis.com";

/** A JWT's claims, unverified, after the SDK's known token prefixes; {} when it isn't one. */
function claims(token: string): { exp?: number; tenant_id?: string } {
  const payload = token.replace(/^(st_|nsct_|nscw_|oidc_|cognito_)/, "").split(".");
  if (payload.length !== 3) return {};
  try {
    return JSON.parse(Buffer.from(payload[1]!, "base64url").toString("utf8")) as { exp?: number; tenant_id?: string };
  } catch {
    return {};
  }
}
/** Whether a token has MIN_VALIDITY_MS left; one without `exp` never expires. */
const fresh = (token: string) => {
  const exp = claims(token).exp;
  return exp === undefined || exp * 1000 > Date.now() + MIN_VALIDITY_MS;
};

/** Where `loadDefaults` looks, in its order: NSC_TOKEN_FILE, the workload token, the `nsc login` file. */
async function tokenFile(ctx: ProviderContext): Promise<string> {
  if (ctx.env["NSC_TOKEN_FILE"]) return ctx.env["NSC_TOKEN_FILE"];
  const workload = "/var/run/nsc/token.json";
  if (await access(workload).then(() => true, () => false)) return workload;
  const os = platform();
  const config =
    os === "darwin"
      ? join(homedir(), "Library/Application Support")
      : os === "win32"
        ? ctx.env["APPDATA"] || join(homedir(), "AppData/Roaming")
        : ctx.env["XDG_CONFIG_HOME"] || join(homedir(), ".config");
  return join(config, "ns/token.json");
}

/** Tokens taken from a token file, by its path; reused while they have MIN_VALIDITY_MS left. */
const fromFiles = new Map<string, string>();

/**
 * A token from the file, as the SDK's LoadedToken issues one: its bearer token as is, or for a
 * session token (what `nsc login` leaves) a tenant token from the cache `nsc` keeps next to it,
 * else a new 10-minute one from the IAM API.
 */
async function tokenFromFile(ctx: ProviderContext, path: string): Promise<string> {
  const hit = fromFiles.get(path);
  if (hit && fresh(hit)) return hit;
  let file: { bearer_token?: string; session_token?: string };
  try {
    file = JSON.parse(await readFile(path, "utf8")) as typeof file;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new SandboxRouterError("auth", "namespace: you are not logged in to Namespace; set NSC_TOKEN or run `nsc login`", "namespace", { cause: err });
    }
    throw err;
  }
  let token: string;
  if (file.session_token) {
    const session = file.session_token;
    const cached = await readFile(join(dirname(path), "token.cache"), "utf8").catch(() => "");
    const c = claims(cached);
    if (c.tenant_id && c.tenant_id === claims(session).tenant_id && (c.exp ?? 0) * 1000 > Date.now() + MIN_VALIDITY_MS) token = cached;
    else {
      // The SDK asks for twice the validity it needs, capped at an hour.
      const res = await connectUnary<{ tenantToken?: string }>(
        iamUrl(ctx),
        ISSUE_FROM_SESSION,
        { tokenDuration: `${(2 * MIN_VALIDITY_MS) / 1000}s` },
        { headers: { authorization: `Bearer ${session}` } },
      );
      if (!res.tenantToken) throw new Error("namespace: IssueTenantTokenFromSession returned no token");
      token = res.tenantToken;
    }
  } else if (file.bearer_token) token = file.bearer_token;
  else throw new SandboxRouterError("auth", `namespace: ${path} holds no bearer or session token`, "namespace");
  fromFiles.set(path, token);
  return token;
}

const bearer = async (ctx: ProviderContext) => ctx.env["NSC_TOKEN"] || tokenFromFile(ctx, await tokenFile(ctx));

/** A unary call; `timeoutMs` is sent as the Connect deadline too. */
async function call<T>(ctx: ProviderContext, method: string, request: unknown, timeoutMs?: number): Promise<T> {
  return connectUnary<T>(baseUrl(ctx), method, request, { headers: { authorization: `Bearer ${await bearer(ctx)}` }, timeoutMs });
}

/** A protobuf Timestamp in JSON: RFC 3339, whole seconds as the SDK sends them. */
const deadlineIn = (sec: number) => new Date((Math.floor(Date.now() / 1000) + sec) * 1000).toISOString().replace(".000Z", "Z");
const pairs = (m: Record<string, string>) => Object.entries(m).map(([name, value]) => ({ name, value }));
/** protobuf JSON `bytes`: base64, left out when empty. */
const text = (b64: string | undefined) => (b64 ? Buffer.from(b64, "base64").toString("utf8") : "");

interface InstanceMetadata {
  instanceId: string;
  /** The enum's name in JSON; a number if the server sends one. */
  status?: string | number;
}

export const namespaceProvider = defineProvider({
  info: {
    id: "namespace",
    name: "Namespace",
    homepage: "https://namespace.so",
    env: ["NSC_TOKEN"],
    capabilities: ["customImage", "extendTimeout"],
    isolation: "microvm",
    maxTimeoutSec: 3 * 3600,
    freeTier: {
      tier: { kind: "none" },
      notes: "Developer plan: $0 base, pay as you go, 32 vCPU concurrency, 3 h max instance life. A 30-day free trial (no card) isn't counted as free usage.",
      source: "https://namespace.so/pricing",
      checked: "2026-11-21",
    },
    // One unit = 1 vCPU + 2 GB for a minute at $0.0015 (overage rate): $0.000025/vCPU-s incl. memory.
    pricing: { vcpuSecondUsd: 0.000025, gibSecondUsd: 0, defaultCpu: 2, defaultMemoryMiB: 4096, source: "https://namespace.so/pricing" },
    surfaces: { rest: "https://{us|eu}.compute.namespaceapis.com (Connect)", sdk: ["@namespacelabs/sdk (npm)", "Go SDK"], cli: "nsc" },
  },

  async create(spec, ctx) {
    const vcpu = Math.max(1, Math.round(spec.cpu));
    // The SDK sets no deadline here; an image that isn't pinned is resolved during the call.
    const res = await call<{ metadata?: InstanceMetadata }>(
      ctx,
      `${COMPUTE}/CreateInstance`,
      {
        shape: { os: "linux", machineArch: String(ctx.options["arch"] ?? "amd64"), virtualCpu: vcpu, memoryMegabytes: spec.memoryMiB },
        deadline: deadlineIn(spec.timeoutSec),
        documentedPurpose: "sandboxrouting",
        labels: pairs(spec.metadata),
        containers: [{ name: CONTAINER, imageRef: spec.nativeTemplate ?? spec.image ?? "ubuntu:24.04", args: ["sleep", "infinity"], envVars: pairs(spec.env) }],
      },
      600_000,
    );
    const instanceId = res.metadata?.instanceId;
    if (!instanceId) throw new Error("namespace: createInstance returned no instance id");
    // Returns once the instance is RUNNING.
    await call(ctx, `${COMPUTE}/WaitInstanceSync`, { instanceId }, 180_000);
    return { providerSandboxId: instanceId, cpu: vcpu, memoryMiB: spec.memoryMiB };
  },

  async exec(id, command, o, ctx) {
    const r = await call<{ stdout?: string; stderr?: string; exitCode?: number }>(
      ctx,
      `${COMMAND}/RunCommandSync`,
      {
        instanceId: id,
        targetContainerName: CONTAINER,
        command: { command: ["sh", "-c", command], envVars: pairs(o.env ?? {}), ...(o.cwd ? { cwd: o.cwd } : {}) },
      },
      (o.timeoutSec ?? 3600) * 1000,
    );
    // One response with all the output: the callbacks get it at the end, in one piece each.
    const stdout = text(r.stdout);
    const stderr = text(r.stderr);
    if (stdout) o.onStdout?.(stdout);
    if (stderr) o.onStderr?.(stderr);
    return { stdout, stderr, exitCode: r.exitCode ?? 0 };
  },

  async setTimeout(id, timeoutSec, ctx) {
    await call(ctx, `${COMPUTE}/ExtendInstance`, { instanceId: id, newDeadline: deadlineIn(timeoutSec) });
  },

  async kill(id, ctx) {
    await call(ctx, `${COMPUTE}/DestroyInstance`, { instanceId: id, reason: "sandboxrouting kill" });
  },

  async listAlive(ctx) {
    // Without includeCompleteRuns the API lists only PENDING, CREATING and RUNNING instances.
    const res = await call<{ instances?: InstanceMetadata[] }>(ctx, `${COMPUTE}/ListInstances`, {});
    return (res.instances ?? []).filter((i) => i.status !== "DESTROYED" && i.status !== 4).map((i) => i.instanceId);
  },
});
