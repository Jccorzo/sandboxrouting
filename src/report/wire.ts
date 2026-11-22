// What the reporter sends to a sandboxrouting back end (back/), and the one definition of it:
// the router builds events with these functions and back validates them with these schemas.
//
// Only facts that are safe to leave the machine go on the wire: ids, provider ids, sizes, times,
// states, prices and counts, plus the metadata keys the user lists in `report.metadataKeys`.
// Never commands, env, file contents, provider error messages or keys. Each `toWire*` builds its
// object field by field from an allowlist, so a field added to a ledger record later stays home
// until someone adds it here on purpose.

import { createHash } from "node:crypto";
import { z } from "zod";
import { validateRecord, type SandboxRecord, type SandboxState, type StopReason } from "../core/state.js";
import { ACTIVE_JOB_STATES, TERMINAL_JOB_STATES, type JobRecord, type JobState, type MigrationReason, type Placement } from "../core/jobs/types.js";
import type { HealthSample, MarkKind, ProviderMark } from "../core/ledger.js";
import type { ErrorKind } from "../core/errors.js";
import type { Billing } from "../core/routing/types.js";
import type { FreeTier, Pricing } from "../core/types.js";

// ------------------------------------------------------------------ the state lists
// Each list is checked against the router's own union type, both ways, so a state added to the
// router fails this file's typecheck until the list (and back's CHECK constraints) follow.

/** A list of every member of `Union` and nothing else; a missing member is a type error naming it. */
const exactly =
  <Union extends string>() =>
  <const List extends readonly Union[]>(list: List, ..._missing: [Exclude<Union, List[number]>] extends [never] ? [] : [missing: Exclude<Union, List[number]>]): List =>
    list;

export const SANDBOX_STATES = exactly<SandboxState>()(["creating", "running", "paused", "stopped", "failed"]);
export const STOP_REASONS = exactly<StopReason>()(["killed", "expired", "gone"]);
export const BILLINGS = exactly<Billing>()(["free", "self-hosted", "paid"]);
export const MARK_KINDS = exactly<MarkKind>()(["quota", "rate_limit", "auth"]);
export const HEALTH_OPS = exactly<HealthSample["op"]>()(["create", "lost"]);
export const ERROR_KINDS = exactly<ErrorKind>()(["quota", "rate_limit", "auth", "not_found", "unsupported", "invalid", "conflict", "transient"]);
export const JOB_STATES = exactly<JobState>()(["queued", "placing", "preparing", "running", "migrating", "succeeded", "failed", "cancelled"]);
export const MIGRATION_REASONS = exactly<MigrationReason>()([
  "lost",
  "stopped",
  "provider-refused",
  "unhealthy",
  "deadline",
  "free-credit",
  "circuit-open",
  "rebalance",
  "oom",
  "prepare-failed",
  "orphaned",
]);
export const PLACEMENT_END_REASONS = [...MIGRATION_REASONS, "finished", "failed", "cancelled"] as const satisfies readonly NonNullable<Placement["endReason"]>[];
export const FREE_TIER_KINDS = exactly<FreeTier["kind"]>()(["none", "one-time-credit", "monthly-credit", "monthly-hours", "unlimited"]);

// The job lists the router exports must agree with the one above.
const _jobListsAgree: readonly JobState[] = [...ACTIVE_JOB_STATES, ...TERMINAL_JOB_STATES, "queued"];
void _jobListsAgree;

// ------------------------------------------------------------------ schemas

const iso = z.string().datetime({ offset: true });
const id = z.string().min(1).max(128);
/** Provider ids are short slugs such as `e2b` or `aws-lambda`. */
const providerId = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);
const usd = z.number().finite().nonnegative();

export const wireSegmentSchema = z.object({ start: iso, end: iso.optional() }).strict();

export const wireSandboxSchema = z
  .object({
    id,
    provider: providerId,
    state: z.enum(SANDBOX_STATES),
    cpu: z.number().finite().nonnegative(),
    memoryMiB: z.number().int().nonnegative(),
    createdAt: iso,
    billing: z.enum(BILLINGS).optional(),
    /** Creating only: the lifetime the create asked for. */
    timeoutSec: z.number().finite().nonnegative().optional(),
    providerSandboxId: z.string().min(1).max(256).optional(),
    expiresAt: iso.optional(),
    segments: z.array(wireSegmentSchema).max(10_000),
    endedAt: iso.optional(),
    reason: z.enum(STOP_REASONS).optional(),
    /** Only the keys listed in `report.metadataKeys`. */
    metadata: z.record(z.string().max(128), z.string().max(512)),
  })
  .strict();

export const wireMarkSchema = z
  .object({ at: iso, until: iso, refusals: z.number().int().positive().optional() })
  .strict();

export const wireHealthSampleSchema = z
  .object({
    at: iso,
    op: z.enum(HEALTH_OPS),
    ok: z.boolean(),
    ms: z.number().finite().nonnegative().optional(),
    kind: z.enum(ERROR_KINDS).optional(),
  })
  .strict();

const wireBoxSchema = z
  .object({ sandboxId: id, provider: providerId, lane: z.string().max(64).optional(), billing: z.enum(BILLINGS).optional(), placedAt: iso })
  .strict();

export const wirePlacementSchema = wireBoxSchema.extend({ endedAt: iso.optional(), endReason: z.enum(PLACEMENT_END_REASONS).optional() }).strict();

export const wireJobSchema = z
  .object({
    id,
    state: z.enum(JOB_STATES),
    version: z.number().int().positive(),
    cursor: z.number().int().nonnegative(),
    steps: z.number().int().positive(),
    migrations: z.number().int().nonnegative(),
    createdAt: iso,
    updatedAt: iso,
    endedAt: iso.optional(),
    /** Active jobs only: when the runner's lease lapses (the job then reads as orphaned). Never the owner. */
    leaseUntil: iso.optional(),
    box: wireBoxSchema.optional(),
    /** Migrating only. */
    reason: z.enum(MIGRATION_REASONS).optional(),
    placements: z.array(wirePlacementSchema).max(1000),
  })
  .strict();

const freeTierSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z.object({ kind: z.literal("one-time-credit"), usd }).strict(),
  z.object({ kind: z.literal("monthly-credit"), usd }).strict(),
  z.object({ kind: z.literal("monthly-hours"), hours: z.number().finite().nonnegative() }).strict(),
  z.object({ kind: z.literal("unlimited") }).strict(),
]);

export const wireProviderSchema = z
  .object({
    id: providerId,
    name: z.string().min(1).max(128),
    selfHosted: z.boolean(),
    enabled: z.boolean(),
    /** Whether its key is present here. Never the key. */
    configured: z.boolean(),
    freeTier: freeTierSchema,
    usedBeforeUsd: usd.optional(),
    pricing: z
      .object({
        vcpuSecondUsd: usd,
        gibSecondUsd: usd,
        sandboxSecondUsd: usd.optional(),
        defaultCpu: z.number().finite().nonnegative(),
        defaultMemoryMiB: z.number().int().nonnegative(),
        billing: z.enum(["wall", "active-cpu"]).optional(),
      })
      .strict(),
    concurrency: z.number().int().positive().optional(),
    circuitBreaker: z
      .object({ failures: z.number().int().nonnegative(), cooldownSec: z.number().positive(), maxCooldownSec: z.number().positive() })
      .strict(),
    healthSamples: z.number().int().positive(),
    /**
     * Spend the ledger had already folded into monthly totals before reporting began, by month
     * (`YYYY-MM`). back has no records for it; everything after, it sees record by record.
     */
    priorUsd: z.record(z.string().regex(/^\d{4}-\d{2}$/), usd),
  })
  .strict();

const envelope = {
  /** `<install>:<seq>`: stable across retries, so a resend is recognised. */
  id: z.string().min(3).max(200),
  /** Per-install sequence, increasing. */
  seq: z.number().int().positive(),
  /** When the router saw this state; never decreases within an install. Newer wins. */
  observedAt: iso,
};

export const wireEventSchema = z.discriminatedUnion("type", [
  z.object({ ...envelope, type: z.literal("sandbox"), sandbox: wireSandboxSchema }).strict(),
  z.object({ ...envelope, type: z.literal("mark"), provider: providerId, kind: z.enum(MARK_KINDS), mark: wireMarkSchema.nullable() }).strict(),
  z
    .object({
      ...envelope,
      type: z.literal("health"),
      provider: providerId,
      sample: wireHealthSampleSchema,
      /** How many identical samples (same time and outcome) come before this one in the ledger. */
      occurrence: z.number().int().nonnegative().max(10_000).optional(),
    })
    .strict(),
  z.object({ ...envelope, type: z.literal("job"), job: wireJobSchema }).strict(),
  z.object({ ...envelope, type: z.literal("provider"), provider: wireProviderSchema }).strict(),
]);

export const INSTALL_ID = /^[A-Za-z0-9_-]{8,64}$/;
export const MAX_BATCH_EVENTS = 200;

/** The batch's shape; each event is validated on its own so one bad event can't block the rest. */
export const wireBatchSchema = z
  .object({
    install: z.string().regex(INSTALL_ID),
    /** The router's package version, for diagnostics. */
    router: z.string().max(64).optional(),
    events: z.array(z.unknown()).min(1).max(MAX_BATCH_EVENTS),
  })
  .strict();

export type WireSandbox = z.infer<typeof wireSandboxSchema>;
export type WireMark = z.infer<typeof wireMarkSchema>;
export type WireHealthSample = z.infer<typeof wireHealthSampleSchema>;
export type WireJob = z.infer<typeof wireJobSchema>;
export type WirePlacement = z.infer<typeof wirePlacementSchema>;
export type WireProvider = z.infer<typeof wireProviderSchema>;
export type WireEvent = z.infer<typeof wireEventSchema>;
export type WireBatch = Omit<z.infer<typeof wireBatchSchema>, "events"> & { events: WireEvent[] };

/** What back answers for each event of a batch. Every id in the batch gets exactly one. */
export type EventOutcome = "applied" | "duplicate" | "stale" | "rejected";
export const EVENT_OUTCOMES = ["applied", "duplicate", "stale", "rejected"] as const satisfies readonly EventOutcome[];
export interface IngestResponse {
  results: { id: string; outcome: EventOutcome; error?: string }[];
}

// ------------------------------------------------------------------ building events

const pick = <T>(v: T | undefined) => (v === undefined ? {} : v);

/** A sandbox record as it may leave the machine. */
export function toWireSandbox(rec: SandboxRecord, metadataKeys: readonly string[]): WireSandbox {
  const metadata: Record<string, string> = {};
  for (const key of metadataKeys) {
    const value = rec.metadata[key];
    if (typeof value === "string") metadata[key.slice(0, 128)] = value.slice(0, 512);
  }
  const out: WireSandbox = {
    id: rec.id,
    provider: rec.provider,
    state: rec.state,
    cpu: rec.cpu,
    memoryMiB: Math.round(rec.memoryMiB),
    createdAt: rec.createdAt,
    ...pick(rec.billing === "free" || rec.billing === "self-hosted" || rec.billing === "paid" ? { billing: rec.billing } : undefined),
    segments: [],
    metadata,
  };
  switch (rec.state) {
    case "creating":
      return { ...out, ...pick(rec.timeoutSec === undefined ? undefined : { timeoutSec: rec.timeoutSec }) };
    case "running":
      return { ...out, providerSandboxId: rec.providerSandboxId, expiresAt: rec.expiresAt, segments: segments(rec.segments) };
    case "paused":
      return { ...out, providerSandboxId: rec.providerSandboxId, ...pick(rec.expiresAt ? { expiresAt: rec.expiresAt } : undefined), segments: segments(rec.segments) };
    case "stopped":
      return { ...out, providerSandboxId: rec.providerSandboxId, segments: segments(rec.segments), endedAt: rec.endedAt, reason: rec.reason };
    case "failed":
      // The error message stays home: provider errors can quote URLs, ids or keys.
      return { ...out, ...pick(rec.providerSandboxId ? { providerSandboxId: rec.providerSandboxId } : undefined), segments: segments(rec.segments), endedAt: rec.endedAt };
  }
}

const segments = (list: { start: string; end?: string }[]) => list.map((s) => (s.end ? { start: s.start, end: s.end } : { start: s.start }));

/** The record a wire sandbox stands for, so back can hand it to the router's own functions. */
export function fromWireSandbox(w: WireSandbox): SandboxRecord {
  const base = { id: w.id, provider: w.provider, cpu: w.cpu, memoryMiB: w.memoryMiB, createdAt: w.createdAt, metadata: w.metadata, ...pick(w.billing ? { billing: w.billing } : undefined) };
  switch (w.state) {
    case "creating":
      return { ...base, state: "creating", ...pick(w.timeoutSec === undefined ? undefined : { timeoutSec: w.timeoutSec }) };
    case "running":
      return { ...base, state: "running", providerSandboxId: w.providerSandboxId ?? "", expiresAt: w.expiresAt ?? "", segments: w.segments };
    case "paused":
      return { ...base, state: "paused", providerSandboxId: w.providerSandboxId ?? "", ...pick(w.expiresAt ? { expiresAt: w.expiresAt } : undefined), segments: w.segments };
    case "stopped":
      return { ...base, state: "stopped", providerSandboxId: w.providerSandboxId ?? "", segments: w.segments, endedAt: w.endedAt ?? "", reason: w.reason ?? "killed" };
    case "failed":
      return { ...base, state: "failed", ...pick(w.providerSandboxId ? { providerSandboxId: w.providerSandboxId } : undefined), segments: w.segments, endedAt: w.endedAt ?? "", error: "" };
  }
}

/**
 * What is wrong with a wire sandbox that its schema can't say: the fields each state needs and
 * the ones it can't have, then the router's own record invariants (`validateRecord`).
 */
export function wireSandboxProblem(w: WireSandbox): string | undefined {
  const has = { pid: w.providerSandboxId !== undefined, exp: w.expiresAt !== undefined, end: w.endedAt !== undefined, reason: w.reason !== undefined };
  const need = (cond: boolean, what: string) => (cond ? undefined : `${w.state} sandbox ${what}`);
  const problem =
    w.state === "creating"
      ? need(!has.pid && !has.exp && !has.end && !has.reason && w.segments.length === 0, "has nothing but its request yet")
      : w.state === "running"
        ? need(has.pid && has.exp && !has.end && !has.reason, "needs providerSandboxId and expiresAt, and no end")
        : w.state === "paused"
          ? need(has.pid && !has.end && !has.reason, "needs providerSandboxId, and no end")
          : w.state === "stopped"
            ? need(has.pid && has.end && has.reason && !has.exp, "needs providerSandboxId, endedAt and reason")
            : need(has.end && !has.reason && !has.exp, "needs endedAt and no reason");
  if (w.timeoutSec !== undefined && w.state !== "creating") return `${w.state} sandbox can't have timeoutSec`;
  if (problem) return problem;
  for (const s of w.segments) if (s.end !== undefined && Date.parse(s.end) < Date.parse(s.start)) return "a segment ends before it starts";
  return validateRecord(fromWireSandbox(w));
}

export function toWireMark(m: ProviderMark): WireMark {
  return { at: m.at, until: m.until, ...pick(m.kind === "quota" && m.refusals !== undefined ? { refusals: m.refusals } : undefined) };
}

export function toWireHealthSample(s: HealthSample): WireHealthSample {
  return { at: s.at, op: s.op, ok: s.ok, ...pick(s.ms === undefined ? undefined : { ms: s.ms }), ...pick(s.kind === undefined ? undefined : { kind: s.kind }) };
}

/**
 * A key that tells two health samples apart; the ledger keeps no id for them. Two samples can be
 * identical (same instant, same outcome), so the key counts which of them this is.
 */
export function healthSampleKey(s: WireHealthSample, occurrence = 0): string {
  return `${s.at}|${s.op}|${s.ok ? 1 : 0}|${s.ms ?? ""}|${s.kind ?? ""}${occurrence ? `#${occurrence}` : ""}`;
}

/** A job as it may leave the machine: no spec (commands, env, files), outputs, errors or lease owner. */
export function toWireJob(rec: JobRecord): WireJob {
  const box = (b: { sandboxId: string; provider: string; lane?: string; billing?: string; placedAt: string }) => ({
    sandboxId: b.sandboxId,
    provider: b.provider,
    ...pick(b.lane === undefined ? undefined : { lane: b.lane.slice(0, 64) }),
    ...pick(b.billing === "free" || b.billing === "self-hosted" || b.billing === "paid" ? { billing: b.billing } : undefined),
    placedAt: b.placedAt,
  });
  const out: WireJob = {
    id: rec.id,
    state: rec.state,
    version: rec.version,
    cursor: rec.cursor,
    steps: rec.spec.steps.length,
    migrations: rec.migrations,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
    placements: rec.placements.map((p) => ({
      ...box(p),
      ...pick(p.endedAt === undefined ? undefined : { endedAt: p.endedAt }),
      ...pick(p.endReason === undefined ? undefined : { endReason: p.endReason }),
    })),
  };
  if ("lease" in rec) out.leaseUntil = rec.lease.until;
  if ("box" in rec && rec.box) out.box = box(rec.box);
  if (rec.state === "migrating") out.reason = rec.reason;
  if ("endedAt" in rec) out.endedAt = rec.endedAt;
  return out;
}

export function toWireProvider(p: {
  id: string;
  name: string;
  selfHosted: boolean;
  enabled: boolean;
  configured: boolean;
  freeTier: FreeTier;
  usedBeforeUsd?: number;
  pricing: Pricing;
  concurrency?: number;
  circuitBreaker: { failures: number; cooldownSec: number; maxCooldownSec: number };
  healthSamples: number;
  priorUsd: Record<string, number>;
}): WireProvider {
  const pr = p.pricing;
  return {
    id: p.id,
    name: p.name,
    selfHosted: p.selfHosted,
    enabled: p.enabled,
    configured: p.configured,
    freeTier: p.freeTier,
    ...pick(p.usedBeforeUsd === undefined ? undefined : { usedBeforeUsd: p.usedBeforeUsd }),
    pricing: {
      vcpuSecondUsd: pr.vcpuSecondUsd,
      gibSecondUsd: pr.gibSecondUsd,
      ...pick(pr.sandboxSecondUsd === undefined ? undefined : { sandboxSecondUsd: pr.sandboxSecondUsd }),
      defaultCpu: pr.defaultCpu,
      defaultMemoryMiB: pr.defaultMemoryMiB,
      ...pick(pr.billing === undefined ? undefined : { billing: pr.billing }),
    },
    ...pick(p.concurrency === undefined ? undefined : { concurrency: p.concurrency }),
    circuitBreaker: { failures: p.circuitBreaker.failures, cooldownSec: p.circuitBreaker.cooldownSec, maxCooldownSec: p.circuitBreaker.maxCooldownSec },
    healthSamples: p.healthSamples,
    priorUsd: p.priorUsd,
  };
}

/** What an event is about. A newer event about the same thing supersedes an older one. */
export function entityKey(ev: WireEvent): string {
  switch (ev.type) {
    case "sandbox":
      return `sandbox:${ev.sandbox.id}`;
    case "job":
      return `job:${ev.job.id}`;
    case "mark":
      return `mark:${ev.provider}:${ev.kind}`;
    case "provider":
      return `provider:${ev.provider.id}`;
    case "health":
      return `health:${ev.provider}:${healthSampleKey(ev.sample, ev.occurrence)}`;
  }
}

/** A short digest of a payload, to tell whether it changed since it was last sent. */
export function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
}
