// Marks on providers after a refusal: free credit used up (quota, a 402), rate limited (a 429) or
// a bad key (401/403). Every mark is in force until its `until`, evaluated on read, so nothing has
// to clear it then. A quota mark also has a lifecycle, decided here and nowhere else (see
// docs/routing.md, "Refusals and marks"):
//
//   refused ──its until passes──▶ half-open ──a free create works──▶ (no mark)
//      ▲                              │
//      └───────another refusal────────┘
//
// While refused, free usage can't take requests. Half-open lets one free create at a time check
// whether the free tier is back, the way the circuit breaker lets one probe through: the others
// skip the free tier while that probe is in flight, instead of joining the same refusal. The
// lapsed mark stays in the ledger until a free create works, so the next refusal knows it is a
// repeat. A free tier that no monthly reset brings back is then asked again after 1, 2 and 4
// days, and once a week after that.

import type { ErrorKind } from "./errors.js";
import type { LedgerData, MarkKind, ProviderMark } from "./ledger.js";

const DAY = 86_400_000;
/** The first quota refusal a monthly reset doesn't explain is checked again after this, doubling with each repeat. */
const QUOTA_RECHECK_MS = DAY;
const QUOTA_RECHECK_MAX_MS = 7 * DAY;
const RATE_LIMIT_MS = 60_000;
const AUTH_MS = 10 * 60_000;

type QuotaMark = Extract<ProviderMark, { kind: "quota" }>;
type BlockingMark = Extract<ProviderMark, { kind: "rate_limit" | "auth" }>;

export type Availability = { ok: true } | { ok: false; reason: string; until: number; kind: "rate_limit" | "auth" };

/** The mark an error leaves on its provider: refusals get one, other errors don't. */
export function refusalKind(kind: ErrorKind): MarkKind | undefined {
  return kind === "quota" || kind === "rate_limit" || kind === "auth" ? kind : undefined;
}

/** Marks still in force for a provider. A mark past `until` simply stops counting. */
export function activeMarks(data: LedgerData, provider: string, now: number): ProviderMark[] {
  return data.marks.filter((m) => m.provider === provider && Date.parse(m.until) > now);
}

/** A rate-limit or auth mark in force keeps the provider out of every plan. */
export function availability(data: LedgerData, provider: string, now: number): Availability {
  const blocking = activeMarks(data, provider, now).find((m): m is BlockingMark => m.kind === "rate_limit" || m.kind === "auth");
  if (!blocking) return { ok: true };
  return { ok: false, kind: blocking.kind, until: Date.parse(blocking.until), reason: blocking.detail ?? blocking.kind };
}

export type QuotaState =
  | { state: "ok" }
  /** Free usage can't take requests until `until`. */
  | { state: "refused"; until: number; refusals: number; reason: string }
  /** The mark lapsed at `since` and no free create has worked since: one at a time may check. */
  | { state: "half-open"; since: number; refusals: number };

/** Where a provider's free tier stands after its last quota refusal. Derived on read. */
export function quotaState(data: LedgerData, provider: string, now: number): QuotaState {
  const mark = quotaMark(data, provider);
  if (!mark) return { state: "ok" };
  const until = Date.parse(mark.until);
  const refusals = mark.refusals ?? 1;
  if (now < until) return { state: "refused", until, refusals, reason: mark.detail ?? "provider reported its quota used up" };
  return { state: "half-open", since: until, refusals };
}

/**
 * A half-open free tier's probe: a free create on it, started since the mark lapsed, still
 * creating. A create from before the lapse isn't the probe, and neither is a paid one.
 */
export function quotaProbeInFlight(data: LedgerData, provider: string, since: number): boolean {
  return Object.values(data.sandboxes).some(
    (r) => r.provider === provider && r.state === "creating" && r.billing === "free" && Date.parse(r.createdAt) >= since,
  );
}

/**
 * Records a refusal; the caller holds the ledger lock. Returns when the provider's mark lapses.
 * For a quota refusal on a monthly free tier, `resetsAt` is when the tier comes back.
 *
 * A quota refusal while the quota mark is in force changes nothing: it comes from a create
 * already in flight when the mark was set, or from a call on a box, and says what the mark
 * already says. One after the mark lapsed is a repeat, and is checked again later than the last.
 */
export function markRefusal(data: LedgerData, r: { provider: string; kind: MarkKind; detail: string; now: number; resetsAt?: number }): number {
  const { provider, kind, detail, now } = r;
  const at = new Date(now).toISOString();
  let mark: ProviderMark;
  if (kind === "quota") {
    const prev = quotaMark(data, provider);
    if (prev && Date.parse(prev.until) > now) return Date.parse(prev.until);
    const refusals = prev ? (prev.refusals ?? 1) + 1 : 1;
    const until = r.resetsAt ?? now + Math.min(QUOTA_RECHECK_MS * 2 ** (refusals - 1), QUOTA_RECHECK_MAX_MS);
    mark = { provider, kind, at, until: new Date(until).toISOString(), detail, refusals };
  } else {
    mark = { provider, kind, at, until: new Date(now + (kind === "rate_limit" ? RATE_LIMIT_MS : AUTH_MS)).toISOString(), detail };
  }
  // A lapsed rate-limit or auth mark says nothing any more; a lapsed quota mark is the half-open state.
  data.marks = data.marks.filter((m) => (m.kind === "quota" || Date.parse(m.until) > now) && !(m.provider === provider && m.kind === kind));
  data.marks.push(mark);
  return Date.parse(mark.until);
}

/**
 * A free create on `provider` worked; the caller holds the ledger lock, in the write that records
 * it. A half-open free tier is back, so its lapsed mark goes. A mark still in force stays.
 */
export function freeCreateWorked(data: LedgerData, provider: string, now: number): void {
  data.marks = data.marks.filter((m) => !(m.provider === provider && m.kind === "quota" && Date.parse(m.until) <= now));
}

function quotaMark(data: LedgerData, provider: string): QuotaMark | undefined {
  return data.marks.find((m): m is QuotaMark => m.provider === provider && m.kind === "quota");
}
