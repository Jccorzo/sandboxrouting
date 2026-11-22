// The shapes of the files scripts/generate.ts writes from the router's registry and adapters.
// Both the generator and the site import these, so the two can't disagree about a field.
// Nothing here is filled in by hand: every value comes from src/ or README.md at build time.

export type Category = "monthly" | "one-time" | "paid" | "self-hosted" | "off";

export const CATEGORY_LABEL: Record<Category, string> = {
  monthly: "Free every month",
  "one-time": "One-time credit",
  paid: "Paid only",
  "self-hosted": "Your own hardware",
  off: "Off by default",
};

export const CATEGORY_ORDER: readonly Category[] = ["monthly", "one-time", "paid", "self-hosted", "off"];

export type FreeTierKind = "none" | "one-time-credit" | "monthly-credit" | "monthly-hours" | "unlimited";

/** One cell of a README table row, as HTML rendered from the README's own markdown. */
export interface ReadmeCell {
  header: string;
  html: string;
  text: string;
}

export interface ProviderDoc {
  id: string;
  name: string;
  homepage: string;
  category: Category;
  /** The adapter's file under src/providers, for the "adapter source" link. */
  adapterFile: string;
  /** The adapter file's leading comment, the author's one-paragraph summary. */
  adapterSummary?: string;
  env: string[];
  sdkPackage?: string;
  capabilities: string[];
  isolation?: string;
  os: string;
  maxTimeoutSec?: number;
  maxExecSec?: number;
  selfHosted: boolean;
  offByDefault?: string;
  enforcesTimeout: boolean;
  surfaces?: { rest?: string; sdk?: string[]; cli?: string; mcp?: string };
  freeTier: {
    kind: FreeTierKind;
    usd?: number;
    hours?: number;
    concurrency?: number;
    maxLifetimeSec?: number;
    requiresCard?: boolean;
    notes?: string;
    source?: string;
    checked?: string;
  };
  pricing: {
    vcpuSecondUsd: number;
    gibSecondUsd: number;
    sandboxSecondUsd?: number;
    defaultCpu: number;
    defaultMemoryMiB: number;
    billing: "wall" | "active-cpu";
    activeCpuFloor?: number;
    source?: string;
  };
  /** The pricing page the terms were checked against (pricing.source, else freeTier.source). */
  pricingUrl?: string;
  /** The date the terms were last checked against that page. */
  checked?: string;
  /** At the reference size (REFERENCE_SIZE): the most an hour can cost, every vCPU busy. */
  maxUsdPerHour: number;
  /** At the reference size: the expected hourly price strategies rank by (active-CPU share applied). */
  expectedUsdPerHour: number;
  /** Free usage in hours at the reference size, when the tier is credit or hours. */
  freeHoursAtReference?: number;
  /** A short label for the free usage, e.g. "$30 every month". */
  freeLabel: string;
  /** The provider's row in the README's tables, where it has one. */
  readme?: { section: string; cells: ReadmeCell[]; footnotes: string[] };
  /** The provider's row in the README's "Keys and access surfaces" table. */
  access?: { keysHtml: string; connectsHtml: string };
}

export interface PlanRow {
  provider: string;
  lane: string;
  billing: string;
  /** Expected price per hour at the request's size. */
  usdPerHour: number;
  why: string[];
}

export interface SkipRow {
  provider: string;
  reason: string;
  /** Which of the hard filters (docs/routing.md) it failed, 1..12, or 0 when the strategy left it out. */
  filter: number;
}

export interface PlanDoc {
  strategy: string;
  ordered: PlanRow[];
  skipped: SkipRow[];
}

/** One cell of the hero's request grid: the controls it was planned with, and the plan. */
export interface PlanGridEntry {
  key: string;
  plan: PlanDoc;
}

export interface Attempt {
  provider: string;
  outcome: "created" | "skipped" | "failed";
  detail?: string;
  kind?: string;
  lane?: string;
  billing?: string;
  /** Seconds after the request when the reason may lapse. */
  untilSec?: number;
}

export interface FailoverStep {
  /** Seconds after the scenario started. */
  atSec: number;
  label: string;
  request: string;
  attempts: Attempt[];
  created?: string;
  error?: string;
  /** Marks and circuits in force after this request, per provider. */
  marks: { provider: string; kind: string; untilSec: number }[];
  circuits: { provider: string; circuit: string; consecutiveFailures: number; openUntilSec?: number }[];
}

export interface CircuitPoint {
  atSec: number;
  event: string;
  circuit: "closed" | "open" | "half-open";
  consecutiveFailures: number;
  openUntilSec?: number;
}

export interface QuotaPoint {
  refusal: number;
  atDay: number;
  untilDay: number;
}

export interface TransitionCell {
  from: string;
  event: string;
  /** The state the record moves to, or undefined when the router throws InvalidTransitionError. */
  to?: string;
  error?: string;
}

export interface JobFrame {
  event: string;
  state: string;
  detail?: string;
  box?: { provider: string; sandboxId: string };
  cursor: number;
  checkpoint?: number;
  inFlight?: number;
  migrations: number;
  placements: { provider: string; endReason?: string }[];
}

export interface StrategyDoc {
  name: string;
  description: string;
}

export interface ComparisonDoc {
  slug: string;
  a: string;
  b: string;
  /** The router's plan with only these two configured, per strategy. */
  plans: { strategy: string; allowPaid: boolean; ordered: PlanRow[]; skipped: SkipRow[] }[];
}

export interface SiteData {
  /** The clock the examples were planned at: the newest `checked` date, at noon UTC. */
  asOf: string;
  version: string;
  counts: Record<Category, number> & { total: number; cloud: number };
  newestChecked: string;
  oldestChecked: string;
  referenceSize: { cpu: number; memoryMiB: number };
  strategies: StrategyDoc[];
  defaults: {
    strategy: string;
    activeCpuShare: number;
    circuitBreaker: { failures: number; cooldownSec: number; maxCooldownSec: number };
    healthSamples: number;
    jobs: Record<string, unknown>;
    allowPaid: boolean;
    timeoutSec: number;
  };
  hero: {
    /** The example ledger the hero plans against, described for the page. */
    ledger: string[];
    defaultKey: string;
    controls: { strategies: string[]; needs: string[]; isolation: string[] };
    /** How many providers the default request ranks, with paid usage off and on. */
    ranked: { free: number; paid: number };
  };
  /** The MCP server's tools, read from the real server. */
  mcpTools: { name: string; description: string }[];
  failover: FailoverStep[];
  circuit: CircuitPoint[];
  quota: QuotaPoint[];
  sandbox: { states: string[]; events: string[]; cells: TransitionCell[]; derived: string };
  job: { states: string[]; frames: JobFrame[]; spec: { steps: string[]; setup: string[] } };
  comparisons: ComparisonDoc[];
}

/** The size every example and price on the site is quoted at. */
export const REFERENCE_SIZE = { cpu: 2, memoryMiB: 4096 } as const;

/** The lifetime every example request asks for. */
export const HERO_TIMEOUT_SEC = 600;

/** Key of a hero grid cell, so the page and the generator name cells the same way. */
export function planKey(c: { strategy: string; allowPaid: boolean; needs: readonly string[]; minIsolation: string }): string {
  return [c.strategy, c.allowPaid ? "paid" : "free", [...c.needs].sort().join("+") || "-", c.minIsolation || "-"].join("|");
}

/** The file a grid cell is served from, under /data/plans/: the key with URL-safe separators. */
export function planFile(key: string): string {
  return key.replace(/\|/g, "_").replace(/\+/g, ".");
}
