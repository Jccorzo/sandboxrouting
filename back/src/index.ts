// back as a library, for a private package that adds billing, teams or abuse controls without
// forking: createApp with its own plugins, the same database and migrations.
export { createApp, type AppOptions } from "./app.js";
export { openDb, pgDb, pgliteDb, type Db, type Queryable } from "./db.js";
export { migrate, MIGRATIONS, MigrationError, type Migration } from "./migrate.js";
export { sweep, rollupAccount, type SweepResult } from "./sweep.js";
export { bootstrap, createAccount, apiKeyAuth } from "./keys.js";
export { defaultAuth, sessionAuth, signIn, revokeSession } from "./sessions.js";
export { exchangeCode, GitHubError, type GitHubConfig, type GitHubUser } from "./github.js";
export { allowEverything, type Newcomer, type AuthProvider, type BackPlugins, type Entitlements, type Principal, type Scope, type Action, type Decision, type UsageEvent } from "./plugins.js";
export type * from "./api.js";
