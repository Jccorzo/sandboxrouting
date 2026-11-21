// Cathedral (cathedral.computer): "sealed" sandboxes, rooms inside an AMD SEV-SNP
// confidential VM shared by several customers. No free tier: prepaid credit. $0.01/h per
// 2 vCPU / 4 GiB ($0.0025 per GiB-hour at every size); 24 h at most. Cathedral stops the sandbox at its stop time.
// REST: https://cathedral.computer/v1 (Bearer cat_sk_…), OpenAPI at /openapi.json. Most
// mutations need an Idempotency-Key. The synchronous exec waits 45 s at most, so commands
// run as background execs that are polled. Files only under /work; no listing; no public URLs.
// No SDK of its own (the stock `e2b` SDK works against sandbox.cathedral.computer). CLI `ctcli`.

import { randomUUID } from "node:crypto";
import { defineProvider, http, httpJson } from "./util.js";
import { insideRoots, pollMs, sleep } from "./rest-helpers.js";
import type { ProviderContext } from "../core/types.js";

const base = (ctx: ProviderContext) => String(ctx.env["CATHEDRAL_API_URL"] ?? "https://cathedral.computer").replace(/\/+$/, "");
const auth = (ctx: ProviderContext) => ({ authorization: `Bearer ${ctx.env["CATHEDRAL_API_KEY"]}` });
/** A fresh key: for calls that are not retried here. */
const once = (ctx: ProviderContext) => ({ ...auth(ctx), "idempotency-key": randomUUID() });
const box = (ctx: ProviderContext, id: string, path = "") => `${base(ctx)}/v1/sandboxes/${encodeURIComponent(id)}${path}`;
const ROOTS = ["/work"];
const MAX_LIFETIME_SEC = 86_400;
const EXEC_LIMIT_SEC = 14_400;
const HOURLY_PER_UNIT_USD = 0.01; // per 2 vCPU / 4 GiB

/** Sealed sizes: 2x4, 4x8 or 8x16 (vCPU x GiB). */
export function cathedralTemplate(cpu: number, memoryMiB: number): { template: string; cpu: number; memoryMiB: number } {
  const n = [2, 4, 8].find((c) => c >= cpu && c * 2048 >= memoryMiB) ?? 8;
  return { template: `sealed-${n}x${n * 2}`, cpu: n, memoryMiB: n * 2048 };
}

interface Sandbox {
  id: string;
  state: string;
  error?: string | null;
  error_code?: string | null;
  lifetime_deadline_at?: string | null;
}
interface Exec {
  exec_id: string;
  state: string;
  exit_code?: number | null;
  stdout?: string;
  stderr?: string;
  timed_out?: boolean;
}

export const cathedralProvider = defineProvider({
  info: {
    id: "cathedral",
    name: "Cathedral",
    homepage: "https://cathedral.computer",
    env: ["CATHEDRAL_API_KEY"],
    capabilities: ["customImage", "extendTimeout"],
    // Rooms in the shared confidential VM are kept apart by a container runtime the API does
    // not report (runc, gVisor or Kata), so only the weakest of them is claimed.
    isolation: "container",
    maxTimeoutSec: MAX_LIFETIME_SEC,
    maxExecSec: EXEC_LIMIT_SEC,
    freeTier: {
      tier: { kind: "none" },
      notes: "Prepaid credit only. Billed per second from booking until deleted or the stop time; the whole lifetime is held from credit at create and the unused part refunded. Asleep, only disk is billed ($0.002/day per 4 GiB).",
      source: "https://cathedral.computer/docs/pricing.md",
      checked: "2026-11-21",
    },
    pricing: { vcpuSecondUsd: HOURLY_PER_UNIT_USD / 2 / 3600, gibSecondUsd: 0, defaultCpu: 2, defaultMemoryMiB: 4096, source: "https://cathedral.computer/docs/pricing.md" },
    surfaces: { rest: "https://cathedral.computer/v1", sdk: ["e2b (npm), with E2B_DOMAIN=sandbox.cathedral.computer"], cli: "ctcli", mcp: "cathedral-mcp (stdio)" },
  },

  async create(spec, ctx) {
    const size = cathedralTemplate(spec.cpu, spec.memoryMiB);
    // Every create needs a spend cap. A full day at this size leaves room to extend; the docs
    // disagree on whether the least allowed is $1.
    const cap = Number(ctx.options["maxSpendUsd"] ?? Math.max(1, Math.ceil((size.cpu / 2) * HOURLY_PER_UNIT_USD * 24 * 100) / 100));
    let sandbox = await httpJson<Sandbox>(`${base(ctx)}/v1/sandboxes`, {
      // The router's id is the key: a retried create returns the same sandbox.
      headers: { ...auth(ctx), "idempotency-key": spec.metadata["sandboxrouting.id"] ?? randomUUID() },
      body: {
        required_hardware: "amd_sev_snp",
        template: spec.nativeTemplate ?? size.template,
        image: spec.image,
        network: String(ctx.options["network"] ?? "internet"),
        lifetime_seconds: Math.min(MAX_LIFETIME_SEC, Math.max(60, Math.ceil(spec.timeoutSec))),
        max_spend_usd: cap,
        env_vars: spec.env,
        labels: spec.metadata,
      },
    });
    try {
      for (let i = 0; i < 600 && sandbox.state !== "running"; i++) {
        if (["failed", "deleting", "deleted"].includes(sandbox.state)) throw new Error(`cathedral sandbox ${sandbox.id} is ${sandbox.state}: ${sandbox.error_code ?? sandbox.error ?? ""}`);
        await sleep(pollMs(ctx, 1000));
        sandbox = await httpJson<Sandbox>(box(ctx, sandbox.id), { headers: auth(ctx) });
      }
      if (sandbox.state !== "running") throw new Error(`cathedral sandbox ${sandbox.id} did not start`);
    } catch (err) {
      await http(box(ctx, sandbox.id), { method: "DELETE", headers: once(ctx) }).catch(() => undefined);
      throw err;
    }
    return { providerSandboxId: sandbox.id, cpu: size.cpu, memoryMiB: size.memoryMiB };
  },

  async exec(id, command, o, ctx) {
    const limit = Math.min(EXEC_LIMIT_SEC, Math.max(1, Math.ceil(o.timeoutSec ?? 600)));
    let cur = await httpJson<Exec>(box(ctx, id, "/execs"), {
      headers: once(ctx),
      body: { command, cwd: o.cwd, env: o.env, timeout_seconds: limit },
    });
    const one = box(ctx, id, `/execs/${encodeURIComponent(cur.exec_id)}`);
    const wait = ctx.options["pollMs"] === undefined ? 25 : 0;
    const deadline = Date.now() + (limit + 60) * 1000;
    while (cur.state === "running" && Date.now() < deadline) {
      if (!wait) await sleep(pollMs(ctx, 1000));
      cur = await httpJson<Exec>(`${one}?wait=${wait}`, { headers: auth(ctx), timeoutMs: 60_000 });
    }
    if (cur.state === "running") await http(one, { method: "DELETE", headers: auth(ctx) }).catch(() => undefined);
    const stdout = cur.stdout ?? "";
    const stderr = cur.stderr ?? "";
    if (stdout) o.onStdout?.(stdout);
    if (stderr) o.onStderr?.(stderr);
    return { stdout, stderr, exitCode: cur.exit_code ?? (cur.timed_out || cur.state === "running" ? 124 : 1) };
  },

  async readFile(id, path, ctx) {
    insideRoots("cathedral", path, ROOTS);
    return new Uint8Array(await (await http(`${box(ctx, id, "/files")}?path=${encodeURIComponent(path)}`, { headers: auth(ctx) })).arrayBuffer());
  },

  async writeFile(id, path, data, ctx) {
    insideRoots("cathedral", path, ROOTS);
    await http(`${box(ctx, id, "/files")}?path=${encodeURIComponent(path)}`, { method: "PUT", headers: { ...auth(ctx), "content-type": "application/octet-stream" }, raw: data });
  },

  async setTimeout(id, timeoutSec, ctx) {
    // The API only extends, by 60 s or more, so the gap to the wanted deadline is what's asked
    // for. Both times here are Cathedral's own: its deadline, and the Date of its response.
    const res = await http(box(ctx, id), { headers: auth(ctx) });
    const sandbox = (await res.json()) as Sandbox;
    const now = Date.parse(res.headers.get("date") ?? "") || Date.now();
    const left = (Date.parse(sandbox.lifetime_deadline_at ?? "") - now) / 1000;
    const more = Math.ceil(timeoutSec - (Number.isFinite(left) ? left : 0));
    if (more <= 0) return; // it cannot be shortened; the router ends it at its own deadline
    await http(box(ctx, id, "/lifetime"), { headers: once(ctx), body: { extend_by_seconds: Math.min(MAX_LIFETIME_SEC, Math.max(60, more)) } });
  },

  async kill(id, ctx) {
    await http(box(ctx, id), { method: "DELETE", headers: once(ctx) });
  },

  async listAlive(ctx) {
    const ids: string[] = [];
    for (let offset = 0; ; offset += 100) {
      const page = await httpJson<{ sandboxes: Sandbox[]; has_more?: boolean }>(`${base(ctx)}/v1/sandboxes?limit=100&offset=${offset}`, { headers: auth(ctx) });
      for (const s of page.sandboxes) if (!["failed", "deleting", "deleted"].includes(s.state)) ids.push(s.id);
      if (!page.has_more || !page.sandboxes.length) return ids;
    }
  },
});
