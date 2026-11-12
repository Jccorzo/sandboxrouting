// SDK entry point.
//
//   import { createRouter } from "sandboxrouting";
//   const router = await createRouter();
//   const sbx = await router.create({ timeoutSec: 600 });
//   const r = await sbx.commands.run("echo hi");
//   await sbx.kill();

export { SandboxRouter, createRouter, type RouterOptions, type ProviderStatus, type SandboxView } from "./core/router.js";
export { Sandbox } from "./core/sandbox.js";
export { loadConfig, parseConfig, configSchema, type RouterConfig, type ProviderConfig } from "./core/config.js";
export { FileLedger, MemoryLedger, type Ledger, type LedgerData, type ProviderMark } from "./core/ledger.js";
export { SandboxRouterError, NoProviderAvailableError, classify, type ErrorKind, type RouteAttempt } from "./core/errors.js";
export { freeStatus, availability, monthWindow, type FreeStatus } from "./core/metering.js";
export { plan, type Plan, type PlanEntry, type Lane } from "./core/policy.js";
export { effectiveState, transition, type SandboxState, type EffectiveState, type SandboxRecord } from "./core/state.js";
export type * from "./core/types.js";
export { defineProvider } from "./providers/util.js";
export * from "./providers/index.js";
export { createServer } from "./server/http.js";
export { createMcpServer } from "./mcp/server.js";
