// Delivers usage events to a plugin's hook, at least once. A row is claimed with a lease
// (pending → delivering), handed to the hook, then marked delivered; if the hook throws, it goes
// back to pending; if the process dies, the lease lapses and the next run claims it again. The
// lease is cleared on every outcome, not just success.
//
//   pending ──claim──▶ delivering ──hook returned──▶ delivered
//      ▲                  │ hook threw, or the lease lapsed
//      └──────────────────┘

import type { Db } from "./db.js";
import { iso } from "./db.js";
import type { UsageEvent } from "./plugins.js";

const LEASE = "2 minutes";

export async function deliverUsage(db: Db, hook: (e: UsageEvent) => Promise<void>, limit = 100): Promise<{ delivered: number; failed: number }> {
  const { rows } = await db.query<{ id: string | number; account_id: string; kind: UsageEvent["kind"]; quantity: string | number; at: Date | string }>(
    `UPDATE usage_events SET status = 'delivering', lease_until = now() + interval '${LEASE}', attempts = attempts + 1
     WHERE id IN (
       SELECT id FROM usage_events
       WHERE status = 'pending' OR (status = 'delivering' AND lease_until < now())
       ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED)
     RETURNING id, account_id, kind, quantity, at`,
    [limit],
  );
  let delivered = 0;
  let failed = 0;
  for (const r of rows.sort((a, b) => Number(a.id) - Number(b.id))) {
    const event: UsageEvent = { id: `usage_${r.id}`, accountId: r.account_id, kind: r.kind, quantity: Number(r.quantity), at: iso(r.at) };
    try {
      await hook(event);
      await db.query("UPDATE usage_events SET status = 'delivered', delivered_at = now(), lease_until = NULL WHERE id = $1 AND status = 'delivering'", [r.id]);
      delivered++;
    } catch {
      await db.query("UPDATE usage_events SET status = 'pending', lease_until = NULL WHERE id = $1 AND status = 'delivering'", [r.id]);
      failed++;
    }
  }
  return { delivered, failed };
}
