// Archil Sandboxes (archil.com): persistent Firecracker microVMs whose root filesystem is an Archil
// disk. Free plan, no card: 1 vCPU-hour + 2 GiB-hours of sandbox compute a month (one hour at the
// default 1 vCPU / 2 GiB, $0.095), hard caps, 5 concurrent, sessions of at most 30 minutes, a
// managed egress allowlist. Developer/Team: $0.055 per vCPU-hour + $0.020 per GiB-hour, allocated,
// sampled each minute; paused and stopped sandboxes pay only disk storage.
// REST: https://control.green.us-east-1.aws.prod.archil.com (one host per region, Bearer key-…),
// OpenAPI at docs.archil.com/api-reference/openapi.yaml; docs docs.archil.com/llms.txt,
// /compute/sandboxes/introduction.md, /administration/billing.md, /reference/limits.md.
// Lifecycle goes over REST. Commands don't: the process API is a WebSocket protocol only the SDK
// speaks (npm `disk`, Node 22.19+), so exec loads it. Files use the router's exec fallback, as the
// SDK's own file calls do. A sandbox is deleted only once stopped, so kill stops it first.
// `max_ttl_seconds` pauses rather than deletes (memory kept, disk billed), so the router deletes
// at the deadline (enforcesTimeout: false). Responses are `{success, data}` / `{success, error, code}`.

import { defineProvider, http, httpJson, HttpError, loadSdk } from "./util.js";
import { pollMs, sbrName, sleep } from "./rest-helpers.js";
import type { ProviderContext } from "../core/types.js";

const REGIONS: Record<string, string> = {
  "aws-us-east-1": "https://control.green.us-east-1.aws.prod.archil.com",
  "aws-us-west-2": "https://control.green.us-west-2.aws.prod.archil.com",
  "aws-eu-west-1": "https://control.green.eu-west-1.aws.prod.archil.com",
  "gcp-us-central1": "https://control.blue.us-central1.gcp.prod.archil.com",
};
const region = (ctx: ProviderContext) => String(ctx.env["ARCHIL_REGION"] ?? "aws-us-east-1");
const base = (ctx: ProviderContext) => {
  const url = ctx.env["ARCHIL_API_URL"] ?? REGIONS[region(ctx)];
  if (!url) throw new Error(`archil: unknown region ${region(ctx)} (one of ${Object.keys(REGIONS).join(", ")})`);
  return String(url).replace(/\/+$/, "");
};
const auth = (ctx: ProviderContext) => ({ authorization: `Bearer ${ctx.env["ARCHIL_API_KEY"]}` });
const box = (ctx: ProviderContext, id: string, path = "") => `${base(ctx)}/api/sandboxes/${encodeURIComponent(id)}${path}`;
const gone = (err: unknown) => err instanceof HttpError && (err.status === 404 || err.status === 410);
const conflict = (err: unknown) => err instanceof HttpError && err.status === 409;

interface Sandbox {
  sandbox_id: string;
  name: string;
  status: string;
  vcpu_count?: number;
  mem_size_mib?: number;
  exit_reason?: string;
}
const one = async (ctx: ProviderContext, id: string) => (await httpJson<{ data: Sandbox }>(box(ctx, id), { headers: auth(ctx) })).data;
const INACTIVE = ["stopped", "exited", "failed"];

/** The slice of the `disk` SDK the adapter uses. */
interface ArchilSdk {
  Archil: new (opts: { apiKey?: string; region?: string; baseUrl?: string }) => {
    sandboxes: {
      get(id: string): Promise<{
        exec(command: string, opts?: { cwd?: string; env?: Record<string, string>; timeoutSeconds?: number }): Promise<{ status: string; exitCode?: number; stdout: string; stderr: string }>;
      }>;
    };
  };
}

export const archilProvider = defineProvider({
  info: {
    id: "archil",
    name: "Archil Sandboxes",
    homepage: "https://archil.com",
    env: ["ARCHIL_API_KEY"],
    sdkPackage: "disk",
    capabilities: ["ports", "pause", "customImage", "snapshot", "extendTimeout"],
    isolation: "microvm",
    enforcesTimeout: false,
    maxTimeoutSec: 86_400,
    freeTier: {
      // 1 vCPU-hour ($0.055) + 2 GiB-hours ($0.04).
      tier: { kind: "monthly-credit", usd: 0.095 },
      concurrency: 5,
      maxLifetimeSec: 1800,
      requiresCard: false,
      notes: "Free plan: 1 vCPU-hour and 2 GiB-hours of sandbox compute a month (one hour at 1 vCPU / 2 GiB), hard caps with no overage, 5 concurrent, sessions of at most 30 minutes, outbound traffic limited to a managed allowlist. Developer has a $10 monthly minimum.",
      source: "https://docs.archil.com/administration/billing.md",
      checked: "2026-11-21",
    },
    // 2 vCPU / 4 GiB is $0.19/h.
    pricing: { vcpuSecondUsd: 0.055 / 3600, gibSecondUsd: 0.02 / 3600, defaultCpu: 1, defaultMemoryMiB: 2048, source: "https://docs.archil.com/administration/billing.md" },
    surfaces: { rest: "https://control.green.us-east-1.aws.prod.archil.com/api", sdk: ["disk (npm)", "archil (PyPI)"], cli: "disk" },
  },

  async create(spec, ctx) {
    const vcpu_count = Math.min(32, Math.max(1, Math.ceil(spec.cpu)));
    const mem_size_mib = Math.min(65_536, Math.max(256, Math.ceil(spec.memoryMiB)));
    const name = sbrName(spec);
    const native = spec.nativeTemplate;
    let made: Sandbox;
    try {
      made = (
        await httpJson<{ data: Sandbox }>(`${base(ctx)}/api/sandboxes?wait=true`, {
          headers: auth(ctx),
          body: {
            name,
            vcpu_count,
            mem_size_mib,
            // A built image's 64-hex id, or any public OCI reference.
            ...(native && /^[0-9a-f]{64}$/.test(native) ? { image_id: native } : native || spec.image ? { base_image: native ?? spec.image } : {}),
            env: spec.env,
            max_ttl_seconds: Math.min(86_400, Math.max(60, Math.ceil(spec.timeoutSec))),
            // No idle pause: a command between router calls would find it paused.
            idle_ttl_seconds: 0,
          },
          timeoutMs: 300_000,
        })
      ).data;
    } catch (err) {
      // Names are unique per account and come from the router id: a retried create finds its sandbox.
      if (!(err instanceof HttpError && err.status === 409 && /name/.test(err.message))) throw err;
      const list = await httpJson<{ data: { sandboxes: Sandbox[] } }>(`${base(ctx)}/api/sandboxes`, { headers: auth(ctx) });
      const found = list.data.sandboxes.find((s) => s.name === name);
      if (!found) throw err;
      made = found;
    }
    const id = made.sandbox_id;
    try {
      let cur = made;
      for (let i = 0; i < 600 && cur.status !== "running"; i++) {
        if (cur.status !== "pending") throw new Error(`archil sandbox ${id} is ${cur.status}${cur.exit_reason ? `: ${cur.exit_reason}` : ""}`);
        await sleep(pollMs(ctx, 1000));
        cur = await one(ctx, id);
      }
      if (cur.status !== "running") throw new Error(`archil sandbox ${id} did not start`);
      return { providerSandboxId: id, cpu: cur.vcpu_count ?? vcpu_count, memoryMiB: cur.mem_size_mib ?? mem_size_mib };
    } catch (err) {
      await this.kill(id, ctx).catch(() => undefined);
      throw err;
    }
  },

  async exec(id, command, o, ctx) {
    const { Archil } = await loadSdk<ArchilSdk>("disk", "archil");
    const client = new Archil({ apiKey: ctx.env["ARCHIL_API_KEY"], region: region(ctx), ...(ctx.env["ARCHIL_API_URL"] ? { baseUrl: ctx.env["ARCHIL_API_URL"] } : {}) });
    const sbx = await client.sandboxes.get(id);
    const r = await sbx.exec(command, {
      ...(o.cwd ? { cwd: o.cwd } : {}),
      ...(o.env && Object.keys(o.env).length ? { env: o.env } : {}),
      ...(o.timeoutSec ? { timeoutSeconds: Math.ceil(o.timeoutSec) } : {}),
    });
    if (r.stdout) o.onStdout?.(r.stdout);
    if (r.stderr) o.onStderr?.(r.stderr);
    return { stdout: r.stdout, stderr: r.stderr, exitCode: r.status === "timed_out" ? 124 : r.exitCode ?? -1 };
  },

  async getUrl(id, port, ctx) {
    const r = await httpJson<{ data: { hostname: string } }>(box(ctx, id, `/ports/${port}`), { method: "PUT", headers: auth(ctx) });
    return `https://${r.data.hostname}`;
  },

  async setTimeout(id, timeoutSec, ctx) {
    // From now, capped at 24 hours after the current session started.
    await http(box(ctx, id, "/timeout"), { headers: auth(ctx), body: { timeout: Math.min(86_400, Math.max(60, Math.ceil(timeoutSec))) } });
  },

  async pause(id, ctx) {
    await http(box(ctx, id, "/pause"), { method: "POST", headers: auth(ctx), timeoutMs: 180_000 });
  },

  async resume(id, ctx) {
    await http(`${box(ctx, id, "/resume")}?wait=true`, { method: "POST", headers: auth(ctx), timeoutMs: 180_000 });
  },

  async kill(id, ctx) {
    // Only a stopped, exited or failed sandbox can be deleted: stop it, wait, then delete.
    try {
      await http(box(ctx, id, "/stop"), { method: "POST", headers: auth(ctx), timeoutMs: 180_000 });
    } catch (err) {
      if (gone(err)) return;
      if (!conflict(err)) throw err; // 409: a pause in progress; wait for it like a stop
    }
    for (let i = 0; i < 300; i++) {
      let cur: Sandbox;
      try {
        cur = await one(ctx, id);
      } catch (err) {
        if (gone(err)) return;
        throw err;
      }
      if (cur.status === "deleted") return;
      if (cur.status === "paused") await http(box(ctx, id, "/stop"), { method: "POST", headers: auth(ctx) }).catch(() => undefined);
      if (INACTIVE.includes(cur.status)) {
        try {
          await http(box(ctx, id), { method: "DELETE", headers: auth(ctx) });
          return;
        } catch (err) {
          if (gone(err)) return;
          if (!conflict(err)) throw err;
        }
      }
      await sleep(pollMs(ctx, 1000));
    }
    throw new Error(`archil sandbox ${id} did not stop to be deleted`);
  },

  async listAlive(ctx) {
    const r = await httpJson<{ data: { sandboxes: Sandbox[] } }>(`${base(ctx)}/api/sandboxes`, { headers: auth(ctx) });
    return r.data.sandboxes.filter((s) => s.status !== "deleted" && s.status !== "deleting").map((s) => s.sandbox_id);
  },
});
