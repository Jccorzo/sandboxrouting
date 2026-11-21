// Prime Intellect Sandboxes (primeintellect.ai): hardware-isolated microVMs that boot any OCI image.
// No free tier. Launch rates through 2026-12-22: $0.02 per vCPU-hour, $0.0125 per GiB-hour and
// $0.0002 per GiB-hour of disk ($0.09/h for 2 vCPU / 4 GiB); a paused sandbox bills disk only.
// REST: https://api.primeintellect.ai/api/v1/sandbox (Bearer key with the `sandbox` scope), OpenAPI
// https://api.primeintellect.ai/api/v1/sandbox/openapi.json, guide
// https://docs.primeintellect.ai/api-reference/sandboxes.md. Commands and files go through the
// sandbox gateway with a 30-minute token from POST /sandbox/{id}/auth: commands as the Connect
// server stream `command_session.CommandSession/Start`, files as /upload and /download under
// <gateway_url>/<user_ns>/<job_id>, as the official SDK does (PyPI `prime-sandboxes` 0.5.14,
// prime_sandboxes/sandbox.py and rpc_command_session.py). CLI `prime sandbox`.
// `timeout_minutes` caps the whole lifetime, so the provider ends the sandbox at its deadline; it
// can't be changed later. Create takes an idempotency key.

import { randomUUID } from "node:crypto";
import { defineProvider, http, httpJson, HttpError } from "./util.js";
import { grantCache, pollMs, sbrName, sleep } from "./rest-helpers.js";
import { connectStream } from "./connect-rpc.js";
import type { ProviderContext } from "../core/types.js";

const base = (ctx: ProviderContext) => `${String(ctx.env["PRIME_API_URL"] ?? "https://api.primeintellect.ai").replace(/\/+$/, "")}/api/v1/sandbox`;
const auth = (ctx: ProviderContext) => ({ authorization: `Bearer ${ctx.env["PRIME_API_KEY"]}` });
const box = (ctx: ProviderContext, id: string, path = "") => `${base(ctx)}/${encodeURIComponent(id)}${path}`;

interface Sandbox {
  id: string;
  status: "PENDING" | "PROVISIONING" | "RUNNING" | "PAUSED" | "ERROR" | "TERMINATED" | "TIMEOUT";
  errorMessage?: string | null;
  cpuCores?: number;
  memoryGB?: number;
  gatewayAuth?: GatewayAuth | null;
}
interface GatewayAuth {
  token: string;
  gateway_url: string;
  user_ns: string;
  job_id: string;
  expires_at: string;
}
const ENDED = new Set(["ERROR", "TERMINATED", "TIMEOUT"]);

/** Gateway tokens per sandbox, minted again shortly before they expire. */
const grants = grantCache<GatewayAuth>();
const mint = (ctx: ProviderContext, id: string) => async () => {
  const a = await httpJson<GatewayAuth>(box(ctx, id, "/auth"), { method: "POST", headers: auth(ctx) });
  return { value: a, expiresAt: Date.parse(a.expires_at) || Date.now() + 25 * 60_000 };
};
const gatewayOf = (a: GatewayAuth) => `${a.gateway_url.replace(/\/+$/, "")}/${a.user_ns}/${a.job_id}`;

/** Runs a gateway call, minting a new token once if the gateway refuses the cached one. */
async function viaGateway<T>(ctx: ProviderContext, id: string, call: (gateway: string, headers: Record<string, string>) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const a = await grants.get(id, mint(ctx, id));
    try {
      return await call(gatewayOf(a), { authorization: `Bearer ${a.token}` });
    } catch (err) {
      if (attempt === 0 && err instanceof HttpError && err.status === 401) {
        grants.drop(id);
        continue;
      }
      throw err;
    }
  }
}

interface StartResponse {
  event?: {
    data?: { stdout?: string; stderr?: string };
    end?: { exitCode?: number; error?: string };
  };
}

export const primeintellectProvider = defineProvider({
  info: {
    id: "primeintellect",
    name: "Prime Intellect",
    homepage: "https://www.primeintellect.ai",
    env: ["PRIME_API_KEY"],
    capabilities: ["pause", "customImage"],
    isolation: "microvm",
    freeTier: {
      tier: { kind: "none" },
      notes: "No free tier; prepaid balance (402 when it is spent). 1,024 active sandboxes per account by default.",
      source: "https://docs.primeintellect.ai/sandboxes/overview.md",
      checked: "2026-11-21",
    },
    // Disk (5 GiB default at $0.0002/GiB-h) is left out: $0.001/h.
    pricing: { vcpuSecondUsd: 0.02 / 3600, gibSecondUsd: 0.0125 / 3600, defaultCpu: 2, defaultMemoryMiB: 4096, source: "https://docs.primeintellect.ai/sandboxes/overview.md#pricing" },
    surfaces: { rest: "https://api.primeintellect.ai/api/v1/sandbox", sdk: ["prime-sandboxes (PyPI)"], cli: "prime sandbox" },
  },

  async create(spec, ctx) {
    const cpu = Math.min(16, Math.max(1, Math.ceil(spec.cpu)));
    const memoryGb = Math.max(0.125, Math.round((spec.memoryMiB / 1024) * 8) / 8);
    const team = ctx.env["PRIME_TEAM_ID"];
    let s = await httpJson<Sandbox>(base(ctx), {
      headers: auth(ctx),
      body: {
        name: sbrName(spec),
        docker_image: spec.image ?? spec.nativeTemplate ?? String(ctx.options["image"] ?? "python:3.11-slim"),
        cpu_cores: cpu,
        memory_gb: memoryGb,
        timeout_minutes: Math.max(1, Math.ceil(spec.timeoutSec / 60)),
        environment_vars: spec.env,
        labels: ["sandboxrouting"],
        idempotency_key: spec.metadata["sandboxrouting.id"] ?? randomUUID(),
        ...(team ? { team_id: team } : {}),
      },
    });
    const id = s.id;
    try {
      // The first use of an image converts it to a VM image, which can take minutes.
      for (let i = 0; i < 600 && s.status !== "RUNNING"; i++) {
        if (ENDED.has(s.status)) throw new Error(`primeintellect sandbox ${id} is ${s.status}${s.errorMessage ? `: ${s.errorMessage}` : ""}`);
        await sleep(pollMs(ctx, 1000));
        s = await httpJson<Sandbox>(box(ctx, id), { headers: auth(ctx) });
      }
      if (s.status !== "RUNNING") throw new Error(`primeintellect sandbox ${id} did not start (${s.status})`);
    } catch (err) {
      await this.kill(id, ctx).catch(() => undefined);
      throw err;
    }
    return { providerSandboxId: id, cpu, memoryMiB: Math.round(memoryGb * 1024) };
  },

  async exec(id, command, o, ctx) {
    const timeoutMs = Math.max(1, o.timeoutSec ?? 3600) * 1000;
    return viaGateway(ctx, id, async (gateway, headers) => {
      let stdout = "";
      let stderr = "";
      const out = new TextDecoder();
      const err = new TextDecoder();
      const request = { command: { cmd: "/bin/sh", args: ["-c", command], envs: o.env ?? {}, ...(o.cwd ? { cwd: o.cwd } : {}) }, stdin: false };
      try {
        for await (const r of connectStream<StartResponse>(gateway, "command_session.CommandSession/Start", request, { headers, timeoutMs })) {
          const ev = r.event ?? {};
          if (ev.data?.stdout) {
            const t = out.decode(Buffer.from(ev.data.stdout, "base64"), { stream: true });
            stdout += t;
            if (t) o.onStdout?.(t);
          }
          if (ev.data?.stderr) {
            const t = err.decode(Buffer.from(ev.data.stderr, "base64"), { stream: true });
            stderr += t;
            if (t) o.onStderr?.(t);
          }
          // proto3 JSON leaves out a zero exit code.
          if (ev.end) return { stdout: stdout + out.decode(), stderr: stderr + err.decode(), exitCode: ev.end.exitCode ?? 0 };
        }
      } catch (e) {
        // The command outlived its deadline: report it the way `timeout` does.
        if (e instanceof HttpError && e.status === 504) return { stdout, stderr: `${stderr}primeintellect: command timed out\n`, exitCode: 124 };
        throw e;
      }
      throw new Error("primeintellect exec: the stream ended without an exit code");
    });
  },

  async readFile(id, path, ctx) {
    return viaGateway(ctx, id, async (gateway, headers) => {
      const q = new URLSearchParams({ path, sandbox_id: id });
      return new Uint8Array(await (await http(`${gateway}/download?${q}`, { headers, timeoutMs: 300_000 })).arrayBuffer());
    });
  },

  async writeFile(id, path, data, ctx) {
    await viaGateway(ctx, id, async (gateway, headers) => {
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(data)]), path.split("/").pop() || "file");
      const q = new URLSearchParams({ path, sandbox_id: id });
      await http(`${gateway}/upload?${q}`, { method: "POST", headers, raw: form, timeoutMs: 300_000 });
    });
  },

  async pause(id, ctx) {
    await http(box(ctx, id, "/pause"), { method: "POST", headers: auth(ctx) });
  },

  async resume(id, ctx) {
    await http(box(ctx, id, "/resume"), { method: "POST", headers: auth(ctx) });
  },

  async kill(id, ctx) {
    grants.drop(id);
    try {
      await http(box(ctx, id), { method: "DELETE", headers: auth(ctx) });
    } catch (err) {
      if (!(err instanceof HttpError && (err.status === 404 || err.status === 410))) throw err;
    }
  },

  async listAlive(ctx) {
    const ids: string[] = [];
    let cursor: string | undefined;
    const team = ctx.env["PRIME_TEAM_ID"];
    do {
      const q = new URLSearchParams({ is_active: "true", per_page: "100", ...(team ? { team_id: team } : {}), ...(cursor ? { cursor } : {}) });
      const page = await httpJson<{ sandboxes: Sandbox[]; next_cursor?: string | null; has_next?: boolean }>(`${base(ctx)}?${q}`, { headers: auth(ctx) });
      ids.push(...page.sandboxes.filter((s) => !ENDED.has(s.status)).map((s) => s.id));
      cursor = page.has_next === false ? undefined : (page.next_cursor ?? undefined);
    } while (cursor);
    return ids;
  },
});
