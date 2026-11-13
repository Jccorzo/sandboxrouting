// Buddy Sandboxes (buddy.works): stateful Ubuntu VMs from a pre-warmed pool, 50 GB disk.
// Free plan: $1 of usage every month, no card. $0.0144 per vCPU-hour and per GB-hour.
// A sandbox's `timeout` only stops it after inactivity and never deletes it (a stopped one
// still bills disk), so the router deletes it at the deadline (enforcesTimeout: false).
// REST: https://api.buddy.works (EU and Asia are separate installations with their own
// tokens), Bearer personal access token. Sandboxes live in a workspace and project.
// The synchronous exec fails after 60 s, so commands run as background execs that are
// polled; their log interleaves the streams, so stderr is kept apart in a scratch file.
// npm `@buddy-works/sandbox-sdk` (pre-1.0), CLI `bdy sandbox`, MCP https://mcp.buddy.works/mcp.

import { randomUUID } from "node:crypto";
import { defineProvider, http, httpJson } from "./util.js";
import { inline, pollMs, sbrName, sleep } from "./rest-helpers.js";
import type { ProviderContext } from "../core/types.js";

const HOSTS: Record<string, string> = { US: "https://api.buddy.works", EU: "https://api.eu.buddy.works", AS: "https://api.asia.buddy.works" };
const base = (ctx: ProviderContext) =>
  String(ctx.env["BUDDY_API_URL"] ?? HOSTS[String(ctx.env["BUDDY_REGION"] ?? "US").toUpperCase()] ?? HOSTS["US"]).replace(/\/+$/, "");
const auth = (ctx: ProviderContext) => ({ authorization: `Bearer ${ctx.env["BUDDY_TOKEN"]}` });
const all = (ctx: ProviderContext) => `${base(ctx)}/workspaces/${encodeURIComponent(String(ctx.env["BUDDY_WORKSPACE"]))}/sandboxes`;
const box = (ctx: ProviderContext, id: string, path = "") => `${all(ctx)}/${encodeURIComponent(id)}${path}`;
/** Content routes take the absolute path without its leading slash. */
const rel = (path: string) => path.replace(/^\/+/, "").split("/").map(encodeURIComponent).join("/");
const EXEC_LIMIT_SEC = 90 * 60;

/** Buddy sizes are "<vCPU>x<GB>" with twice as many GB as vCPUs, from 1x2 to 12x24. */
export function buddyResources(cpu: number, memoryMiB: number): { resources: string; cpu: number; memoryMiB: number } {
  const n = Math.min(12, Math.max(1, Math.ceil(cpu), Math.ceil(memoryMiB / 2048)));
  return { resources: `${n}x${n * 2}`, cpu: n, memoryMiB: n * 2048 };
}

interface Sandbox {
  id: string;
  status: "STARTING" | "STOPPING" | "FAILED" | "RUNNING" | "STOPPED" | "RESTORING";
  setup_status?: "INPROGRESS" | "SUCCESS" | "FAILED" | "STALE";
  endpoints?: Endpoint[];
}
interface Endpoint {
  name?: string;
  endpoint?: string;
  endpoint_url?: string;
  http?: { endpoint_url?: string };
}
interface Exec {
  execution_id?: string;
  id?: string;
  status: "INPROGRESS" | "SUCCESSFUL" | "FAILED" | "CANCELLED";
  exit_code?: number;
  failure_reason?: string;
}

/** Waits until the sandbox runs and its setup is done; file calls are dropped before that. */
async function ready(ctx: ProviderContext, sandbox: Sandbox): Promise<void> {
  for (let i = 0; i < 600; i++) {
    if (sandbox.status === "FAILED" || sandbox.setup_status === "FAILED") throw new Error(`buddy sandbox ${sandbox.id} failed to start`);
    if (sandbox.status === "RUNNING" && (sandbox.setup_status ?? "SUCCESS") === "SUCCESS") return;
    await sleep(pollMs(ctx, 500));
    sandbox = await httpJson<Sandbox>(box(ctx, sandbox.id), { headers: auth(ctx) });
  }
  throw new Error(`buddy sandbox ${sandbox.id} did not become ready`);
}

/** Runs one command with the 60-second synchronous call. */
const quick = (ctx: ProviderContext, id: string, command: string) =>
  httpJson<{ exit_code: number; stdout: string; stderr: string }>(box(ctx, id, "/exec"), { headers: auth(ctx), body: { command, runtime: "BASH" }, timeoutMs: 90_000 });

export const buddyProvider = defineProvider({
  info: {
    id: "buddy",
    name: "Buddy Sandboxes",
    homepage: "https://buddy.works/sandboxes",
    env: ["BUDDY_TOKEN", "BUDDY_WORKSPACE", "BUDDY_PROJECT"],
    capabilities: ["ports", "pause", "fileList", "snapshot"],
    isolation: "vm",
    enforcesTimeout: false,
    maxExecSec: EXEC_LIMIT_SEC,
    freeTier: {
      tier: { kind: "monthly-credit", usd: 1 },
      requiresCard: false,
      notes: "Free plan: $1 of usage a month (compute and storage), no card; sandboxes stop when it is used up.",
      source: "https://buddy.works/pricing",
      checked: "2026-11-12",
    },
    pricing: { vcpuSecondUsd: 0.0144 / 3600, gibSecondUsd: 0.0144 / 3600, defaultCpu: 2, defaultMemoryMiB: 4096, source: "https://buddy.works/pricing" },
    surfaces: { rest: "https://api.buddy.works", sdk: ["@buddy-works/sandbox-sdk (npm)"], cli: "bdy sandbox", mcp: "https://mcp.buddy.works/mcp" },
  },

  async create(spec, ctx) {
    const size = buddyResources(spec.cpu, spec.memoryMiB);
    const name = sbrName(spec);
    const sandbox = await httpJson<Sandbox>(`${all(ctx)}?project_name=${encodeURIComponent(String(ctx.env["BUDDY_PROJECT"]))}`, {
      headers: auth(ctx),
      body: {
        name,
        identifier: name,
        os: String(ctx.options["os"] ?? "ubuntu:24.04"),
        resources: size.resources,
        tags: ["sandboxrouting"],
        variables: Object.entries(spec.env).map(([key, value]) => ({ key, value })),
        snapshot_id: spec.nativeTemplate,
      },
    });
    try {
      await ready(ctx, sandbox);
    } catch (err) {
      await http(box(ctx, sandbox.id), { method: "DELETE", headers: auth(ctx) }).catch(() => undefined);
      throw err;
    }
    return { providerSandboxId: sandbox.id, cpu: size.cpu, memoryMiB: size.memoryMiB };
  },

  async exec(id, command, o, ctx) {
    // No cwd, env or timeout fields. Commands start in /buddy as user `buddy`.
    const errFile = `/tmp/.sbr-${randomUUID()}.err`;
    const limit = Math.min(EXEC_LIMIT_SEC, o.timeoutSec ?? EXEC_LIMIT_SEC);
    const started = await httpJson<Exec>(box(ctx, id, "/execs"), {
      headers: auth(ctx),
      body: { command: `{ ${inline(command, o)}\n} 2> ${errFile}`, runtime: "BASH" },
    });
    const execId = String(started.execution_id ?? started.id);
    const one = box(ctx, id, `/execs/${encodeURIComponent(execId)}`);
    const deadline = Date.now() + limit * 1000;
    let cur = started;
    let timedOut = false;
    while (cur.status === "INPROGRESS") {
      if (Date.now() >= deadline) {
        timedOut = true;
        await http(one, { method: "DELETE", headers: auth(ctx) }).catch(() => undefined);
        break;
      }
      const wait = Math.min(pollMs(ctx, 25_000), Math.max(0, deadline - Date.now()));
      cur = await httpJson<Exec>(`${one}?wait=${wait}`, { headers: auth(ctx), timeoutMs: wait + 30_000 });
    }

    const lines: string[] = [];
    for (let offset = 0; ; ) {
      const page = await httpJson<{ lines?: string[]; next_offset?: number }>(`${one}/log?offset=${offset}&limit=1000`, { headers: auth(ctx) });
      lines.push(...(page.lines ?? []));
      if ((page.lines ?? []).length < 1000 || page.next_offset === undefined || page.next_offset <= offset) break;
      offset = page.next_offset;
    }
    const stdout = lines.length ? `${lines.join("\n")}\n` : "";
    // Every outcome reads and clears the scratch file, not just success.
    let stderr = (await quick(ctx, id, `cat ${errFile} 2>/dev/null; rm -f ${errFile}`).catch(() => ({ stdout: "" }))).stdout;
    if (stdout) o.onStdout?.(stdout);
    if (timedOut) stderr += `timed out after ${limit} s\n`;
    else if (cur.exit_code === undefined && cur.status !== "SUCCESSFUL") stderr += `buddy exec ${cur.status}${cur.failure_reason ? `: ${cur.failure_reason}` : ""}\n`;
    if (stderr) o.onStderr?.(stderr);
    return { stdout, stderr, exitCode: timedOut ? 124 : cur.exit_code ?? (cur.status === "SUCCESSFUL" ? 0 : 1) };
  },

  async readFile(id, path, ctx) {
    return new Uint8Array(await (await http(box(ctx, id, `/download/${rel(path)}`), { headers: auth(ctx) })).arrayBuffer());
  },

  async writeFile(id, path, data, ctx) {
    const form = new FormData();
    form.append("file", new Blob([data as Uint8Array<ArrayBuffer>]), path.slice(path.lastIndexOf("/") + 1));
    const user = encodeURIComponent(String(ctx.options["user"] ?? "buddy"));
    await http(`${box(ctx, id, `/content/upload/${rel(path)}`)}?userName=${user}`, { method: "POST", headers: auth(ctx), raw: form });
  },

  async listFiles(id, path, ctx) {
    const r = await httpJson<{ contents?: { type: string; name: string; path?: string; size?: number }[] }>(box(ctx, id, `/content/${rel(path)}`), { headers: auth(ctx) });
    const dir = path.endsWith("/") ? path : `${path}/`;
    return (r.contents ?? []).map((e) => ({ name: e.name, path: `${dir}${e.name}`, isDir: e.type === "DIR", size: e.size }));
  },

  async getUrl(id, port, ctx) {
    const name = `sbr-${port}`;
    const urlOf = (s: Sandbox) => {
      const e = (s.endpoints ?? []).find((x) => x.name === name);
      return e?.endpoint_url ?? e?.http?.endpoint_url;
    };
    const cur = await httpJson<Sandbox>(box(ctx, id), { headers: auth(ctx) });
    const have = urlOf(cur);
    if (have) return have;
    // PATCH replaces the list, so the endpoints already there are sent back with the new one.
    const endpoints = [...(cur.endpoints ?? []).filter((e) => e.name !== name), { name, endpoint: String(port), type: "HTTP" }];
    const url = urlOf(await httpJson<Sandbox>(box(ctx, id), { method: "PATCH", headers: auth(ctx), body: { endpoints } }));
    if (!url) throw new Error(`buddy returned no URL for port ${port}`);
    return url;
  },

  async pause(id, ctx) {
    // Keeps the disk; memory and processes are lost.
    await http(box(ctx, id, "/stop"), { method: "POST", headers: auth(ctx) });
  },

  async resume(id, ctx) {
    await ready(ctx, await httpJson<Sandbox>(box(ctx, id, "/start"), { method: "POST", headers: auth(ctx) }));
  },

  async kill(id, ctx) {
    await http(box(ctx, id), { method: "DELETE", headers: auth(ctx) });
  },

  async listAlive(ctx) {
    const r = await httpJson<{ sandboxes?: (Sandbox & { name?: string })[] }>(`${all(ctx)}?project_name=${encodeURIComponent(String(ctx.env["BUDDY_PROJECT"]))}`, {
      headers: auth(ctx),
    });
    // A project may hold sandboxes the router didn't make; a stopped one still exists.
    return (r.sandboxes ?? []).filter((s) => (s.name ?? "").startsWith("sbr-") && s.status !== "FAILED").map((s) => s.id);
  },
});
