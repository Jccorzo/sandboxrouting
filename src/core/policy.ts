// Ranks providers for a request. Pure: takes the ledger snapshot and returns an ordered
// plan plus the reason every other provider was left out, so `sbr route` can explain it.
//
// Lanes under the default `free-first` policy, in order:
//   1. monthly free usage that will be lost at the reset (use it or lose it), ranked by
//      how much is at risk per day left;
//   2. one-time free credit, ranked by the share still unspent (drains them evenly);
//   3. your own hardware (local Docker, openci), unless `selfHosted` moves it first or out;
//   4. paid, only when allowed and under budget, cheapest first.

import type { ProviderAdapter, ProviderContext, ResolvedSpec } from "./types.js";
import type { RouterConfig } from "./config.js";
import type { LedgerData } from "./ledger.js";
import { isLive } from "./state.js";
import {
  availability,
  effectivePricing,
  freeStatus,
  liveCount,
  paidSpendThisMonth,
  ratePerSecond,
  type FreeStatus,
} from "./metering.js";

export type Lane = "self-hosted-first" | "free-recurring" | "free-one-time" | "self-hosted" | "paid";
const LANE_ORDER: Lane[] = ["self-hosted-first", "free-recurring", "free-one-time", "self-hosted", "paid"];

export interface PlanEntry {
  provider: string;
  lane: Lane;
  free: FreeStatus;
  ratePerSecondUsd: number;
  score: number;
}

export interface Plan {
  ordered: PlanEntry[];
  skipped: { provider: string; reason: string }[];
}

export interface PolicyInput {
  adapters: ProviderAdapter[];
  config: RouterConfig;
  data: LedgerData;
  spec: ResolvedSpec;
  now: number;
  ctxFor(adapter: ProviderAdapter): ProviderContext;
  /** Remaining free credit the providers reported themselves, when they can. */
  reported?: Record<string, { remainingFreeUsd?: number }>;
}

export function isConfigured(adapter: ProviderAdapter, ctx: ProviderContext): boolean {
  if (adapter.isConfigured) return adapter.isConfigured(ctx);
  return adapter.info.env.every((name) => Boolean(ctx.env[name]));
}

export function plan(input: PolicyInput): Plan {
  const { adapters, config, data, spec, now } = input;
  const ordered: PlanEntry[] = [];
  const skipped: Plan["skipped"] = [];
  const skip = (provider: string, reason: string) => skipped.push({ provider, reason });

  const paidSoFar = adapters.reduce(
    (sum, a) => sum + paidSpendThisMonth(a.info, config.providers[a.info.id], data, now),
    0,
  );
  const paidBudgetLeft =
    config.maxPaidUsdPerMonth === undefined ? Number.POSITIVE_INFINITY : config.maxPaidUsdPerMonth - paidSoFar;

  for (const adapter of adapters) {
    const { info } = adapter;
    const cfg = config.providers[info.id];
    if (cfg?.enabled === false) {
      skip(info.id, "disabled in config");
      continue;
    }
    if (spec.providers && !spec.providers.includes(info.id)) {
      skip(info.id, "not in the request's provider list");
      continue;
    }
    if (spec.exclude?.includes(info.id)) {
      skip(info.id, "excluded by the request");
      continue;
    }
    if (info.selfHosted && config.selfHosted === "never" && !spec.providers?.includes(info.id)) {
      skip(info.id, "self-hosted providers are off (selfHosted: never)");
      continue;
    }
    const ctx = input.ctxFor(adapter);
    if (!isConfigured(adapter, ctx)) {
      skip(info.id, `not configured (set ${info.env.join(", ")})`);
      continue;
    }
    const missing = (spec.needs ?? []).filter((c) => !info.capabilities.includes(c));
    if (missing.length) {
      skip(info.id, `lacks ${missing.join(", ")}`);
      continue;
    }
    if (spec.image && !spec.template?.[info.id] && !info.capabilities.includes("customImage")) {
      skip(info.id, "cannot run an arbitrary image (give a template for it instead)");
      continue;
    }
    if (info.maxTimeoutSec !== undefined && spec.timeoutSec > info.maxTimeoutSec) {
      skip(info.id, `timeout ${spec.timeoutSec}s is over its maximum ${info.maxTimeoutSec}s`);
      continue;
    }
    const avail = availability(data, info.id, now);
    if (!avail.ok) {
      skip(info.id, `${avail.reason} (until ${new Date(avail.until).toISOString()})`);
      continue;
    }

    const free = freeStatus(info, cfg, data, now, input.reported?.[info.id]);
    const rate = ratePerSecond(effectivePricing(info, cfg), spec.cpu, spec.memoryMiB);
    const live = liveCount(data, info.id, now, isLive);
    const cap = cfg?.concurrency ?? info.freeTier.concurrency;
    const overLifetime = info.freeTier.maxLifetimeSec !== undefined && spec.timeoutSec > info.freeTier.maxLifetimeSec;
    const freeUsable =
      (free.state === "available" || free.state === "unlimited") && !overLifetime && (cap === undefined || live < cap);

    let lane: Lane | undefined;
    let score = 0;
    if (config.policy === "cheapest") {
      if (free.state === "unlimited") lane = "self-hosted";
      else if (freeUsable) lane = "free-one-time";
      else if (allowPaid(config, cfg) && paidBudgetLeft > 0) lane = "paid";
      score = -rate;
    } else if (free.state === "unlimited" && freeUsable) {
      lane = config.selfHosted === "first" ? "self-hosted-first" : "self-hosted";
    } else if (freeUsable && free.state === "available") {
      if (free.resetsAt !== undefined) {
        lane = "free-recurring";
        const daysLeft = Math.max((free.resetsAt - now) / 86_400_000, 1 / 24);
        score = free.fraction / daysLeft; // most free usage at risk per day goes first
      } else {
        lane = "free-one-time";
        score = free.fraction;
      }
    } else if (allowPaid(config, cfg) && paidBudgetLeft > 0) {
      lane = "paid";
      score = -rate;
    }

    if (!lane) {
      const why =
        free.state === "exhausted"
          ? `free tier used up (${free.reason})`
          : free.state === "none"
            ? "no free tier"
            : overLifetime
              ? `timeout over the free tier's ${info.freeTier.maxLifetimeSec}s limit`
              : cap !== undefined && live >= cap
                ? `free tier allows ${cap} at once and ${live} are live`
                : "not free";
      const paidNote = allowPaid(config, cfg)
        ? paidBudgetLeft <= 0
          ? "; paid budget for this month is spent"
          : ""
        : "; paid usage is off (allowPaid)";
      skip(info.id, why + paidNote);
      continue;
    }
    ordered.push({ provider: info.id, lane, free, ratePerSecondUsd: rate, score });
  }

  const preference = spec.providers ?? [];
  ordered.sort((a, b) => {
    const lane = LANE_ORDER.indexOf(a.lane) - LANE_ORDER.indexOf(b.lane);
    if (lane) return lane;
    const pa = config.providers[a.provider]?.priority ?? 100;
    const pb = config.providers[b.provider]?.priority ?? 100;
    if (pa !== pb) return pa - pb;
    if (preference.length) {
      const d = preference.indexOf(a.provider) - preference.indexOf(b.provider);
      if (d) return d;
    }
    if (b.score !== a.score) return b.score - a.score;
    if (a.ratePerSecondUsd !== b.ratePerSecondUsd) return a.ratePerSecondUsd - b.ratePerSecondUsd;
    return a.provider.localeCompare(b.provider);
  });
  return { ordered, skipped };
}

function allowPaid(config: RouterConfig, cfg: { allowPaid?: boolean } | undefined): boolean {
  return cfg?.allowPaid ?? config.allowPaid;
}
