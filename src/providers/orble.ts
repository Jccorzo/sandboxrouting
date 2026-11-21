// Orble (orble.tech): Linux virtual machines ("boxes") for agents, suspended when idle and
// resumed with memory and processes kept. No free tier: prepaid credit. Billed per second
// while running: size S (2 vCPU / 4 GiB) $0.015/h, M (4 / 8) $0.03/h, L (8 / 16) $0.06/h;
// suspended boxes pay only for storage. Only Orble's own boxes are in scope here; the other
// vendors' sandboxes Orble lists are not.
// A box has no time limit, so the router deletes it at the deadline (enforcesTimeout: false).
// REST: https://orble.tech/v1 (Bearer orble_…), the API the official SDKs call:
// github.com/orbletech/orble-sdk (js/src/index.ts); docs orble.tech/docs.md and
// orble.tech/pricing.md. npm `@orble/sdk`, PyPI `orble-sdk`, CLI `orble`, MCP
// https://orble.tech/mcp. Orble also serves E2B- and Daytona-compatible APIs.
// Boxes are addressed by name. Commands run with `/bin/sh -c` as `agent` in /home/agent, at
// most 600 s (exit 124 at the timeout); a call still running after about 50 s answers with a
// job to ask again. Create takes no env, labels or idempotency key.

import { defineProvider, http, httpJson, HttpError } from "./util.js";
import { ENV_FILE, envFileBody, pollMs, sbrName, sleep, withEnvFile } from "./rest-helpers.js";
import type { ProviderContext } from "../core/types.js";

const base = (ctx: ProviderContext) => String(ctx.env["ORBLE_API_URL"] ?? "https://orble.tech").replace(/\/+$/, "");
const auth = (ctx: ProviderContext) => ({ authorization: `Bearer ${ctx.env["ORBLE_API_KEY"]}` });
const box = (ctx: ProviderContext, name: string, path = "") => `${base(ctx)}/v1/boxes/${encodeURIComponent(name)}${path}`;
const gone = (err: unknown) => err instanceof HttpError && (err.status === 404 || err.status === 410);
const EXEC_LIMIT_SEC = 600;

const SIZES = [
  { size: "s", cpu: 2, memoryMiB: 4096 },
  { size: "m", cpu: 4, memoryMiB: 8192 },
  { size: "l", cpu: 8, memoryMiB: 16384 },
];
/** Orble sizes, smallest first: the first that fits the request. */
export function orbleSize(cpu: number, memoryMiB: number) {
  return SIZES.find((s) => s.cpu >= cpu && s.memoryMiB >= memoryMiB) ?? SIZES[SIZES.length - 1]!;
}

interface Box {
  name: string;
  state?: string;
}
interface ExecReply {
  running?: boolean;
  job?: string;
  exit_code?: number;
  stdout?: string;
  stderr?: string;
  timed_out?: boolean;
}

export const orbleProvider = defineProvider({
  info: {
    id: "orble",
    name: "Orble",
    homepage: "https://orble.tech",
    env: ["ORBLE_API_KEY"],
    capabilities: ["ports", "pause", "snapshot"],
    isolation: "vm",
    enforcesTimeout: false,
    maxExecSec: EXEC_LIMIT_SEC,
    freeTier: {
      tier: { kind: "none" },
      notes: "No free tier: prepaid credit for usage. Pro ($20 a month) adds egress rules, secrets, box networks and more capacity.",
      source: "https://orble.tech/pricing.md",
      checked: "2026-11-21",
    },
    // Linear in size: $0.0075 per vCPU-hour with 2 GiB per vCPU included.
    pricing: { vcpuSecondUsd: 0.0075 / 3600, gibSecondUsd: 0, defaultCpu: 2, defaultMemoryMiB: 4096, source: "https://orble.tech/pricing.md" },
    surfaces: { rest: "https://orble.tech/v1", sdk: ["@orble/sdk (npm)", "orble-sdk (PyPI)"], cli: "orble", mcp: "https://orble.tech/mcp" },
  },

  async create(spec, ctx) {
    const size = orbleSize(spec.cpu, spec.memoryMiB);
    const name = sbrName(spec);
    const made = await httpJson<Box>(`${base(ctx)}/v1/boxes`, {
      headers: auth(ctx),
      body: { name, size: size.size, ...(spec.nativeTemplate ? { from: spec.nativeTemplate } : {}) },
      timeoutMs: 300_000,
    });
    const id = made.name ?? name;
    try {
      let cur = made;
      for (let i = 0; i < 300 && cur.state !== undefined && cur.state !== "running"; i++) {
        if (/fail|error|delet/i.test(cur.state)) throw new Error(`orble box ${id} is ${cur.state}`);
        await sleep(pollMs(ctx, 1000));
        cur = await httpJson<Box>(box(ctx, id), { headers: auth(ctx) });
      }
      if (cur.state !== undefined && cur.state !== "running") throw new Error(`orble box ${id} did not start`);
      if (Object.keys(spec.env).length) await this.writeFile(id, ENV_FILE, new TextEncoder().encode(envFileBody(spec.env)), ctx);
    } catch (err) {
      await http(box(ctx, id), { method: "DELETE", headers: auth(ctx) }).catch(() => undefined);
      throw err;
    }
    return { providerSandboxId: id, cpu: size.cpu, memoryMiB: size.memoryMiB };
  },

  async exec(id, command, o, ctx) {
    const timeout_s = Math.min(EXEC_LIMIT_SEC, Math.max(1, Math.ceil(o.timeoutSec ?? EXEC_LIMIT_SEC)));
    let r = await httpJson<ExecReply>(box(ctx, id, "/exec"), {
      headers: auth(ctx),
      body: { command: withEnvFile(command), timeout_s, ...(o.env ? { env: o.env } : {}), ...(o.cwd ? { cwd: o.cwd } : {}) },
      timeoutMs: 120_000,
    });
    while (r.running) r = await httpJson<ExecReply>(box(ctx, id, "/exec"), { headers: auth(ctx), body: { job: r.job }, timeoutMs: 120_000 });
    const stdout = r.stdout ?? "";
    const stderr = r.stderr ?? "";
    if (stdout) o.onStdout?.(stdout);
    if (stderr) o.onStderr?.(stderr);
    return { stdout, stderr, exitCode: r.exit_code ?? (r.timed_out ? 124 : 1) };
  },

  async readFile(id, path, ctx) {
    // Read in parts: each answer says its encoding, the bytes it holds and the file's size.
    const parts: Buffer[] = [];
    for (let offset = 0; ; ) {
      const r = await httpJson<{ content: string; encoding: string; bytes: number; size: number }>(`${box(ctx, id, "/files")}?path=${encodeURIComponent(path)}&offset=${offset}`, { headers: auth(ctx) });
      const part = r.encoding === "utf-8" ? Buffer.from(r.content, "utf8") : Buffer.from(r.content, "base64");
      parts.push(part);
      offset += r.bytes;
      if (!part.length || !r.bytes || offset >= r.size) break;
    }
    return new Uint8Array(Buffer.concat(parts));
  },

  async writeFile(id, path, data, ctx) {
    // Replaces the file and makes missing directories; at most 8 MiB.
    await http(`${box(ctx, id, "/files")}?path=${encodeURIComponent(path)}`, { method: "PUT", headers: { ...auth(ctx), "content-type": "application/octet-stream" }, raw: data });
  },

  async getUrl(id, port, ctx) {
    return (await httpJson<{ url: string }>(box(ctx, id, `/ports/${port}`), { method: "PUT", headers: auth(ctx), body: { access: "public" } })).url;
  },

  async pause(id, ctx) {
    await http(box(ctx, id, "/suspend"), { method: "POST", headers: auth(ctx) });
  },

  async resume(id, ctx) {
    await http(box(ctx, id, "/resume"), { method: "POST", headers: auth(ctx) });
  },

  async kill(id, ctx) {
    await http(box(ctx, id), { method: "DELETE", headers: auth(ctx) }).catch((err) => {
      if (!gone(err)) throw err;
    });
  },

  async listAlive(ctx) {
    const boxes = await httpJson<Box[]>(`${base(ctx)}/v1/boxes`, { headers: auth(ctx) });
    return boxes.filter((b) => !/delet|fail|error/i.test(b.state ?? "")).map((b) => b.name);
  },
});
