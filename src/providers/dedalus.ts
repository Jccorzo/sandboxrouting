// Dedalus Machines (Dedalus Labs): persistent Cloud Hypervisor VMs. Public beta: calls return
// 403 BETA_ACCESS_REQUIRED until your org is admitted. Free (Hobby): $20 one-time, no card.
// REST: https://dcs.dedaluslabs.ai/v1 (Bearer dsk_… or x-api-key), OpenAPI dcs-openapi.json.
// Executions are asynchronous: create, poll, then fetch output. No image, env or TTL at the
// machine level, so the router deletes machines at the deadline (enforcesTimeout: false).

import { randomUUID } from "node:crypto";
import { defineProvider, http, httpJson } from "./util.js";
import { pollMs, sleep } from "./rest-helpers.js";
import type { ProviderContext } from "../core/types.js";

const base = (ctx: ProviderContext) => String(ctx.env["DEDALUS_BASE_URL"] ?? "https://dcs.dedaluslabs.ai").replace(/\/+$/, "");
const auth = (ctx: ProviderContext) => ({ authorization: `Bearer ${ctx.env["DEDALUS_API_KEY"]}` });
const m = (ctx: ProviderContext, id: string, path = "") => `${base(ctx)}/v1/machines/${encodeURIComponent(id)}${path}`;
const mutate = (ctx: ProviderContext) => ({ ...auth(ctx), "idempotency-key": randomUUID() });

interface Machine {
  machine_id: string;
  phase?: string;
  status?: { phase?: string; last_error?: string };
  vcpu?: number;
  memory_mib?: number;
}
const phaseOf = (x: Machine) => x.status?.phase ?? x.phase ?? "";

interface Execution {
  execution_id: string;
  status: "wake_in_progress" | "queued" | "running" | "succeeded" | "failed" | "cancelled" | "expired";
  exit_code?: number;
  error_message?: string;
}
const DONE = new Set(["succeeded", "failed", "cancelled", "expired"]);

export const dedalusProvider = defineProvider({
  info: {
    id: "dedalus",
    name: "Dedalus Machines",
    homepage: "https://www.dedaluslabs.ai",
    env: ["DEDALUS_API_KEY"],
    capabilities: ["pause"],
    isolation: "microvm",
    enforcesTimeout: false,
    freeTier: {
      tier: { kind: "one-time-credit", usd: 20 },
      requiresCard: false,
      notes: "Hobby: $20 one-time, no card. Public beta: needs org admission (403 BETA_ACCESS_REQUIRED).",
      source: "https://www.dedaluslabs.ai/llms-full.txt",
      checked: "2026-11-11",
    },
    // Per-vCPU and per-GiB rates are not published; this is an estimate for metering.
    pricing: { vcpuSecondUsd: 0.05 / 3600, gibSecondUsd: 0.0125 / 3600, defaultCpu: 1, defaultMemoryMiB: 2048, source: "https://www.dedaluslabs.ai/llms-full.txt" },
    surfaces: { rest: "https://dcs.dedaluslabs.ai/v1", sdk: ["dedalus (npm)", "dedalus-sdk (PyPI)"], cli: "dedalus" },
  },

  async create(spec, ctx) {
    const created = await httpJson<Machine>(`${base(ctx)}/v1/machines`, {
      headers: { ...auth(ctx), "idempotency-key": spec.metadata["sandboxrouting.id"] ?? randomUUID() },
      body: { vcpu: spec.cpu, memory_mib: spec.memoryMiB, storage_gib: Number(ctx.options["storageGiB"] ?? 10), autosleep: "never" },
    });
    for (let i = 0; i < 300; i++) {
      const cur = await httpJson<Machine>(m(ctx, created.machine_id), { headers: auth(ctx) });
      const phase = phaseOf(cur);
      if (phase === "running") return { providerSandboxId: created.machine_id, cpu: created.vcpu, memoryMiB: created.memory_mib };
      if (phase === "failed" || phase === "destroyed") throw new Error(`dedalus machine ${created.machine_id} ${phase}: ${cur.status?.last_error ?? ""}`);
      await sleep(pollMs(ctx, 1500));
    }
    throw new Error(`dedalus machine ${created.machine_id} did not reach running`);
  },

  async exec(id, command, o, ctx) {
    let ex = await httpJson<Execution>(m(ctx, id, "/executions"), {
      headers: mutate(ctx),
      body: { command: ["sh", "-c", command], cwd: o.cwd, env: o.env, timeout_ms: o.timeoutSec ? o.timeoutSec * 1000 : undefined },
    });
    const deadline = Date.now() + ((o.timeoutSec ?? 3600) + 60) * 1000;
    while (!DONE.has(ex.status)) {
      if (Date.now() > deadline) throw new Error(`dedalus execution ${ex.execution_id} did not finish`);
      await sleep(pollMs(ctx, 1000));
      ex = await httpJson<Execution>(m(ctx, id, `/executions/${encodeURIComponent(ex.execution_id)}`), { headers: auth(ctx) });
    }
    const out = await httpJson<{ stdout?: string; stderr?: string }>(m(ctx, id, `/executions/${encodeURIComponent(ex.execution_id)}/output`), {
      headers: auth(ctx),
    });
    const stdout = out.stdout ?? "";
    const stderr = out.stderr ?? "";
    if (stdout) o.onStdout?.(stdout);
    if (stderr) o.onStderr?.(stderr);
    if (ex.exit_code === undefined) throw new Error(`dedalus execution ${ex.status}: ${ex.error_message ?? "no exit code"}`);
    return { stdout, stderr, exitCode: ex.exit_code };
  },

  async pause(id, ctx) {
    await http(m(ctx, id, "/sleep"), { method: "POST", headers: mutate(ctx) });
  },

  async resume(id, ctx) {
    await http(m(ctx, id, "/wake"), { method: "POST", headers: mutate(ctx) });
  },

  async kill(id, ctx) {
    await http(m(ctx, id), { method: "DELETE", headers: mutate(ctx) });
  },

  async listAlive(ctx) {
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await httpJson<{ items: Machine[] | null; next_cursor?: string }>(
        `${base(ctx)}/v1/machines?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        { headers: auth(ctx) },
      );
      for (const x of page.items ?? []) if (!["destroying", "destroyed", "failed"].includes(phaseOf(x))) ids.push(x.machine_id);
      cursor = page.next_cursor || undefined;
    } while (cursor);
    return ids;
  },
});
