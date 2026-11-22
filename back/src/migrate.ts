// Schema migrations, run at startup (or, with SBR_MIGRATE_ON_START=0, checked there and run by
// `cli migrate` as the database's owner). Forward only: each runs once, in order, in one transaction
// with the record that it ran, under an advisory lock so two instances starting together don't
// both run it. A database that ran a migration this code doesn't know (newer code ran against
// it), or one whose recorded migration differs from this code's, stops startup instead of
// being "fixed".

import { createHash } from "node:crypto";
import type { Db } from "./db.js";
import * as m0001 from "./migrations/0001_init.js";

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [{ version: 1, name: m0001.name, sql: m0001.sql }];

/** Any 64-bit number unique to this purpose. */
const MIGRATION_LOCK = 7_270_720_001;

const checksum = (sql: string) => createHash("sha256").update(sql).digest("hex");

export class MigrationError extends Error {
  override name = "MigrationError";
}

type Queryable = Parameters<Parameters<Db["tx"]>[0]>[0];
interface Recorded {
  version: number;
  name: string;
  checksum: string;
}

/**
 * Checks what the database ran against this code's migrations: refuses one it doesn't know or
 * one that was edited, and returns the versions not run yet, in order.
 */
function pending(rows: readonly Recorded[], migrations: readonly Migration[]): Migration[] {
  const known = new Map(migrations.map((m) => [m.version, m]));
  for (const row of rows) {
    const m = known.get(row.version);
    if (!m) {
      throw new MigrationError(
        `the database has migration ${row.version} (${row.name}), which this back doesn't know: a newer version ran against it. Run that version or newer.`,
      );
    }
    if (checksum(m.sql) !== row.checksum) {
      throw new MigrationError(`migration ${row.version} (${row.name}) differs from the one the database ran. Migrations are never edited: add a new one.`);
    }
  }
  const done = new Set(rows.map((r) => r.version));
  return [...migrations].sort((a, b) => a.version - b.version).filter((m) => !done.has(m.version));
}

const recorded = (q: Queryable) => q.query<Recorded>("SELECT version, name, checksum FROM schema_migrations ORDER BY version").then((r) => r.rows);

/** Brings the schema up to date. Returns the versions it applied. */
export async function migrate(db: Db, migrations: readonly Migration[] = MIGRATIONS): Promise<number[]> {
  return db.tx(async (q) => {
    await q.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK]);
    await q.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version integer PRIMARY KEY CHECK (version > 0),
      name text NOT NULL,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const applied: number[] = [];
    for (const m of pending(await recorded(q), migrations)) {
      await q.exec(m.sql);
      await q.query("INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)", [m.version, m.name, checksum(m.sql)]);
      applied.push(m.version);
    }
    return applied;
  });
}

/**
 * The versions this code would apply, without changing anything: for a back that logs in as a
 * role that can't change the schema (SBR_MIGRATE_ON_START=0), where the database's owner runs
 * `cli migrate` before each rollout. Refuses, as migrate does, a database this code can't serve.
 */
export async function checkMigrations(db: Db, migrations: readonly Migration[] = MIGRATIONS): Promise<number[]> {
  return db.tx(
    async (q) => {
      const { rows } = await q.query<{ exists: boolean }>("SELECT to_regclass('schema_migrations') IS NOT NULL AS exists");
      const ran = rows[0]?.exists ? await recorded(q) : [];
      return pending(ran, migrations).map((m) => m.version);
    },
    { readOnly: true },
  );
}

/** SBR_MIGRATE_ON_START: on unless "0". Off, back and the CLI only check (checkMigrations). */
export const migrateOnStart = (env: NodeJS.ProcessEnv = process.env) => env["SBR_MIGRATE_ON_START"] !== "0";

/**
 * What a process does with the schema before it serves: migrate, or with SBR_MIGRATE_ON_START=0
 * check and refuse to go on while anything is pending.
 */
export async function prepareSchema(db: Db, env: NodeJS.ProcessEnv = process.env): Promise<number[]> {
  if (migrateOnStart(env)) return migrate(db);
  const left = await checkMigrations(db);
  if (left.length) {
    throw new MigrationError(
      `migration${left.length === 1 ? "" : "s"} ${left.join(", ")} not run yet, and SBR_MIGRATE_ON_START=0: run "node back/dist/cli.js migrate" as the database's owner first.`,
    );
  }
  return [];
}
