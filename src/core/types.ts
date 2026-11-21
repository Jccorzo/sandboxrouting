// The common contract every provider adapter implements, and the shapes the router,
// SDK, REST API, CLI and MCP server all share. One definition; nothing else redefines these.

/** What the caller asks for. Everything is optional; adapters map it to their own API. */
export interface SandboxSpec {
  /**
   * An OCI image reference such as `python:3.12-slim`. Only providers with the
   * `customImage` capability are eligible when this is set.
   */
  image?: string;
  /** Provider-native template/snapshot/blueprint per provider id, e.g. `{ e2b: "my-tpl" }`. */
  template?: Record<string, string>;
  /** Requested vCPUs. Providers that cannot size round to their nearest size. */
  cpu?: number;
  /** Requested memory in MiB. */
  memoryMiB?: number;
  /** Lifetime in seconds before the provider stops it. Default 300. */
  timeoutSec?: number;
  env?: Record<string, string>;
  /** Free-form labels. The router adds `sandboxrouting.id`. */
  metadata?: Record<string, string>;
  /** Capabilities the sandbox must have; providers lacking one are skipped. */
  needs?: Capability[];
  /** Restrict routing to these provider ids (in this order of preference). */
  providers?: string[];
  /** Never route to these provider ids. */
  exclude?: string[];
  /** Region hint, passed through when the provider supports it. */
  region?: string;
  /** Routing strategy for this request (default: config `routing.strategy`). See docs/routing.md. */
  strategy?: string;
  /** Soft: rank these providers last within their lane (e.g. ones that just failed this job). */
  avoid?: string[];
  /** Soft: rank these first within their lane (e.g. the provider whose template is warm). */
  prefer?: string[];
  /** Weakest isolation acceptable. Providers with weaker or unknown isolation are skipped. */
  minIsolation?: Isolation;
  /**
   * Longest single command you will run, in seconds. Providers that cut commands off sooner
   * (`info.maxExecSec`, e.g. exe.dev's 30 s) are skipped.
   */
  execTimeoutSec?: number;
  /**
   * Operating system the sandbox must run. Default `linux`: only providers whose `info.os`
   * matches are eligible, so a request that doesn't ask for macOS never lands on a Mac.
   */
  os?: SandboxOS;
}

/** Operating systems a provider can run. Providers are `linux` unless their info says otherwise. */
export type SandboxOS = "linux" | "macos";
export const SANDBOX_OS: readonly SandboxOS[] = ["linux", "macos"];

/**
 * How sandboxes are isolated from each other and from the host, weakest first:
 * a container shares the host kernel; gVisor intercepts syscalls in a user-space kernel;
 * a microVM (Firecracker, Cloud Hypervisor) or VM has its own kernel on a hypervisor.
 */
export type Isolation = "container" | "gvisor" | "microvm" | "vm";

/** Strength order for `minIsolation`: microVMs and VMs count as equally strong. */
export const ISOLATION_STRENGTH: Record<Isolation, number> = { container: 0, gvisor: 1, microvm: 2, vm: 2 };

export type Capability =
  | "ports" // public URL for a port inside the sandbox
  | "pause" // pause/resume keeping memory or disk
  | "customImage" // arbitrary OCI image
  | "gpu"
  | "snapshot"
  | "fileList" // native directory listing (exec fallback exists otherwise)
  | "extendTimeout"; // change the deadline of a live sandbox

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutSec?: number;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface FileInfo {
  name: string;
  path: string;
  isDir: boolean;
  size?: number;
}

/** How a provider gives away usage for free. Terms change: config can override these. */
export type FreeTier =
  | { kind: "none" }
  /** Credit granted once per account; spent until gone. */
  | { kind: "one-time-credit"; usd: number }
  /** Credit that resets every calendar month (UTC). Unused credit is lost: burn it first. */
  | { kind: "monthly-credit"; usd: number }
  /** Compute hours that reset every calendar month (UTC), measured in sandbox-hours. */
  | { kind: "monthly-hours"; hours: number }
  /** Runs on hardware you already have (local Docker, self-hosted openci). */
  | { kind: "unlimited" };

export interface FreeTierTerms {
  tier: FreeTier;
  /** Live sandboxes allowed at once on the free plan. */
  concurrency?: number;
  /** Longest lifetime a free sandbox may have, in seconds. */
  maxLifetimeSec?: number;
  requiresCard?: boolean;
  notes?: string;
  /** Official page the terms come from, and when they were last checked. */
  source?: string;
  checked?: string;
}

/** Price after free usage, used to rank paid fallbacks and to meter free credit. */
export interface Pricing {
  vcpuSecondUsd: number;
  gibSecondUsd: number;
  /** Flat per-sandbox-second price when the provider bills per size instead. */
  sandboxSecondUsd?: number;
  /** Size used when the spec leaves cpu/memory unset. */
  defaultCpu: number;
  defaultMemoryMiB: number;
  /**
   * How the vCPU price is billed. `wall` (the default): every second the sandbox runs.
   * `active-cpu`: only the CPU time the sandbox actually uses (Vercel, Cloudflare, Render, ...),
   * while memory is still billed for every second it runs. Strategies rank an `active-cpu`
   * provider by its expected cost at `activeCpuShare`; free-tier reservations, the paid budget
   * and the ledger's metering still count wall clock, since the router can't see CPU time.
   * Ignored with `sandboxSecondUsd`. See docs/routing.md "Active-CPU billing".
   */
  billing?: "wall" | "active-cpu";
  /**
   * Expected share of the vCPUs' time a sandbox keeps busy, 0..1, for `active-cpu` billing.
   * Default `routing.activeCpuShare`, else DEFAULT_ACTIVE_CPU_SHARE (0.3).
   */
  activeCpuShare?: number;
  /** Share of the vCPUs an `active-cpu` provider bills however idle the box is (Tensorlake: 0.2). */
  activeCpuFloor?: number;
  source?: string;
}

export interface ProviderInfo {
  id: string;
  name: string;
  homepage: string;
  /** Environment variables that must be set for the provider to be usable. */
  env: string[];
  /** npm package the adapter loads lazily, if any. */
  sdkPackage?: string;
  capabilities: Capability[];
  maxTimeoutSec?: number;
  freeTier: FreeTierTerms;
  pricing: Pricing;
  /** Other ways the provider is exposed, for docs and `sbr providers --explain`. */
  surfaces?: { rest?: string; sdk?: string[]; cli?: string; mcp?: string };
  /** True for providers that run on your own hardware (local Docker, openci). */
  selfHosted?: boolean;
  /**
   * False when the provider keeps a sandbox alive past the requested timeout (no TTL, or a
   * service that restarts). The router then deletes it at the deadline and the sweep reaps
   * any it missed. Default true.
   */
  enforcesTimeout?: boolean;
  /** How its sandboxes are isolated. Unknown (undefined) fails any `minIsolation` request. */
  isolation?: Isolation;
  /** Longest a single exec call may run before the provider cuts it off, in seconds. */
  maxExecSec?: number;
  /** The operating system its sandboxes run. Default `linux`. */
  os?: SandboxOS;
}

/** Usage the provider itself reports, when it has an API for it. */
export interface ProviderUsage {
  /** Remaining free credit in USD, if known. */
  remainingFreeUsd?: number;
  /** Spent this period in USD, if known. */
  spentUsd?: number;
}

export interface CreatedSandbox {
  /** The provider's own id for the sandbox. */
  providerSandboxId: string;
  /** What the provider actually gave, if it differs from the request. */
  cpu?: number;
  memoryMiB?: number;
}

export interface ProviderContext {
  env: Record<string, string | undefined>;
  /** Provider-specific options from config (`providers.<id>.options`). */
  options: Record<string, unknown>;
}

/**
 * A provider adapter. Only `create`, `exec` and `kill` are required: the router supplies
 * exec-based fallbacks for files, listing and URLs, so a new provider can start small.
 */
export interface ProviderAdapter {
  info: ProviderInfo;
  /** Whether credentials are present. Default: every `info.env` variable is set. */
  isConfigured?(ctx: ProviderContext): boolean;

  create(spec: ResolvedSpec, ctx: ProviderContext): Promise<CreatedSandbox>;
  exec(id: string, command: string, opts: ExecOptions, ctx: ProviderContext): Promise<ExecResult>;
  kill(id: string, ctx: ProviderContext): Promise<void>;

  readFile?(id: string, path: string, ctx: ProviderContext): Promise<Uint8Array>;
  writeFile?(id: string, path: string, data: Uint8Array, ctx: ProviderContext): Promise<void>;
  listFiles?(id: string, path: string, ctx: ProviderContext): Promise<FileInfo[]>;
  getUrl?(id: string, port: number, ctx: ProviderContext): Promise<string>;
  setTimeout?(id: string, timeoutSec: number, ctx: ProviderContext): Promise<void>;
  pause?(id: string, ctx: ProviderContext): Promise<void>;
  resume?(id: string, ctx: ProviderContext): Promise<void>;
  /** Provider ids of sandboxes that are alive now. Used by the sweep to reconcile. */
  listAlive?(ctx: ProviderContext): Promise<string[]>;
  usage?(ctx: ProviderContext): Promise<ProviderUsage>;
}

/** A spec after defaults are applied, as handed to an adapter. */
export interface ResolvedSpec extends SandboxSpec {
  cpu: number;
  memoryMiB: number;
  timeoutSec: number;
  env: Record<string, string>;
  metadata: Record<string, string>;
  /** The provider-native template for this adapter, if the caller gave one. */
  nativeTemplate?: string;
}
