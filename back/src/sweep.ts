// The sweep: what a cron trigger calls (POST /v1/sweep), so nothing needs an always-on process.
// Nothing depends on it for correctness: every read derives its values on read, and days the
// sweep hasn't rolled up are computed live by the same function. It makes reads cheaper, and
// converges what a crash or a slow hook left: usage events not yet delivered.
//
// Rollups per account move a watermark forward:
//   rolled_through: the last UTC day whose rollup is complete.
//   rollup_dirty_from: set by ingest to the earliest created_at of a sandbox (or provider price)
//     that changed since; days from then on read live until re-rolled.
// A rollup is computed outside any lock, then committed only if the account's change_seq is
// what it was when the rows were read (compare-and-set); otherwise it is dropped and the next
// sweep tries again.

import type { Db } from "./db.js";
import { iso } from "./db.js";
import { DAY_MS, dayKey, dayWindow, dbNow, pricingKey, usageForDays } from "./derive.js";
import { sandboxesOverlapping } from "./reads.js";
import type { Pricing, WireProvider } from "./router.js";
import type { ResolvedPlugins } from "./plugins.js";
import { deliverUsage } from "./usage.js";

/** Most days one account rolls up per sweep, so one call stays short; the next continues. */
const MAX_DAYS = 120;
const EVENT_RETENTION = "30 days";
const HEALTH_RETENTION = "30 days";

export interface SweepResult {
  accounts: number;
  daysRolledUp: number;
  rollupsRetried: number;
  eventsPruned: number;
  healthPruned: number;
  usageDelivered: number;
}

export type RollupOutcome = { outcome: "rolled"; days: number } | { outcome: "nothing-to-do" } | { outcome: "changed-meanwhile" };

export async function rollupAccount(db: Db, accountId: string): Promise<RollupOutcome> {
  const plan = await db.tx(
    async (q) => {
      const now = await dbNow(q);
      const { rows } = await q.query<{ change_seq: string | number; rollup_dirty_from: Date | null; rolled_through: string | null }>(
        "SELECT change_seq, rollup_dirty_from, rolled_through FROM accounts WHERE id = $1",
        [accountId],
      );
      const acct = rows[0];
      if (!acct) return undefined;
      const lastClosed = dayKey(now - DAY_MS); // today isn't over
      let start: string;
      if (acct.rolled_through) {
        const next = dayKey(Date.parse(`${acct.rolled_through}T00:00:00Z`) + DAY_MS);
        const dirty = acct.rollup_dirty_from ? dayKey(Date.parse(iso(acct.rollup_dirty_from))) : undefined;
        start = dirty && dirty < next ? dirty : next;
      } else {
        const { rows: first } = await q.query<{ first: Date | null }>("SELECT min(created_at) AS first FROM sandboxes WHERE account_id = $1", [accountId]);
        start = first[0]?.first ? dayKey(Date.parse(iso(first[0].first))) : lastClosed;
      }
      if (start > lastClosed) return undefined;
      const days: string[] = [];
      for (let t = Date.parse(`${start}T00:00:00Z`); days.length < MAX_DAYS && dayKey(t) <= lastClosed; t += DAY_MS) days.push(dayKey(t));
      const rows2 = await sandboxesOverlapping(q, accountId, dayWindow(days[0]!).from, dayWindow(days.at(-1)!).to);
      const { rows: snaps } = await q.query<{ install_id: string; snapshot: WireProvider }>("SELECT install_id, snapshot FROM install_providers WHERE account_id = $1", [accountId]);
      const pricing = new Map<string, Pricing>(snaps.map((s) => [pricingKey(s.install_id, s.snapshot.id), s.snapshot.pricing]));
      return { changeSeq: String(acct.change_seq), days, points: usageForDays(rows2, pricing, days, now), reachedEnd: days.at(-1) === lastClosed };
    },
    { isolation: "repeatable read", readOnly: true },
  );
  if (!plan) return { outcome: "nothing-to-do" };

  return db.tx(async (q) => {
    const last = plan.days.at(-1)!;
    // Up to the last closed day, nothing rolled is dirty any more. A partial run (MAX_DAYS) moves
    // the dirty mark past what it just rolled, so the next sweep continues instead of redoing it.
    const { rows } = await q.query(
      `UPDATE accounts SET rolled_through = $3::date,
         rollup_dirty_from = CASE
           WHEN $4::boolean OR rollup_dirty_from IS NULL THEN NULL
           ELSE GREATEST(rollup_dirty_from, ($3::date + 1)::timestamp AT TIME ZONE 'UTC') END
       WHERE id = $1 AND change_seq = $2::bigint RETURNING 1`,
      [accountId, plan.changeSeq, last, plan.reachedEnd],
    );
    if (!rows.length) return { outcome: "changed-meanwhile" } as const;
    await q.query("DELETE FROM usage_daily WHERE account_id = $1 AND day BETWEEN $2::date AND $3::date", [accountId, plan.days[0], last]);
    for (const p of plan.points) {
      await q.query(
        `INSERT INTO usage_daily (account_id, day, install_id, provider, sandboxes, sandbox_seconds, gib_seconds, usd) VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8)`,
        [accountId, p.day, p.install, p.provider, p.sandboxes, p.sandboxHours * 3600, p.gibHours * 3600, p.usd],
      );
    }
    return { outcome: "rolled", days: plan.days.length } as const;
  });
}

/** One sweep over every active account, or over one account. */
export async function sweep(db: Db, plugins: ResolvedPlugins, opts: { accountId?: string } = {}): Promise<SweepResult> {
  const { rows } = opts.accountId
    ? await db.query<{ id: string }>("SELECT id FROM accounts WHERE id = $1 AND status = 'active'", [opts.accountId])
    : await db.query<{ id: string }>("SELECT id FROM accounts WHERE status = 'active' ORDER BY id");
  const result: SweepResult = { accounts: rows.length, daysRolledUp: 0, rollupsRetried: 0, eventsPruned: 0, healthPruned: 0, usageDelivered: 0 };
  for (const { id } of rows) {
    const r = await rollupAccount(db, id);
    if (r.outcome === "rolled") result.daysRolledUp += r.days;
    if (r.outcome === "changed-meanwhile") result.rollupsRetried++;
  }
  const scope = opts.accountId ? " AND account_id = $1" : "";
  const args = opts.accountId ? [opts.accountId] : [];
  result.eventsPruned = (await db.query(`DELETE FROM ingest_events WHERE received_at < now() - interval '${EVENT_RETENTION}'${scope}`, args)).rowCount;
  result.healthPruned = (await db.query(`DELETE FROM health_samples WHERE at < now() - interval '${HEALTH_RETENTION}'${scope}`, args)).rowCount;
  if (plugins.onUsage) result.usageDelivered = (await deliverUsage(db, plugins.onUsage)).delivered;
  return result;
}
