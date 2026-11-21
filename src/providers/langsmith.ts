// LangSmith Sandboxes (langchain.com): Firecracker microVMs booted from snapshots, billed in
// LangChain Standard Units (1 LSU = $1). Developer plan (free, no card): 8 LSU of sandbox usage a
// month, at most 10 sandboxes. 0.0576 LSU per vCPU-hour and 0.01845 LSU per GiB-hour, per second,
// so the 8 LSU buy about 42 h of 2 vCPU / 4 GiB; storage 0.000123 LSU per GiB-hour.
// REST: https://api.smith.langchain.com/api/v2/sandboxes (X-API-Key; EU at eu.api.smith.langchain.com,
// set LANGSMITH_ENDPOINT), OpenAPI https://docs.langchain.com/langsmith/langsmith-platform-openapi.json,
// reference https://docs.langchain.com/langsmith/smith-api/sandboxes/create-a-sandbox.md. Commands
// and files go to each sandbox's `dataplane_url`, as the official SDK (`langsmith/sandbox`) does.
// A sandbox is addressed by its name. Its lifetime is idle-based (`idle_ttl_seconds` stops it,
// `delete_after_stop_seconds` then deletes it), so a busy one outlives the deadline and the router
// deletes it (enforcesTimeout: false). Sandboxes are created with `persistent: false`: nothing is
// kept or charged for storage once stopped. A 429 is the workspace's limits (sandbox count, CPU,
// memory), not spent credit, so it is reported as a concurrency limit.

import { defineProvider, http, httpJson, HttpError } from "./util.js";
import { pollMs, sbrName, sleep } from "./rest-helpers.js";
import type { ProviderContext } from "../core/types.js";

/** LANGSMITH_ENDPOINT may carry the tracing API's `/api/v1` suffix; the sandbox API sits beside it. */
const base = (ctx: ProviderContext) =>
  `${String(ctx.env["LANGSMITH_ENDPOINT"] ?? "https://api.smith.langchain.com")
    .replace(/\/+$/, "")
    .replace(/\/api(\/v1)?$/, "")}/api/v2/sandboxes`;
const auth = (ctx: ProviderContext): Record<string, string> => ({
  "x-api-key": String(ctx.env["LANGSMITH_API_KEY"]),
  ...(ctx.env["LANGSMITH_WORKSPACE_ID"] ? { "x-tenant-id": String(ctx.env["LANGSMITH_WORKSPACE_ID"]) } : {}),
});
const boxUrl = (ctx: ProviderContext, name: string, path = "") => `${base(ctx)}/boxes/${encodeURIComponent(name)}${path}`;
/** TTLs are whole minutes. */
const minutes = (sec: number) => Math.max(60, Math.ceil(sec / 60) * 60);

/** Memory follows CPU at 4 GiB per vCPU and must stay within half of that ratio (2-6 GiB per vCPU), 64 GiB at most. */
export function langsmithSize(cpu: number, memoryMiB: number): { vcpus: number; memBytes: number } {
  const vcpus = Math.max(1, Math.ceil(cpu), Math.ceil(memoryMiB / 6144));
  const mib = Math.min(65536, vcpus * 6144, Math.max(vcpus * 2048, Math.ceil(memoryMiB)));
  return { vcpus, memBytes: mib * 1024 * 1024 };
}

interface Box {
  id?: string;
  name: string;
  status?: "provisioning" | "ready" | "failed" | "stopped" | "deleting";
  status_message?: string;
  dataplane_url?: string;
  vcpus?: number;
  mem_bytes?: number;
}

/** Each sandbox's data-plane URL, stable across stop and start; looked up again after a restart. */
const planes = new Map<string, string>();
async function plane(ctx: ProviderContext, name: string): Promise<string> {
  const held = planes.get(name);
  if (held) return held;
  const b = await httpJson<Box>(boxUrl(ctx, name), { headers: auth(ctx) });
  if (!b.dataplane_url) throw new Error(`langsmith sandbox ${name} has no dataplane_url`);
  planes.set(name, b.dataplane_url.replace(/\/+$/, ""));
  return planes.get(name)!;
}

/** The workspace's resource limits: a 429 whose body says "Quota exceeded" but means concurrency. */
function limitNotCredit(err: unknown): never {
  if (err instanceof HttpError && err.status === 429) {
    throw new HttpError(429, `langsmith: too many sandboxes for the workspace's limits (count, CPU or memory)`);
  }
  throw err;
}

export const langsmithProvider = defineProvider({
  info: {
    id: "langsmith",
    name: "LangSmith Sandboxes",
    homepage: "https://www.langchain.com/langsmith/sandboxes",
    env: ["LANGSMITH_API_KEY"],
    capabilities: ["extendTimeout"],
    isolation: "microvm",
    enforcesTimeout: false,
    freeTier: {
      // 1 LSU = $1.
      tier: { kind: "monthly-credit", usd: 8 },
      concurrency: 10,
      requiresCard: false,
      notes: "Developer plan ($0): 8 LSU ($8) of sandbox usage a month, about 42 h of 2 vCPU / 4 GiB; limited to 10 sandboxes. Plus ($39/seat) also includes 8 LSU, then pay as you go.",
      source: "https://www.langchain.com/pricing",
      checked: "2026-11-21",
    },
    pricing: { vcpuSecondUsd: 0.0576 / 3600, gibSecondUsd: 0.01845 / 3600, defaultCpu: 2, defaultMemoryMiB: 4096, source: "https://www.langchain.com/pricing" },
    surfaces: { rest: "https://api.smith.langchain.com/api/v2/sandboxes", sdk: ["langsmith (npm, langsmith/sandbox)", "langsmith (PyPI)"], cli: "langsmith sandbox" },
  },

  async create(spec, ctx) {
    const size = langsmithSize(spec.cpu, spec.memoryMiB);
    // The name comes from the router id, so a retried create finds the first one (409) instead
    // of making another.
    const name = sbrName(spec);
    const template = spec.nativeTemplate ?? (ctx.options["snapshot"] as string | undefined);
    const isId = template !== undefined && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(template);
    let b: Box;
    try {
      b = await httpJson<Box>(`${base(ctx)}/boxes`, {
        headers: auth(ctx),
        body: {
          name,
          wait_for_ready: false,
          ...(isId ? { snapshot_id: template } : template ? { snapshot: template } : {}),
          vcpus: size.vcpus,
          mem_bytes: size.memBytes,
          persistent: false,
          idle_ttl_seconds: minutes(spec.timeoutSec),
          delete_after_stop_seconds: 60,
          env_vars: spec.env,
          labels: spec.metadata,
        },
      });
    } catch (err) {
      if (err instanceof HttpError && err.status === 409) b = await httpJson<Box>(boxUrl(ctx, name), { headers: auth(ctx) });
      else limitNotCredit(err);
    }
    try {
      let status = b.status ?? "provisioning";
      for (let i = 0; i < 600 && status !== "ready"; i++) {
        if (status === "failed" || status === "deleting" || status === "stopped") throw new Error(`langsmith sandbox ${name} is ${status}${b.status_message ? `: ${b.status_message}` : ""}`);
        await sleep(pollMs(ctx, 1000));
        const cur = await httpJson<{ status: Box["status"]; status_message?: string }>(boxUrl(ctx, name, "/status"), { headers: auth(ctx) });
        status = cur.status ?? "provisioning";
        b = { ...b, status: cur.status, status_message: cur.status_message };
      }
      if (status !== "ready") throw new Error(`langsmith sandbox ${name} did not become ready`);
      if (b.dataplane_url) planes.set(name, b.dataplane_url.replace(/\/+$/, ""));
      else await plane(ctx, name);
    } catch (err) {
      await this.kill(name, ctx).catch(() => undefined);
      throw err;
    }
    return { providerSandboxId: name, cpu: b.vcpus ?? size.vcpus, memoryMiB: Math.round((b.mem_bytes ?? size.memBytes) / (1024 * 1024)) };
  },

  async exec(id, command, o, ctx) {
    // Both official SDKs send `timeout`; the spec names `timeout_seconds`. Both are sent.
    const timeout = Math.max(1, Math.ceil(o.timeoutSec ?? 3600));
    const runConfig = o.cwd || (o.env && Object.keys(o.env).length) ? { run_config: { work_dir: o.cwd, env_vars: o.env } } : {};
    try {
      const r = await httpJson<{ stdout?: string; stderr?: string; exit_code?: number }>(`${await plane(ctx, id)}/execute`, {
        headers: auth(ctx),
        body: { command, shell: "/bin/bash", timeout, timeout_seconds: timeout, ...runConfig },
        timeoutMs: (timeout + 30) * 1000,
      });
      if (r.stdout) o.onStdout?.(r.stdout);
      if (r.stderr) o.onStderr?.(r.stderr);
      return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", exitCode: r.exit_code ?? -1 };
    } catch (err) {
      // 422: the command outran the synchronous request deadline.
      if (err instanceof HttpError && err.status === 422 && /deadline/i.test(err.message)) {
        const stderr = `langsmith: the command outran the synchronous request deadline\n`;
        o.onStderr?.(stderr);
        return { stdout: "", stderr, exitCode: 124 };
      }
      throw err;
    }
  },

  async readFile(id, path, ctx) {
    return new Uint8Array(await (await http(`${await plane(ctx, id)}/download?path=${encodeURIComponent(path)}`, { headers: auth(ctx) })).arrayBuffer());
  },

  async writeFile(id, path, data, ctx) {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(data)], { type: "application/octet-stream" }), "file");
    await http(`${await plane(ctx, id)}/upload?path=${encodeURIComponent(path)}`, { method: "POST", headers: auth(ctx), raw: form });
  },

  async setTimeout(id, timeoutSec, ctx) {
    // Moves the idle window; the router's own deadline still decides when it is deleted.
    await http(boxUrl(ctx, id), { method: "PATCH", headers: auth(ctx), body: { idle_ttl_seconds: minutes(timeoutSec) } });
  },

  async kill(id, ctx) {
    planes.delete(id);
    try {
      await http(boxUrl(ctx, id), { method: "DELETE", headers: auth(ctx) });
    } catch (err) {
      if (!(err instanceof HttpError && (err.status === 404 || err.status === 410))) throw err;
    }
  },

  async listAlive(ctx) {
    const names: string[] = [];
    let cursor: string | undefined;
    do {
      const q = new URLSearchParams({ page_size: "100", name_contains: "sbr-", ...(cursor ? { cursor } : {}) });
      const page = await httpJson<{ items?: Box[]; next_cursor?: string | null }>(`${base(ctx)}/boxes?${q}`, { headers: auth(ctx) });
      if (!Array.isArray(page.items)) throw new Error("langsmith: unexpected response shape listing sandboxes");
      // A workspace may hold sandboxes the router didn't make; a stopped one still exists.
      names.push(...page.items.filter((b) => b.name.startsWith("sbr-") && b.status !== "deleting" && b.status !== "failed").map((b) => b.name));
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    return names;
  },
});

