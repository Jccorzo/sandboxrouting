// Shared bits for REST-only adapters: polling delays, provider-safe names, shell quoting.

import { createHash } from "node:crypto";
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
