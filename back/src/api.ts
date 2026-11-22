// What back's read API answers: the dashboard imports these types (`@sandboxrouting/back/api`)
// and renders them as they are. Every derived value (effective state, spend, free usage left,
// health, the circuit breaker) is computed by back with the database's clock; the dashboard
// computes none of them.

import type { Availability, EffectiveJobState, EffectiveState, FreeStatus, ProviderHealth, QuotaState } from "./router.js";

export type { Availability, EffectiveJobState, EffectiveState, FreeStatus, ProviderHealth, QuotaState };

/** Every answer carries the database time it was computed at (ISO). */
export interface Timed {
  now: string;
}

export interface Me extends Timed {
  account: { id: string; name: string };
  key: { id: string; scope: "ingest" | "admin" };
}

export interface InstallView {
  id: string;
  firstSeenAt: string;
  lastSeenAt: string;
  routerVersion: string | null;
}

/** Usage on one UTC day for one provider of one install. */
export interface UsagePoint {
  day: string; // YYYY-MM-DD
  install: string;
  provider: string;
  /** Sandboxes that ran at some point that day. */
  sandboxes: number;
  sandboxHours: number;
  /** Memory held while running: memoryMiB / 1024 × hours. */
  gibHours: number;
  /** USD at the install's prices for the provider; null when back has no prices for it yet. */
  usd: number | null;
}

export interface UsageView extends Timed {
  days: number;
  from: string; // YYYY-MM-DD, first day
  installs: InstallView[];
  points: UsagePoint[];
  totals: { sandboxes: number; live: number; sandboxHours: number; gibHours: number; usd: number; usdUnknown: boolean };
  /** Days served from the sweep's rollups (the rest were computed live). For diagnostics. */
  rolledUpDays: number;
}

export interface MarkView {
  install: string;
  provider: string;
  kind: "quota" | "rate_limit" | "auth";
  at: string;
  until: string;
  refusals: number | null;
  /** Derived now: in force until `until`; a quota mark past it is half-open until a free create works. */
  standing: "in-force" | "half-open" | "lapsed";
}

export interface ProviderView {
  install: string;
  provider: string;
  name: string;
  selfHosted: boolean;
  enabled: boolean;
  configured: boolean;
  free: FreeStatus;
  monthUsd: number;
  paidMonthUsd: number;
  live: number;
  concurrency: number | null;
  availability: Availability;
  quota: QuotaState;
  health: ProviderHealth;
  marks: MarkView[];
  observedAt: string;
}

export interface ProvidersView extends Timed {
  installs: InstallView[];
  providers: ProviderView[];
}

export interface SandboxView {
  id: string;
  install: string;
  provider: string;
  state: EffectiveState;
  cpu: number;
  memoryMiB: number;
  billing: "free" | "self-hosted" | "paid" | null;
  createdAt: string;
  expiresAt: string | null;
  endedAt: string | null;
  reason: "killed" | "expired" | "gone" | null;
  sandboxHours: number;
  gibHours: number;
  costUsd: number | null;
  metadata: Record<string, string>;
  observedAt: string;
}

export interface SandboxesView extends Timed {
  view: "live" | "recent";
  sandboxes: SandboxView[];
}

export interface JobMove {
  at: string;
  fromProvider: string;
  fromSandbox: string;
  toProvider: string | null;
  toSandbox: string | null;
  reason: string;
}

export interface JobView {
  id: string;
  install: string;
  state: EffectiveJobState;
  cursor: number;
  steps: number;
  migrations: number;
  provider: string | null;
  sandboxId: string | null;
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
  leaseUntil: string | null;
  reason: string | null;
  placements: { sandboxId: string; provider: string; lane: string | null; billing: string | null; placedAt: string; endedAt: string | null; endReason: string | null }[];
  moves: JobMove[];
}

export interface JobsView extends Timed {
  jobs: JobView[];
}

export interface RefusalView {
  install: string;
  provider: string;
  kind: "quota" | "rate_limit" | "auth";
  at: string;
  until: string;
  refusals: number | null;
}

export interface FailedCreateDay {
  day: string;
  provider: string;
  /** Creates that failed on this provider; the router then tried the next one. */
  count: number;
}

export interface RefusalsView extends Timed {
  days: number;
  inForce: MarkView[];
  refusals: RefusalView[];
  failedCreates: FailedCreateDay[];
  /** Health failures (transient errors, boxes lost early) per day and provider. */
  infraFailures: FailedCreateDay[];
}

export type KeyView =
  | { id: string; name: string; scope: "ingest" | "admin"; prefix: string; state: "active"; createdAt: string; lastUsedAt: string | null }
  | { id: string; name: string; scope: "ingest" | "admin"; prefix: string; state: "revoked"; createdAt: string; revokedAt: string; lastUsedAt: string | null };

export interface KeysView extends Timed {
  keys: KeyView[];
}

export interface CreatedKey {
  key: KeyView;
  /** Shown once; back keeps only its hash. */
  token: string;
}

/** Errors are `{ error: { code, message } }`, with the HTTP status saying the class. */
export interface ApiError {
  error: { code: string; message: string; key?: KeyView };
}
