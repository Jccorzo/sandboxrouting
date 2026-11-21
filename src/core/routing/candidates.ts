// The hard filters every strategy shares (docs/routing.md §1) and the facts strategies rank
// by. A provider that fails a filter is skipped with the reason `sbr route` shows; one that
// passes becomes a Candidate, built here and nowhere else. Pure: the ledger snapshot in.

import { ISOLATION_STRENGTH, type ProviderAdapter, type ProviderContext, type ProviderInfo } from "../types.js";
import type { ProviderConfig } from "../config.js";
import { isLive, type SandboxRecord } from "../state.js";
import {
  committed,
  committedSeconds,
  effectiveFreeTier,
  activeCpuShare,
  effectivePricing,
  expectedRatePerSecond,
  freeStatus,
  liveCount,
  monthWindow,
  paidSpendThisMonth,
  ratePerSecond,
  recordBilling,
  type FreeStatus,
  type Spend,
} from "../metering.js";
import { availability, quotaProbeInFlight, quotaState } from "../marks.js";
import { providerHealth } from "../health.js";
import type { Billing, Candidate, PolicyInput, Skip } from "./types.js";

const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();
/** Float sums of dollars and seconds are off by a hair; an exact fit still fits. */
const fits = (left: number, need: number) => left >= need - 1e-9;
/** Dollars in a reason: cents from $1 up, two significant digits below ($0.40, $0.036, $0.0028). */
const usd = (x: number) => `$${x === 0 || x >= 1 ? x.toFixed(2) : x.toPrecision(2)}`;
const hours = (secs: number) => `${(secs / 3600).toFixed(2)} h`;

type Assessed = { candidate: Candidate; billing: Billing } | { reason: string; until?: number };
/** Why free or paid usage can't take a request, and when that may change (absent: waiting won't help). */
type Problem = { reason: string; until?: number };

/** This month's paid budget across every provider: what was spent, and what live paid sandboxes will still spend. */
interface Budget {
  usd: number;
  spent: number;
  committed: number;
}

/** Whether routing may use a provider: config's `enabled` if set, else on unless `offByDefault`. */
export function isEnabled(info: ProviderInfo, cfg: ProviderConfig | undefined): boolean {
  return cfg?.enabled ?? info.offByDefault === undefined;
}

export function isConfigured(adapter: ProviderAdapter, ctx: ProviderContext): boolean {
  if (adapter.isConfigured) return adapter.isConfigured(ctx);
  return adapter.info.env.every((name) => Boolean(ctx.env[name]));
}

/** Every provider either becomes a candidate or is skipped with the first filter it fails. */
export function buildCandidates(input: PolicyInput): { candidates: Candidate[]; skipped: Skip[] } {
  const budget = paidBudget(input);
  const candidates: Candidate[] = [];
  const skipped: Skip[] = [];
  for (const adapter of input.adapters) {
    const out = assess(input, adapter, budget);
    if ("reason" in out) skipped.push(skip(adapter.info.id, out.reason, out.until));
    else candidates.push(out.candidate);
  }
  return { candidates, skipped };
}

/**
 * The hard filters and billing for one provider, whatever the strategy. The router re-checks a
 * reservation with it under the ledger lock; `input.adapters` should still be all of them, since
 * the paid budget is shared.
 */
export function eligibility(
  input: PolicyInput,
  provider: string,
): { ok: true; candidate: Candidate; billing: Billing } | { ok: false; reason: string; until?: number } {
  const adapter = input.adapters.find((a) => a.info.id === provider);
  if (!adapter) return { ok: false, reason: `unknown provider "${provider}"` };
  const out = assess(input, adapter, paidBudget(input));
  if (!("reason" in out)) return { ok: true, ...out };
  return out.until === undefined ? { ok: false, reason: out.reason } : { ok: false, reason: out.reason, until: out.until };
}

function skip(provider: string, reason: string, until: number | undefined): Skip {
  return until === undefined ? { provider, reason } : { provider, reason, until };
}

/** How a candidate is billed by default: free usage when it can take the request, else paid. */
export function billingOf(c: Candidate): Billing | undefined {
  if (c.freeUsable) return c.free.state === "unlimited" ? "self-hosted" : "free";
  return c.paidAllowed ? "paid" : undefined;
}

/**
 * Why `c` can't be billed this way now, or undefined when it can: paid needs `paidAllowed`,
 * free and self-hosted need `freeUsable`. One check for plan()'s safety pass and for the
 * re-check under the lock, so a request planned as free never silently becomes paid.
 */
export function billingProblem(c: Candidate, billing: Billing): string | undefined {
  if (billing === "paid") return c.paidAllowed ? undefined : (c.budgetBlocked ?? "paid usage is off or this month's paid budget is spent");
  if (billing === "free" || billing === "self-hosted") return c.freeUsable ? undefined : `no free capacity (${c.freeBlocked})`;
  return `"${String(billing)}" is not a billing`; // a strategy in plain JS can return anything
}

function assess(input: PolicyInput, adapter: ProviderAdapter, budget: Budget | undefined): Assessed {
  const { config, data, spec, now } = input;
  const { info } = adapter;
  const id = info.id;
  const cfg = config.providers[id];

  if (cfg?.enabled === false) return { reason: "disabled in config" };
  if (!isEnabled(info, cfg)) return { reason: `off by default: ${info.offByDefault} (set "enabled": true to use it)` };
  if (spec.providers && !spec.providers.includes(id)) return { reason: "not in the request's provider list" };
  if (spec.exclude?.includes(id)) return { reason: "excluded by the request" };
  if (info.selfHosted && config.selfHosted === "never" && !spec.providers?.includes(id)) {
    return { reason: "self-hosted providers are off (selfHosted: never)" };
  }
  if (!isConfigured(adapter, input.ctxFor(adapter))) return { reason: `not configured (set ${info.env.join(", ")})` };
  const missing = (spec.needs ?? []).filter((c) => !info.capabilities.includes(c));
  if (missing.length) return { reason: `lacks ${missing.join(", ")}` };
  const os = info.os ?? "linux";
  if ((spec.os ?? "linux") !== os) return { reason: `runs ${os}, not ${spec.os ?? "linux"}` };
  if (spec.image && !spec.template?.[id] && !info.capabilities.includes("customImage")) {
    return { reason: "cannot run an arbitrary image (give a template for it instead)" };
  }
  if (info.maxTimeoutSec !== undefined && spec.timeoutSec > info.maxTimeoutSec) {
    return { reason: `timeout ${spec.timeoutSec}s is over its maximum ${info.maxTimeoutSec}s` };
  }
  if (spec.execTimeoutSec !== undefined && info.maxExecSec !== undefined && spec.execTimeoutSec > info.maxExecSec) {
    return { reason: `exec timeout ${spec.execTimeoutSec}s is over its per-command maximum ${info.maxExecSec}s` };
  }
  if (spec.minIsolation) {
    const isolation = cfg?.isolation ?? info.isolation;
    if (!isolation) {
      return { reason: `isolation unknown (set providers.${id}.isolation if it is ${spec.minIsolation} or stronger)` };
    }
    if (ISOLATION_STRENGTH[isolation] < ISOLATION_STRENGTH[spec.minIsolation]) {
      return { reason: `isolation ${isolation} is weaker than ${spec.minIsolation}` };
    }
  }
  const avail = availability(data, id, now);
  if (!avail.ok) return { reason: `${avail.reason} (until ${iso(avail.until)})`, until: avail.until };
  const health = providerHealth(data, id, now, config.routing.circuitBreaker);
  if (health.circuit === "open") {
    return { reason: `circuit open after ${health.consecutiveFailures} failures (until ${iso(health.openUntil!)})`, until: health.openUntil! };
  }
  // Half-open lets one create through; a create started after the newest failure is that probe.
  if (
    health.circuit === "half-open" &&
    Object.values(data.sandboxes).some((r) => r.provider === id && r.state === "creating" && Date.parse(r.createdAt) > health.lastFailureAt!)
  ) {
    return { reason: "circuit half-open; a probe is in flight", until: now };
  }

  const free = freeStatus(info, cfg, data, now, input.reported?.[id]);
  const pricing = effectivePricing(info, cfg);
  // Strategies rank by the expected rate (an active-CPU provider at its expected CPU share);
  // reservations below hold the most the box can cost, every vCPU busy (docs/routing.md).
  const ratePerSecondUsd = expectedRatePerSecond(pricing, spec.cpu, spec.memoryMiB, config.routing.activeCpuShare);
  const maxRatePerSecondUsd = ratePerSecond(pricing, spec.cpu, spec.memoryMiB);
  // What the box will really cost: the provider's own default size where the request left it unset.
  const asked = input.requested;
  const costRate = asked
    ? ratePerSecond(pricing, asked.cpu || pricing.defaultCpu, asked.memoryMiB || pricing.defaultMemoryMiB)
    : maxRatePerSecondUsd;
  const live = liveCount(data, id, now, isLive);
  const cap = cfg?.concurrency ?? info.freeTier.concurrency;
  const quota = quotaState(data, id, now);
  const freeNo = freeProblem(free, committed(info, cfg, data, now).free, {
    rate: costRate,
    timeoutSec: spec.timeoutSec,
    lifetimeCap: info.freeTier.maxLifetimeSec,
    cap,
    live,
    probing: quota.state === "half-open" && quotaProbeInFlight(data, id, quota.since),
    now,
  });
  const allowPaid = cfg?.allowPaid ?? config.allowPaid;
  const budgetNo = allowPaid && budget ? budgetProblem(budget, costRate * spec.timeoutSec, now) : undefined;

  const candidate: Candidate = {
    provider: id,
    info,
    config: cfg,
    free,
    freeUsable: freeNo === undefined,
    paidAllowed: allowPaid && budgetNo === undefined,
    freeBlocked: freeNo?.reason,
    budgetBlocked: budgetNo?.reason,
    ratePerSecondUsd,
    maxRatePerSecondUsd,
    activeCpuShare:
      pricing.billing === "active-cpu" && pricing.sandboxSecondUsd === undefined ? activeCpuShare(pricing, config.routing.activeCpuShare) : undefined,
    freeCoverage: freeNo === undefined ? headroom(free, committed(info, cfg, data, now).free, costRate, spec.timeoutSec) : 0,
    live,
    cap,
    recentCreates: Object.values(data.sandboxes).filter((r) => r.provider === id && now - Date.parse(r.createdAt) < HOUR).length,
    priority: cfg?.priority ?? 100,
    preferenceIndex: spec.providers?.indexOf(id) ?? -1,
    preferred: spec.prefer?.includes(id) ?? false,
    avoided: spec.avoid?.includes(id) ?? false,
    health,
  };
  const billing = billingOf(candidate);
  if (!billing) {
    // Neither side can take it now; whichever reason lapses first may change that.
    const paidNo: Problem = budgetNo ?? { reason: "paid usage is off (allowPaid)" };
    const freeUntil = freeNo?.until;
    const until = freeUntil === undefined ? paidNo.until : paidNo.until === undefined ? freeUntil : Math.min(freeUntil, paidNo.until);
    return { reason: `${candidate.freeBlocked}; ${paidNo.reason}`, until };
  }
  return { candidate, billing };
}

/**
 * Why free usage can't take the request, and when that may change; undefined when it can. A
 * free tier takes a request only when what is left of it, after what live free sandboxes will
 * still spend (`committed`), covers the request's whole timeout at the requested size: USD for
 * credit tiers, sandbox-seconds for hour tiers. Otherwise a box that started on its last cent
 * would run on past it, and its overrun would be billed.
 */
function freeProblem(
  free: FreeStatus,
  held: Spend,
  o: { rate: number; timeoutSec: number; lifetimeCap?: number; cap?: number; live: number; probing: boolean; now: number },
): Problem | undefined {
  // A refusal is checked again when its mark lapses; usage the ledger metered comes back at the reset.
  if (free.state === "exhausted") return { reason: `free tier used up (${free.reason})`, until: free.refusedUntil ?? free.resetsAt };
  if (free.state === "none") return { reason: "no free tier" };
  if (o.lifetimeCap !== undefined && o.timeoutSec > o.lifetimeCap) return { reason: `timeout over the free tier's ${o.lifetimeCap}s limit` };
  if (free.state === "available") {
    const byHours = free.unit === "hours";
    const holding = byHours ? held.sandboxSeconds : held.usd;
    const left = (byHours ? free.remaining * 3600 : free.remaining) - holding;
    const need = byHours ? o.timeoutSec : o.rate * o.timeoutSec;
    if (!fits(left, need)) {
      const show = byHours ? hours : usd;
      const after = holding > 0 ? ` after ${show(holding)} committed` : "";
      return {
        reason: `free ${byHours ? "hours" : "credit"} left (${show(Math.max(0, left))}${after}) won't cover this request (${show(need)})`,
        // A live box holding part of it may end at any moment; otherwise only the reset brings more.
        until: holding > 0 ? o.now : free.resetsAt,
      };
    }
  }
  // Half-open after a refusal: one free create at a time checks whether the tier is back.
  if (o.probing) return { reason: "free tier half-open after a refusal; a probe is in flight", until: o.now };
  // Full: a slot frees as soon as a box is killed (at the latest at the soonest deadline).
  if (o.cap !== undefined && o.live >= o.cap) return { reason: `free tier allows ${o.cap} at once and ${o.live} are live`, until: o.now };
  return undefined;
}

/** Requests like this one that free usage still covers before it would run out; 1.0 is this many or more. */
const HEADROOM_REQUESTS = 10;

/**
 * Free headroom, 0..1: how many more requests like this one the free usage left (after what live
 * boxes will still spend) could take, out of HEADROOM_REQUESTS. Every free candidate covers this
 * one request; headroom tells the one about to run out from the one with plenty left.
 */
function headroom(free: FreeStatus, held: Spend, rate: number, timeoutSec: number): number {
  if (free.state === "unlimited") return 1;
  if (free.state !== "available") return 0;
  const byHours = free.unit === "hours";
  const left = (byHours ? free.remaining * 3600 : free.remaining) - (byHours ? held.sandboxSeconds : held.usd);
  const need = byHours ? timeoutSec : rate * timeoutSec;
  if (need <= 0) return 1;
  return Math.max(0, Math.min(1, left / need / HEADROOM_REQUESTS));
}

/**
 * Why this month's paid budget can't take a request costing `cost` (its whole timeout at the
 * requested size), and when that may change; undefined when it can. What is left after what live
 * paid sandboxes on every provider will still spend has to cover all of it.
 */
function budgetProblem(budget: Budget, cost: number, now: number): Problem | undefined {
  const left = budget.usd - budget.spent - budget.committed;
  if (left > 0 && fits(left, cost)) return undefined;
  const nextMonth = monthWindow(now).to;
  if (budget.usd - budget.spent <= 0) return { reason: "paid budget for this month is spent", until: nextMonth };
  const after = budget.committed > 0 ? ` after ${usd(budget.committed)} committed` : "";
  return {
    reason: `paid budget left this month (${usd(Math.max(0, left))}${after}) won't cover this request (${usd(cost)})`,
    // A live paid box holding part of it may end at any moment; otherwise next month.
    until: budget.committed > 0 ? now : nextMonth,
  };
}

/** `maxPaidUsdPerMonth` against every provider's paid spend this month and live paid sandboxes; undefined without a budget. */
function paidBudget({ adapters, config, data, now }: Money): Budget | undefined {
  if (config.maxPaidUsdPerMonth === undefined) return undefined;
  let spent = 0;
  let held = 0;
  for (const { info } of adapters) {
    const cfg = config.providers[info.id];
    spent += paidSpendThisMonth(info, cfg, data, now);
    held += committed(info, cfg, data, now).paid.usd;
  }
  return { usd: config.maxPaidUsdPerMonth, spent, committed: held };
}

/** What the money checks need: every adapter (the paid budget is shared), config, the ledger and the clock. */
type Money = Pick<PolicyInput, "adapters" | "config" | "data" | "now">;

/**
 * Why `rec` can't hold `seconds` from now (a later deadline, or a resume), or undefined when it
 * can. The rule a new request meets: what the box may then spend must fit, as it is billed, in its
 * free tier after every other live box's hold, or in the month's paid budget. What the box holds
 * now is replaced by the new hold, so it isn't counted twice.
 */
export function holdProblem(input: Money, rec: SandboxRecord, seconds: number): string | undefined {
  const adapter = input.adapters.find((a) => a.info.id === rec.provider);
  if (!adapter) return undefined;
  const { info } = adapter;
  const cfg = input.config.providers[info.id];
  const rate = ratePerSecond(effectivePricing(info, cfg), rec.cpu, rec.memoryMiB);
  const mine = committedSeconds(rec, input.now);
  const billing = recordBilling(rec, effectiveFreeTier(info, cfg));
  if (billing === "free") {
    const free = freeStatus(info, cfg, input.data, input.now);
    if (free.state === "exhausted") return `free tier used up (${free.reason})`;
    if (free.state !== "available") return undefined;
    const held = committed(info, cfg, input.data, input.now).free;
    const byHours = free.unit === "hours";
    const left = byHours ? free.remaining * 3600 - (held.sandboxSeconds - mine) : free.remaining - (held.usd - mine * rate);
    const need = byHours ? seconds : seconds * rate;
    if (fits(left, need)) return undefined;
    const show = byHours ? hours : usd;
    return `free ${byHours ? "hours" : "credit"} left (${show(Math.max(0, left))}) won't cover ${show(need)} on this box`;
  }
  if (billing === "paid") {
    const budget = paidBudget(input);
    if (!budget) return undefined;
    const left = budget.usd - budget.spent - (budget.committed - mine * rate);
    const need = seconds * rate;
    if (left > 0 && fits(left, need)) return undefined;
    return `paid budget left this month (${usd(Math.max(0, left))}) won't cover ${usd(need)} on this box`;
  }
  return undefined;
}
