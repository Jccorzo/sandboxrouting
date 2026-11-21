// Mandala Computer (mandala.computer): whole Linux desktops (VMs behind hardware virtualization)
// that agents see, click and run commands on. Plans are monthly pools ($29 Solo, up to 4
// computers); without one, pay as you go from prepaid credits: $0.03 per vCPU-hour + $0.015 per
// GB-hour of RAM, by the second while a computer runs ($0.12/h for 2 vCPU / 4 GB), disk $0.10 per
// GB-month while it exists. A plan or credits are required to launch anything (402 otherwise).
// REST: https://app.mandala.computer/api/v1 (Bearer key). Docs: mandala.computer/llms.txt,
// app.mandala.computer/llms-full.txt, OpenAPI 3.1 at app.mandala.computer/api/docs/openapi.json,
// mandala.computer/pricing.md, mandala.computer/security.md. npm/CLI `mandala-computer`, MCP.
// A computer has no TTL under 10 minutes: `ends_in_hours` stops it (disk kept and billed), so the
// router deletes it at the deadline (enforcesTimeout: false). Create takes no env: it is kept in a
// file every command loads. Commands run in the background and are polled, since the hosted edge
// cuts a foreground request off after about 120 s.

import { randomUUID } from "node:crypto";
import { defineProvider, http, httpJson, HttpError } from "./util.js";
import { ENV_FILE, envFileBody, pollMs, sbrName, sleep, withEnvFile } from "./rest-helpers.js";
import type { ProviderContext } from "../core/types.js";

const base = (ctx: ProviderContext) => String(ctx.env["MANDALA_API_URL"] ?? "https://app.mandala.computer/api/v1").replace(/\/+$/, "");
const auth = (ctx: ProviderContext) => ({ authorization: `Bearer ${ctx.env["MANDALA_API_KEY"]}` });
const pc = (ctx: ProviderContext, id: string, path = "") => `${base(ctx)}/computers/${encodeURIComponent(id)}${path}`;
const gone = (err: unknown) => err instanceof HttpError && (err.status === 404 || err.status === 410);

interface Computer {
  id: string;
  status: string;
  state?: string;
  cpu?: number;
  ram_mb?: number;
}
const FAILED = ["build-failed", "half-removed"];
/** `ends_in_hours` takes 10 minutes (0.17 h) to 366 days. */
const endsInHours = (sec: number) => Math.min(8784, Math.max(0.17, Math.round((sec / 3600) * 1000) / 1000));
const b64 = (s: string | undefined) => (s ? Buffer.from(s, "base64").toString("utf8") : "");

export const mandalaProvider = defineProvider({
  info: {
    id: "mandala",
    name: "Mandala Computer",
    homepage: "https://mandala.computer",
    env: ["MANDALA_API_KEY"],
    capabilities: ["ports", "pause", "snapshot", "fileList", "extendTimeout"],
    isolation: "vm",
    enforcesTimeout: false,
    freeTier: {
      tier: { kind: "none" },
      requiresCard: true,
      notes: "A paid plan (from $29/mo, a pool for up to 4 computers) or prepaid pay-as-you-go credits ($10/$25/$50 packs, 12 months) is required to launch a computer.",
      source: "https://mandala.computer/pricing.md",
      checked: "2026-11-21",
    },
    pricing: { vcpuSecondUsd: 0.03 / 3600, gibSecondUsd: 0.015 / 3600, defaultCpu: 2, defaultMemoryMiB: 4096, source: "https://mandala.computer/pricing.md" },
    surfaces: { rest: "https://app.mandala.computer/api/v1", sdk: ["mandala-computer (npm)", "mandala-computer (PyPI)"], cli: "mandala", mcp: "https://app.mandala.computer/mcp" },
  },

  async create(spec, ctx) {
    const cpu = Math.max(1, Math.ceil(spec.cpu));
    const ram_mb = Math.max(1024, Math.ceil(spec.memoryMiB));
    const r = await httpJson<Computer | { computer: Computer; start_error: string }>(`${base(ctx)}/computers`, {
      headers: { ...auth(ctx), "idempotency-key": spec.metadata["sandboxrouting.id"] ?? randomUUID() },
      body: { name: sbrName(spec), cpu, ram_mb, ...(spec.nativeTemplate ? { template: spec.nativeTemplate } : {}), ends_in_hours: endsInHours(spec.timeoutSec) },
      timeoutMs: 300_000,
    });
    const made = "start_error" in r ? r.computer : r;
    try {
      // Built but would not boot: the computer exists and is billed for its disk.
      if ("start_error" in r) throw new Error(`mandala computer ${made.id} would not start: ${r.start_error}`);
      let cur = made;
      for (let i = 0; i < 600 && cur.status !== "running"; i++) {
        if (FAILED.includes(cur.status)) throw new Error(`mandala computer ${made.id} is ${cur.status}`);
        await sleep(pollMs(ctx, 2000));
        cur = await httpJson<Computer>(pc(ctx, made.id), { headers: auth(ctx) });
      }
      if (cur.status !== "running") throw new Error(`mandala computer ${made.id} did not start`);
      if (Object.keys(spec.env).length) await this.writeFile(made.id, ENV_FILE, new TextEncoder().encode(envFileBody(spec.env)), ctx);
      return { providerSandboxId: made.id, cpu: cur.cpu ?? cpu, memoryMiB: cur.ram_mb ?? ram_mb };
    } catch (err) {
      await http(pc(ctx, made.id), { method: "DELETE", headers: auth(ctx) }).catch(() => undefined);
      throw err;
    }
  },

  async exec(id, command, o, ctx) {
    const h = await httpJson<{ pid: number }>(pc(ctx, id, "/exec"), {
      headers: auth(ctx),
      body: { command: withEnvFile(command), background: true, ...(o.cwd ? { cwd: o.cwd } : {}), ...(o.env && Object.keys(o.env).length ? { env: o.env } : {}) },
    });
    const deadline = o.timeoutSec ? Date.now() + o.timeoutSec * 1000 : Infinity;
    let stdout = "";
    let stderr = "";
    for (;;) {
      // Each read consumes what arrived since the previous one.
      const s = await httpJson<{ exited: boolean; exit_code?: number; stdout_b64?: string; stderr_b64?: string; more?: boolean; killed?: boolean }>(pc(ctx, id, `/exec/${h.pid}`), {
        headers: auth(ctx),
      });
      const out = b64(s.stdout_b64);
      const err = b64(s.stderr_b64);
      if (out) {
        stdout += out;
        o.onStdout?.(out);
      }
      if (err) {
        stderr += err;
        o.onStderr?.(err);
      }
      if (s.exited && !s.more) return { stdout, stderr, exitCode: s.exit_code ?? (s.killed ? 137 : -1) };
      if (Date.now() > deadline) {
        await http(pc(ctx, id, `/exec/${h.pid}`), { method: "DELETE", headers: auth(ctx) }).catch(() => undefined);
        return { stdout, stderr, exitCode: 124 };
      }
      if (!s.more) await sleep(pollMs(ctx, 500));
    }
  },

  async readFile(id, path, ctx) {
    return new Uint8Array(await (await http(`${pc(ctx, id, "/files")}?path=${encodeURIComponent(path)}`, { headers: auth(ctx) })).arrayBuffer());
  },

  async writeFile(id, path, data, ctx) {
    // At most 64 MiB per upload; an existing file is replaced.
    await http(`${pc(ctx, id, "/files")}?path=${encodeURIComponent(path)}`, {
      method: "PUT",
      headers: { ...auth(ctx), "content-type": "application/octet-stream" },
      raw: data,
    });
  },

  async listFiles(id, path, ctx) {
    // At most 512 entries are examined; a bigger directory comes back truncated.
    const r = await httpJson<{ entries: { name: string; type: string; size_bytes?: number }[] }>(`${pc(ctx, id, "/files/list")}?path=${encodeURIComponent(path)}`, {
      headers: auth(ctx),
    });
    const dir = path.endsWith("/") ? path : `${path}/`;
    return r.entries.map((e) => ({ name: e.name, path: `${dir}${e.name}`, isDir: e.type === "directory", size: e.size_bytes }));
  },

  async getUrl(id, port, ctx) {
    // Public on paid plans by default; a trial gets a private URL. Solo allows 2 per computer.
    return (await httpJson<{ url: string }>(pc(ctx, id, "/public-urls"), { headers: auth(ctx), body: { port } })).url;
  },

  async setTimeout(id, timeoutSec, ctx) {
    await http(pc(ctx, id), { method: "PATCH", headers: auth(ctx), body: { ends_in_hours: endsInHours(timeoutSec) } });
  },

  async pause(id, ctx) {
    await http(pc(ctx, id, "/suspend"), { method: "POST", headers: auth(ctx), timeoutMs: 120_000 });
  },

  async resume(id, ctx) {
    await http(pc(ctx, id, "/start"), { method: "POST", headers: auth(ctx), timeoutMs: 120_000 });
  },

  async kill(id, ctx) {
    await http(pc(ctx, id), { method: "DELETE", headers: auth(ctx), timeoutMs: 120_000 }).catch((err) => {
      if (!gone(err)) throw err;
    });
  },

  async listAlive(ctx) {
    // Every computer that exists or may exist (live, unreachable, deleting); a failed build still
    // holds its disk, so it is listed for the sweep to delete.
    const rows = await httpJson<Computer[]>(`${base(ctx)}/computers?allow_partial=1`, { headers: auth(ctx) });
    return rows.filter((c) => c.state !== "deleting").map((c) => c.id);
  },
});
