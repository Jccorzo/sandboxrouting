// SuperHQ Nanite (nanite.run): persistent microVMs on the open-source shuru runtime, in
// Sydney. No free tier: prepaid credits. A sandbox has no size, image or TTL parameter; it
// stops by itself after 30 idle seconds, wakes on the next request, and bills only CPU and
// memory actually used. It is never deleted for you, so the router deletes it at the
// deadline (enforcesTimeout: false).
// REST: https://api.nanite.run/v1 (Bearer sk_…). No SDK, CLI or OpenAPI for the hosted API.
// The wire format matches Fly Sprites': sandboxes are addressed by name, and HTTP exec
// streams the same one-byte-tagged frames.

import { defineProvider, http, httpJson } from "./util.js";
import { sbrName } from "./rest-helpers.js";
import { decodeExecFrames } from "./sprites.js";
import type { ProviderContext } from "../core/types.js";

const base = (ctx: ProviderContext) => String(ctx.env["NANITE_API_URL"] ?? "https://api.nanite.run").replace(/\/+$/, "");
const auth = (ctx: ProviderContext) => ({ authorization: `Bearer ${ctx.env["NANITE_API_KEY"]}` });
const box = (ctx: ProviderContext, name: string, path = "") => `${base(ctx)}/v1/sandboxes/${encodeURIComponent(name)}${path}`;

export const naniteProvider = defineProvider({
  info: {
    id: "nanite",
    name: "SuperHQ Nanite",
    homepage: "https://nanite.run",
    env: ["NANITE_API_KEY"],
    capabilities: ["ports", "pause", "fileList", "snapshot"],
    isolation: "microvm",
    enforcesTimeout: false,
    freeTier: {
      tier: { kind: "none" },
      notes: "Prepaid credits only (1 credit = $1). 100 sandboxes kept, 25 running, 30 creates a minute.",
      source: "https://nanite.run/docs/billing.md",
      checked: "2026-11-12",
    },
    // Billed on CPU time and memory in use, so this is the ceiling for a busy 4 vCPU / 8 GiB box.
    pricing: { vcpuSecondUsd: 0.072 / 3600, gibSecondUsd: 0.0432 / 3600, defaultCpu: 4, defaultMemoryMiB: 8192, source: "https://nanite.run/docs/billing.md" },
    surfaces: { rest: "https://api.nanite.run/v1" },
  },

  async create(spec, ctx) {
    // Names are unique per workspace; deriving it from the router id makes a retry hit 409.
    const name = sbrName(spec);
    await http(`${base(ctx)}/v1/sandboxes`, { headers: auth(ctx), body: { name, env: spec.env }, timeoutMs: 120_000 });
    return { providerSandboxId: name, cpu: 4, memoryMiB: 8192 };
  },

  async exec(id, command, o, ctx) {
    const url = new URL(box(ctx, id, "/exec"));
    for (const v of ["sh", "-c", command]) url.searchParams.append("cmd", v);
    if (o.cwd) url.searchParams.set("dir", o.cwd);
    for (const [k, v] of Object.entries(o.env ?? {})) url.searchParams.append("env", `${k}=${v}`);
    const res = await http(url.toString(), { method: "POST", headers: auth(ctx), timeoutMs: ((o.timeoutSec ?? 3600) + 30) * 1000 });
    const r = await decodeExecFrames(res.body as unknown as AsyncIterable<Uint8Array>);
    const stdout = r.stdout.toString("utf8");
    const stderr = r.stderr.toString("utf8");
    if (stdout) o.onStdout?.(stdout);
    if (stderr) o.onStderr?.(stderr);
    return { stdout, stderr, exitCode: r.exitCode };
  },

  async readFile(id, path, ctx) {
    const res = await http(`${box(ctx, id, "/fs/read")}?path=${encodeURIComponent(path)}`, { headers: auth(ctx) });
    return new Uint8Array(await res.arrayBuffer());
  },

  async writeFile(id, path, data, ctx) {
    // 16 MiB per request.
    await http(`${box(ctx, id, "/fs/write")}?path=${encodeURIComponent(path)}&mkdir=true`, {
      method: "PUT",
      headers: { ...auth(ctx), "content-type": "application/octet-stream" },
      raw: data,
    });
  },

  async listFiles(id, path, ctx) {
    const r = await httpJson<{ entries?: { name: string; path?: string; type?: string; isDir?: boolean; size?: number }[] }>(
      `${box(ctx, id, "/fs/list")}?path=${encodeURIComponent(path)}`,
      { headers: auth(ctx) },
    );
    const dir = path.endsWith("/") ? path : `${path}/`;
    return (r.entries ?? []).map((e) => ({ name: e.name, path: e.path ?? `${dir}${e.name}`, isDir: e.isDir ?? e.type === "directory", size: e.size }));
  },

  async getUrl(id, port, ctx) {
    // The one preview URL serves port 8080; other ports need the WebSocket proxy.
    if (port !== 8080) throw new Error("nanite's preview URL only serves port 8080");
    const r = await httpJson<{ url?: string | null }>(box(ctx, id), { method: "PUT", headers: auth(ctx), body: { url_settings: { auth: "public" } } });
    const url = r?.url ?? (await httpJson<{ url?: string | null }>(box(ctx, id), { headers: auth(ctx) })).url;
    if (!url) throw new Error(`nanite sandbox ${id} has no preview URL`);
    return url;
  },

  async pause(id, ctx) {
    await http(box(ctx, id, "/stop"), { method: "POST", headers: auth(ctx) });
  },

  async resume(id, ctx) {
    // There is no start call: any request wakes a stopped sandbox.
    await this.exec(id, "true", { timeoutSec: 60 }, ctx);
  },

  async kill(id, ctx) {
    await http(box(ctx, id), { method: "DELETE", headers: auth(ctx) });
  },

  async listAlive(ctx) {
    const names: string[] = [];
    let token: string | undefined;
    do {
      const url = new URL(`${base(ctx)}/v1/sandboxes`);
      url.searchParams.set("prefix", "sbr-");
      url.searchParams.set("max_results", "500");
      if (token) url.searchParams.set("continuation_token", token);
      const page = await httpJson<{ sandboxes?: { name: string }[]; has_more?: boolean; next_continuation_token?: string }>(url.toString(), { headers: auth(ctx) });
      names.push(...(page.sandboxes ?? []).map((s) => s.name));
      token = page.has_more ? page.next_continuation_token : undefined;
    } while (token);
    return names;
  },
});
