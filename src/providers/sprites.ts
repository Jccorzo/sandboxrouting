// Fly Sprites: persistent Firecracker VMs that are not billed for compute while warm or cold.
// No free tier (Fly's $1 trial). The official SDK (@fly/sprites) needs Node 24, so this
// adapter speaks the same REST API directly: https://api.sprites.dev/v1, Bearer token.
// Sprites have no TTL, so the router deletes them at the deadline (enforcesTimeout: false).

import { createHash } from "node:crypto";
import { defineProvider, http, httpJson } from "./util.js";
import type { ProviderContext } from "../core/types.js";

const base = (ctx: ProviderContext) => String(ctx.env["SPRITES_BASE_URL"] ?? "https://api.sprites.dev").replace(/\/+$/, "");
const auth = (ctx: ProviderContext) => ({ authorization: `Bearer ${ctx.env["SPRITES_TOKEN"]}` });
const sprite = (ctx: ProviderContext, name: string, path = "") => `${base(ctx)}/v1/sprites/${encodeURIComponent(name)}${path}`;

// HTTP exec frames: first byte is the stream, exit frame is [3, code].
const STDOUT = 1;
const STDERR = 2;
const EXIT = 3;

/** Decodes the framed body of POST /exec. Frames carry no length, so chunk boundaries matter. */
export async function decodeExecFrames(chunks: AsyncIterable<Uint8Array>): Promise<{ stdout: Buffer; stderr: Buffer; exitCode: number }> {
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  let stream = STDOUT;
  let held: Uint8Array = new Uint8Array(0);
  let exitCode = -1;
  const write = (data: Uint8Array) => {
    if (data.length) (stream === STDOUT ? out : err).push(Buffer.from(data));
  };
  for await (const value of chunks) {
    if (!value.length) continue;
    write(held);
    held = new Uint8Array(0);
    const type = value[0]!;
    if (type === EXIT && value.length === 2) {
      exitCode = value[1]!;
      continue;
    }
    if (type !== STDOUT && type !== STDERR) throw new Error(`sprites exec: unexpected frame type ${type}`);
    stream = type;
    // The exit frame may arrive glued to the end of the last read: hold back two bytes.
    const split = Math.max(1, value.length - 2);
    write(value.subarray(1, split));
    held = value.subarray(split);
  }
  if (held.length === 2 && held[0] === EXIT) exitCode = held[1]!;
  else write(held);
  if (exitCode < 0) throw new Error("sprites exec: no exit frame");
  return { stdout: Buffer.concat(out), stderr: Buffer.concat(err), exitCode };
}

export const spritesProvider = defineProvider({
  info: {
    id: "sprites",
    name: "Fly Sprites",
    homepage: "https://fly.io/sprites",
    env: ["SPRITES_TOKEN"],
    capabilities: ["ports", "fileList"],
    enforcesTimeout: false,
    freeTier: {
      tier: { kind: "none" },
      notes: "Fly's $1 trial only. Idle (warm/cold) Sprites are not billed for compute.",
      source: "https://fly.io/docs/about/pricing/",
      checked: "2026-11-11",
    },
    pricing: { vcpuSecondUsd: 0.0385 / 3600, gibSecondUsd: 0.021875 / 3600, defaultCpu: 1, defaultMemoryMiB: 1024, source: "https://fly.io/docs/about/pricing/" },
    surfaces: { rest: "https://api.sprites.dev/v1", sdk: ["@fly/sprites (npm, Node 24+)", "sprites-py"], cli: "sprite" },
  },

  async create(spec, ctx) {
    const name = `sbr-${createHash("sha256").update(spec.metadata["sandboxrouting.id"] ?? String(Date.now())).digest("hex").slice(0, 16)}`;
    await http(`${base(ctx)}/v1/sprites`, {
      headers: auth(ctx),
      body: { name, environment: spec.env, labels: spec.metadata, wait_for_capacity: true },
      timeoutMs: 120_000,
    });
    return { providerSandboxId: name };
  },

  async exec(id, command, o, ctx) {
    const url = new URL(sprite(ctx, id, "/exec"));
    for (const v of ["sh", "-c", command]) url.searchParams.append("cmd", v);
    url.searchParams.set("path", "sh");
    if (o.cwd) url.searchParams.set("dir", o.cwd);
    for (const [k, v] of Object.entries(o.env ?? {})) url.searchParams.append("env", `${k}=${v}`);
    const res = await http(url.toString(), {
      method: "POST",
      headers: { ...auth(ctx), "content-type": "application/octet-stream" },
      timeoutMs: ((o.timeoutSec ?? 3600) + 30) * 1000,
    });
    const r = await decodeExecFrames(res.body as unknown as AsyncIterable<Uint8Array>);
    const stdout = r.stdout.toString("utf8");
    const stderr = r.stderr.toString("utf8");
    if (stdout) o.onStdout?.(stdout);
    if (stderr) o.onStderr?.(stderr);
    return { stdout, stderr, exitCode: r.exitCode };
  },

  async readFile(id, path, ctx) {
    const url = new URL(sprite(ctx, id, "/fs/read"));
    url.searchParams.set("path", path);
    return new Uint8Array(await (await http(url.toString(), { headers: auth(ctx) })).arrayBuffer());
  },

  async writeFile(id, path, data, ctx) {
    const url = new URL(sprite(ctx, id, "/fs/write"));
    url.searchParams.set("path", path);
    url.searchParams.set("mkdirParents", "true");
    await http(url.toString(), { method: "PUT", headers: { ...auth(ctx), "content-type": "application/octet-stream" }, raw: data });
  },

  async listFiles(id, path, ctx) {
    const url = new URL(sprite(ctx, id, "/fs/list"));
    url.searchParams.set("path", path);
    const { entries } = await httpJson<{ entries: { name: string; isDir?: boolean; size?: number }[] }>(url.toString(), { headers: auth(ctx) });
    const dir = path.endsWith("/") ? path : `${path}/`;
    return entries.map((e) => ({ name: e.name, path: `${dir}${e.name}`, isDir: Boolean(e.isDir), size: e.size }));
  },

  async getUrl(id, _port, ctx) {
    // A Sprite has one public URL (its HTTP service); make it public and return it.
    await http(sprite(ctx, id), { method: "PUT", headers: auth(ctx), body: { url_settings: { auth: "public" } } });
    const info = await httpJson<{ url?: string }>(sprite(ctx, id), { headers: auth(ctx) });
    return info.url ?? `https://${id}.sprites.dev`;
  },

  async kill(id, ctx) {
    await http(sprite(ctx, id), { method: "DELETE", headers: auth(ctx) });
  },

  async listAlive(ctx) {
    const names: string[] = [];
    let token: string | undefined;
    do {
      const url = new URL(`${base(ctx)}/v1/sprites`);
      if (token) url.searchParams.set("continuation_token", token);
      const page = await httpJson<{ sprites?: { name: string }[]; next_continuation_token?: string }>(url.toString(), { headers: auth(ctx) });
      names.push(...(page.sprites ?? []).map((s) => s.name).filter((n) => n.startsWith("sbr-")));
      token = page.next_continuation_token;
    } while (token);
    return names;
  },
});
