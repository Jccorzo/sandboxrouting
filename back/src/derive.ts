// Derived values, one definition each, computed on read with the database's now(). Every one is
// the router's own function (src/router.ts) applied to rows rebuilt as the router's records:
// back never re-implements effective state, billable time, spend, free usage, health or marks.

import type { Queryable } from "./db.js";
import { iso, isoOrUndefined } from "./db.js";
import {
  activeMarks,
  availability,
  billableSeconds,
  effectiveJobState,
  effectiveState,
  freeStatus,
  fromWireSandbox,
  isLive,
  monthWindow,
  paidSpendThisMonth,
  providerHealth,
  quotaState,
  ratePerSecond,
  spend,
  type HealthSample,
  type JobRecord,
  type LedgerData,
  type Pricing,
  type ProviderConfig,
  type ProviderInfo,
  type ProviderMark,
  type SandboxRecord,
  type Window,
  type WireProvider,
  type WireSandbox,
} from "./router.js";
import type { JobMove, JobView, MarkView, ProviderView, SandboxView, UsagePoint } from "./api.js";

export const DAY_MS = 86_400_000;
const ALL_TIME: Window = { from: 0, to: Number.POSITIVE_INFINITY };

/** The database's clock, the one clock for everything derived. In a transaction: its start. */
export async function dbNow(q: Queryable): Promise<number> {
  const { rows } = await q.query<{ now: Date | string }>("SELECT now() AS now");
  return Date.parse(iso(rows[0]!.now));
}

// ------------------------------------------------------------------ sandboxes

export const SANDBOX_COLUMNS =
  "id, install_id, provider, state, cpu, memory_mib, billing, created_at, timeout_sec, provider_sandbox_id, expires_at, ended_at, stop_reason, segments, metadata, observed_at";

export interface SandboxRow {
  id: string;
  install_id: string;
  provider: string;
  state: WireSandbox["state"];
  cpu: number;
  memory_mib: number;
  billing: WireSandbox["billing"] | null;
  created_at: Date | string;
  timeout_sec: number | null;
  provider_sandbox_id: string | null;
  expires_at: Date | string | null;
  ended_at: Date | string | null;
  stop_reason: WireSandbox["reason"] | null;
  segments: { start: string; end?: string }[];
  metadata: Record<string, string>;
  observed_at: Date | string;
}

/** A row as the router's own record. */
export function recordOf(r: SandboxRow): SandboxRecord {
  const w: WireSandbox = {
    id: r.id,
    provider: r.provider,
    state: r.state,
    cpu: Number(r.cpu),
    memoryMiB: Number(r.memory_mib),
    createdAt: iso(r.created_at),
    ...(r.billing ? { billing: r.billing } : {}),
    ...(r.timeout_sec === null ? {} : { timeoutSec: Number(r.timeout_sec) }),
    ...(r.provider_sandbox_id === null ? {} : { providerSandboxId: r.provider_sandbox_id }),
    ...(r.expires_at === null ? {} : { expiresAt: iso(r.expires_at) }),
    segments: r.segments,
    ...(r.ended_at === null ? {} : { endedAt: iso(r.ended_at) }),
    ...(r.stop_reason === null ? {} : { reason: r.stop_reason }),
    metadata: r.metadata,
  };
  return fromWireSandbox(w);
}

/** Memory held while running, in GiB-seconds: billable seconds × memoryMiB / 1024. */
export function gibSeconds(rec: SandboxRecord, window: Window, now: number): number {
  return (billableSeconds(rec, window, now) * rec.memoryMiB) / 1024;
}

/** USD in a window at the given prices (the router's rate: every vCPU busy the whole time). */
export function usdIn(rec: SandboxRecord, pricing: Pricing | undefined, window: Window, now: number): number | null {
  return pricing ? billableSeconds(rec, window, now) * ratePerSecond(pricing, rec.cpu, rec.memoryMiB) : null;
}

export function sandboxView(row: SandboxRow, pricing: Pricing | undefined, now: number): SandboxView {
  const rec = recordOf(row);
  return {
    id: rec.id,
    install: row.install_id,
    provider: rec.provider,
    state: effectiveState(rec, now),
    cpu: rec.cpu,
    memoryMiB: rec.memoryMiB,
    billing: row.billing ?? null,
    createdAt: rec.createdAt,
    expiresAt: isoOrUndefined(row.expires_at) ?? null,
    endedAt: isoOrUndefined(row.ended_at) ?? null,
    reason: row.stop_reason ?? null,
    sandboxHours: billableSeconds(rec, ALL_TIME, now) / 3600,
    gibHours: gibSeconds(rec, ALL_TIME, now) / 3600,
    costUsd: usdIn(rec, pricing, ALL_TIME, now),
    metadata: rec.metadata,
    observedAt: iso(row.observed_at),
  };
}

export const isLiveNow = (row: SandboxRow, now: number) => isLive(recordOf(row), now);

// ------------------------------------------------------------------ usage per day

export const dayKey = (t: number) => new Date(t).toISOString().slice(0, 10);
export const dayWindow = (day: string): Window => {
  const from = Date.parse(`${day}T00:00:00Z`);
  return { from, to: from + DAY_MS };
};

/** The last `n` UTC days up to and including today's, oldest first. */
export function lastDays(now: number, n: number): string[] {
  const today = Date.parse(`${dayKey(now)}T00:00:00Z`);
  return Array.from({ length: n }, (_, i) => dayKey(today - (n - 1 - i) * DAY_MS));
}

export const pricingKey = (install: string, provider: string) => `${install}\u0000${provider}`;

/**
 * Usage per day, install and provider: the one definition the live read and the sweep's
 * rollups share. A sandbox counts on a day when it ran at some point that day.
 */
export function usageForDays(rows: SandboxRow[], pricing: Map<string, Pricing>, days: string[], now: number): UsagePoint[] {
  const out = new Map<string, UsagePoint>();
  const recs = rows.map((r) => ({ install: r.install_id, rec: recordOf(r) }));
  for (const day of days) {
    const w = dayWindow(day);
    for (const { install, rec } of recs) {
      const secs = billableSeconds(rec, w, now);
      if (secs <= 0) continue;
      const key = `${day}\u0000${pricingKey(install, rec.provider)}`;
      const p = (out.get(key) ?? out.set(key, { day, install, provider: rec.provider, sandboxes: 0, sandboxHours: 0, gibHours: 0, usd: 0 }).get(key))!;
      const price = pricing.get(pricingKey(install, rec.provider));
      p.sandboxes += 1;
      p.sandboxHours += secs / 3600;
      p.gibHours += (secs * rec.memoryMiB) / 1024 / 3600;
      p.usd = p.usd === null || !price ? null : p.usd + secs * ratePerSecond(price, rec.cpu, rec.memoryMiB);
    }
  }
  return [...out.values()];
}

// ------------------------------------------------------------------ providers

/** The router's ProviderInfo, as far as a snapshot carries it: what the metering functions read. */
export function providerInfo(p: WireProvider): ProviderInfo {
  return {
    id: p.id,
    name: p.name,
    homepage: "",
    env: [],
    capabilities: [],
    selfHosted: p.selfHosted,
    freeTier: { tier: p.freeTier, ...(p.concurrency === undefined ? {} : { concurrency: p.concurrency }) },
    pricing: p.pricing,
  };
}

/** The snapshot's free tier and prices are already the config's effective ones; only the credit used before tracking is left. */
export function providerConfig(p: WireProvider): ProviderConfig {
  return p.usedBeforeUsd === undefined ? {} : { usedBeforeUsd: p.usedBeforeUsd };
}

export interface MarkRow {
  install_id: string;
  provider: string;
  kind: ProviderMark["kind"];
  at: Date | string;
  until: Date | string;
  refusals: number | null;
}

export function markOf(r: MarkRow): ProviderMark {
  const base = { provider: r.provider, at: iso(r.at), until: iso(r.until) };
  return r.kind === "quota" ? { ...base, kind: "quota", ...(r.refusals === null ? {} : { refusals: r.refusals }) } : { ...base, kind: r.kind };
}

/** A ledger as the router would hold it for one install and provider, for the router's functions. */
export function ledgerFor(p: WireProvider, recs: SandboxRecord[], marks: ProviderMark[], health: HealthSample[]): LedgerData {
  return {
    version: 1,
    sandboxes: Object.fromEntries(recs.map((r) => [r.id, r])),
    marks,
    archivedUsd: { [p.id]: p.priorUsd },
    health: { [p.id]: health },
    jobs: {},
  };
}

export function markViews(install: string, data: LedgerData, provider: string, now: number): MarkView[] {
  const inForce = new Set(activeMarks(data, provider, now));
  const quota = quotaState(data, provider, now);
  return data.marks
    .filter((m) => m.provider === provider)
    .map((m) => ({
      install,
      provider,
      kind: m.kind,
      at: m.at,
      until: m.until,
      refusals: m.kind === "quota" ? (m.refusals ?? 1) : null,
      standing: inForce.has(m) ? "in-force" : m.kind === "quota" && quota.state === "half-open" ? "half-open" : "lapsed",
    }));
}

export function providerView(install: string, p: WireProvider, recs: SandboxRecord[], marks: ProviderMark[], health: HealthSample[], now: number, observedAt: string): ProviderView {
  const data = ledgerFor(p, recs, marks, health);
  const info = providerInfo(p);
  const cfg = providerConfig(p);
  return {
    install,
    provider: p.id,
    name: p.name,
    selfHosted: p.selfHosted,
    enabled: p.enabled,
    configured: p.configured,
    free: freeStatus(info, cfg, data, now),
    monthUsd: spend(data, p.id, info.pricing, monthWindow(now), now).usd,
    paidMonthUsd: paidSpendThisMonth(info, cfg, data, now),
    live: recs.filter((r) => isLive(r, now)).length,
    concurrency: p.concurrency ?? null,
    availability: availability(data, p.id, now),
    quota: quotaState(data, p.id, now),
    health: providerHealth(data, p.id, now, p.circuitBreaker),
    marks: markViews(install, data, p.id, now),
    observedAt,
  };
}

// ------------------------------------------------------------------ jobs

export interface JobRow {
  id: string;
  install_id: string;
  state: JobRecord["state"];
  cursor: number;
  steps: number;
  migrations: number;
  created_at: Date | string;
  updated_at: Date | string;
  ended_at: Date | string | null;
  lease_until: Date | string | null;
  box: { sandboxId: string; provider: string } | null;
  reason: string | null;
  placements: { sandboxId: string; provider: string; lane?: string; billing?: string; placedAt: string; endedAt?: string; endReason?: string }[];
}

const NOT_A_MOVE = new Set(["finished", "failed", "cancelled"]);

export function jobView(r: JobRow, now: number): JobView {
  // The router's effectiveJobState reads only the state and the lease's end; the rest of the
  // record (spec, results) never leaves the router, so it isn't here to pass.
  const leaseUntil = isoOrUndefined(r.lease_until);
  const rec = { state: r.state, ...(leaseUntil ? { lease: { owner: "", until: leaseUntil } } : {}) } as unknown as JobRecord;
  const moves: JobMove[] = [];
  r.placements.forEach((p, i) => {
    if (!p.endReason || NOT_A_MOVE.has(p.endReason)) return;
    const next = r.placements[i + 1];
    moves.push({
      at: p.endedAt ?? p.placedAt,
      fromProvider: p.provider,
      fromSandbox: p.sandboxId,
      toProvider: next?.provider ?? null,
      toSandbox: next?.sandboxId ?? null,
      reason: p.endReason,
    });
  });
  return {
    id: r.id,
    install: r.install_id,
    state: effectiveJobState(rec, now),
    cursor: r.cursor,
    steps: r.steps,
    migrations: r.migrations,
    provider: r.box?.provider ?? null,
    sandboxId: r.box?.sandboxId ?? null,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    endedAt: isoOrUndefined(r.ended_at) ?? null,
    leaseUntil: leaseUntil ?? null,
    reason: r.reason,
    placements: r.placements.map((p) => ({
      sandboxId: p.sandboxId,
      provider: p.provider,
      lane: p.lane ?? null,
      billing: p.billing ?? null,
      placedAt: p.placedAt,
      endedAt: p.endedAt ?? null,
      endReason: p.endReason ?? null,
    })),
    moves,
  };
}
