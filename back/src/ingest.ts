// Ingest: a router's batch of events, applied in one transaction.
//
// Idempotent twice over. Each event's id is recorded (ingest_events), so a resend is answered
// "duplicate" and changes nothing. And each row keeps the version of the state it holds, so an
// older state never overwrites a newer one even when events arrive out of order or after their
// ids were pruned: the guard is in the write (ON CONFLICT … DO UPDATE … WHERE newer).
//
// Each event is validated on its own and applied under its own savepoint: one bad event is
// answered "rejected" and the rest still land, so a router can't get stuck resending it.

import type { Queryable } from "./db.js";
import { lockAccount } from "./keys.js";
import type { Principal, ResolvedPlugins } from "./plugins.js";
import {
  entityKey,
  healthSampleKey,
  wireBatchSchema,
  wireEventSchema,
  wireSandboxProblem,
  type EventOutcome,
  type IngestResponse,
  type WireEvent,
  type WireJob,
} from "./router.js";

export class IngestError extends Error {
  constructor(
    readonly status: 400 | 401,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

type Result = IngestResponse["results"][number];

const ACTIVE = new Set(["placing", "preparing", "running", "migrating"]);
const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);

/** What is wrong with a job that its schema can't say; the same rules as the jobs table's CHECKs. */
export function wireJobProblem(j: WireJob): string | undefined {
  if (j.cursor > j.steps) return `cursor ${j.cursor} is past ${j.steps} steps`;
  if (ACTIVE.has(j.state) !== (j.leaseUntil !== undefined)) return `${j.state} job ${ACTIVE.has(j.state) ? "needs" : "can't have"} a lease`;
  if (TERMINAL.has(j.state) !== (j.endedAt !== undefined)) return `${j.state} job ${TERMINAL.has(j.state) ? "needs" : "can't have"} endedAt`;
  if ((j.state === "migrating") !== (j.reason !== undefined)) return `${j.state} job ${j.state === "migrating" ? "needs" : "can't have"} a reason`;
  if ((j.state === "preparing" || j.state === "running") && !j.box) return `${j.state} job needs a box`;
  if (j.box && !["preparing", "running", "migrating"].includes(j.state)) return `${j.state} job can't have a box`;
  return undefined;
}

function eventProblem(ev: WireEvent, install: string): string | undefined {
  if (ev.id !== `${install}:${ev.seq}`) return `event id must be "${install}:${ev.seq}"`;
  switch (ev.type) {
    case "sandbox":
      return wireSandboxProblem(ev.sandbox);
    case "job":
      return wireJobProblem(ev.job);
    case "health": {
      const s = ev.sample;
      if (s.op === "lost" && s.ok) return "a lost box can't be ok";
      if (s.ms !== undefined && !(s.ok && s.op === "create")) return "only a create that worked has a latency";
      if (s.ok && s.kind !== undefined) return "an ok sample has no error kind";
      return undefined;
    }
    case "mark":
      if (ev.mark && ev.kind !== "quota" && ev.mark.refusals !== undefined) return "only quota marks count refusals";
      return undefined;
    case "provider":
      return undefined;
  }
}

/** Applies one event to its row. Returns whether the row changed (false: it held something newer). */
async function apply(q: Queryable, accountId: string, install: string, ev: WireEvent): Promise<{ applied: boolean; dirtyFrom?: string }> {
  const v = [ev.observedAt, ev.seq];
  switch (ev.type) {
    case "sandbox": {
      const s = ev.sandbox;
      const { rows } = await q.query<{ created_at: Date | string }>(
        `INSERT INTO sandboxes (account_id, id, install_id, provider, state, cpu, memory_mib, billing, created_at, timeout_sec,
           provider_sandbox_id, expires_at, ended_at, stop_reason, segments, metadata, observed_at, seq)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16::jsonb, $17, $18)
         ON CONFLICT (account_id, id) DO UPDATE SET
           install_id = EXCLUDED.install_id, provider = EXCLUDED.provider, state = EXCLUDED.state, cpu = EXCLUDED.cpu,
           memory_mib = EXCLUDED.memory_mib, billing = EXCLUDED.billing, created_at = EXCLUDED.created_at,
           timeout_sec = EXCLUDED.timeout_sec, provider_sandbox_id = EXCLUDED.provider_sandbox_id, expires_at = EXCLUDED.expires_at,
           ended_at = EXCLUDED.ended_at, stop_reason = EXCLUDED.stop_reason, segments = EXCLUDED.segments,
           metadata = EXCLUDED.metadata, observed_at = EXCLUDED.observed_at, seq = EXCLUDED.seq, updated_at = now()
         WHERE (sandboxes.observed_at, sandboxes.seq) < (EXCLUDED.observed_at, EXCLUDED.seq)
         RETURNING created_at`,
        [
          accountId,
          s.id,
          install,
          s.provider,
          s.state,
          s.cpu,
          s.memoryMiB,
          s.billing ?? null,
          s.createdAt,
          s.timeoutSec ?? null,
          s.providerSandboxId ?? null,
          s.expiresAt ?? null,
          s.endedAt ?? null,
          s.reason ?? null,
          JSON.stringify(s.segments),
          JSON.stringify(s.metadata),
          ...v,
        ],
      );
      return rows.length ? { applied: true, dirtyFrom: s.createdAt } : { applied: false };
    }
    case "mark": {
      const m = ev.mark;
      const { rows } = await q.query(
        `INSERT INTO marks (account_id, install_id, provider, kind, status, at, until, refusals, observed_at, seq)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (account_id, install_id, provider, kind) DO UPDATE SET
           status = EXCLUDED.status, at = EXCLUDED.at, until = EXCLUDED.until, refusals = EXCLUDED.refusals,
           observed_at = EXCLUDED.observed_at, seq = EXCLUDED.seq
         WHERE (marks.observed_at, marks.seq) < (EXCLUDED.observed_at, EXCLUDED.seq)
         RETURNING 1`,
        [accountId, install, ev.provider, ev.kind, m ? "set" : "cleared", m?.at ?? null, m?.until ?? null, m?.refusals ?? null, ...v],
      );
      // The refusal itself is a fact whatever the mark became since.
      if (m) {
        await q.query(
          `INSERT INTO refusals (account_id, install_id, provider, kind, at, until, refusals) VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT DO NOTHING`,
          [accountId, install, ev.provider, ev.kind, m.at, m.until, m.refusals ?? null],
        );
      }
      return { applied: rows.length > 0 };
    }
    case "health": {
      const s = ev.sample;
      const { rows } = await q.query(
        `INSERT INTO health_samples (account_id, install_id, provider, sample_key, at, op, ok, ms, kind) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT DO NOTHING RETURNING 1`,
        [accountId, install, ev.provider, healthSampleKey(s, ev.occurrence), s.at, s.op, s.ok, s.ms ?? null, s.kind ?? null],
      );
      return { applied: rows.length > 0 };
    }
    case "job": {
      const j = ev.job;
      // A job carries its own version: newer version wins, then newer observation.
      const { rows } = await q.query(
        `INSERT INTO jobs (account_id, id, install_id, state, version, cursor, steps, migrations, created_at, updated_at, ended_at,
           lease_until, box, reason, placements, observed_at, seq)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, $15::jsonb, $16, $17)
         ON CONFLICT (account_id, id) DO UPDATE SET
           install_id = EXCLUDED.install_id, state = EXCLUDED.state, version = EXCLUDED.version, cursor = EXCLUDED.cursor,
           steps = EXCLUDED.steps, migrations = EXCLUDED.migrations, created_at = EXCLUDED.created_at, updated_at = EXCLUDED.updated_at,
           ended_at = EXCLUDED.ended_at, lease_until = EXCLUDED.lease_until, box = EXCLUDED.box, reason = EXCLUDED.reason,
           placements = EXCLUDED.placements, observed_at = EXCLUDED.observed_at, seq = EXCLUDED.seq
         WHERE (jobs.version, jobs.observed_at, jobs.seq) < (EXCLUDED.version, EXCLUDED.observed_at, EXCLUDED.seq)
         RETURNING 1`,
        [
          accountId,
          j.id,
          install,
          j.state,
          j.version,
          j.cursor,
          j.steps,
          j.migrations,
          j.createdAt,
          j.updatedAt,
          j.endedAt ?? null,
          j.leaseUntil ?? null,
          j.box ? JSON.stringify(j.box) : null,
          j.reason ?? null,
          JSON.stringify(j.placements),
          ...v,
        ],
      );
      return { applied: rows.length > 0 };
    }
    case "provider": {
      const p = ev.provider;
      const { rows } = await q.query(
        `INSERT INTO install_providers (account_id, install_id, provider, snapshot, observed_at, seq) VALUES ($1, $2, $3, $4::jsonb, $5, $6)
         ON CONFLICT (account_id, install_id, provider) DO UPDATE SET snapshot = EXCLUDED.snapshot, observed_at = EXCLUDED.observed_at, seq = EXCLUDED.seq
         WHERE (install_providers.observed_at, install_providers.seq) < (EXCLUDED.observed_at, EXCLUDED.seq)
         RETURNING 1`,
        [accountId, install, p.id, JSON.stringify(p), ...v],
      );
      if (!rows.length) return { applied: false };
      // New prices change what every day of this provider cost: those days are re-rolled.
      const { rows: first } = await q.query<{ first: Date | string | null }>(
        "SELECT min(created_at) AS first FROM sandboxes WHERE account_id = $1 AND install_id = $2 AND provider = $3",
        [accountId, install, p.id],
      );
      const f = first[0]?.first;
      return f ? { applied: true, dirtyFrom: new Date(f).toISOString() } : { applied: true };
    }
  }
}

/** Validates and applies a batch. Throws IngestError for a batch that isn't one, or a principal that lost its authority. */
export async function ingest(db: { tx: <T>(fn: (q: Queryable) => Promise<T>) => Promise<T> }, plugins: ResolvedPlugins, p: Principal, body: unknown): Promise<IngestResponse> {
  const batch = wireBatchSchema.safeParse(body);
  if (!batch.success) throw new IngestError(400, "invalid_batch", batch.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ").slice(0, 500));
  const { install, router, events } = batch.data;

  return db.tx(async (q) => {
    // The account's lock serialises this account's batches, and the key is re-read under it.
    const account = await lockAccount(q, p.accountId);
    if (account?.status !== "active" || !(await plugins.auth.stillAuthorized(p, q))) {
      throw new IngestError(401, "unauthorized", "the key was revoked or its account disabled");
    }
    await q.query(
      `INSERT INTO installs (account_id, id, router_version) VALUES ($1, $2, $3)
       ON CONFLICT (account_id, id) DO UPDATE SET last_seen_at = now(), router_version = coalesce(EXCLUDED.router_version, installs.router_version)`,
      [p.accountId, install, router ?? null],
    );

    const results: Result[] = [];
    let dirtyFrom: string | undefined;
    let changed = 0;
    for (const raw of events) {
      const id = typeof (raw as { id?: unknown })?.id === "string" ? (raw as { id: string }).id.slice(0, 200) : "";
      const parsed = wireEventSchema.safeParse(raw);
      if (!parsed.success) {
        results.push({ id, outcome: "rejected", error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ").slice(0, 300) });
        continue;
      }
      const ev = parsed.data;
      const problem = eventProblem(ev, install);
      if (problem) {
        results.push({ id: ev.id, outcome: "rejected", error: problem });
        continue;
      }
      await q.exec("SAVEPOINT ev");
      try {
        const done = await apply(q, p.accountId, install, ev);
        const recorded = await q.query(
          `INSERT INTO ingest_events (account_id, event_id, install_id, seq, type, entity, observed_at, outcome, payload)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb) ON CONFLICT DO NOTHING RETURNING 1`,
          [p.accountId, ev.id, install, ev.seq, ev.type, entityKey(ev), ev.observedAt, done.applied ? "applied" : "stale", JSON.stringify(ev)],
        );
        await q.exec("RELEASE SAVEPOINT ev");
        // A resend applies nothing: its row already holds this version or a newer one.
        const outcome: EventOutcome = !recorded.rows.length ? "duplicate" : done.applied ? "applied" : "stale";
        results.push({ id: ev.id, outcome });
        if (done.applied) {
          changed++;
          if (done.dirtyFrom && (!dirtyFrom || done.dirtyFrom < dirtyFrom)) dirtyFrom = done.dirtyFrom;
        }
      } catch (err) {
        await q.exec("ROLLBACK TO SAVEPOINT ev");
        results.push({ id: ev.id, outcome: "rejected", error: `the database refused it: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300) });
      }
    }

    if (dirtyFrom) {
      await q.query(
        `UPDATE accounts SET change_seq = change_seq + 1,
           rollup_dirty_from = LEAST(coalesce(rollup_dirty_from, $2::timestamptz), $2::timestamptz) WHERE id = $1`,
        [p.accountId, dirtyFrom],
      );
    }
    // For a billing plugin: written with the events, delivered after commit (usage.ts).
    if (plugins.onUsage && changed > 0) {
      await q.query("INSERT INTO usage_events (account_id, kind, quantity) VALUES ($1, 'events.ingested', $2)", [p.accountId, changed]);
    }
    return { results };
  });
}
