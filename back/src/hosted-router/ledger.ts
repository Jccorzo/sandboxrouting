// The hosted router's ledger: the router's Ledger (src/core/ledger.ts) on Postgres, one row per
// account in router_ledgers. The same contract as FileLedger: `update` runs its function on fresh
// data under a lock and saves the result whole if it changed.
//
// The lock is the account's row lock (lockAccount), the one every write about an account takes
// first, so the ledger, ingest and the vault never wait on each other in different orders. Under
// it, the caller's authority is checked again: a router key revoked while a create was on its way
// can't record what that create made (the router then deletes the box it can't record).
//
// After a write that changed something, `afterWrite` runs in the same transaction: the hosted
// router applies the changes to the dashboard's tables there, so a rolled-back write leaves no
// trace in them and nothing is left to deliver later.

import type { Db, Queryable } from "../db.js";
import { lockAccount } from "../keys.js";
import { emptyLedger, newOutbox, SandboxRouterError, validateJob, validateRecord, type Ledger, type LedgerData, type OutboxData } from "./from-router.js";

export interface PostgresLedgerHooks {
  /** Under the account's lock: whether this write may go ahead (the caller's key still active). Absent: always. */
  authorized?: (q: Queryable, account: { status: string }) => Promise<boolean>;
  /** In the write's transaction, after `fn` changed the data: `report` is saved with it. */
  afterWrite?: (q: Queryable, data: LedgerData, report: OutboxData) => Promise<void>;
}

/** The install the hosted router reports as, on every account (install ids are 8 to 64 characters). */
export const HOSTED_INSTALL = "ins_hosted";

/** What the hosted router's reports start from: an outbox whose install is HOSTED_INSTALL. */
export const newHostedReport = (): OutboxData => ({ ...newOutbox(), installId: HOSTED_INSTALL });

/** Ledger data as stored, checked the way FileLedger checks its file. */
export function ledgerFrom(raw: unknown, accountId: string): LedgerData {
  if (raw === undefined || raw === null) return emptyLedger();
  const data = (typeof raw === "string" ? JSON.parse(raw) : raw) as LedgerData;
  if (data.version !== 1) throw new Error(`account ${accountId}: unknown ledger version ${String(data.version)}`);
  data.archivedUsd ??= {};
  data.health ??= {};
  data.jobs ??= {};
  data.marks ??= [];
  data.sandboxes ??= {};
  for (const rec of Object.values(data.sandboxes)) {
    const problem = validateRecord(rec);
    if (problem) throw new Error(`account ${accountId}: sandbox ${rec.id}: ${problem}`);
  }
  for (const job of Object.values(data.jobs)) {
    const problem = validateJob(job);
    if (problem) throw new Error(`account ${accountId}: job ${job.id}: ${problem}`);
  }
  return data;
}

export class PostgresLedger implements Ledger {
  constructor(
    private readonly db: Db,
    readonly accountId: string,
    private readonly hooks: PostgresLedgerHooks = {},
  ) {}

  async read(): Promise<LedgerData> {
    const { rows } = await this.db.query<{ data: unknown }>("SELECT data FROM router_ledgers WHERE account_id = $1", [this.accountId]);
    return ledgerFrom(rows[0]?.data, this.accountId);
  }

  update<T>(fn: (data: LedgerData) => T | Promise<T>): Promise<T> {
    return this.db.tx(async (q) => {
      const account = await lockAccount(q, this.accountId);
      if (!account) throw new SandboxRouterError("not_found", `no account ${this.accountId}`);
      if (this.hooks.authorized && !(await this.hooks.authorized(q, account))) {
        throw new SandboxRouterError("invalid", "this key was revoked, or its account disabled, while the request was running");
      }
      const { rows } = await q.query<{ data: unknown; report: unknown }>("SELECT data, report FROM router_ledgers WHERE account_id = $1", [this.accountId]);
      const data = ledgerFrom(rows[0]?.data, this.accountId);
      const before = JSON.stringify(data);
      const out = await fn(data);
      const after = JSON.stringify(data);
      if (after === before) return out;
      const stored = rows[0]?.report;
      const report = stored ? ((typeof stored === "string" ? JSON.parse(stored) : stored) as OutboxData) : newHostedReport();
      await this.hooks.afterWrite?.(q, data, report);
      await q.query(
        `INSERT INTO router_ledgers (account_id, data, report) VALUES ($1, $2::jsonb, $3::jsonb)
         ON CONFLICT (account_id) DO UPDATE SET data = EXCLUDED.data, report = EXCLUDED.report,
           version = router_ledgers.version + 1, updated_at = now()`,
        [this.accountId, after, JSON.stringify(report)],
      );
      return out;
    });
  }
}
