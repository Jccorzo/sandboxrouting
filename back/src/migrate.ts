// Schema migrations, run at startup. Forward only: each runs once, in order, in one transaction
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
    const { rows } = await q.query<{ version: number; name: string; checksum: string }>("SELECT version, name, checksum FROM schema_migrations ORDER BY version");
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
    const applied: number[] = [];
    for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
      if (done.has(m.version)) continue;
      await q.exec(m.sql);
      await q.query("INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)", [m.version, m.name, checksum(m.sql)]);
      applied.push(m.version);
    }
    return applied;
  });
}
