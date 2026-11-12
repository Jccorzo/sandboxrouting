// The sandbox lifecycle, as the router tracks it. This file is the one place that decides
// which moves are allowed; the ledger stores the result and everything else reads it
// through `effectiveState`.
//
//   creating ──created──▶ running ──paused──▶ paused
//      │                    │  ▲                 │
//   createFailed          stop │ resumed ◀────────┘
//      ▼                    ▼  │
//    failed ◀───lost─── (running|paused) ──stop/expire──▶ stopped
//
// Billing is a list of segments; a segment is open exactly while the state is `running`.
// A failed record keeps the provider's id of any box its create made, so the remote sweep
// can delete that box if killing it failed.

export type SandboxState = "creating" | "running" | "paused" | "stopped" | "failed";
/** `expired` is never stored: a running sandbox past its deadline reads as expired. */
export type EffectiveState = SandboxState | "expired";

export interface Segment {
  start: string; // ISO time
  end?: string;
}

interface Base {
  id: string; // router id, e.g. sbr_k3j2...
  provider: string;
  cpu: number;
  memoryMiB: number;
  createdAt: string;
  metadata: Record<string, string>;
  /** How it is paid for, as planned when it was reserved: "free", "self-hosted" or "paid". */
  billing?: string;
}

export type SandboxRecord =
  /** `timeoutSec`: the lifetime the create asked for, so what it will spend counts before it starts. */
  | (Base & { state: "creating"; timeoutSec?: number })
  | (Base & { state: "running"; providerSandboxId: string; expiresAt: string; segments: Segment[] })
  | (Base & { state: "paused"; providerSandboxId: string; expiresAt?: string; segments: Segment[] })
  | (Base & { state: "stopped"; providerSandboxId: string; segments: Segment[]; endedAt: string; reason: StopReason })
  | (Base & { state: "failed"; providerSandboxId?: string; segments: Segment[]; endedAt: string; error: string });

export type StopReason = "killed" | "expired" | "gone";

export type SandboxEvent =
  | { type: "created"; providerSandboxId: string; timeoutSec: number; cpu?: number; memoryMiB?: number }
  /** `providerSandboxId`: the box the provider made anyway, when its record couldn't say so. */
  | { type: "createFailed"; error: string; providerSandboxId?: string }
  | { type: "paused" }
  | { type: "resumed"; timeoutSec: number }
  | { type: "timeoutSet"; timeoutSec: number }
  | { type: "stopped"; reason: StopReason }
  | { type: "lost"; error: string };

export class InvalidTransitionError extends Error {
  constructor(from: SandboxState, event: SandboxEvent["type"]) {
    super(`sandbox cannot go through "${event}" while ${from}`);
    this.name = "InvalidTransitionError";
  }
}

const iso = (ms: number) => new Date(ms).toISOString();
const ms = (s: string) => Date.parse(s);

export function effectiveState(rec: SandboxRecord, now: number): EffectiveState {
  if (rec.state === "running" && ms(rec.expiresAt) <= now) return "expired";
  return rec.state;
}

/** Whether the sandbox still holds a slot at the provider (counts against concurrency). */
export function isLive(rec: SandboxRecord, now: number): boolean {
  const s = effectiveState(rec, now);
  return s === "creating" || s === "running";
}

function closeSegments(segments: Segment[], at: number): Segment[] {
  return segments.map((seg) => (seg.end ? seg : { ...seg, end: iso(Math.max(ms(seg.start), at)) }));
}

/** When an open segment really ended: now, or the deadline if the provider already stopped it. */
function endOf(rec: SandboxRecord, now: number): number {
  if (rec.state === "running") return Math.min(now, ms(rec.expiresAt));
  return now;
}

/** The only function that moves a sandbox between states. Pure: returns the new record. */
export function transition(rec: SandboxRecord, ev: SandboxEvent, now: number): SandboxRecord {
  const base: Base = {
    id: rec.id,
    provider: rec.provider,
    cpu: rec.cpu,
    memoryMiB: rec.memoryMiB,
    createdAt: rec.createdAt,
    metadata: rec.metadata,
    ...(rec.billing === undefined ? {} : { billing: rec.billing }),
  };
  const segments = rec.state === "creating" ? [] : rec.segments;
  const live = effectiveState(rec, now);

  switch (ev.type) {
    case "created":
      if (rec.state !== "creating") break;
      return {
        ...base,
        cpu: ev.cpu ?? rec.cpu,
        memoryMiB: ev.memoryMiB ?? rec.memoryMiB,
        state: "running",
        providerSandboxId: ev.providerSandboxId,
        expiresAt: iso(now + ev.timeoutSec * 1000),
        segments: [{ start: iso(now) }],
      };
    case "createFailed": {
      const box = ev.providerSandboxId === undefined ? {} : { providerSandboxId: ev.providerSandboxId };
      // A create the sweep gave up on (`lost`) that finished after all: keep its box's id.
      if (rec.state === "failed" && rec.providerSandboxId === undefined && ev.providerSandboxId !== undefined) return { ...rec, ...box };
      if (rec.state !== "creating") break;
      return { ...base, state: "failed", ...box, segments: [], endedAt: iso(now), error: ev.error };
    }
    case "paused":
      if (live !== "running") break;
      return {
        ...base,
        state: "paused",
        providerSandboxId: (rec as { providerSandboxId: string }).providerSandboxId,
        segments: closeSegments(segments, now),
      };
    case "resumed":
      if (rec.state !== "paused") break;
      return {
        ...base,
        state: "running",
        providerSandboxId: rec.providerSandboxId,
        expiresAt: iso(now + ev.timeoutSec * 1000),
        segments: [...segments, { start: iso(now) }],
      };
    case "timeoutSet":
      if (live !== "running") break;
      return { ...(rec as Extract<SandboxRecord, { state: "running" }>), expiresAt: iso(now + ev.timeoutSec * 1000) };
    case "stopped": {
      if (rec.state === "stopped") return rec; // idempotent
      if (rec.state !== "running" && rec.state !== "paused") break;
      const end = endOf(rec, now);
      return {
        ...base,
        state: "stopped",
        providerSandboxId: rec.providerSandboxId,
        segments: closeSegments(segments, end),
        endedAt: iso(end),
        // Past its deadline the provider stopped it, whatever we were about to do.
        reason: live === "expired" ? "expired" : ev.reason,
      };
    }
    case "lost": {
      if (rec.state === "stopped" || rec.state === "failed") return rec;
      const end = endOf(rec, now);
      return {
        ...base,
        state: "failed",
        providerSandboxId: rec.state === "creating" ? undefined : rec.providerSandboxId,
        segments: closeSegments(segments, end),
        endedAt: iso(end),
        error: ev.error,
      };
    }
  }
  throw new InvalidTransitionError(rec.state, ev.type);
}

/** Checks the invariants the types cannot express (used when loading a ledger from disk). */
export function validateRecord(rec: SandboxRecord): string | undefined {
  if (rec.state === "creating") return undefined;
  const open = rec.segments.filter((s) => !s.end).length;
  if (rec.state === "running" && open !== 1) return "running sandbox must have exactly one open segment";
  if (rec.state !== "running" && open !== 0) return `${rec.state} sandbox cannot have an open segment`;
  if (rec.state === "running" && !rec.expiresAt) return "running sandbox needs expiresAt";
  if ((rec.state === "running" || rec.state === "paused" || rec.state === "stopped") && !rec.providerSandboxId)
    return `${rec.state} sandbox needs providerSandboxId`;
  return undefined;
}
