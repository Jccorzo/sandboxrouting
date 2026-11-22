// The database: Postgres through `pg` in production, or PGlite (Postgres compiled to WASM) for
// tests and a no-setup local run. Both speak the same SQL; back only uses this interface.

import pg from "pg";

export interface Result<R> {
  rows: R[];
  rowCount: number;
}

export interface Queryable {
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<Result<R>>;
  /** Several statements, no parameters (migrations). */
  exec(sql: string): Promise<void>;
}

export type Isolation = "read committed" | "repeatable read" | "serializable";

export interface Db extends Queryable {
  /** Runs `fn` in one transaction: committed if it returns, rolled back if it throws. */
  tx<T>(fn: (q: Queryable) => Promise<T>, opts?: { isolation?: Isolation; readOnly?: boolean }): Promise<T>;
  close(): Promise<void>;
}

const begin = (opts: { isolation?: Isolation; readOnly?: boolean } = {}) =>
  `BEGIN ISOLATION LEVEL ${(opts.isolation ?? "read committed").toUpperCase()}${opts.readOnly ? " READ ONLY" : ""}`;

export function pgDb(connectionString: string, max = Number(process.env["DATABASE_POOL_MAX"] ?? 10)): Db {
  // Dates come back as text so nothing turns a calendar day into a local midnight.
  pg.types.setTypeParser(1082, (v: string) => v);
  const pool = new pg.Pool({ connectionString, max });
  const wrap = (c: pg.Pool | pg.PoolClient): Queryable => ({
    async query<R>(sql: string, params?: unknown[]) {
      const r = await c.query(sql, params as unknown[]);
      return { rows: r.rows as R[], rowCount: r.rowCount ?? 0 };
    },
    async exec(sql: string) {
      await c.query(sql);
    },
  });
  return {
    ...wrap(pool),
    async tx(fn, opts) {
      const client = await pool.connect();
      try {
        await client.query(begin(opts));
        const out = await fn(wrap(client));
        await client.query("COMMIT");
        return out;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

/** PGlite in memory (no `dataDir`) or on disk. Loaded only when asked for: it's a dev dependency. */
export async function pgliteDb(dataDir?: string): Promise<Db> {
  const { PGlite, types } = await import("@electric-sql/pglite");
  const db = await PGlite.create(dataDir, { parsers: { [types.DATE]: (v: string) => v } });
  type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
  const wrap = (c: typeof db | Tx): Queryable => ({
    async query<R>(sql: string, params?: unknown[]) {
      const r = await c.query<R>(sql, params as unknown[]);
      return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
    },
    async exec(sql: string) {
      await c.exec(sql);
    },
  });
  return {
    ...wrap(db),
    async tx(fn, opts) {
      // PGlite has one connection; its transaction() queues everything else behind this one.
      return db.transaction(async (t) => {
        await t.query(`SET TRANSACTION ISOLATION LEVEL ${(opts?.isolation ?? "read committed").toUpperCase()}${opts?.readOnly ? " READ ONLY" : ""}`);
        return fn(wrap(t));
      });
    },
    close: () => db.close(),
  };
}

/**
 * `DATABASE_URL`: a postgres:// URL, or `pglite:<dir>` / `pglite:memory` for PGlite (needs the
 * @electric-sql/pglite package, a dev dependency).
 */
export async function openDb(url: string): Promise<Db> {
  if (url.startsWith("pglite:")) {
    const dir = url.slice("pglite:".length);
    return pgliteDb(dir === "memory" || dir === "" ? undefined : dir);
  }
  return pgDb(url);
}

/** A timestamp column as the ISO string the router's functions take. */
export function iso(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "string") return new Date(v).toISOString();
  throw new Error(`not a timestamp: ${String(v)}`);
}

export function isoOrUndefined(v: unknown): string | undefined {
  return v === null || v === undefined ? undefined : iso(v);
}
