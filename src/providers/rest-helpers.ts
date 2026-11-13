// Shared bits for REST-only adapters: polling delays, provider-safe names, shell quoting,
// event streams and file-root checks.

import { createHash } from "node:crypto";
import { SandboxRouterError } from "../core/errors.js";
import type { ProviderContext, ResolvedSpec } from "../core/types.js";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Delay between polls of an async operation; `options.pollMs` lets tests run fast. */
export const pollMs = (ctx: ProviderContext, fallback: number) => Number(ctx.options["pollMs"] ?? fallback);

/** A lowercase name derived from the router id: letters, digits and hyphens only. */
export function sbrName(spec: ResolvedSpec, length = 16): string {
  const seed = spec.metadata["sandboxrouting.id"] ?? `${Date.now()}-${Math.random()}`;
  return `sbr-${createHash("sha256").update(seed).digest("hex").slice(0, length)}`;
}

export const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Prefix a command with `cd` and `export` for providers whose exec lacks cwd/env fields. */
export function inline(command: string, opts: { cwd?: string; env?: Record<string, string> }): string {
  const env = Object.entries(opts.env ?? {})
    .map(([k, v]) => `export ${k}=${shq(v)}; `)
    .join("");
  return `${env}${opts.cwd ? `cd ${shq(opts.cwd)} && ` : ""}${command}`;
}

/** Parses a `text/event-stream` body. An event without an `event:` line is named "message". */
export async function* sse(body: AsyncIterable<Uint8Array>): AsyncGenerator<{ event: string; data: string }> {
  const decoder = new TextDecoder();
  let buffer = "";
  const parse = (block: string) => {
    let event = "message";
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    return data.length || event !== "message" ? { event, data: data.join("\n") } : undefined;
  };
  for await (const chunk of body) {
    buffer = (buffer + decoder.decode(chunk, { stream: true })).replace(/\r\n/g, "\n");
    let end: number;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const ev = parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 2);
      if (ev) yield ev;
    }
  }
  const last = parse(buffer + decoder.decode());
  if (last) yield last;
}

/**
 * For file APIs that only reach some directories: a path outside them throws `unsupported`,
 * which makes the router use its exec fallback instead.
 */
export function insideRoots(provider: string, path: string, roots: string[]): void {
  if (roots.some((r) => path === r || path.startsWith(`${r}/`))) return;
  throw new SandboxRouterError("unsupported", `${provider} file API only reaches ${roots.join(", ")}`, provider);
}

/** Where create-time env is kept for providers whose create call takes none. */
export const ENV_FILE = "/tmp/.sbr-env";
/** The body of that file: one `export` per variable. */
export const envFileBody = (env: Record<string, string>) => Object.entries(env).map(([k, v]) => `export ${k}=${shq(v)}\n`).join("");
/** Loads that file, when there is one, before the command. */
export const withEnvFile = (command: string) => `[ -f ${ENV_FILE} ] && . ${ENV_FILE}; ${command}`;

/**
 * Per-sandbox access (a data-plane URL and token) that is minted or looked up once and kept
 * until shortly before it expires. Expiry is checked on every read; `drop` forgets a sandbox.
 */
export function grantCache<T>() {
  const held = new Map<string, { value: T; until: number }>();
  return {
    async get(key: string, mint: () => Promise<{ value: T; expiresAt: number }>): Promise<T> {
      const hit = held.get(key);
      if (hit && hit.until > Date.now()) return hit.value;
      const made = await mint();
      held.set(key, { value: made.value, until: made.expiresAt - 60_000 });
      return made.value;
    },
    drop: (key: string) => void held.delete(key),
  };
}
