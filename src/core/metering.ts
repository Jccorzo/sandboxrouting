// What usage costs, how much free usage is left, and what live sandboxes will still spend. One
// definition: the router, CLI, REST API and MCP server all call `providerStatus`, and nothing
// stores the verdict.

import type { FreeTier, Pricing, ProviderInfo, ProviderUsage } from "./types.js";
import type { LedgerData, ProviderMark } from "./ledger.js";
import type { SandboxRecord } from "./state.js";
import type { ProviderConfig } from "./config.js";
import type { Billing } from "./routing/types.js";

const ms = (s: string) => Date.parse(s);

export interface Window {
  from: number;
  to: number;
}

/** The calendar month (UTC) containing `now`, which is when monthly free tiers reset. */
export function monthWindow(now: number): Window {
  const d = new Date(now);
  return {
    from: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1),
    to: Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1),
  };
}

export const monthKey = (t: number) => new Date(t).toISOString().slice(0, 7);

/** Seconds the sandbox was running inside `window`. Open segments end at now or the deadline. */
export function billableSeconds(rec: SandboxRecord, window: Window, now: number): number {
  if (rec.state === "creating") return 0;
  let total = 0;
  for (const seg of rec.segments) {
    let end = seg.end ? ms(seg.end) : now;
    if (!seg.end && rec.state === "running") end = Math.min(end, ms(rec.expiresAt));
    const a = Math.max(ms(seg.start), window.from);
    const b = Math.min(end, window.to);
    if (b > a) total += (b - a) / 1000;
  }
  return total;
}

export function ratePerSecond(pricing: Pricing, cpu: number, memoryMiB: number): number {
  if (pricing.sandboxSecondUsd !== undefined) return pricing.sandboxSecondUsd;
  return cpu * pricing.vcpuSecondUsd + (memoryMiB / 1024) * pricing.gibSecondUsd;
}

export function effectivePricing(info: ProviderInfo, cfg?: ProviderConfig): Pricing {
  return { ...info.pricing, ...stripUndefined(cfg?.pricing ?? {}) };
}

export function effectiveFreeTier(info: ProviderInfo, cfg?: ProviderConfig): FreeTier {
  return cfg?.freeTier ?? info.freeTier.tier;
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export interface Spend {
  usd: number;
  sandboxSeconds: number;
}

/** What a provider's sandboxes cost inside a window, from the ledger. */
export function spend(data: LedgerData, provider: string, pricing: Pricing, window: Window, now: number): Spend {
  let usd = 0;
  let sandboxSeconds = 0;
  for (const rec of Object.values(data.sandboxes)) {
    if (rec.provider !== provider) continue;
    const secs = billableSeconds(rec, window, now);
    sandboxSeconds += secs;
    usd += secs * ratePerSecond(pricing, rec.cpu, rec.memoryMiB);
  }
  for (const [month, amount] of Object.entries(data.archivedUsd[provider] ?? {})) {
    const t = Date.parse(`${month}-01T00:00:00Z`);
    if (t >= window.from && t < window.to) usd += amount;
  }
  return { usd, sandboxSeconds };
}

/**
 * Seconds a sandbox will still run if nothing stops it early: a running one until its deadline,
 * a creating one for the lifetime it asked for (0 for a record from before that was kept), a
 * paused, finished or expired one none. With `billableSeconds` so far, that is its whole lifetime.
 */
export function committedSeconds(rec: SandboxRecord, now: number): number {
  if (rec.state === "running") return Math.max(0, ms(rec.expiresAt) - now) / 1000;
  if (rec.state === "creating") return rec.timeoutSec ?? 0;
  return 0;
}

/** How a sandbox is paid for: as it was reserved, or for an older record, as its provider's tier suggests. */
export function recordBilling(rec: SandboxRecord, tier: FreeTier): Billing {
  if (rec.billing === "free" || rec.billing === "self-hosted" || rec.billing === "paid") return rec.billing;
  return tier.kind === "none" ? "paid" : tier.kind === "unlimited" ? "self-hosted" : "free";
}

/**
 * What a provider's live sandboxes will still spend if each runs to its deadline, by how each is
 * billed: USD at each record's own size, and sandbox-seconds. Free usage and the paid budget only
 * take a new sandbox when what is left after this covers it, so parallel requests can't all fit
 * in the same remainder.
 */
export function committed(info: ProviderInfo, cfg: ProviderConfig | undefined, data: LedgerData, now: number): Record<Billing, Spend> {
  const tier = effectiveFreeTier(info, cfg);
  const pricing = effectivePricing(info, cfg);
  const out: Record<Billing, Spend> = {
    free: { usd: 0, sandboxSeconds: 0 },
    "self-hosted": { usd: 0, sandboxSeconds: 0 },
    paid: { usd: 0, sandboxSeconds: 0 },
  };
  for (const rec of Object.values(data.sandboxes)) {
    if (rec.provider !== info.id) continue;
    const secs = committedSeconds(rec, now);
    if (secs === 0) continue;
    const held = out[recordBilling(rec, tier)];
    held.sandboxSeconds += secs;
    held.usd += secs * ratePerSecond(pricing, rec.cpu, rec.memoryMiB);
  }
  return out;
}

export type FreeStatus =
  | { state: "unlimited" }
  | { state: "none" }
  | {
      state: "available";
      /** Remaining free credit in USD (credit tiers) or hours (hour tiers). */
      remaining: number;
      unit: "usd" | "hours";
      /** Remaining as a share of the whole grant, 0..1. */
      fraction: number;
      /** When unused free usage is lost (monthly tiers). */
      resetsAt?: number;
      basis: "ledger" | "provider";
    }
  | { state: "exhausted"; resetsAt?: number; reason: string };

export type Availability =
  | { ok: true }
  | { ok: false; reason: string; until: number; kind: ProviderMark["kind"] };

/** Marks still in force for a provider. A mark past `until` simply stops counting. */
export function activeMarks(data: LedgerData, provider: string, now: number): ProviderMark[] {
  return data.marks.filter((m) => m.provider === provider && ms(m.until) > now);
}

export function availability(data: LedgerData, provider: string, now: number): Availability {
  const blocking = activeMarks(data, provider, now).find((m) => m.kind === "rate_limit" || m.kind === "auth");
  if (!blocking) return { ok: true };
  return { ok: false, kind: blocking.kind, until: ms(blocking.until), reason: blocking.detail ?? blocking.kind };
}

export function freeStatus(
  info: ProviderInfo,
  cfg: ProviderConfig | undefined,
  data: LedgerData,
  now: number,
  reported?: ProviderUsage,
): FreeStatus {
  const tier = effectiveFreeTier(info, cfg);
  if (tier.kind === "unlimited") return { state: "unlimited" };
  if (tier.kind === "none") return { state: "none" };

  const pricing = effectivePricing(info, cfg);
  const month = monthWindow(now);
  const quota = activeMarks(data, info.id, now).find((m) => m.kind === "quota");
  const resetsAt = tier.kind === "one-time-credit" ? undefined : month.to;
  if (quota) return { state: "exhausted", resetsAt, reason: quota.detail ?? "provider reported its quota used up" };

  let remaining: number;
  let grant: number;
  let basis: "ledger" | "provider" = "ledger";
  if (tier.kind === "monthly-hours") {
    grant = tier.hours;
    remaining = grant - spend(data, info.id, pricing, month, now).sandboxSeconds / 3600;
  } else {
    grant = tier.usd;
    const window = tier.kind === "monthly-credit" ? month : { from: 0, to: Number.POSITIVE_INFINITY };
    const used = spend(data, info.id, pricing, window, now).usd + (tier.kind === "one-time-credit" ? cfg?.usedBeforeUsd ?? 0 : 0);
    remaining = grant - used;
    // The provider's own number wins when it has one: it sees usage from outside the router.
    if (reported?.remainingFreeUsd !== undefined) {
      remaining = Math.min(remaining, reported.remainingFreeUsd);
      basis = "provider";
    }
  }
  if (remaining <= 0 || grant <= 0) {
    return { state: "exhausted", resetsAt, reason: `free ${tier.kind === "monthly-hours" ? "hours" : "credit"} used up` };
  }
  return {
    state: "available",
    remaining,
    unit: tier.kind === "monthly-hours" ? "hours" : "usd",
    fraction: Math.min(1, remaining / grant),
    resetsAt,
    basis,
  };
}

/**
 * Paid spend this month: whatever went past the free grant. Used for `maxPaidUsdPerMonth`.
 */
export function paidSpendThisMonth(info: ProviderInfo, cfg: ProviderConfig | undefined, data: LedgerData, now: number): number {
  const tier = effectiveFreeTier(info, cfg);
  if (tier.kind === "unlimited") return 0;
  const pricing = effectivePricing(info, cfg);
  const month = monthWindow(now);
  const thisMonth = spend(data, info.id, pricing, month, now).usd;
  switch (tier.kind) {
    case "none":
      return thisMonth;
    case "monthly-credit":
      return Math.max(0, thisMonth - tier.usd);
    case "monthly-hours": {
      const s = spend(data, info.id, pricing, month, now);
      const paidSecs = Math.max(0, s.sandboxSeconds - tier.hours * 3600);
      return s.sandboxSeconds > 0 ? (s.usd * paidSecs) / s.sandboxSeconds : 0;
    }
    case "one-time-credit": {
      const before = spend(data, info.id, pricing, { from: 0, to: month.from }, now).usd + (cfg?.usedBeforeUsd ?? 0);
      const total = before + thisMonth;
      return Math.max(0, total - tier.usd) - Math.max(0, before - tier.usd);
    }
  }
}

/** Live sandboxes per provider, for free-tier concurrency caps. */
export function liveCount(data: LedgerData, provider: string, now: number, isLive: (r: SandboxRecord, now: number) => boolean): number {
  return Object.values(data.sandboxes).filter((r) => r.provider === provider && isLive(r, now)).length;
}
