// Keln Sandboxes (keln.ai): Linux microVMs from an inference platform, on the same API keys and
// prepaid balance as its models. $0.0504 per vCPU-hour + $0.0162 per GiB-hour, per second while
// running; paused and stopped sandboxes are free. No free tier: create and resume need the
// balance to cover the first 5 minutes (402 insufficient_balance). 3 running sandboxes before the
// first paid top-up, 20 after; at most 24 h per session.
// REST: https://sandbox.keln.ai (Bearer sk-keln-…). Docs: docs.keln.ai/sandboxes/ (overview,
// limits, pricing), docs.keln.ai/api/sandboxes/ (every endpoint and error code), docs.keln.ai/llms.txt.
// Commands stream as server-sent events (base64 output); a dropped stream is reattached from
// the last event id. Create and run take an Idempotency-Key. Errors are
// `{"error": {"type", "code", "message"}}`; deleting a stopped sandbox answers 200.

import { randomUUID } from "node:crypto";
import { defineProvider, http, httpJson, HttpError, refusals } from "./util.js";
import { pollMs, sleep, sse } from "./rest-helpers.js";
import type { ProviderContext } from "../core/types.js";

const base = (ctx: ProviderContext) => String(ctx.env["KELN_SANDBOX_URL"] ?? "https://sandbox.keln.ai").replace(/\/+$/, "");
const auth = (ctx: ProviderContext) => ({ authorization: `Bearer ${ctx.env["KELN_API_KEY"]}` });
const box = (ctx: ProviderContext, id: string, path = "") => `${base(ctx)}/v1/sandboxes/${encodeURIComponent(id)}${path}`;
const gone = (err: unknown) => err instanceof HttpError && (err.status === 404 || err.status === 410);

/** 429 daily_limit is the workspace's sandbox time for the day: a quota, not a rate limit. */
const refused = refusals("keln", [{ status: 429, body: /daily_limit/, kind: "quota", why: "sandbox time for the day used up" }]);

/** 1 to 4 vCPUs; memory 1,024 to 8,192 MiB per vCPU, at most 16,384, in whole GiB. */
export function kelnSize(cpu: number, memoryMiB: number): { cpu: number; memory_mb: number } {
  const c = Math.min(4, Math.max(1, Math.ceil(cpu)));
  const gib = Math.ceil(Math.max(1024, memoryMiB) / 1024);
  return { cpu: c, memory_mb: Math.min(16, c * 8, Math.max(c, gib)) * 1024 };
}

/** Metadata: at most 50 keys, keys up to 40 characters, values up to 500. */
const metadata = (m: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(m)
      .filter(([k, v]) => k.length <= 40 && v.length <= 500)
      .slice(0, 50),
  );

interface Sandbox {
  id: string;
  state: string;
  end_reason?: string | null;
  ports?: { port: number; public: boolean; url: string }[];
}

export const kelnProvider = defineProvider({
  info: {
    id: "keln",
    name: "Keln Sandboxes",
    homepage: "https://keln.ai",
    env: ["KELN_API_KEY"],
    capabilities: ["ports", "pause", "snapshot", "fileList", "extendTimeout"],
    isolation: "microvm",
    maxTimeoutSec: 86_400,
    freeTier: {
      tier: { kind: "none" },
      concurrency: 3,
      requiresCard: true,
      notes: "Prepaid balance only, no monthly fee and no free credit. 3 running sandboxes until the first paid top-up, then 20; 24 h per session.",
      source: "https://docs.keln.ai/sandboxes/",
      checked: "2026-11-21",
    },
    // 2 vCPU / 4 GiB is $0.166/h.
    pricing: { vcpuSecondUsd: 0.0504 / 3600, gibSecondUsd: 0.0162 / 3600, defaultCpu: 2, defaultMemoryMiB: 4096, source: "https://docs.keln.ai/sandboxes/" },
    surfaces: { rest: "https://sandbox.keln.ai/v1", mcp: "docs.keln.ai/mcp/" },
  },

  async create(spec, ctx) {
    const size = kelnSize(spec.cpu, spec.memoryMiB);
    // A native template that names one of your images (img_…) starts from it; anything else is a template name.
    const native = spec.nativeTemplate;
    let r: Sandbox;
    try {
      r = await httpJson<Sandbox>(`${base(ctx)}/v1/sandboxes`, {
        headers: { ...auth(ctx), "idempotency-key": spec.metadata["sandboxrouting.id"] ?? randomUUID() },
        body: {
          ...(native?.startsWith("img_") ? { image: native } : native ? { template: native } : {}),
          ...size,
          timeout_s: Math.min(86_400, Math.max(1, Math.ceil(spec.timeoutSec))),
          env: spec.env,
          metadata: metadata(spec.metadata),
        },
        timeoutMs: 300_000,
      });
    } catch (err) {
      throw refused(err);
    }
    try {
      let cur = r;
      for (let i = 0; i < 600 && cur.state !== "running"; i++) {
        if (cur.state === "stopped") throw new Error(`keln sandbox ${r.id} stopped while starting${cur.end_reason ? `: ${cur.end_reason}` : ""}`);
        await sleep(pollMs(ctx, 1000));
        cur = await httpJson<Sandbox>(box(ctx, r.id), { headers: auth(ctx) });
      }
      if (cur.state !== "running") throw new Error(`keln sandbox ${r.id} did not start`);
    } catch (err) {
      // Keln made it: never leave it running when the create fails.
      await http(box(ctx, r.id), { method: "DELETE", headers: auth(ctx) }).catch(() => undefined);
      throw err;
    }
    return { providerSandboxId: r.id, cpu: size.cpu, memoryMiB: size.memory_mb };
  },

  async exec(id, command, o, ctx) {
    const timeout_s = o.timeoutSec ? Math.max(1, Math.ceil(o.timeoutSec)) : undefined;
    const timeoutMs = ((timeout_s ?? 86_400) + 60) * 1000;
    let stdout = "";
    let stderr = "";
    let commandId: string | undefined;
    // Event ids are positions in the command's stream (1, 2, 3…), stable across reattaches.
    let seen = 0;
    // The first request runs the command; a stream that drops is reattached after its last event.
    for (let attempt = 0; attempt < 5; attempt++) {
      const res =
        commandId === undefined
          ? await http(box(ctx, id, "/commands"), {
              headers: { ...auth(ctx), accept: "text/event-stream", "idempotency-key": randomUUID() },
              body: { command, cwd: o.cwd, env: o.env, timeout_s },
              timeoutMs,
            })
          : await http(box(ctx, id, `/commands/${encodeURIComponent(commandId)}/events`), {
              headers: { ...auth(ctx), accept: "text/event-stream", ...(seen ? { "last-event-id": String(seen) } : {}) },
              timeoutMs,
            });
      commandId ??= res.headers.get("keln-command-id") ?? undefined;
      try {
        for await (const ev of sse(res.body as unknown as AsyncIterable<Uint8Array>)) {
          if (!ev.data) continue;
          const d = JSON.parse(ev.data) as Record<string, unknown>;
          if (ev.event !== "error") seen++;
          if (ev.event === "started") commandId = String(d["command_id"]);
          else if (ev.event === "stdout" || ev.event === "stderr") {
            const text = Buffer.from(String(d["data"] ?? ""), "base64").toString("utf8");
            if (ev.event === "stdout") {
              stdout += text;
              o.onStdout?.(text);
            } else {
              stderr += text;
              o.onStderr?.(text);
            }
          } else if (ev.event === "exit") {
            const code = d["exit_code"];
            const signal = d["signal"];
            // Stopped by its timeout or a signal: the shell's 128 + signal.
            return { stdout, stderr, exitCode: typeof code === "number" ? code : 128 + (typeof signal === "number" ? signal : 9) };
          } else if (ev.event === "error") throw new Error(`keln exec: ${JSON.stringify(d["error"] ?? d)}`);
        }
      } catch (err) {
        if (commandId === undefined || /keln exec:/.test(String(err))) throw err;
      }
      if (commandId === undefined) break;
    }
    throw new Error("keln exec: the stream ended without an exit event");
  },

  async readFile(id, path, ctx) {
    return new Uint8Array(await (await http(`${box(ctx, id, "/files")}?path=${encodeURIComponent(path)}`, { headers: auth(ctx) })).arrayBuffer());
  },

  async writeFile(id, path, data, ctx) {
    await http(`${box(ctx, id, "/files")}?path=${encodeURIComponent(path)}`, {
      method: "PUT",
      headers: { ...auth(ctx), "content-type": "application/octet-stream" },
      raw: data,
    });
  },

  async listFiles(id, path, ctx) {
    const r = await httpJson<{ data: { name: string; path: string; type: string; size?: number }[] }>(`${box(ctx, id, "/files/list")}?path=${encodeURIComponent(path)}`, {
      headers: auth(ctx),
    });
    return r.data.map((e) => ({ name: e.name, path: e.path, isDir: e.type === "dir", size: e.size }));
  },

  async getUrl(id, port, ctx) {
    // `ports` replaces the whole list, so the ports already open are sent back with this one.
    const cur = await httpJson<Sandbox>(box(ctx, id), { headers: auth(ctx) });
    const ports = [...(cur.ports ?? []).filter((p) => p.port !== port).map((p) => ({ port: p.port, public: p.public })), { port, public: true }];
    const r = await httpJson<Sandbox>(box(ctx, id), { method: "PATCH", headers: auth(ctx), body: { ports } });
    const url = r.ports?.find((p) => p.port === port)?.url;
    if (!url) throw new Error(`keln did not open port ${port} on ${id}`);
    return url;
  },

  async setTimeout(id, timeoutSec, ctx) {
    await http(box(ctx, id, "/timeout"), { headers: auth(ctx), body: { timeout_s: Math.min(86_400, Math.max(1, Math.ceil(timeoutSec))) } });
  },

  async pause(id, ctx) {
    await http(box(ctx, id, "/pause"), { method: "POST", headers: auth(ctx) });
  },

  async resume(id, ctx) {
    await http(box(ctx, id, "/resume"), { method: "POST", headers: auth(ctx) }).catch((err) => {
      throw refused(err);
    });
  },

  async kill(id, ctx) {
    // Deleting a stopped sandbox answers 200; one Keln no longer knows is gone too.
    await http(box(ctx, id), { method: "DELETE", headers: auth(ctx) }).catch((err) => {
      if (!gone(err)) throw err;
    });
  },

  async listAlive(ctx) {
    const ids: string[] = [];
    let after: string | null = null;
    do {
      const q = new URLSearchParams({ state: "starting,running,paused", limit: "100", ...(after ? { after } : {}) });
      const page: { data: Sandbox[]; has_more: boolean; next_cursor: string | null } = await httpJson(`${base(ctx)}/v1/sandboxes?${q}`, { headers: auth(ctx) });
      ids.push(...page.data.map((s) => s.id));
      after = page.has_more ? page.next_cursor : null;
    } while (after);
    return ids;
  },
});
