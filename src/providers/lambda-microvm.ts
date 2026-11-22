// AWS Lambda MicroVMs: Firecracker microVMs (ARM64, up to 16 vCPU / 32 GB, 8 h max) with
// suspend/resume. No free tier. The API creates, suspends and terminates VMs but has no
// exec: the only way in is the VM's HTTPS endpoint (auth token + port headers). So sandboxes
// run the image in templates/aws-lambda-microvm, whose execd server runs commands and moves
// files; this adapter talks to it through the endpoint.
// Spoken over HTTP with SigV4 (signing name `lambda`), no SDK, with the calls the official SDK
// (npm `@aws-sdk/client-lambda-microvms` 3.1167.0, Apache-2.0) makes: REST-JSON under
// https://lambda.{region}.amazonaws.com/2025-09-09/microvms, as its schema (dist-es/schemas)
// binds each operation. Guide: https://docs.aws.amazon.com/lambda/latest/dg/lambda-microvms-guide.html.
// CLI: `aws lambda-microvms`.

import { randomUUID } from "node:crypto";
import { defineProvider, http, httpJson, HttpError } from "./util.js";
import { pollMs, sleep } from "./rest-helpers.js";
import { awsCredentials, awsRegion, rfc3986, signV4 } from "./aws-sigv4.js";
import { SandboxRouterError } from "../core/errors.js";
import type { ProviderContext } from "../core/types.js";

const EXECD_PORT = 8080;
const endpoints = new Map<string, string>();
const tokens = new Map<string, { headers: Record<string, string>; until: number }>();

interface Microvm {
  microvmId?: string;
  state?: string;
  endpoint?: string;
}

/** DNS suffixes (plain, dual-stack) of the partitions other than `aws`, by region prefix. */
const PARTITIONS: [RegExp, string, string][] = [
  [/^cn-/, "amazonaws.com.cn", "api.amazonwebservices.com.cn"],
  [/^us-isob-/, "sc2s.sgov.gov", "sc2s.sgov.gov"],
  [/^us-isof-/, "csp.hci.ic.gov", "csp.hci.ic.gov"],
  [/^us-iso-/, "c2s.ic.gov", "c2s.ic.gov"],
  [/^eu-isoe-/, "cloud.adc-e.uk", "cloud.adc-e.uk"],
  [/^eusc-/, "amazonaws.eu", "amazonaws.eu"],
];

/** The SDK's endpoint: a configured AWS_ENDPOINT_URL_LAMBDA_MICROVMS / AWS_ENDPOINT_URL, else its ruleset's. */
function endpointUrl(ctx: ProviderContext, region: string): string {
  const configured = ctx.env["AWS_ENDPOINT_URL_LAMBDA_MICROVMS"] || ctx.env["AWS_ENDPOINT_URL"];
  if (configured) return configured;
  const [, plain, dual] = PARTITIONS.find(([re]) => re.test(region)) ?? [/./, "amazonaws.com", "api.aws"];
  const fips = ctx.env["AWS_USE_FIPS_ENDPOINT"] === "true";
  const dualStack = ctx.env["AWS_USE_DUALSTACK_ENDPOINT"] === "true";
  return `https://lambda${fips ? "-fips" : ""}.${region}.${dualStack ? dual : plain}`;
}

/** The SDK's standard retry mode: 3 attempts for throttling, 5xx and network errors. */
const MAX_ATTEMPTS = 3;
const THROTTLING = new Set(["ThrottlingException", "TooManyRequestsException", "Throttling", "ThrottledException", "RequestThrottledException", "RequestThrottled", "RequestLimitExceeded", "LimitExceededException", "SlowDown", "BandwidthLimitExceeded", "PriorRequestNotComplete", "ProvisionedThroughputExceededException", "TransactionInProgressException", "EC2ThrottledException"]);
const backoff = (retries: number, throttled: boolean) => Math.floor(Math.min(20_000, Math.random() * 2 ** retries * (throttled ? 500 : 100)));

/** The error's shape name, from the x-amzn-errortype header or the body, as REST-JSON clients read it. */
function errorType(res: Response, text: string): string {
  const header = res.headers.get("x-amzn-errortype");
  if (header) return header.split(":")[0]!;
  try {
    const body = JSON.parse(text) as { code?: string; __type?: string };
    return String(body.code ?? body.__type ?? "").split("#").pop()!.split(":")[0]!;
  } catch {
    return "";
  }
}

/** One signed control-plane call. Errors are HttpErrors whose message starts with the operation and error type. */
async function aws<T>(ctx: ProviderContext, op: string, method: string, path: string, opts: { query?: Record<string, string | undefined>; body?: unknown } = {}): Promise<T> {
  const [region, credentials] = await Promise.all([awsRegion(ctx.env), awsCredentials(ctx.env)]);
  if (!region) throw new SandboxRouterError("auth", "lambda-microvm needs an AWS region: set AWS_REGION", "lambda-microvm");
  if ("missing" in credentials) throw new SandboxRouterError("auth", `lambda-microvm: ${credentials.missing}`, "lambda-microvm");
  const base = new URL(endpointUrl(ctx, region));
  const fullPath = `${base.pathname.replace(/\/+$/, "")}${path}`;
  const query = Object.entries(opts.query ?? {})
    .flatMap(([k, v]) => (v === undefined ? [] : [`${rfc3986(k)}=${rfc3986(v)}`]))
    .join("&");
  const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  const url = `${base.origin}${fullPath}${query ? `?${query}` : ""}`;
  for (let attempt = 1; ; attempt++) {
    // Signed per attempt: the signature carries the time.
    const headers = signV4(
      { method, host: base.host, path: fullPath, query, headers: body === undefined ? {} : { "content-type": "application/json" }, body },
      { region, service: "lambda", credentials, signBody: true },
    );
    let res: Response;
    try {
      res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(120_000) });
    } catch (err) {
      if (attempt < MAX_ATTEMPTS && !(err instanceof Error && err.name === "TimeoutError")) {
        await sleep(backoff(attempt - 1, false));
        continue;
      }
      throw err;
    }
    const text = await res.text();
    if (res.ok) return (text ? JSON.parse(text) : {}) as T;
    const type = errorType(res, text);
    const throttled = res.status === 429 || THROTTLING.has(type);
    if (attempt < MAX_ATTEMPTS && (throttled || res.status >= 500)) {
      await sleep(backoff(attempt - 1, throttled));
      continue;
    }
    throw new HttpError(res.status, `${op}: ${res.status} ${type ? `${type}: ` : ""}${text.slice(0, 500)}`);
  }
}

const vmPath = (id: string) => `/2025-09-09/microvms/${rfc3986(id)}`;

/** Headers that get a request through the VM's endpoint to execd, cached until near expiry. */
export async function endpointFor(id: string, ctx: ProviderContext): Promise<{ base: string; headers: Record<string, string> }> {
  let endpoint = endpoints.get(id);
  if (!endpoint) {
    const vm = await aws<Microvm>(ctx, "GetMicrovm", "GET", vmPath(id));
    endpoint = String(vm.endpoint);
    endpoints.set(id, endpoint);
  }
  let token = tokens.get(id);
  if (!token || token.until < Date.now() + 60_000) {
    const res = await aws<{ authToken?: Record<string, string> }>(ctx, "CreateMicrovmAuthToken", "POST", `${vmPath(id)}/auth-token`, {
      body: { expirationInMinutes: 60, allowedPorts: [{ port: EXECD_PORT }] },
    });
    token = { headers: { ...res.authToken, "X-aws-proxy-port": String(EXECD_PORT) }, until: Date.now() + 60 * 60_000 };
    tokens.set(id, token);
  }
  const base = endpoint.startsWith("http") ? endpoint : `https://${endpoint}`;
  return { base: base.replace(/\/+$/, ""), headers: token.headers };
}

export const lambdaMicrovmProvider = defineProvider({
  info: {
    id: "lambda-microvm",
    name: "AWS Lambda MicroVMs",
    homepage: "https://docs.aws.amazon.com/lambda/latest/dg/microvms.html",
    env: ["LAMBDA_MICROVM_IMAGE"],
    capabilities: ["pause", "fileList"],
    isolation: "microvm",
    maxTimeoutSec: 8 * 3600,
    freeTier: {
      tier: { kind: "none" },
      notes: "The Lambda free tier covers Functions only. Needs the execd image from templates/aws-lambda-microvm.",
      source: "https://aws.amazon.com/lambda/pricing/",
      checked: "2026-11-11",
    },
    pricing: { vcpuSecondUsd: 0.0000276944, gibSecondUsd: 0.0000036667, defaultCpu: 1, defaultMemoryMiB: 2048, source: "https://aws.amazon.com/lambda/pricing/" },
    surfaces: { rest: "Lambda MicroVMs API (SigV4)", sdk: ["@aws-sdk/client-lambda-microvms (npm)", "boto3 lambda-microvms"], cli: "aws lambda-microvms" },
  },

  isConfigured(ctx) {
    // The image ARN is required; AWS credentials come from the environment or a shared-file profile.
    return Boolean(ctx.env["LAMBDA_MICROVM_IMAGE"] || ctx.options["image"]);
  },

  async create(spec, ctx) {
    const image = spec.nativeTemplate ?? String(ctx.options["image"] ?? ctx.env["LAMBDA_MICROVM_IMAGE"]);
    const vm = await aws<Microvm>(ctx, "RunMicrovm", "POST", "/2025-09-09/microvms", {
      body: {
        imageIdentifier: image,
        ingressNetworkConnectors: ctx.options["ingressConnectors"] as string[] | undefined,
        egressNetworkConnectors: ctx.options["egressConnectors"] as string[] | undefined,
        runHookPayload: JSON.stringify({ env: spec.env }),
        maximumDurationInSeconds: Math.min(28_800, Math.max(1, spec.timeoutSec)),
        // An idempotency token: the SDK fills a random one when none is given.
        clientToken: spec.metadata["sandboxrouting.id"] ?? randomUUID(),
      },
    });
    const id = String(vm.microvmId);
    if (vm.endpoint) endpoints.set(id, vm.endpoint);
    for (let i = 0; i < 120; i++) {
      const cur = await aws<Microvm>(ctx, "GetMicrovm", "GET", vmPath(id));
      if (cur.state === "RUNNING") break;
      if (cur.state === "TERMINATED" || cur.state === "TERMINATING") throw new Error(`microvm ${id} ended while starting`);
      await sleep(pollMs(ctx, 1000));
    }
    return { providerSandboxId: id };
  },

  async exec(id, command, o, ctx) {
    const { base, headers } = await endpointFor(id, ctx);
    const r = await httpJson<{ stdout: string; stderr: string; exitCode: number }>(`${base}/exec`, {
      headers,
      body: { command, cwd: o.cwd, env: o.env, timeoutSec: o.timeoutSec },
      timeoutMs: ((o.timeoutSec ?? 3600) + 30) * 1000,
    });
    if (r.stdout) o.onStdout?.(r.stdout);
    if (r.stderr) o.onStderr?.(r.stderr);
    return r;
  },

  async readFile(id, path, ctx) {
    const { base, headers } = await endpointFor(id, ctx);
    return new Uint8Array(await (await http(`${base}/files?path=${encodeURIComponent(path)}`, { headers })).arrayBuffer());
  },

  async writeFile(id, path, data, ctx) {
    const { base, headers } = await endpointFor(id, ctx);
    await http(`${base}/files?path=${encodeURIComponent(path)}`, { method: "PUT", headers: { ...headers, "content-type": "application/octet-stream" }, raw: data });
  },

  async listFiles(id, path, ctx) {
    const { base, headers } = await endpointFor(id, ctx);
    const items = await httpJson<{ name: string; isDir: boolean; size?: number }[]>(`${base}/files/list?path=${encodeURIComponent(path)}`, { headers });
    const dir = path.endsWith("/") ? path : `${path}/`;
    return items.map((f) => ({ ...f, path: `${dir}${f.name}` }));
  },

  async pause(id, ctx) {
    await aws(ctx, "SuspendMicrovm", "POST", `${vmPath(id)}/suspend`);
  },

  async resume(id, ctx) {
    await aws(ctx, "ResumeMicrovm", "POST", `${vmPath(id)}/resume`);
  },

  async kill(id, ctx) {
    endpoints.delete(id);
    tokens.delete(id);
    await aws(ctx, "TerminateMicrovm", "DELETE", vmPath(id));
  },

  async listAlive(ctx) {
    const ids: string[] = [];
    let nextToken: string | undefined;
    do {
      const page = await aws<{ items?: Microvm[]; nextToken?: string }>(ctx, "ListMicrovms", "GET", "/2025-09-09/microvms", { query: { nextToken } });
      for (const vm of page.items ?? []) if (vm.state !== "TERMINATED" && vm.state !== "TERMINATING" && vm.microvmId) ids.push(vm.microvmId);
      nextToken = page.nextToken;
    } while (nextToken);
    return ids;
  },
});
