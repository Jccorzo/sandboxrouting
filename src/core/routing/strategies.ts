// The built-in routing strategies. Each one only orders the candidates that passed the hard
// filters (candidates.ts); plan() re-checks every entry's billing afterwards. Pure: the same
// candidates and context give the same order.
//
// Every built-in breaks ties the same way: lane (or the strategy's own tiers), then avoided
// last, then config priority, then preferred first, then the request's `providers` order, then
// the strategy's score, then price, then name. In the paid lane only `fastest` puts anything
// before price: the others spend a budget on as many sandboxes as it buys.

import type { RouterConfig } from "../config.js";
import { billingOf } from "./candidates.js";
import { LANE_ORDER, type Billing, type Candidate, type Lane, type PlanEntry, type RoutingStrategy, type StrategyResult } from "./types.js";

const DAY = 86_400_000;
/** Create latency assumed when no candidate has any history yet. */
const DEFAULT_CREATE_MS = 10_000;

interface Row {
  c: Candidate;
  lane: Lane;
  /** First sort key: the lane's position, or the strategy's own tiers. */
  tier: number;
  /** Within-lane sort keys, higher first. The first is the entry's score. */
  keys: number[];
  why: string[];
}

export const freeFirst: RoutingStrategy = {
  name: "free-first",
  description:
    "Free usage first: monthly tiers by most at risk per day left, then one-time credit by share left, then your hardware, then paid, cheapest first.",
  rank(candidates, ctx) {
    return toResult(
      candidates.map((c) => {
        const lane = freeFirstLane(c, ctx.config);
        return row(c, lane, [freeFirstScore(c, lane, ctx.now)], [lane, usageText(c, lane, ctx.now)]);
      }),
    );
  },
};

export const cheapest: RoutingStrategy = {
  name: "cheapest",
  description: "By price: any free usage first, then your hardware, then paid, cheapest first.",
  rank(candidates) {
    return toResult(
      candidates.map((c) => {
        const billing = billed(c);
        // Every free tier shares one lane so price alone orders them (the old `policy: "cheapest"` lanes).
        const lane: Lane = billing === "self-hosted" ? "self-hosted" : billing === "free" ? "free-one-time" : "paid";
        return row(c, lane, [-c.ratePerSecondUsd], [lane, perHour(c.ratePerSecondUsd)]);
      }),
    );
  },
};

export const balanced: RoutingStrategy = {
  name: "balanced",
  description:
    "The free-first lanes; within a lane, a weighted score of free value, health, speed, free coverage and load (routing.weights).",
  rank(candidates, ctx) {
    const w = ctx.config.routing.weights;
    const lanes = candidates.map((c) => freeFirstLane(c, ctx.config));
    const values = freeValues(candidates, lanes, ctx.now);
    const untried = untriedCreateMs(candidates);
    return toResult(
      candidates.map((c, i) => {
        const lane = lanes[i]!;
        const s = {
          free: values[i]!,
          health: c.health.successRate,
          speed: 1 / (1 + expectedReadyMs(c, untried) / 10_000),
          coverage: c.freeCoverage,
          load: Math.max(0, 1 - loadShare(c)),
        };
        const score = w.freeValue * s.free + w.health * s.health + w.speed * s.speed + w.coverage * s.coverage + w.load * s.load;
        const parts = Object.entries(s).map(([k, v]) => `${k} ${v.toFixed(2)}`);
        const why = [lane, `score ${score.toFixed(2)} (${parts.join(", ")})`];
        // Paid: the cheapest first, then the score among equal prices.
        return lane === "paid" ? row(c, lane, [-c.ratePerSecondUsd, score], [lane, perHour(c.ratePerSecondUsd), why[1]!]) : row(c, lane, [score], why);
      }),
    );
  },
};

export const fastest: RoutingStrategy = {
  name: "fastest",
  description:
    "Unbilled first (free tiers and your hardware), then paid; within each, the shortest expected time to a ready box (median create latency ÷ success rate).",
  rank(candidates, ctx) {
    const untried = untriedCreateMs(candidates);
    return toResult(
      candidates.map((c) => {
        const lane = freeFirstLane(c, ctx.config);
        const ready = expectedReadyMs(c, untried);
        const basis =
          c.health.samples === 0
            ? "not tried yet, so assumed as fast as the fastest"
            : `${c.health.createP50Ms === undefined ? "no successful create yet" : `p50 ${Math.round(c.health.createP50Ms)} ms`}, ${pct(c.health.successRate)} ok`;
        return {
          ...row(c, lane, [-ready], [lane, `~${(ready / 1000).toFixed(1)} s to ready (${basis})`]),
          tier: lane === "paid" ? 1 : 0,
        };
      }),
    );
  },
};

export const spread: RoutingStrategy = {
  name: "spread",
  description:
    "The free-first lanes; within a lane, the most free headroom first (lowest live/cap, fewest recent creates), so fan-out doesn't hit one provider's rate limit.",
  rank(candidates, ctx) {
    const lanes = candidates.map((c) => freeFirstLane(c, ctx.config));
    const values = freeValues(candidates, lanes, ctx.now);
    return toResult(
      candidates.map((c, i) => {
        const lane = lanes[i]!;
        const live = c.cap === undefined ? `${c.live} live` : `${c.live}/${c.cap} live`;
        const keys = [-loadShare(c), -c.recentCreates, values[i]!];
        if (lane === "paid") return row(c, lane, [-c.ratePerSecondUsd, ...keys], [lane, perHour(c.ratePerSecondUsd), live]);
        return row(c, lane, keys, [lane, `${live}, ${c.recentCreates} created in the last hour`]);
      }),
    );
  },
};

export function builtinStrategies(): RoutingStrategy[] {
  return [freeFirst, cheapest, balanced, fastest, spread];
}

/** How the candidate would be billed: free usage when it can take the request, else paid (which plan() re-checks). */
const billed = (c: Candidate): Billing => billingOf(c) ?? "paid";

/** The free-first lane, from how the candidate would be billed. */
function freeFirstLane(c: Candidate, config: RouterConfig): Lane {
  const billing = billed(c);
  if (billing === "self-hosted") return config.selfHosted === "first" ? "self-hosted-first" : "self-hosted";
  if (billing === "free") return c.free.state === "available" && c.free.resetsAt !== undefined ? "free-recurring" : "free-one-time";
  return "paid";
}

/** Free-first's within-lane score: monthly usage at risk per day left, one-time share left, paid price. */
function freeFirstScore(c: Candidate, lane: Lane, now: number): number {
  if (lane === "paid") return -c.ratePerSecondUsd;
  if (c.free.state !== "available") return 0; // your hardware: nothing to lose
  if (c.free.resetsAt === undefined) return c.free.fraction;
  const daysLeft = Math.max((c.free.resetsAt - now) / DAY, 1 / 24);
  return c.free.fraction / daysLeft; // most free usage at risk per day goes first
}

/**
 * Use-it-or-lose-it value, 0..1: a monthly tier's share at risk per day left, scaled so the most
 * at risk in this plan is 1; a one-time credit's share left; 0 for your hardware and paid.
 */
function freeValues(candidates: readonly Candidate[], lanes: Lane[], now: number): number[] {
  const raw = candidates.map((c, i) => {
    const lane = lanes[i]!;
    return lane === "free-recurring" || lane === "free-one-time" ? freeFirstScore(c, lane, now) : 0;
  });
  const maxAtRisk = Math.max(0, ...raw.filter((_, i) => lanes[i] === "free-recurring")) || 1;
  return raw.map((v, i) => (lanes[i] === "free-recurring" ? v / maxAtRisk : v));
}

/**
 * Expected time to a usable box: a create that fails has to be retried elsewhere. A provider
 * never tried gets `untriedMs`, which beats every provider with history; one that has only
 * failed gets the slow default, divided by its poor success rate.
 */
function expectedReadyMs(c: Candidate, untriedMs: number): number {
  if (c.health.samples === 0) return untriedMs;
  return (c.health.createP50Ms ?? DEFAULT_CREATE_MS) / c.health.successRate;
}

/**
 * What to assume for a provider never tried: the fastest median create seen on any candidate,
 * undiscounted by failures, so it ranks ahead of all of them. Assumed slow, it would never be
 * tried and never get a latency of its own; one try replaces the guess with its real median.
 */
function untriedCreateMs(candidates: readonly Candidate[]): number {
  const known = candidates.flatMap((c) => (c.health.createP50Ms === undefined ? [] : [c.health.createP50Ms]));
  return known.length ? Math.min(...known) : DEFAULT_CREATE_MS;
}

/** Share of the free concurrency cap in use; 0 without a cap. */
function loadShare(c: Candidate): number {
  return c.cap === undefined ? 0 : c.live / c.cap;
}

function row(c: Candidate, lane: Lane, keys: number[], why: string[]): Row {
  return { c, lane, tier: LANE_ORDER.indexOf(lane), keys, why };
}

function toResult(rows: Row[]): StrategyResult {
  rows.sort(compareRows);
  return {
    ordered: rows.map(({ c, lane, keys, why }): PlanEntry => ({
      provider: c.provider,
      lane,
      billing: lane === "paid" ? "paid" : billed(c),
      free: c.free,
      ratePerSecondUsd: c.ratePerSecondUsd,
      score: keys[0] ?? 0,
      why: [...why, ...(c.avoided ? ["avoided"] : []), ...(c.preferred ? ["preferred"] : [])],
    })),
  };
}

function compareRows(a: Row, b: Row): number {
  return (
    a.tier - b.tier ||
    Number(a.c.avoided) - Number(b.c.avoided) ||
    a.c.priority - b.c.priority ||
    Number(b.c.preferred) - Number(a.c.preferred) ||
    requestOrder(a.c) - requestOrder(b.c) ||
    compareKeys(a.keys, b.keys) ||
    a.c.ratePerSecondUsd - b.c.ratePerSecondUsd ||
    a.c.provider.localeCompare(b.c.provider)
  );
}

/** Position in the request's `providers` list; without one (-1) it orders nothing. */
function requestOrder(c: Candidate): number {
  return c.preferenceIndex < 0 ? Number.MAX_SAFE_INTEGER : c.preferenceIndex;
}

function compareKeys(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return y - x;
  }
  return 0;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const perHour = (rate: number) => `$${(rate * 3600).toFixed(4)}/h`;

function usageText(c: Candidate, lane: Lane, now: number): string {
  if (lane === "paid") return perHour(c.ratePerSecondUsd);
  if (c.free.state !== "available") return "your hardware";
  const left = `${pct(c.free.fraction)} left`;
  return c.free.resetsAt === undefined ? left : `${left}, resets in ${((c.free.resetsAt - now) / DAY).toFixed(1)} d`;
}
