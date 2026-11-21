// Google Cloud Run sandboxes (Preview, July 2026): isolated sandboxes started from inside a Cloud
// Run container with the `sandbox` CLI, sharing that container's CPU and memory at no extra
// charge. There is no API to start one from outside, so each router sandbox is one Cloud Run
// *instance* (Preview: a singleton, addressable container) created through the Admin API from
// the image in templates/cloud-run-sandbox, whose execd runs every command in a detached
// sandbox with `sandbox exec`.
//   https://docs.cloud.google.com/run/docs/code-execution
//   https://docs.cloud.google.com/run/docs/reference/sandbox-cli
//   https://docs.cloud.google.com/run/docs/configuring/instances/sandboxes   (sandboxLauncher)
//   https://docs.cloud.google.com/run/docs/instances/create-and-manage-instances
//   https://run.googleapis.com/$discovery/rest?version=v2   (projects.locations.instances, rev 20261108)
//     POST   /v2/projects/{p}/locations/{r}/instances?instanceId=…   → Operation
//     GET    /v2/projects/{p}/locations/{r}/instances/{name}         {terminalCondition, urls, containers}
//     GET    /v2/projects/{p}/locations/{r}/instances?pageToken=…    {instances, nextPageToken}
//     DELETE /v2/projects/{p}/locations/{r}/instances/{name}
// Instances aren't offered in us-central1, us-east1 or europe-west1. Billing is Cloud Run's
// instance-based rate; the monthly free tier is a spending discount at Tier 1 prices.
// Cloud Run's first generation runs on gVisor (the second on microVMs), so it claims gvisor.

import { randomBytes } from "node:crypto";
import { SandboxRouterError } from "../core/errors.js";
import { defineProvider, http, HttpError, httpJson } from "./util.js";
import { pollMs, sbrName, sleep } from "./rest-helpers.js";
import { googleAccessToken, googleIdToken, hasGoogleCredentials } from "./google-auth.js";
import type { ProviderContext, ResolvedSpec } from "../core/types.js";

const ID = "cloudrun";
/** The label every router-made instance carries, so the sweep lists only those. */
const LABEL = "sandboxrouting";

const api = (ctx: ProviderContext) => String(ctx.env["CLOUD_RUN_API_URL"] ?? "https://run.googleapis.com").replace(/\/+$/, "");
const parent = (ctx: ProviderContext) => `projects/${ctx.env["GOOGLE_CLOUD_PROJECT"]}/locations/${ctx.env["CLOUD_RUN_REGION"]}`;
const instances = (ctx: ProviderContext) => `${api(ctx)}/v2/${parent(ctx)}/instances`;
const instance = (ctx: ProviderContext, id: string) => `${instances(ctx)}/${encodeURIComponent(id)}`;
const auth = async (ctx: ProviderContext) => ({ authorization: `Bearer ${await googleAccessToken(ctx, ID)}` });

/** Cloud Run sizes: 1, 2, 4 or 8 vCPU; 4 vCPU needs 2 GiB and 8 needs 4 GiB; memory in 512 MiB steps. */
export function cloudRunSize(cpu: number, memoryMiB: number): { cpu: number; memoryMiB: number } {
  const c = [1, 2, 4, 8].find((n) => n >= cpu) ?? 8;
  const floor = c >= 8 ? 4096 : c >= 4 ? 2048 : 512;
  const mem = Math.min(32768, Math.max(floor, Math.ceil(memoryMiB / 512) * 512));
  return { cpu: c, memoryMiB: mem };
}

interface Condition {
  type?: string;
  state?: string;
  reason?: string;
  message?: string;
}
interface Instance {
  name: string;
  labels?: Record<string, string>;
  urls?: string[];
  terminalCondition?: Condition;
  conditions?: Condition[];
  deleteTime?: string;
  containers?: { env?: { name: string; value?: string }[] }[];
}
interface Operation {
  name?: string;
  done?: boolean;
  error?: { code?: number; message?: string };
}

/** The create body: one sandbox-launching container from the execd image. */
export function cloudRunInstanceBody(spec: ResolvedSpec, ctx: ProviderContext, token: string) {
  const size = cloudRunSize(spec.cpu, spec.memoryMiB);
  const iam = Boolean(ctx.options["invokerIam"]);
  const env: Record<string, string> = {
    SBR_TOKEN: token,
    SBR_DEADLINE: String(Math.ceil(Date.now() / 1000 + spec.timeoutSec)),
    SBR_ALLOW_EGRESS: ctx.options["allowEgress"] === false ? "0" : "1",
    SBR_ENV: Buffer.from(JSON.stringify(spec.env)).toString("base64"),
  };
  const serviceAccount = ctx.options["serviceAccount"] ?? ctx.env["CLOUD_RUN_SERVICE_ACCOUNT"];
  return {
    body: {
      labels: { [LABEL]: "sbr" },
      launchStage: "BETA",
      ingress: "INGRESS_TRAFFIC_ALL",
      invokerIamDisabled: !iam,
      // When execd exits at the deadline the instance stops instead of starting again.
      restartPolicy: "NEVER",
      ...(serviceAccount ? { serviceAccount: String(serviceAccount) } : {}),
      containers: [
        {
          image: spec.nativeTemplate ?? String(ctx.options["image"] ?? ctx.env["CLOUD_RUN_SANDBOX_IMAGE"]),
          sandboxLauncher: true,
          ports: [{ containerPort: 8080 }],
          env: Object.entries(env).map(([name, value]) => ({ name, value })),
          resources: { limits: { cpu: String(size.cpu), memory: `${size.memoryMiB}Mi` }, cpuIdle: false },
        },
      ],
    },
    size,
  };
}

/** Where an instance's execd answers and the token it wants, read back from the instance. */
const access = new Map<string, { url: string; token: string }>();
async function execd(ctx: ProviderContext, id: string): Promise<{ url: string; headers: Record<string, string> }> {
  const key = `${parent(ctx)}/${id}`;
  let a = access.get(key);
  if (!a) {
    const inst = await httpJson<Instance>(instance(ctx, id), { headers: await auth(ctx) });
    const url = inst.urls?.[0];
    const token = inst.containers?.[0]?.env?.find((e) => e.name === "SBR_TOKEN")?.value;
    if (!url || !token) throw new SandboxRouterError("transient", `cloudrun instance ${id} has no URL or token yet`, ID);
    a = { url: url.replace(/\/+$/, ""), token };
    access.set(key, a);
  }
  const headers: Record<string, string> = { "x-sbr-token": a.token };
  if (ctx.options["invokerIam"]) headers["authorization"] = `Bearer ${await googleIdToken(ctx, ID, a.url)}`;
  return { url: a.url, headers };
}

/** Waits for the instance's Ready condition, then for execd's sandbox; a failure on the way throws. */
async function waitReady(ctx: ProviderContext, id: string, limitMs: number): Promise<void> {
  const deadline = Date.now() + limitMs;
  for (;;) {
    const inst = await httpJson<Instance>(instance(ctx, id), { headers: await auth(ctx) });
    const c = inst.terminalCondition;
    if (c?.state === "CONDITION_FAILED") throw new Error(`cloudrun instance ${id} failed: ${c.reason ?? ""} ${c.message ?? ""}`.trim());
    if (c?.state === "CONDITION_SUCCEEDED" && inst.urls?.length) break;
    if (Date.now() > deadline) throw new SandboxRouterError("transient", `cloudrun instance ${id} not ready after ${limitMs / 1000} s`, ID);
    await sleep(pollMs(ctx, 2000));
  }
  for (;;) {
    const e = await execd(ctx, id);
    try {
      await http(`${e.url}/health`, { headers: e.headers, timeoutMs: 10_000 });
      return;
    } catch (err) {
      // 500 is execd saying `sandbox run` failed: final. Anything else may still be starting.
      if (err instanceof HttpError && err.status === 500) throw new Error(`cloudrun sandbox in ${id} failed to start: ${err.message}`);
      if (err instanceof HttpError && (err.status === 401 || err.status === 403)) throw err;
      if (Date.now() > deadline) throw err;
      await sleep(pollMs(ctx, 1000));
    }
  }
}

async function remove(ctx: ProviderContext, id: string): Promise<void> {
  access.delete(`${parent(ctx)}/${id}`);
  try {
    await http(instance(ctx, id), { method: "DELETE", headers: await auth(ctx) });
  } catch (err) {
    if (err instanceof HttpError && (err.status === 404 || err.status === 410)) return;
    throw err;
  }
}

export const cloudrunProvider = defineProvider({
  info: {
    id: ID,
    name: "Google Cloud Run sandboxes",
    homepage: "https://cloud.google.com/run",
    // Plus a credential: GOOGLE_OAUTH_ACCESS_TOKEN or GOOGLE_APPLICATION_CREDENTIALS(_JSON).
    env: ["GOOGLE_CLOUD_PROJECT", "CLOUD_RUN_REGION", "CLOUD_RUN_SANDBOX_IMAGE"],
    capabilities: [],
    isolation: "gvisor",
    // No TTL on instances: the router deletes at the deadline (execd also stops itself then).
    enforcesTimeout: false,
    freeTier: {
      // 240,000 vCPU-s × $0.000018 + 450,000 GiB-s × $0.000002, applied as a spending discount.
      tier: { kind: "monthly-credit", usd: 5.22 },
      requiresCard: true,
      notes:
        "Instance-based free tier: 240,000 vCPU-seconds + 450,000 GiB-seconds a month per billing account (≈ 31 h at 2 vCPU / 4 GiB). Needs a billing account. Sandboxes and instances are Preview.",
      source: "https://cloud.google.com/run/pricing",
      checked: "2026-11-21",
    },
    pricing: { vcpuSecondUsd: 0.000018, gibSecondUsd: 0.000002, defaultCpu: 2, defaultMemoryMiB: 4096, source: "https://cloud.google.com/run/pricing" },
    surfaces: { rest: "https://run.googleapis.com/v2 (instances) + execd", sdk: ["@google-cloud/run (InstancesClient)"], cli: "gcloud beta run instances" },
  },

  isConfigured(ctx) {
    return Boolean(ctx.env["GOOGLE_CLOUD_PROJECT"] && ctx.env["CLOUD_RUN_REGION"] && (ctx.options["image"] || ctx.env["CLOUD_RUN_SANDBOX_IMAGE"]) && hasGoogleCredentials(ctx));
  },

  async create(spec, ctx) {
    // The router id names the instance, so a retried create finds the one the first try made.
    const id = sbrName(spec);
    const { body, size } = cloudRunInstanceBody(spec, ctx, randomBytes(24).toString("hex"));
    let op: Operation | undefined;
    try {
      op = await httpJson<Operation>(`${instances(ctx)}?instanceId=${encodeURIComponent(id)}`, { headers: await auth(ctx), body });
    } catch (err) {
      if (!(err instanceof HttpError && err.status === 409)) throw err;
    }
    try {
      if (op?.done && op.error) throw new Error(`cloudrun create ${id}: ${op.error.message ?? `code ${op.error.code}`}`);
      await waitReady(ctx, id, Number(ctx.options["readyTimeoutSec"] ?? 300) * 1000);
    } catch (err) {
      await remove(ctx, id).catch(() => undefined);
      throw err;
    }
    return { providerSandboxId: id, cpu: size.cpu, memoryMiB: size.memoryMiB };
  },

  async exec(id, command, o, ctx) {
    const e = await execd(ctx, id);
    const r = await httpJson<{ stdout: string; stderr: string; exitCode: number }>(`${e.url}/exec`, {
      headers: e.headers,
      body: { command, cwd: o.cwd, env: o.env, timeoutSec: o.timeoutSec },
      timeoutMs: ((o.timeoutSec ?? 3600) + 30) * 1000,
    });
    if (r.stdout) o.onStdout?.(r.stdout);
    if (r.stderr) o.onStderr?.(r.stderr);
    return r;
  },

  async kill(id, ctx) {
    await remove(ctx, id);
  },

  async listAlive(ctx) {
    const ids: string[] = [];
    let pageToken = "";
    do {
      const page = await httpJson<{ instances?: Instance[]; nextPageToken?: string }>(
        `${instances(ctx)}?pageSize=100${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`,
        { headers: await auth(ctx) },
      );
      for (const inst of page.instances ?? []) {
        if (inst.labels?.[LABEL] === "sbr" && !inst.deleteTime) ids.push(inst.name.split("/").pop()!);
      }
      pageToken = page.nextPageToken ?? "";
    } while (pageToken);
    return ids;
  },
});
