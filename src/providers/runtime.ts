// Runtime Cloud (withruntime.com): Firecracker microVMs, each with its own kernel, disk and
// network. No free plan: the first machine asks for a card and starts a 7-day Pro trial with $5
// of usage; Pro is $25 a month with $25 of usage included. CPU is billed on use ($0.03 per busy
// vCPU-hour, at least 0.1 vCPU while running), memory on what the machine holds ($0.008 per
// GB-hour); a paused machine pays only for storage. Sandboxes pause after 300 s idle and wake
// on the next call. `deleteAfterSeconds` deletes it at the deadline; an update moves the end to
// that many seconds from now.
// REST: https://api.withruntime.com/v2 (Bearer key, version 2026-10-27), OpenAPI at
// api.withruntime.com/v2/openapi.json; docs withruntime.com/docs/reference/sandboxes.md,
// withruntime.com/docs/commands.md, withruntime.com/docs/lifecycle.md,
// withruntime.com/docs/pricing.md, withruntime.com/docs/errors.md. npm `withruntime` (SDK and
// `npx withruntime` CLI), MCP server.
// Commands start with `wait: false` and their output is read from a byte cursor until they end.

import { randomUUID } from "node:crypto";
import { SandboxRouterError } from "../core/errors.js";
import { defineProvider, http, httpJson, HttpError } from "./util.js";
import { pollMs, sbrName, sleep } from "./rest-helpers.js";
import type { ProviderContext } from "../core/types.js";

const base = (ctx: ProviderContext) => String(ctx.env["RUNTIME_API_URL"] ?? "https://api.withruntime.com").replace(/\/+$/, "");
const headers = (ctx: ProviderContext) => ({ authorization: `Bearer ${ctx.env["RUNTIME_API_KEY"]}`, "runtime-version": "2026-10-27" });
const box = (ctx: ProviderContext, id: string, path = "") => `${base(ctx)}/v2/sandboxes/${encodeURIComponent(id)}${path}`;
const gone = (err: unknown) => err instanceof HttpError && (err.status === 404 || err.status === 410);

interface Machine {
  id: string;
  state: "starting" | "running" | "paused" | "deleted" | "error";
  vcpu?: number;
  memoryGB?: number;
}
interface Process {
  id: string;
  state: "running" | "exited" | "killed" | "timed_out";
  exitCode?: number;
}

/**
 * A 403 `limit_exceeded` is the plan's vCPUs-at-once limit, not a bad key: it clears when
 * machines end, so it is a rate limit rather than spent credit.
 */
function refusal(err: unknown): unknown {
  if (err instanceof HttpError && err.status === 403 && /limit_exceeded/.test(err.message)) return new SandboxRouterError("rate_limit", err.message, "runtime", { cause: err });
  return err;
}

export const runtimeProvider = defineProvider({
  info: {
    id: "runtime",
    name: "Runtime Cloud",
    homepage: "https://withruntime.com",
    env: ["RUNTIME_API_KEY"],
    capabilities: ["ports", "pause", "snapshot", "fileList", "extendTimeout"],
    isolation: "microvm",
    freeTier: {
      tier: { kind: "one-time-credit", usd: 5 },
      requiresCard: true,
      notes: "No free plan. The first machine asks for a card and starts a 7-day Pro trial with $5 of usage; Pro then costs $25 a month with $25 of usage included. Pro: 100 vCPUs running at once, 8 per machine.",
      source: "https://withruntime.com/docs/pricing.md",
      checked: "2026-11-21",
    },
    pricing: { billing: "active-cpu", vcpuSecondUsd: 0.03 / 3600, gibSecondUsd: 0.008 / 3600, defaultCpu: 2, defaultMemoryMiB: 4096, source: "https://withruntime.com/docs/pricing.md" },
    surfaces: { rest: "https://api.withruntime.com/v2", sdk: ["withruntime (npm)", "withruntime (PyPI)"], cli: "npx withruntime", mcp: "Runtime MCP server" },
  },

  async create(spec, ctx) {
    const vcpu = Math.max(1, Math.ceil(spec.cpu));
    const memoryGB = Math.max(1, Math.ceil(spec.memoryMiB / 1024));
    let made: Machine;
    try {
      made = await httpJson<Machine>(`${base(ctx)}/v2/sandboxes`, {
        headers: { ...headers(ctx), "idempotency-key": spec.metadata["sandboxrouting.id"] ?? randomUUID() },
        body: {
          name: sbrName(spec),
          vcpu,
          memoryGB,
          labels: spec.metadata,
          env: spec.env,
          deleteAfterSeconds: Math.max(1, Math.ceil(spec.timeoutSec)),
          ...(spec.nativeTemplate ? { from: spec.nativeTemplate } : {}),
        },
        timeoutMs: 120_000,
      });
    } catch (err) {
      throw refusal(err);
    }
    try {
      let cur = made;
      for (let i = 0; i < 600 && cur.state !== "running"; i++) {
        if (cur.state === "error" || cur.state === "deleted") throw new Error(`runtime sandbox ${made.id} is ${cur.state}`);
        await sleep(pollMs(ctx, 1000));
        cur = await httpJson<Machine>(box(ctx, made.id), { headers: headers(ctx) });
      }
      if (cur.state !== "running") throw new Error(`runtime sandbox ${made.id} did not start`);
    } catch (err) {
      await http(box(ctx, made.id), { method: "DELETE", headers: headers(ctx) }).catch(() => undefined);
      throw err;
    }
    return { providerSandboxId: made.id, cpu: made.vcpu ?? vcpu, memoryMiB: Math.round((made.memoryGB ?? memoryGB) * 1024) };
  },

  async exec(id, command, o, ctx) {
    // Text `cmd` runs with `bash -lc`; a paused sandbox is resumed first.
    const p = await httpJson<Process>(box(ctx, id, ":exec"), {
      headers: { ...headers(ctx), "idempotency-key": randomUUID() },
      body: { cmd: command, cwd: o.cwd, env: o.env, wait: false, ...(o.timeoutSec ? { timeoutSeconds: o.timeoutSec } : {}) },
    });
    let stdout = "";
    let stderr = "";
    let cursor = 0;
    const waitSeconds = ctx.options["pollMs"] === undefined ? 8 : 0;
    for (;;) {
      const out = await httpJson<{ chunks: { stream: "stdout" | "stderr"; text: string }[]; nextCursor: number; process?: Process }>(
        `${box(ctx, id, `/processes/${encodeURIComponent(p.id)}/output`)}?cursor=${cursor}&waitSeconds=${waitSeconds}&maxBytes=196608`,
        { headers: headers(ctx), timeoutMs: 60_000 },
      );
      for (const c of out.chunks) {
        if (c.stream === "stderr") {
          stderr += c.text;
          o.onStderr?.(c.text);
        } else {
          stdout += c.text;
          o.onStdout?.(c.text);
        }
      }
      const advanced = out.nextCursor > cursor;
      cursor = out.nextCursor;
      const proc = out.process;
      if (proc && proc.state !== "running" && !advanced) {
        // A signal's end is negative; the shell's convention is 128 + signal.
        const code = proc.exitCode ?? (proc.state === "timed_out" ? 124 : 137);
        return { stdout, stderr, exitCode: proc.state === "timed_out" ? 124 : code < 0 ? 128 - code : code };
      }
      if (!advanced) await sleep(pollMs(ctx, 0));
    }
  },

  async readFile(id, path, ctx) {
    return new Uint8Array(await (await http(`${box(ctx, id, "/files")}?path=${encodeURIComponent(path)}`, { headers: headers(ctx) })).arrayBuffer());
  },

  async writeFile(id, path, data, ctx) {
    // Its folders are made; the file is whole once every byte came.
    await http(`${box(ctx, id, "/files")}?path=${encodeURIComponent(path)}`, { method: "PUT", headers: { ...headers(ctx), "content-type": "application/octet-stream" }, raw: data });
  },

  async listFiles(id, path, ctx) {
    const r = await httpJson<{ items: { path: string; name?: string; type?: string; size?: number; exists: boolean }[] }>(`${box(ctx, id, "/files/list")}?path=${encodeURIComponent(path)}&depth=1`, {
      headers: headers(ctx),
    });
    return r.items.filter((e) => e.exists).map((e) => ({ name: e.name ?? e.path.split("/").pop() ?? e.path, path: e.path, isDir: e.type === "directory", size: e.size }));
  },

  async getUrl(id, port, ctx) {
    return (await httpJson<{ url: string }>(box(ctx, id, "/previews"), { headers: headers(ctx), body: { port, visibility: "public" } })).url;
  },

  async setTimeout(id, timeoutSec, ctx) {
    await http(box(ctx, id, ":update"), { headers: { ...headers(ctx), "idempotency-key": randomUUID() }, body: { deleteAfterSeconds: Math.max(1, Math.ceil(timeoutSec)) } });
  },

  async pause(id, ctx) {
    await http(box(ctx, id, ":pause"), { method: "POST", headers: headers(ctx) });
  },

  async resume(id, ctx) {
    await http(box(ctx, id, ":resume"), { method: "POST", headers: headers(ctx) });
  },

  async kill(id, ctx) {
    // A deleted machine reads 404.
    await http(box(ctx, id), { method: "DELETE", headers: headers(ctx) }).catch((err) => {
      if (!gone(err)) throw err;
    });
  },

  async listAlive(ctx) {
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const q = new URLSearchParams({ limit: "200", ...(cursor ? { cursor } : {}) });
      const page: { items: Machine[]; next?: string | null } = await httpJson(`${base(ctx)}/v2/sandboxes?${q}`, { headers: headers(ctx) });
      ids.push(...page.items.filter((m) => m.state !== "deleted" && m.state !== "error").map((m) => m.id));
      cursor = page.next ?? undefined;
    } while (cursor);
    return ids;
  },
});
