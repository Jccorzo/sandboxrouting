// Small helpers adapters share: lazy SDK loading, HTTP with errors the router can classify,
// and shell wrapping for providers that take argv.

import { readFileSync } from "node:fs";
import { SandboxRouterError, type ErrorKind } from "../core/errors.js";
import type { ProviderAdapter } from "../core/types.js";

/** Defines a provider adapter. Exists for type inference and to keep adapters uniform. */
export function defineProvider<T extends ProviderAdapter>(adapter: T): T {
  return adapter;
}

/**
 * How a provider SDK reaches the user's machine, read from sandboxrouting's own package.json, the
 * one place that says: `bundled` (a dependency, installed with sandboxrouting) or `optional` (an
 * optional peer dependency the user installs next to it). Undefined for a package that isn't ours
 * to install (Cloudflare's runs in the bridge Worker). Install hints and the site both ask this.
 */
export function sdkInstall(pkg: string): "bundled" | "optional" | undefined {
  // src/providers/util.ts and dist/providers/util.js both sit two levels below package.json.
  manifest ??= JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as Manifest;
  if (manifest.dependencies?.[pkg]) return "bundled";
  if (manifest.peerDependencies?.[pkg]) return "optional";
  return undefined;
}
interface Manifest {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}
let manifest: Manifest | undefined;

/** Loads a provider SDK, with an install hint when it is missing. */
// Optional SDKs are peer dependencies that may not be installed, so their types can't be imported here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function loadSdk<T = any>(pkg: string, provider: string): Promise<T> {
  try {
    return (await import(pkg)) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND" || /Cannot find (module|package)/.test(String(err))) {
      // A bundled SDK is missing only from a broken install.
      const hint = sdkInstall(pkg) === "bundled" ? "it ships with sandboxrouting, so reinstall sandboxrouting" : `npm install ${pkg}`;
      throw new SandboxRouterError("auth", `${provider} needs its SDK: ${hint}`, provider, { cause: err });
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

/**
 * A refusal whose HTTP status would make `classify` read it wrong. Some providers answer a spent
 * balance with 409, their own spending cap with 429 (which reads as a rate limit), or a plan
 * limit with 403 (which reads as a bad key). An adapter declares these once with `refusals` and
 * rethrows errors through the function it returns, so the router's marks see what the refusal
 * really is: `quota` (credit or a plan limit used up, waits for the period to reset),
 * `rate_limit` (too many at once, clears when sandboxes end) or `invalid` (this request alone is
 * past a limit, such as a size: the router tries the next provider and marks nothing).
 */
export interface Refusal {
  status: number;
  /** Matched against the error's message, which carries the response body. Omitted: any body. */
  body?: RegExp;
  kind: Extract<ErrorKind, "quota" | "rate_limit" | "invalid">;
  /** What the refusal means, put before the provider's own message. */
  why?: string;
}

/**
 * Turns an `HttpError` that matches one of `rules` into the SandboxRouterError it means, and
 * returns anything else unchanged. Use it as `catch (err) { throw refused(err); }`.
 */
export function refusals(provider: string, rules: readonly Refusal[]): (err: unknown) => unknown {
  return (err) => {
    if (!(err instanceof HttpError)) return err;
    const rule = rules.find((r) => r.status === err.status && (!r.body || r.body.test(err.message)));
    if (!rule) return err;
    return new SandboxRouterError(rule.kind, rule.why ? `${provider}: ${rule.why}: ${err.message}` : err.message, provider, { cause: err });
  };
}

export interface HttpOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  /** Raw body instead of JSON. */
  raw?: RequestInit["body"];
  timeoutMs?: number;
}

/**
 * Node's fetch is undici, whose dispatcher stops waiting for response headers, and between body
 * chunks, after 300 s whatever the request's own signal says. An adapter whose exec answers in
 * one response would then fail every command longer than five minutes. undici takes both
 * timeouts per request too, so this dispatcher hands each request to the global one (the one
 * fetch would use, which keeps any proxy agent the app installed) with both set just past the
 * request's own timeout: the AbortSignal below is what ends a request. The global dispatcher is
 * found under undici's registry symbol (versioned: 1 up to undici 7, 2 from undici 8, Node 26),
 * the cross-copy contract undici itself relies on, so no undici dependency is needed.
 */
const BUILTIN_UNDICI_MAJOR = Number(process.versions["undici"]?.split(".")[0] ?? 0);
const GLOBAL_DISPATCHER = [Symbol.for("undici.globalDispatcher.2"), Symbol.for("undici.globalDispatcher.1")];
if (BUILTIN_UNDICI_MAJOR < 8) GLOBAL_DISPATCHER.reverse();

interface Dispatcher {
  dispatch(opts: Record<string, unknown>, handler: unknown): boolean;
}

/** A fetch `dispatcher` whose headers and body timeouts are `limitMs`. */
export function dispatcherFor(limitMs: number): Dispatcher {
  return {
    dispatch(opts, handler) {
      // Looked up per request: Node's fetch installs its global dispatcher when first called.
      const g = globalThis as unknown as Record<symbol, Dispatcher | undefined>;
      const global = g[GLOBAL_DISPATCHER[0]!] ?? g[GLOBAL_DISPATCHER[1]!];
      if (!global) throw new Error("fetch has no global dispatcher");
      return global.dispatch({ ...opts, headersTimeout: limitMs, bodyTimeout: limitMs }, handler);
    },
  };
}

export async function http(url: string, opts: HttpOptions = {}): Promise<Response> {
  const headers: Record<string, string> = { ...opts.headers };
  let body: RequestInit["body"] | undefined = opts.raw;
  if (opts.body !== undefined) {
    headers["content-type"] ??= "application/json";
    body = JSON.stringify(opts.body);
  }
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const res = await fetch(url, {
    method: opts.method ?? (body ? "POST" : "GET"),
    headers,
    body,
    signal: AbortSignal.timeout(timeoutMs),
    // fetch only ever calls a dispatcher's dispatch(); the type wants undici's whole class.
    dispatcher: dispatcherFor(timeoutMs + 1000) as unknown as RequestInit["dispatcher"],
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
