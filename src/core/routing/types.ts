// The routing contract. Hard filters (keys, capabilities, allowPaid, budgets, marks, the
// circuit breaker) live in candidates.ts and are the same for every strategy; a strategy only
// orders the candidates that survive them. See docs/routing.md.

import type { ProviderAdapter, ProviderContext, ProviderInfo, ResolvedSpec } from "../types.js";
import type { ProviderConfig, RouterConfig } from "../config.js";
import type { LedgerData } from "../ledger.js";
import type { FreeStatus } from "../metering.js";

export type Lane = "self-hosted-first" | "free-recurring" | "free-one-time" | "self-hosted" | "paid";
export const LANE_ORDER: readonly Lane[] = ["self-hosted-first", "free-recurring", "free-one-time", "self-hosted", "paid"];

/** How a sandbox on this provider would be paid for. */
export type Billing = "free" | "self-hosted" | "paid";

/** Derived on read from the ledger's health samples (src/core/health.ts). Never stored. */
export interface ProviderHealth {
  /** Samples considered (after the age cutoff). */
  samples: number;
  /** Time-decayed share of recent infrastructure outcomes that succeeded, 0..1; 0.9 with no data. */
  successRate: number;
  /** Median latency of recent successful creates, in ms. Undefined without data. */
  createP50Ms?: number;
  /** Failures since the last success (newest first). */
  consecutiveFailures: number;
  /** When the newest failure happened (ms epoch), if any. */
  lastFailureAt?: number;
  circuit: "closed" | "open" | "half-open";
  /** For an open circuit: when it turns half-open (ms epoch). */
  openUntil?: number;
}

/** Everything known about one provider that passed the hard filters. Strategies rank these. */
export interface Candidate {
  provider: string;
  info: ProviderInfo;
  config?: ProviderConfig;
  free: FreeStatus;
  /**
   * Free usage can take this request now: what is left of the tier after what live free
   * sandboxes will still spend covers the whole request (or the tier is unlimited), the timeout
   * is within the free lifetime cap, and the free concurrency cap has room.
   */
  freeUsable: boolean;
  /**
   * Paid usage is allowed for this provider and, with `maxPaidUsdPerMonth`, what is left of the
   * month's budget after what live paid sandboxes will still spend covers the request's cost.
   */
  paidAllowed: boolean;
  /** Why free usage can't take it, when it can't. */
  freeBlocked?: string;
  /** Why the month's paid budget can't take it, when paid usage is on but the budget is short. */
  budgetBlocked?: string;
  /**
   * Expected price per second at the requested size, which strategies rank by: for a provider
   * that bills only active CPU, the vCPU part at `activeCpuShare`; otherwise `maxRatePerSecondUsd`.
   */
  ratePerSecondUsd: number;
  /** The most a second can cost at the requested size (every vCPU busy). Reservations hold this. */
  maxRatePerSecondUsd: number;
  /** The CPU share `ratePerSecondUsd` assumes, for a provider that bills only active CPU. */
  activeCpuShare?: number;
  /**
   * Free headroom, 0..1. A free candidate always covers this whole request; this says how many
   * more like it the free usage left could take, out of 10 (1 for unlimited, 0 when not free).
   */
  freeCoverage: number;
  /** Live sandboxes (creating or running) on this provider. */
  live: number;
  /** Free-tier concurrency cap, when there is one. */
  cap?: number;
  /** Sandboxes created on this provider in the last hour (for spreading load). */
  recentCreates: number;
  /** `providers.<id>.priority`, default 100. Lower goes first. */
  priority: number;
  /** Position in the request's `providers` list, or -1 when it gave none. */
  preferenceIndex: number;
  /** In the request's `prefer` list. */
  preferred: boolean;
  /** In the request's `avoid` list. */
  avoided: boolean;
  health: ProviderHealth;
}

export interface PlanEntry {
  provider: string;
  lane: Lane;
  billing: Billing;
  free: FreeStatus;
  /** Expected price per second (see Candidate.ratePerSecondUsd). */
  ratePerSecondUsd: number;
  /** The most a second can cost (every vCPU busy). */
  maxRatePerSecondUsd: number;
  /** The strategy's within-lane score (higher first). Only comparable inside one plan. */
  score: number;
  /** Why it sits where it does, for `sbr route`, e.g. ["free-recurring", "82% left, resets in 6.0 d"]. */
  why?: string[];
}

/**
 * A provider left out of a plan. `until` is when its reason may stop applying (ms epoch): a
 * mark's expiry, the circuit's reopening, the monthly reset, the soonest deadline among the
 * sandboxes filling its free slots, now for a half-open free tier whose probe is in flight.
 * Absent, waiting won't change it (a missing key, capability or isolation, a lifetime cap, paid
 * usage off).
 */
export interface Skip {
  provider: string;
  reason: string;
  until?: number;
}

export interface Plan {
  /** Name of the strategy that ordered it. */
  strategy: string;
  ordered: PlanEntry[];
  skipped: Skip[];
}

export interface RoutingContext {
  /** The request, sized: cpu and memory are never 0 here. */
  spec: ResolvedSpec;
  config: RouterConfig;
  now: number;
  /** Read-only snapshot of the ledger. */
  data: LedgerData;
}

export interface StrategyResult {
  ordered: PlanEntry[];
  /** Candidates the strategy chose not to use, with its reason. */
  skipped?: Skip[];
}

export interface RoutingStrategy {
  name: string;
  description: string;
  /**
   * Orders candidates. Pure: no I/O, no clock other than `ctx.now`. Return entries only for
   * candidates you were given; anything left out goes to `skipped` with your reason (or a
   * generic one). The router then re-checks billing: a `paid` entry needs `paidAllowed`, a
   * `free` one needs `freeUsable`, so no strategy can route around `allowPaid`.
   */
  rank(candidates: readonly Candidate[], ctx: RoutingContext): StrategyResult;
}

/** What `plan()` and `eligibility()` need. The router builds it. */
export interface PolicyInput {
  adapters: ProviderAdapter[];
  config: RouterConfig;
  data: LedgerData;
  /** Sized spec (cpu/memory filled with a common size, so prices compare). */
  spec: ResolvedSpec;
  /**
   * The request's own size, 0 where it left it to the provider. Reservations price the box the
   * provider will actually create (its default size where unset); ranking uses `spec`.
   */
  requested?: { cpu: number; memoryMiB: number };
  now: number;
  ctxFor(adapter: ProviderAdapter): ProviderContext;
  /** Remaining free credit the providers reported themselves, when they can. */
  reported?: Record<string, { remainingFreeUsd?: number }>;
}
