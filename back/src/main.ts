// Starts back from environment variables only:
//
//   DATABASE_URL       postgres://… (required), or pglite:<dir> / pglite:memory for a local try
//   PORT, HOST         default 8787, 0.0.0.0
//   SBR_ADMIN_TOKEN    optional: an admin key for the first account (self-hosting), ≥ 24 chars
//   SBR_INGEST_TOKEN   optional: an ingest key for the first account, ≥ 24 chars
//   SBR_SWEEP_TOKEN    optional: lets a cron trigger call POST /v1/sweep for every account
//   SBR_MIGRATE_ON_START  "0": don't migrate, only check, and refuse to start while a migration is
//                      pending (for a role that can't change the schema; `cli migrate` runs them)
//   DATABASE_POOL_MAX  connections this process opens at most (default 10)
//
// Migrations run at startup unless SBR_MIGRATE_ON_START=0. Nothing runs in the background: scale-to-zero hosting works.

import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { openDb } from "./db.js";
import { bootstrap } from "./keys.js";
import { MigrationError, prepareSchema } from "./migrate.js";

const env = process.env;
const url = env["DATABASE_URL"];
if (!url) {
  console.error("back: DATABASE_URL is required (postgres://…, or pglite:memory to try it out)");
  process.exit(1);
}

const db = await openDb(url);
let applied: number[];
try {
  applied = await prepareSchema(db);
} catch (err) {
  if (!(err instanceof MigrationError)) throw err;
  console.error(`back: ${err.message}`);
  await db.close();
  process.exit(1);
}
if (applied.length) console.log(`back: applied migration${applied.length === 1 ? "" : "s"} ${applied.join(", ")}`);
await bootstrap(db, { admin: env["SBR_ADMIN_TOKEN"], ingest: env["SBR_INGEST_TOKEN"] });

const app = createApp({ db, sweepToken: env["SBR_SWEEP_TOKEN"] || undefined });
const port = Number(env["PORT"] ?? 8787);
const server = serve({ fetch: app.fetch, port, hostname: env["HOST"] ?? "0.0.0.0" }, (info) => console.log(`back: listening on :${info.port}`));

const stop = () => {
  server.close(() => void db.close().finally(() => process.exit(0)));
  setTimeout(() => process.exit(0), 10_000).unref();
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
