// The schema: migrations only move forward, every status column's CHECK names exactly the
// router's states, and the CHECKs tying columns to a status refuse combinations the router can't
// produce.
import { afterEach, describe, expect, it } from "vitest";
import { closeAll, emptyDb, freshDb } from "./helpers.js";
import { randomBytes } from "node:crypto";
import { MIGRATIONS, MigrationError, checkMigrations, migrate, prepareSchema } from "../src/migrate.js";
import { pgDb } from "../src/db.js";
import type { Db } from "../src/db.js";
import { BILLINGS, ERROR_KINDS, FREE_TIER_KINDS, HEALTH_OPS, JOB_STATES, MARK_KINDS, MIGRATION_REASONS, SANDBOX_STATES, STOP_REASONS } from "../src/router.js";

afterEach(closeAll);

describe("migrations", () => {
  it("apply once, in order, and a second run applies nothing", async () => {
    const db = await emptyDb();
    expect(await migrate(db)).toEqual(MIGRATIONS.map((m) => m.version));
    expect(await migrate(db)).toEqual([]);
  });

  it("refuse a database that ran a migration this code doesn't know", async () => {
    const db = await freshDb();
    await db.query("INSERT INTO schema_migrations (version, name, checksum) VALUES (999, 'from-the-future', 'x')");
    await expect(migrate(db)).rejects.toBeInstanceOf(MigrationError);
  });

  it("refuse a migration edited after the database ran it", async () => {
    const db = await freshDb();
    const edited = MIGRATIONS.map((m) => (m.version === 1 ? { ...m, sql: `${m.sql}\n-- edited` } : m));
    await expect(migrate(db, edited)).rejects.toThrow(/differs/);
  });

  it("run a new migration on a database at the old schema, keeping its rows", async () => {
    const db = await freshDb();
    await db.query("INSERT INTO accounts (name) VALUES ('kept')");
    const next = [...MIGRATIONS, { version: 2, name: "add-column", sql: "ALTER TABLE accounts ADD COLUMN note text" }];
    expect(await migrate(db, next)).toEqual([2]);
    expect((await db.query("SELECT name, note FROM accounts")).rows).toEqual([{ name: "kept", note: null }]);
  });

  it("two instances starting together run each migration once", async () => {
    const db = await emptyDb();
    const [a, b] = await Promise.all([migrate(db), migrate(db)]);
    expect([...a, ...b].sort()).toEqual(MIGRATIONS.map((m) => m.version));
  });
});

describe("a back that doesn't migrate (SBR_MIGRATE_ON_START=0)", () => {
  const off = { SBR_MIGRATE_ON_START: "0" };

  it("sees every migration as pending on an empty database, and changes nothing", async () => {
    const db = await emptyDb();
    expect(await checkMigrations(db)).toEqual(MIGRATIONS.map((m) => m.version));
    expect((await db.query<{ t: string | null }>("SELECT to_regclass('schema_migrations')::text AS t")).rows[0]?.t).toBeNull();
    await expect(prepareSchema(db, off)).rejects.toThrow(/not run yet/);
  });

  it("starts on a database that is up to date, and refuses one with a migration left", async () => {
    const db = await freshDb();
    expect(await prepareSchema(db, off)).toEqual([]);
    const next = [...MIGRATIONS, { version: 2, name: "add-column", sql: "ALTER TABLE accounts ADD COLUMN note text" }];
    expect(await checkMigrations(db, next)).toEqual([2]);
  });

  it("refuses, as migrate does, a migration it doesn't know or one that was edited", async () => {
    const db = await freshDb();
    const edited = MIGRATIONS.map((m) => ({ ...m, sql: `${m.sql}\n-- edited` }));
    await expect(checkMigrations(db, edited)).rejects.toThrow(/differs/);
    await db.query("INSERT INTO schema_migrations (version, name, checksum) VALUES (999, 'from-the-future', 'x')");
    await expect(checkMigrations(db)).rejects.toBeInstanceOf(MigrationError);
  });

  it("works as a role that can't change the schema, where migrate can't", async () => {
    const db = await freshDb();
    const role = `sbr_app_${randomBytes(4).toString("hex")}`;
    await db.exec(`CREATE ROLE ${role} LOGIN PASSWORD '${role}';
      REVOKE CREATE ON SCHEMA public FROM PUBLIC;
      GRANT USAGE ON SCHEMA public TO ${role};
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role};`);
    const url = process.env["TEST_DATABASE_URL"];
    let app: Db = db;
    if (url) {
      const u = new URL(url);
      u.username = role;
      u.password = role;
      u.pathname = `/${(await db.query<{ d: string }>("SELECT current_database() AS d")).rows[0]!.d}`;
      app = pgDb(u.toString(), 1);
    } else {
      await db.exec(`SET ROLE ${role}`); // PGlite: one connection, so the session becomes the role
    }
    try {
      expect(await prepareSchema(app, off)).toEqual([]);
      await expect(migrate(app)).rejects.toThrow(/permission denied/);
    } finally {
      if (url) await app.close();
      else await db.exec("RESET ROLE");
      await db.exec(`DROP OWNED BY ${role}; DROP ROLE ${role}`);
    }
  });
});

/** The values a column's CHECK (… IN (…)) allows, read back from the database. */
async function allowed(db: Db, table: string, column: string): Promise<string[]> {
  const { rows } = await db.query<{ def: string }>(
    `SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
     WHERE t.relname = $1 AND c.contype = 'c'`,
    [table],
  );
  const re = new RegExp(`\\(?\\(?${column}\\)?(?:::text)? = ANY \\(+ARRAY\\[([^\\]]+)\\]`);
  // The constraints tying other columns to a status name subsets; the list of states is the longest.
  let best: string[] | undefined;
  for (const { def } of rows) {
    const m = re.exec(def);
    const values = m ? [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!).sort() : undefined;
    if (values && (!best || values.length > best.length)) best = values;
  }
  if (!best) throw new Error(`no IN-list CHECK on ${table}.${column}`);
  return best;
}

describe("state lists match the router's", () => {
  const cases: [string, string, readonly string[]][] = [
    ["sandboxes", "state", SANDBOX_STATES],
    ["sandboxes", "stop_reason", STOP_REASONS],
    ["sandboxes", "billing", BILLINGS],
    ["marks", "kind", MARK_KINDS],
    ["refusals", "kind", MARK_KINDS],
    ["health_samples", "op", HEALTH_OPS],
    ["health_samples", "kind", ERROR_KINDS],
    ["jobs", "state", JOB_STATES],
    ["jobs", "reason", MIGRATION_REASONS],
  ];
  it.each(cases)("%s.%s", async (table, column, states) => {
    const db = await freshDb();
    expect(await allowed(db, table, column)).toEqual([...states].sort());
  });

  it("install_providers' free tier kinds", async () => {
    const db = await freshDb();
    const { rows } = await db.query<{ def: string }>(
      "SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid WHERE t.relname = 'install_providers' AND c.contype = 'c'",
    );
    const def = rows.map((r) => r.def).find((d) => d.includes("freeTier"))!;
    expect([...def.matchAll(/'([a-z-]+)'::text/g)].map((x) => x[1]!).filter((k) => k !== "freeTier" && k !== "kind").sort()).toEqual([...FREE_TIER_KINDS].sort());
  });
});

describe("impossible rows are unrepresentable", () => {
  async function setup() {
    const db = await freshDb();
    const { rows } = await db.query<{ id: string }>("INSERT INTO accounts (name) VALUES ('a') RETURNING id");
    const account = rows[0]!.id;
    await db.query("INSERT INTO installs (account_id, id) VALUES ($1, 'ins_test_0001')", [account]);
    return { db, account };
  }
  const t = "2026-11-01T00:00:00.000Z";
  const sandbox = (over: Record<string, unknown>) => ({
    state: "running",
    provider_sandbox_id: "p-1",
    expires_at: "2026-11-01T01:00:00.000Z",
    ended_at: null,
    stop_reason: null,
    timeout_sec: null,
    segments: [{ start: t }],
    ...over,
  });
  const insertSandbox = (db: Db, account: string, s: Record<string, unknown>) =>
    db.query(
      `INSERT INTO sandboxes (account_id, id, install_id, provider, state, cpu, memory_mib, created_at, timeout_sec, provider_sandbox_id, expires_at, ended_at, stop_reason, segments, observed_at, seq)
       VALUES ($1, 'sbr_x', 'ins_test_0001', 'a', $2, 1, 1024, $3, $4, $5, $6, $7, $8, $9::jsonb, $3, 1)`,
      [account, s["state"], t, s["timeout_sec"], s["provider_sandbox_id"], s["expires_at"], s["ended_at"], s["stop_reason"], JSON.stringify(s["segments"])],
    );

  it("accepts a well-formed running sandbox", async () => {
    const { db, account } = await setup();
    await insertSandbox(db, account, sandbox({}));
  });

  it.each([
    ["running without a deadline", { expires_at: null }],
    ["running with no open segment", { segments: [{ start: t, end: t }] }],
    ["running with two open segments", { segments: [{ start: t }, { start: t }] }],
    ["paused with an open segment", { state: "paused" }],
    ["stopped without a reason", { state: "stopped", expires_at: null, segments: [{ start: t, end: t }], ended_at: t }],
    ["stopped without an end", { state: "stopped", expires_at: null, segments: [{ start: t, end: t }], stop_reason: "killed" }],
    ["failed with a stop reason", { state: "failed", expires_at: null, segments: [], ended_at: t, stop_reason: "killed" }],
    ["creating with a box", { state: "creating", expires_at: null, segments: [] }],
    ["running with a create timeout", { timeout_sec: 60 }],
    ["an unknown state", { state: "expired" }],
  ])("refuses a sandbox %s", async (_name, over) => {
    const { db, account } = await setup();
    await expect(insertSandbox(db, account, sandbox(over))).rejects.toThrow(/check constraint/i);
  });

  it.each([
    ["an active job without a lease", "running", null, null, '{"sandboxId":"s","provider":"a"}', null],
    ["a finished job without an end", "succeeded", null, null, null, null],
    ["a migrating job without a reason", "migrating", t, null, null, null],
    ["a queued job with a box", "queued", null, null, '{"sandboxId":"s","provider":"a"}', null],
    ["a queued job with a lease", "queued", t, null, null, null],
  ])("refuses %s", async (_name, state, lease, ended, box, reason) => {
    const { db, account } = await setup();
    await expect(
      db.query(
        `INSERT INTO jobs (account_id, id, install_id, state, version, cursor, steps, migrations, created_at, updated_at, ended_at, lease_until, box, reason, placements, observed_at, seq)
         VALUES ($1, 'job_x', 'ins_test_0001', $2, 1, 0, 1, 0, $3, $3, $4, $5, $6::jsonb, $7, '[]', $3, 1)`,
        [account, state, t, ended, lease, box, reason],
      ),
    ).rejects.toThrow(/check constraint/i);
  });

  it("refuses a revoked key without a revocation time, a set mark without its until, and a disabled account without a time", async () => {
    const { db, account } = await setup();
    await expect(db.query("INSERT INTO api_keys (account_id, name, scope, prefix, hash, state) VALUES ($1, 'k', 'admin', 'p', '\\x01', 'revoked')", [account])).rejects.toThrow(/check/i);
    await expect(
      db.query("INSERT INTO marks (account_id, install_id, provider, kind, status, at, observed_at, seq) VALUES ($1, 'ins_test_0001', 'a', 'quota', 'set', now(), now(), 1)", [account]),
    ).rejects.toThrow(/check/i);
    await expect(db.query("UPDATE accounts SET status = 'disabled' WHERE id = $1", [account])).rejects.toThrow(/check/i);
    await expect(
      db.query("INSERT INTO usage_events (account_id, kind, quantity, status) VALUES ($1, 'events.ingested', 1, 'delivering')", [account]),
    ).rejects.toThrow(/check/i);
  });
});
