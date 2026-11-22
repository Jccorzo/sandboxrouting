// The seam to sandboxrouting itself. Inside this repository it is the SDK's own source; in AgentRun's repository it
// becomes the npm package, loaded lazily and pinned exactly as AgentRun loads every vendor SDK (PROVIDERS.md,
// "Wire it up": a constant like E2B_PACKAGE, which test/vendor-sdks.test.mjs checks), so these lines are the only
// ones that change there.
export type { Capability, Isolation, RouteAttempt, RouterConfig, SandboxSpec, SandboxView } from "../index.js";
export { NoProviderAvailableError, SandboxRouter, SandboxRouterError } from "../index.js";

/** The router wired from the environment (config file, on-disk ledger, every built-in provider), loaded on first use. */
export async function loadRouterKit() {
  const { createRouter, loadConfig, parseConfig } = await import("../index.js");
  return { createRouter, loadConfig, parseConfig };
}
