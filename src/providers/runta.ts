// Runta (runta.com): persistent agent runtimes with egress control, secret stubs and
// checkpoints. $0.0504 per vCPU-hour + $0.0162 per GiB-hour while running (paused: memory and
// disk only; shut down: disk only, $0.000108/GiB-hour). $50 of free credit, no card; trial
// accounts share 32 vCPU / 64 GiB across their runtimes.
// REST: https://api.runta.com/v2 (Bearer Runta API key), OpenAPI at runta.com/openapi.yaml;
// docs runta.com/llms.txt, runta.com/docs/runtime/runtime-basic/, pricing runta.com/pricing/.
// The REST API creates, reads, pauses, resumes and deletes runtimes and moves files, but has no
// route that runs a command: commands go over a WebSocket (wss://api.runta.com/v2/runtimes/{id}/
// exec/stream), so `exec` loads the official SDK, npm `@runta/runta-sdk` (optional peer
// dependency; dist/internal/exec-stream.js speaks that socket). Everything else is plain REST.
// Mutations take `expected_revision` (compare-and-set: a stale one is a 409, read again and
// retry). Create takes an Idempotency-Key. `auto_shutdown_policy` shuts the runtime down at
// the deadline and `auto_delete_policy` then deletes it. Errors are `{error: {code, message}}`;
// 403 `tenant_blocked` is read as an account billing block.

import { randomUUID } from "node:crypto";
import { defineProvider, http, httpJson, HttpError, loadSdk, refusals } from "./util.js";
import { pollMs, sbrName, sleep } from "./rest-helpers.js";
import type { ProviderContext } from "../core/types.js";

const base = (ctx: ProviderContext) => String(ctx.env["RUNTA_API_URL"] ?? "https://api.runta.com").replace(/\/+$/, "");
const auth = (ctx: ProviderContext) => ({ authorization: `Bearer ${ctx.env["RUNTA_API_KEY"]}` });
const rt = (ctx: ProviderContext, id: string, path = "") => `${base(ctx)}/v2/runtimes/${encodeURIComponent(id)}${path}`;
const gone = (err: unknown) => err instanceof HttpError && (err.status === 404 || err.status === 410);
const refused = refusals("runta", [{ status: 403, body: /tenant_blocked/, kind: "quota", why: "account blocked (billing)" }]);

interface Runtime {
  id: string;
  status: string;
  revision: number;
  error_message?: string;
  resources?: { requests?: { vcpus?: number; memory_mib?: number } };
}
const FAILED = ["error", "crashed", "deleting", "shutdown"];

interface RuntaSdk {
  Runta: new (config: { token?: string; endpoint?: string }) => {
    runtimes: {
      get(id: string): Promise<{
        exec(command: readonly string[], options: { timeoutSecs?: number; env?: Record<string, string>; cwd?: string }): Promise<{ exitCode: number; stdout: string; stderr: string }>;
      }>;
    };
    close(): Promise<void>;
  };
}

const read = async (ctx: ProviderContext, id: string) => (await httpJson<{ data: Runtime }>(rt(ctx, id), { headers: auth(ctx) })).data;

/** A revision-guarded change: read the revision, send it, and on a 409 read again and retry. */
async function guarded(ctx: ProviderContext, id: string, send: (revision: number) => Promise<unknown>): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const cur = await read(ctx, id);
    try {
      await send(cur.revision);
      return;
    } catch (err) {
      if (!(err instanceof HttpError && err.status === 409) || attempt >= 4) throw err;
    }
  }
}

const destroy = (ctx: ProviderContext, id: string) =>
  guarded(ctx, id, (revision) => http(`${rt(ctx, id)}?expected_revision=${revision}`, { method: "DELETE", headers: auth(ctx) })).catch((err) => {
    if (!gone(err)) throw err;
  });

export const runtaProvider = defineProvider({
  info: {
    id: "runta",
    name: "Runta",
    homepage: "https://runta.com",
    env: ["RUNTA_API_KEY"],
    sdkPackage: "@runta/runta-sdk",
    capabilities: ["pause", "snapshot", "extendTimeout"],
    maxTimeoutSec: 2_147_483_647,
    // Isolation is left unset: Runta does not publish it, so `minIsolation` requests skip it.
    freeTier: {
      tier: { kind: "one-time-credit", usd: 50 },
      requiresCard: false,
      notes: "$50 of free credit, no card. Trial accounts share 32 vCPU and 64 GiB across their runtimes; adding a payment method raises the limits. The page doesn't say whether the credit recurs.",
      source: "https://runta.com/pricing/",
      checked: "2026-11-21",
    },
    pricing: { vcpuSecondUsd: 0.0504 / 3600, gibSecondUsd: 0.0162 / 3600, defaultCpu: 2, defaultMemoryMiB: 4096, source: "https://runta.com/pricing/" },
    surfaces: { rest: "https://api.runta.com/v2 (+ WebSocket exec)", sdk: ["@runta/runta-sdk (npm)", "runta (PyPI)"], cli: "runta", mcp: "https://mcp.runta.com/mcp" },
  },

  async create(spec, ctx) {
    const vcpus = Math.max(1, Math.ceil(spec.cpu));
    const memory_mib = Math.max(512, Math.ceil(spec.memoryMiB));
    let made: Runtime;
    try {
      made = (
        await httpJson<{ data: Runtime }>(`${base(ctx)}/v2/runtimes`, {
          headers: { ...auth(ctx), "idempotency-key": spec.metadata["sandboxrouting.id"] ?? randomUUID() },
          body: {
            name: sbrName(spec),
            environment_variables: spec.env,
            resources: { requests: { vcpus, memory_mib } },
            image: spec.nativeTemplate ? { id: spec.nativeTemplate } : undefined,
            // Shut down at the deadline, then delete right after.
            auto_shutdown_policy: { mode: "enabled", after_seconds: Math.max(1, Math.ceil(spec.timeoutSec)) },
            auto_delete_policy: { mode: "enabled", after_seconds: 1 },
          },
          timeoutMs: 300_000,
        })
      ).data;
    } catch (err) {
      throw refused(err);
    }
    try {
      let cur = made;
      for (let i = 0; i < 600 && cur.status !== "running"; i++) {
        if (FAILED.includes(cur.status)) throw new Error(`runta runtime ${made.id} is ${cur.status}${cur.error_message ? `: ${cur.error_message}` : ""}`);
        await sleep(pollMs(ctx, 1000));
        cur = await read(ctx, made.id);
      }
      if (cur.status !== "running") throw new Error(`runta runtime ${made.id} did not start`);
    } catch (err) {
      // Runta made it: never leave it running (and billing) when the create fails.
      await destroy(ctx, made.id).catch(() => undefined);
      throw err;
    }
    return { providerSandboxId: made.id, cpu: made.resources?.requests?.vcpus ?? vcpus, memoryMiB: made.resources?.requests?.memory_mib ?? memory_mib };
  },

  async exec(id, command, o, ctx) {
    const { Runta } = await loadSdk<RuntaSdk>("@runta/runta-sdk", "runta");
    const client = new Runta({ token: String(ctx.env["RUNTA_API_KEY"]), endpoint: base(ctx) });
    try {
      const runtime = await client.runtimes.get(id);
      const r = await runtime.exec(["sh", "-c", command], { timeoutSecs: o.timeoutSec, env: o.env, cwd: o.cwd });
      if (r.stdout) o.onStdout?.(r.stdout);
      if (r.stderr) o.onStderr?.(r.stderr);
      return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode };
    } finally {
      await client.close().catch(() => undefined);
    }
  },

  async readFile(id, path, ctx) {
    const res = await http(`${rt(ctx, id, "/files")}?path=${encodeURIComponent(path)}`, { headers: auth(ctx) });
    return new Uint8Array(await res.arrayBuffer());
  },

  async writeFile(id, path, data, ctx) {
    await http(`${rt(ctx, id, "/files")}?path=${encodeURIComponent(path)}`, {
      method: "PUT",
      headers: { ...auth(ctx), "content-type": "application/octet-stream" },
      raw: data,
    });
  },

  async setTimeout(id, timeoutSec, ctx) {
    // Saving the policy restarts its clock, so the runtime shuts down timeoutSec from now.
    await guarded(ctx, id, (revision) =>
      http(`${rt(ctx, id)}?expected_revision=${revision}`, {
        method: "PATCH",
        headers: auth(ctx),
        body: { auto_shutdown_policy: { mode: "enabled", after_seconds: Math.max(1, Math.ceil(timeoutSec)) } },
      }),
    );
  },

  async pause(id, ctx) {
    await guarded(ctx, id, (revision) => http(`${rt(ctx, id, "/pause")}?expected_revision=${revision}`, { method: "POST", headers: auth(ctx) }));
  },

  async resume(id, ctx) {
    await guarded(ctx, id, (revision) => http(`${rt(ctx, id, "/resume")}?expected_revision=${revision}`, { method: "POST", headers: auth(ctx) }));
  },

  async kill(id, ctx) {
    // 202 accepted or 204 already deleted; 404 is already gone.
    await destroy(ctx, id);
  },

  async listAlive(ctx) {
    const ids: string[] = [];
    let after: string | null | undefined;
    for (let page = 0; page < 100; page++) {
      const q = new URLSearchParams({ limit: "100", ...(after ? { after } : {}) });
      const r: { data: Runtime[]; pagination?: { next_cursor?: string | null; has_more?: boolean } } = await httpJson(`${base(ctx)}/v2/runtimes?${q}`, { headers: auth(ctx) });
      for (const x of r.data) if (x.status !== "deleting" && x.status !== "shutdown") ids.push(x.id);
      after = r.pagination?.next_cursor;
      if (!after || r.pagination?.has_more === false) break;
    }
    return ids;
  },
});
