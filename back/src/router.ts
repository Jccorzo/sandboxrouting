// The one place back imports the router (../../src, the `sandboxrouting` package's source). back
// keeps no copy of the router's states or formulas: effective state, billable time, spend, free
// usage left, health and the circuit breaker, marks and the job lifecycle are the router's own
// functions, called here with the database's clock. When the router moves to router/ (npm
// workspaces), only these paths change.

export {
  effectiveState,
  isLive,
  validateRecord,
  type EffectiveState,
  type SandboxRecord,
  type SandboxState,
} from "../../src/core/state.js";
export {
  billableSeconds,
  freeStatus,
  monthWindow,
  paidSpendThisMonth,
  ratePerSecond,
  spend,
  type FreeStatus,
  type Window,
} from "../../src/core/metering.js";
export { providerHealth } from "../../src/core/health.js";
export { activeMarks, availability, quotaState, type Availability, type QuotaState } from "../../src/core/marks.js";
export { effectiveJobState } from "../../src/core/jobs/state.js";
export type { EffectiveJobState, JobRecord, JobState, MigrationReason } from "../../src/core/jobs/types.js";
export type { HealthSample, LedgerData, MarkKind, ProviderMark } from "../../src/core/ledger.js";
export type { ProviderHealth } from "../../src/core/routing/types.js";
export type { ProviderConfig } from "../../src/core/config.js";
export type { FreeTier, Pricing, ProviderInfo } from "../../src/core/types.js";
export * from "../../src/report/wire.js";
