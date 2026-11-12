// AWS Lambda MicroVMs: Firecracker microVMs (ARM64, up to 16 vCPU / 32 GB, 8 h max) with
// suspend/resume. No free tier. The API creates, suspends and terminates VMs but has no
// exec: the only way in is the VM's HTTPS endpoint (auth token + port headers). So sandboxes
// run the image in templates/aws-lambda-microvm, whose execd server runs commands and moves
// files; this adapter talks to it through the endpoint.
// SDK: npm `@aws-sdk/client-lambda-microvms`. CLI: `aws lambda-microvms`.

import { defineProvider, http, httpJson, loadSdk } from "./util.js";
import type { ProviderContext } from "../core/types.js";

type MvSdk = typeof import("@aws-sdk/client-lambda-microvms");
type MvClient = InstanceType<MvSdk["LambdaMicrovmsClient"]>;

const EXECD_PORT = 8080;
let client: MvClient | undefined;
let sdkMod: MvSdk | undefined;
const endpoints = new Map<string, string>();
const tokens = new Map<string, { headers: Record<string, string>; until: number }>();

async function aws(ctx: ProviderContext): Promise<{ client: MvClient; sdk: MvSdk }> {
  sdkMod ??= await loadSdk<MvSdk>("@aws-sdk/client-lambda-microvms", "lambda-microvm");
  client ??= new sdkMod.LambdaMicrovmsClient({ region: ctx.env["AWS_REGION"] ?? ctx.env["AWS_DEFAULT_REGION"] });
  return { client, sdk: sdkMod };
}

/** Headers that get a request through the VM's endpoint to execd, cached until near expiry. */
export async function endpointFor(id: string, ctx: ProviderContext): Promise<{ base: string; headers: Record<string, string> }> {
  const { client, sdk } = await aws(ctx);
  let endpoint = endpoints.get(id);
  if (!endpoint) {
    const vm = await client.send(new sdk.GetMicrovmCommand({ microvmIdentifier: id }));
    endpoint = String(vm.endpoint);
    endpoints.set(id, endpoint);
  }
  let token = tokens.get(id);
  if (!token || token.until < Date.now() + 60_000) {
    const res = await client.send(
      new sdk.CreateMicrovmAuthTokenCommand({ microvmIdentifier: id, expirationInMinutes: 60, allowedPorts: [{ port: EXECD_PORT }] }),
    );
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
    sdkPackage: "@aws-sdk/client-lambda-microvms",
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
    // The image ARN is required; AWS credentials come from the usual chain (env, profile, role).
    return Boolean(ctx.env["LAMBDA_MICROVM_IMAGE"] || ctx.options["image"]);
  },

  async create(spec, ctx) {
    const { client, sdk } = await aws(ctx);
    const image = spec.nativeTemplate ?? String(ctx.options["image"] ?? ctx.env["LAMBDA_MICROVM_IMAGE"]);
    const vm = await client.send(
      new sdk.RunMicrovmCommand({
        imageIdentifier: image,
        maximumDurationInSeconds: Math.min(28_800, Math.max(1, spec.timeoutSec)),
        runHookPayload: JSON.stringify({ env: spec.env }),
        clientToken: spec.metadata["sandboxrouting.id"],
        ingressNetworkConnectors: ctx.options["ingressConnectors"] as string[] | undefined,
        egressNetworkConnectors: ctx.options["egressConnectors"] as string[] | undefined,
      }),
    );
    const id = String(vm.microvmId);
    if (vm.endpoint) endpoints.set(id, vm.endpoint);
    for (let i = 0; i < 120; i++) {
      const cur = await client.send(new sdk.GetMicrovmCommand({ microvmIdentifier: id }));
      if (cur.state === "RUNNING") break;
      if (cur.state === "TERMINATED" || cur.state === "TERMINATING") throw new Error(`microvm ${id} ended while starting`);
      await new Promise((r) => setTimeout(r, Number(ctx.options["pollMs"] ?? 1000)));
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
    const { client, sdk } = await aws(ctx);
    await client.send(new sdk.SuspendMicrovmCommand({ microvmIdentifier: id }));
  },

  async resume(id, ctx) {
    const { client, sdk } = await aws(ctx);
    await client.send(new sdk.ResumeMicrovmCommand({ microvmIdentifier: id }));
  },

  async kill(id, ctx) {
    const { client, sdk } = await aws(ctx);
    endpoints.delete(id);
    tokens.delete(id);
    await client.send(new sdk.TerminateMicrovmCommand({ microvmIdentifier: id }));
  },

  async listAlive(ctx) {
    const { client, sdk } = await aws(ctx);
    const ids: string[] = [];
    let nextToken: string | undefined;
    do {
      const page = await client.send(new sdk.ListMicrovmsCommand({ nextToken }));
      for (const vm of page.items ?? []) if (vm.state !== "TERMINATED" && vm.state !== "TERMINATING" && vm.microvmId) ids.push(vm.microvmId);
      nextToken = page.nextToken;
    } while (nextToken);
    return ids;
  },
});
