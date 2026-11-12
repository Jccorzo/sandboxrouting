// Small helpers adapters share: lazy SDK loading, HTTP with errors the router can classify,
// and shell wrapping for providers that take argv.

import { SandboxRouterError } from "../core/errors.js";
import type { ProviderAdapter } from "../core/types.js";

/** Defines a provider adapter. Exists for type inference and to keep adapters uniform. */
export function defineProvider<T extends ProviderAdapter>(adapter: T): T {
  return adapter;
}

/** Loads an optional SDK, with an install hint when it is missing. */
export async function loadSdk<T = any>(pkg: string, provider: string): Promise<T> {
  try {
    return (await import(pkg)) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND" || /Cannot find (module|package)/.test(String(err))) {
      throw new SandboxRouterError("auth", `${provider} needs its SDK: npm install ${pkg}`, provider, { cause: err });
    }
    throw err;
  }
}

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export interface HttpOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  /** Raw body instead of JSON. */
  raw?: RequestInit["body"];
  timeoutMs?: number;
}

export async function http(url: string, opts: HttpOptions = {}): Promise<Response> {
  const headers: Record<string, string> = { ...opts.headers };
  let body: RequestInit["body"] | undefined = opts.raw;
  if (opts.body !== undefined) {
    headers["content-type"] ??= "application/json";
    body = JSON.stringify(opts.body);
  }
  const res = await fetch(url, {
    method: opts.method ?? (body ? "POST" : "GET"),
    headers,
    body,
    signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new HttpError(res.status, `${opts.method ?? "GET"} ${new URL(url).pathname}: ${res.status} ${text.slice(0, 500)}`);
  }
  return res;
}

export async function httpJson<T>(url: string, opts: HttpOptions = {}): Promise<T> {
  const res = await http(url, opts);
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/** Wraps a command line for providers whose exec takes argv. */
export function shArgv(command: string, opts: { cwd?: string; env?: Record<string, string> } = {}): string[] {
  return ["sh", "-c", withCwdEnv(command, opts)];
}

export function withCwdEnv(command: string, opts: { cwd?: string; env?: Record<string, string> } = {}): string {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const env = Object.entries(opts.env ?? {})
    .map(([k, v]) => `export ${k}=${q(v)}; `)
    .join("");
  const cd = opts.cwd ? `cd ${q(opts.cwd)} && ` : "";
  return `${env}${cd}${command}`;
}

export const toBuffer = (data: Uint8Array) => Buffer.from(data.buffer, data.byteOffset, data.byteLength);
