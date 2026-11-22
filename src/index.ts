// SDK entry point.
//
//   import { createRouter } from "sandboxrouting";
//   const router = await createRouter();
//   const sbx = await router.create({ timeoutSec: 600 });
//   const r = await sbx.commands.run("echo hi");
//   await sbx.kill();
//
//   // Work that survives a box dying or running out: see docs/routing.md.
//   await router.jobs.run({ steps: [{ run: "make" }, { run: "make test" }] });

export { SandboxRouter, createRouter, type RouterOptions, type ProviderStatus, type SandboxView } from "./core/router.js";
export { Sandbox } from "./core/sandbox.js";
export { loadConfig, parseConfig, configSchema, strategyNameFor, type RouterConfig, type ProviderConfig, type RoutingConfig, type JobPolicy } from "./core/config.js";
export { FileLedger, MemoryLedger, type Ledger, type LedgerData, type ProviderMark, type HealthSample } from "./core/ledger.js";
export { SandboxRouterError, NoProviderAvailableError, ConflictError, classify, type ErrorKind, type RouteAttempt } from "./core/errors.js";
export { freeStatus, monthWindow, type FreeStatus } from "./core/metering.js";
export { availability, quotaState, type Availability, type QuotaState } from "./core/marks.js";
export { plan, eligibility, type Plan, type PlanEntry, type Lane } from "./core/policy.js";
export type { Billing, Candidate, ProviderHealth, RoutingContext, RoutingStrategy, StrategyResult } from "./core/routing/types.js";
export { StrategyRegistry } from "./core/routing/registry.js";
export { builtinStrategies } from "./core/routing/strategies.js";
export { providerHealth } from "./core/health.js";
export { effectiveState, transition, type SandboxState, type EffectiveState, type SandboxRecord } from "./core/state.js";
export { effectiveJobState, checkJobSpec } from "./core/jobs/state.js";
export { JobManager } from "./core/jobs/manager.js";
export { FileCheckpointStore, MemoryCheckpointStore } from "./core/jobs/checkpoint.js";
export { moveSandbox } from "./core/jobs/move.js";
export type * from "./core/jobs/types.js";
export type * from "./core/types.js";
export { ISOLATION_STRENGTH, SANDBOX_OS } from "./core/types.js";
export { defineProvider } from "./providers/util.js";
export * from "./providers/index.js";
export { createServer } from "./server/http.js";
export { createMcpServer } from "./mcp/server.js";
export { reportingLedger, ReportingLedger, Reporter, FileOutbox, MemoryOutbox, type ReportStatus, type Outbox } from "./report/index.js";
