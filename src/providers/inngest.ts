// Inngest Sandboxes (inngest.com, open beta): Linux microVMs next to Inngest's durable functions.
// Only on Pro plans and above (403 access_denied otherwise); billed per second for vCPU
// ($0.0396/h) and memory ($0.0108 per GB-hour). Sizes are 1, 2 or 4 vCPU with 1, 2 or 4 GiB per
// vCPU. The beta gives a sandbox one hour of active runtime, then pauses it (paused time is free).
// Docs: inngest.com/docs-markdown/sandboxes/reference, /limits, /features/commands,
// /features/isolation-and-security, inngest.com/pricing. The documented surface is the TypeScript
// SDK (`inngest` 4.21.1+, `inngest.sandboxes`); this adapter speaks the REST API that SDK calls,
// read from its source (npm `inngest` 4.26.2, components/sandbox/client.js): https://api.inngest.com/v2,
// Bearer <the signing key hashed as the SDK does>. The REST contract may change without notice.
// Responses are `{data, metadata?, page?}`; errors are `{errors: [{code, message}]}`.
// Create is idempotent by name: the same active name and configuration returns the same sandbox.
// No TTL: the beta pauses a sandbox when its runtime runs out, so the router deletes it at the
// deadline (enforcesTimeout: false). A captured command waits at most five minutes.

import { createHash } from "node:crypto";
import { defineProvider, http, httpJson, HttpError } from "./util.js";
import { pollMs, sbrName, sleep } from "./rest-helpers.js";
import type { ProviderContext } from "../core/types.js";

const base = (ctx: ProviderContext) => String(ctx.env["INNGEST_API_BASE_URL"] ?? ctx.env["INNGEST_BASE_URL"] ?? "https://api.inngest.com").replace(/\/+$/, "");

/** The SDK's `hashSigningKey`: keep the `signkey-<env>-` prefix, SHA-256 the hex key's bytes. */
export function inngestApiKey(signingKey: string): string {
  const prefix = /^signkey-\w+-/.exec(signingKey)?.[0] ?? "";
  return `${prefix}${createHash("sha256")
    .update(Buffer.from(signingKey.slice(prefix.length), "hex"))
    .digest("hex")}`;
}

const auth = (ctx: ProviderContext) => ({
  authorization: `Bearer ${inngestApiKey(String(ctx.env["INNGEST_SIGNING_KEY"] ?? "").trim())}`,
  // A branch environment, as the SDK sends it.
  ...(ctx.env["INNGEST_ENV"] ? { "x-inngest-env": String(ctx.env["INNGEST_ENV"]) } : {}),
});
const box = (ctx: ProviderContext, id: string, path = "") => `${base(ctx)}/v2/sandboxes/${encodeURIComponent(id)}${path}`;
const gone = (err: unknown) => err instanceof HttpError && (err.status === 404 || err.status === 410);

/** 1, 2 or 4 vCPU; 1, 2 or 4 GiB per vCPU. */
export function inngestSize(cpu: number, memoryMiB: number): { vcpu: number; memoryMb: number } {
  const vcpu = cpu <= 1 ? 1 : cpu <= 2 ? 2 : 4;
  const perCpu = memoryMiB / vcpu;
  const gib = perCpu <= 1024 ? 1 : perCpu <= 2048 ? 2 : 4;
  return { vcpu, memoryMb: vcpu * gib * 1024 };
}

interface Sandbox {
  id: string;
  status: string;
  error?: string;
}
const STARTING = ["PENDING", "STARTING"];

export const inngestProvider = defineProvider({
  info: {
    id: "inngest",
    name: "Inngest Sandboxes",
    homepage: "https://www.inngest.com",
    env: ["INNGEST_SIGNING_KEY"],
    capabilities: ["pause", "snapshot"],
    isolation: "microvm",
    enforcesTimeout: false,
    maxTimeoutSec: 3600,
    maxExecSec: 300,
    freeTier: {
      tier: { kind: "none" },
      concurrency: 100,
      maxLifetimeSec: 3600,
      notes: "Open beta, on Pro plans and above only (the free Hobby plan has no sandboxes). Pro: 100 concurrent sandboxes; one hour of active runtime per sandbox in the beta.",
      source: "https://www.inngest.com/pricing",
      checked: "2026-11-21",
    },
    // 2 vCPU / 4 GB is $0.1224/h.
    pricing: { vcpuSecondUsd: 0.0396 / 3600, gibSecondUsd: 0.0108 / 3600, defaultCpu: 2, defaultMemoryMiB: 4096, source: "https://www.inngest.com/pricing" },
    surfaces: { rest: "https://api.inngest.com/v2/sandboxes (undocumented, used by the SDK)", sdk: ["inngest (npm, inngest.sandboxes / step.sandbox)"] },
  },

  async create(spec, ctx) {
    const size = inngestSize(spec.cpu, spec.memoryMiB);
    const r = await httpJson<{ data: Sandbox }>(`${base(ctx)}/v2/sandboxes`, {
      headers: auth(ctx),
      // Named after the router id: a retried create returns the sandbox the first one made.
      body: { name: sbrName(spec), ...size, ...(spec.nativeTemplate ? { image: spec.nativeTemplate } : {}), ...(Object.keys(spec.env).length ? { environment: spec.env } : {}) },
      timeoutMs: 180_000,
    });
    const id = r.data.id;
    try {
      let cur = r.data;
      for (let i = 0; i < 600 && cur.status !== "RUNNING"; i++) {
        if (!STARTING.includes(cur.status)) throw new Error(`inngest sandbox ${id} is ${cur.status}${cur.error ? `: ${cur.error}` : ""}`);
        await sleep(pollMs(ctx, 1000));
        cur = (await httpJson<{ data: Sandbox }>(box(ctx, id), { headers: auth(ctx) })).data;
      }
      if (cur.status !== "RUNNING") throw new Error(`inngest sandbox ${id} did not start`);
    } catch (err) {
      await http(box(ctx, id), { method: "DELETE", headers: auth(ctx) }).catch(() => undefined);
      throw err;
    }
    return { providerSandboxId: id, cpu: size.vcpu, memoryMiB: size.memoryMb };
  },

  async exec(id, command, o, ctx) {
    const timeoutMs = Math.min(300_000, Math.max(1000, Math.ceil((o.timeoutSec ?? 300) * 1000)));
    try {
      const r = await httpJson<{ data: { stdout?: string; stderr?: string; exitCode: number } }>(box(ctx, id, "/exec"), {
        headers: auth(ctx),
        body: {
          command: ["/bin/sh", "-c", command],
          ...(o.env && Object.keys(o.env).length ? { environment: o.env } : {}),
          ...(o.cwd ? { cwd: o.cwd } : {}),
          timeout: `${timeoutMs}ms`,
        },
        timeoutMs: timeoutMs + 60_000,
      });
      const stdout = Buffer.from(r.data.stdout ?? "", "base64").toString("utf8");
      const stderr = Buffer.from(r.data.stderr ?? "", "base64").toString("utf8");
      if (stdout) o.onStdout?.(stdout);
      if (stderr) o.onStderr?.(stderr);
      return { stdout, stderr, exitCode: r.data.exitCode };
    } catch (err) {
      // The observation timeout: the command may still have run, but no exit code came back.
      if (err instanceof HttpError && /sandbox_exec_timed_out/.test(err.message)) return { stdout: "", stderr: err.message, exitCode: 124 };
      throw err;
    }
  },

  async readFile(id, path, ctx) {
    return new Uint8Array(await (await http(`${box(ctx, id, "/files")}?path=${encodeURIComponent(path)}`, { headers: auth(ctx) })).arrayBuffer());
  },

  async writeFile(id, path, data, ctx) {
    // One whole regular file, at most 100 MiB; an existing one is replaced.
    await http(`${box(ctx, id, "/files")}?path=${encodeURIComponent(path)}`, {
      method: "PUT",
      headers: { ...auth(ctx), "content-type": "application/octet-stream" },
      raw: data,
    });
  },

  async pause(id, ctx) {
    await http(box(ctx, id, "/pause"), { method: "POST", headers: auth(ctx) });
    await waitFor(id, "PAUSED", ctx);
  },

  async resume(id, ctx) {
    await http(box(ctx, id, "/resume"), { method: "POST", headers: auth(ctx) });
    await waitFor(id, "RUNNING", ctx);
  },

  async kill(id, ctx) {
    // 204 when already gone, 202 while terminating.
    await http(box(ctx, id), { method: "DELETE", headers: auth(ctx) }).catch((err) => {
      if (!gone(err)) throw err;
    });
  },

  async listAlive(ctx) {
    const ids: string[] = [];
    let cursor: string | null | undefined;
    do {
      const q = new URLSearchParams({ limit: "50", ...(cursor ? { cursor } : {}) });
      const page: { data?: Sandbox[]; page?: { cursor?: string | null; hasMore?: boolean } } = await httpJson(`${base(ctx)}/v2/sandboxes?${q}`, { headers: auth(ctx) });
      for (const s of page.data ?? []) if (!/^(TERMINAT|FAILED)/.test(s.status)) ids.push(s.id);
      cursor = page.page?.hasMore ? page.page.cursor : null;
    } while (cursor);
    return ids;
  },
});

async function waitFor(id: string, target: string, ctx: ProviderContext): Promise<void> {
  for (let i = 0; i < 300; i++) {
    const s = (await httpJson<{ data: Sandbox }>(box(ctx, id), { headers: auth(ctx) })).data;
    if (s.status === target) return;
    if (/^(TERMINAT|FAILED)/.test(s.status)) throw new Error(`inngest sandbox ${id} is ${s.status}`);
    await sleep(pollMs(ctx, 1000));
  }
  throw new Error(`inngest sandbox ${id} did not reach ${target}`);
}
