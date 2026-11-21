// Namespace (namespace.so) Compute: micro-VM instances with a deadline, running one managed
// container that commands go into. No free tier (the Developer plan is $0 base, pay as you
// go, capped at 32 vCPU and 3 h per instance).
// SDK: npm `@namespacelabs/sdk` (Connect at https://{us|eu}.compute.namespaceapis.com).
// CLI: `nsc`. Credentials: NSC_TOKEN (bearer), else the SDK's defaults (NSC_TOKEN_FILE, nsc login).

import { defineProvider, loadSdk } from "./util.js";
import type { ProviderContext } from "../core/types.js";

type NsSdk = typeof import("@namespacelabs/sdk");
type NsClient = ReturnType<NsSdk["createComputeClient"]>;

const CONTAINER = "sandbox";
let client: NsClient | undefined;

async function ns(ctx: ProviderContext): Promise<NsClient> {
  if (client) return client;
  const sdk = await loadSdk<NsSdk>("@namespacelabs/sdk", "namespace");
  const token = ctx.env["NSC_TOKEN"];
  client = sdk.createComputeClient({
    tokenSource: token ? sdk.fromBearerToken(token) : await sdk.loadDefaults(),
    region: ctx.env["NSC_REGION"] ?? (ctx.options["region"] as string | undefined),
  });
  return client;
}

const deadlineIn = (sec: number) => ({ seconds: BigInt(Math.floor(Date.now() / 1000) + sec), nanos: 0 });
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

export const namespaceProvider = defineProvider({
  info: {
    id: "namespace",
    name: "Namespace",
    homepage: "https://namespace.so",
    env: ["NSC_TOKEN"],
    sdkPackage: "@namespacelabs/sdk",
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
    const c = await ns(ctx);
    const vcpu = Math.max(1, Math.round(spec.cpu));
    const res = await c.compute.createInstance({
      shape: { os: "linux", machineArch: String(ctx.options["arch"] ?? "amd64"), virtualCpu: vcpu, memoryMegabytes: spec.memoryMiB },
      deadline: deadlineIn(spec.timeoutSec),
      documentedPurpose: "sandboxrouting",
      labels: Object.entries(spec.metadata).map(([name, value]) => ({ name, value })),
      containers: [
        {
          name: CONTAINER,
          imageRef: spec.nativeTemplate ?? spec.image ?? "ubuntu:24.04",
          args: ["sleep", "infinity"],
          envVars: Object.entries(spec.env).map(([name, value]) => ({ name, value })),
        },
      ],
    });
    const instanceId = res.metadata?.instanceId;
    if (!instanceId) throw new Error("namespace: createInstance returned no instance id");
    await c.compute.waitInstanceSync({ instanceId }, { timeoutMs: 180_000 });
    return { providerSandboxId: instanceId, cpu: vcpu, memoryMiB: spec.memoryMiB };
  },

  async exec(id, command, o, ctx) {
    const c = await ns(ctx);
    const r = await c.command.runCommandSync(
      {
        instanceId: id,
        targetContainerName: CONTAINER,
        command: { command: ["sh", "-c", command], cwd: o.cwd ?? "", envVars: Object.entries(o.env ?? {}).map(([name, value]) => ({ name, value })) },
      },
      { timeoutMs: (o.timeoutSec ?? 3600) * 1000 },
    );
    const stdout = dec(r.stdout);
    const stderr = dec(r.stderr);
    if (stdout) o.onStdout?.(stdout);
    if (stderr) o.onStderr?.(stderr);
    return { stdout, stderr, exitCode: r.exitCode };
  },

  async setTimeout(id, timeoutSec, ctx) {
    await (await ns(ctx)).compute.extendInstance({ instanceId: id, newDeadline: deadlineIn(timeoutSec) });
  },

  async kill(id, ctx) {
    await (await ns(ctx)).compute.destroyInstance({ instanceId: id, reason: "sandboxrouting kill" });
  },

  async listAlive(ctx) {
    const res = await (await ns(ctx)).compute.listInstances({});
    return res.instances.filter((i) => i.status !== 4 /* DESTROYED */).map((i) => i.instanceId);
  },
});
