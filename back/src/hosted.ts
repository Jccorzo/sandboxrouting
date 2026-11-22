// The hosted router's catalog, config rules and strategies, from the router's sources. Kept apart
// from router.ts because the catalog loads provider adapters, and api.ts (which the dashboard
// imports for its types) must not reach them.
export { HOSTED_CATALOG, catalogEntry, checkCredentials, credentialHints } from "../../src/hosted/catalog.js";
export { checkHostedConfig } from "../../src/hosted/config.js";
export { builtinStrategies } from "../../src/core/routing/strategies.js";
