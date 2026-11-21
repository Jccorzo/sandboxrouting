// Rayrun (rayrunos.com): agent sandboxes in hardware-isolated microVMs, a China-hosted cloud
// that bills in yuan. A new account gets ¥50 of balance.
// REST: https://api.rayrunos.com/v1, Bearer token (console "设置 → 我的 API Token"; the CLI
// reads RAYRUN_API_URL + RAYRUN_TOKEN). Written from the API reference, generated from its
// OpenAPI 3.0.3 contract (Rayrun API 0.1.0), and the guides (checked 2026-11-21):
//   https://rayrunos.com/docs/api/sandboxes/   POST /sandboxes (synchronous, ~15 s at most,
//     Idempotency-Key ≤ 128), GET /sandboxes[?label=k=v], GET|DELETE /sandboxes/{id},
//     POST /sandboxes/{id}/pause | /resume (204, idempotent)
//   https://rayrunos.com/docs/api/exec/        POST /sandboxes/{id}/exec {command, cwd, env,
//     timeout_seconds ≤ 3600} → {exit_code, stdout, stderr, timed_out, truncated}
//   https://rayrunos.com/docs/api/ingress/     PUT /sandboxes/{id}/ingress/{port} {visibility, protocol} → {url}
//   https://rayrunos.com/docs/api/files/       (workdir-relative paths only, so not used)
//   https://rayrunos.com/docs/pricing/         ¥0.03/vCPU-h + ¥0.01/GiB-h, memory rounded up
//   https://rayrunos.com/docs/quickstart/
// Statuses: Creating, Running, Paused, Stopped, Terminated. Create takes no env, so env is kept
// in a file commands load. A new sandbox has no network by default; the adapter opens egress
// (`options.egress: "closed"` keeps it shut). `max_lifetime_seconds` cold-stops the sandbox
// (disk kept) rather than deleting it, so the router deletes it at its deadline.
// 403 insufficient_balance is a spent balance; 409 resource_exhausted is a full host.

import { randomUUID } from "node:crypto";
import { HttpError, defineProvider, http, httpJson, refusals } from "./util.js";
import { ENV_FILE, envFileBody, pollMs, sbrName, shq, sleep, withEnvFile } from "./rest-helpers.js";
import { CNY_PER_USD } from "./currency.js";
import type { ProviderContext } from "../core/types.js";

const ID = "rayrun";
const base = (ctx: ProviderContext) => String(ctx.env["RAYRUN_API_URL"] ?? "https://api.rayrunos.com/v1").replace(/\/+$/, "");
const auth = (ctx: ProviderContext) => ({ authorization: `Bearer ${ctx.env["RAYRUN_TOKEN"]}` });
const box = (ctx: ProviderContext, id: string, path = "") => `${base(ctx)}/sandboxes/${encodeURIComponent(id)}${path}`;
const refused = refusals(ID, [{ status: 403, body: /insufficient_balance|arrears/, kind: "quota", why: "balance used up" }]);

interface Sandbox {
  id: string;
  name?: string | null;
  status: string;
  cpu_cores?: number;
  memory_mb?: number;
}

/** Labels Rayrun accepts: at most 16, keys of 1 to 63 letters, digits, `_`, `.`, `-`, values of 1 to 255 characters. */
export function rayrunLabels(metadata: Record<string, string>): Record<string, string> {
  const ok = Object.entries(metadata).filter(([k, v]) => /^[A-Za-z0-9_.-]{1,63}$/.test(k) && v.length > 0 && v.length <= 255 && ![...v].some((ch) => ch.charCodeAt(0) < 0x20));
  // The router's own id first, so it survives the cut.
  ok.sort(([a], [b]) => Number(b === "sandboxrouting.id") - Number(a === "sandboxrouting.id"));
  return Object.fromEntries(ok.slice(0, 16));
}

async function run(ctx: ProviderContext, id: string, command: string, o: { cwd?: string; env?: Record<string, string>; timeoutSec?: number } = {}) {
  const timeout = Math.min(3600, Math.max(1, Math.ceil(o.timeoutSec ?? 3600)));
  return httpJson<{ exit_code: number | null; stdout: string; stderr: string; timed_out?: boolean }>(box(ctx, id, "/exec"), {
    headers: auth(ctx),
    body: { command, cwd: o.cwd, env: o.env, timeout_seconds: timeout },
    timeoutMs: (timeout + 30) * 1000,
  });
}

export const rayrunProvider = defineProvider({
  info: {
    id: ID,
    name: "Rayrun",
    homepage: "https://rayrunos.com",
    env: ["RAYRUN_TOKEN"],
    capabilities: ["ports", "pause"],
    isolation: "microvm",
    enforcesTimeout: false,
    maxExecSec: 3600,
    freeTier: {
      tier: { kind: "one-time-credit", usd: Math.round((50 / CNY_PER_USD) * 100) / 100 },
      notes: "¥50 of balance at sign-up (converted at the CNY rate in currency.ts). Top-ups by WeChat Pay. Out of balance, running sandboxes are cold-stopped.",
      source: "https://rayrunos.com/docs/pricing/",
      checked: "2026-11-21",
    },
    pricing: { vcpuSecondUsd: 0.03 / CNY_PER_USD / 3600, gibSecondUsd: 0.01 / CNY_PER_USD / 3600, defaultCpu: 2, defaultMemoryMiB: 4096, source: "https://rayrunos.com/docs/pricing/" },
    surfaces: { rest: "https://api.rayrunos.com/v1", sdk: ["e2b (control plane only on the hosted service)"], cli: "rayrun" },
  },

  async create(spec, ctx) {
    const name = sbrName(spec);
    const body = {
      name,
      // An image from GET /agents, e.g. claude-code@1 (the CLI's default) or ubuntu@1.
      agent: spec.nativeTemplate ?? String(ctx.options["agent"] ?? "ubuntu@1"),
      cpu_cores: Math.max(1, Math.ceil(spec.cpu)),
      memory_mb: Math.max(512, Math.round(spec.memoryMiB)),
      max_lifetime_seconds: Math.max(1, Math.ceil(spec.timeoutSec)),
      labels: rayrunLabels(spec.metadata),
      ...(ctx.options["egress"] === "closed" ? {} : { egress: { allow_all: true } }),
    };
    let sbx: Sandbox;
    try {
      sbx = await httpJson<Sandbox>(`${base(ctx)}/sandboxes`, {
        headers: { ...auth(ctx), "idempotency-key": (spec.metadata["sandboxrouting.id"] ?? randomUUID()).slice(0, 128) },
        body,
        timeoutMs: 120_000,
      });
    } catch (err) {
      // The name comes from the router id: past the idempotency window a retry meets the first sandbox's name.
      if (!(err instanceof HttpError && err.status === 409 && /name_conflict/.test(err.message))) throw refused(err);
      const label = spec.metadata["sandboxrouting.id"];
      const q = label ? `?label=${encodeURIComponent(`sandboxrouting.id=${label}`)}` : "";
      const found = (await httpJson<{ sandboxes: Sandbox[] }>(`${base(ctx)}/sandboxes${q}`, { headers: auth(ctx) })).sandboxes.find(
        (s) => s.name === name && s.status !== "Terminated",
      );
      if (!found) throw err;
      sbx = found;
    }
    const id = sbx.id;
    try {
      let status = sbx.status;
      for (let i = 0; i < 300 && status !== "Running"; i++) {
        if (status === "Terminated" || status === "Stopped") throw new Error(`rayrun sandbox ${id} is ${status}`);
        if (status === "Paused") await http(box(ctx, id, "/resume"), { method: "POST", headers: auth(ctx) });
        await sleep(pollMs(ctx, 1000));
        status = (await httpJson<Sandbox>(box(ctx, id), { headers: auth(ctx) })).status;
      }
      if (status !== "Running") throw new Error(`rayrun sandbox ${id} did not start`);
      if (Object.keys(spec.env).length) {
        const r = await run(ctx, id, `umask 077; printf %s ${shq(envFileBody(spec.env))} > ${ENV_FILE}`, { timeoutSec: 60 });
        if (r.exit_code !== 0) throw new Error(`rayrun sandbox ${id}: could not write its env file: ${r.stderr}`);
      }
    } catch (err) {
      await http(box(ctx, id), { method: "DELETE", headers: auth(ctx) }).catch(() => undefined);
      throw err;
    }
    return { providerSandboxId: id, cpu: sbx.cpu_cores ?? body.cpu_cores, memoryMiB: sbx.memory_mb ?? body.memory_mb };
  },

  async exec(id, command, o, ctx) {
    // `command` runs as /bin/sh -c; cwd must be absolute.
    const r = await run(ctx, id, withEnvFile(command), o);
    if (r.stdout) o.onStdout?.(r.stdout);
    if (r.stderr) o.onStderr?.(r.stderr);
    return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exit_code ?? (r.timed_out ? 124 : 1) };
  },

  async getUrl(id, port, ctx) {
    const r = await httpJson<{ url: string }>(box(ctx, id, `/ingress/${port}`), { method: "PUT", headers: auth(ctx), body: { visibility: "public", protocol: "http" } });
    return r.url;
  },

  async pause(id, ctx) {
    await http(box(ctx, id, "/pause"), { method: "POST", headers: auth(ctx) });
  },

  async resume(id, ctx) {
    try {
      await http(box(ctx, id, "/resume"), { method: "POST", headers: auth(ctx) });
    } catch (err) {
      throw refused(err);
    }
  },

  async kill(id, ctx) {
    // 204 also for one already Terminated; 404 for one that never existed.
    try {
      await http(box(ctx, id), { method: "DELETE", headers: auth(ctx) });
    } catch (err) {
      if (!(err instanceof HttpError && (err.status === 404 || err.status === 410))) throw err;
    }
  },

  async listAlive(ctx) {
    const r = await httpJson<{ sandboxes: Sandbox[] }>(`${base(ctx)}/sandboxes`, { headers: auth(ctx) });
    return r.sandboxes.filter((s) => s.status !== "Terminated").map((s) => s.id);
  },
});
