// The dashboard's reads. Each runs in one REPEATABLE READ, read-only transaction, so every row it
// reads and the now() it derives with belong to the same moment.

import type { Db, Queryable } from "./db.js";
import { iso } from "./db.js";
import {
  DAY_MS,
  SANDBOX_COLUMNS,
  dayKey,
  dayWindow,
  dbNow,
  isLiveNow,
  jobView,
  lastDays,
  markOf,
  markViews,
  ledgerFor,
  pricingKey,
  providerView,
  recordOf,
  sandboxView,
  usageForDays,
  type JobRow,
  type MarkRow,
  type SandboxRow,
} from "./derive.js";
import type { HealthSample, Pricing, WireProvider } from "./router.js";
import type {
  FailedCreateDay,
  InstallView,
  JobsView,
  MarkView,
  ProvidersView,
  RefusalsView,
  SandboxesView,
  UsagePoint,
  UsageView,
} from "./api.js";

const read = <T>(db: Db, fn: (q: Queryable) => Promise<T>) => db.tx(fn, { isolation: "repeatable read", readOnly: true });

async function installs(q: Queryable, accountId: string): Promise<InstallView[]> {
  const { rows } = await q.query<{ id: string; first_seen_at: Date; last_seen_at: Date; router_version: string | null }>(
    "SELECT id, first_seen_at, last_seen_at, router_version FROM installs WHERE account_id = $1 ORDER BY first_seen_at",
    [accountId],
  );
  return rows.map((r) => ({ id: r.id, firstSeenAt: iso(r.first_seen_at), lastSeenAt: iso(r.last_seen_at), routerVersion: r.router_version }));
}

async function snapshots(q: Queryable, accountId: string): Promise<{ install: string; snapshot: WireProvider; observedAt: string }[]> {
  const { rows } = await q.query<{ install_id: string; snapshot: WireProvider; observed_at: Date }>(
    "SELECT install_id, snapshot, observed_at FROM install_providers WHERE account_id = $1 ORDER BY provider, install_id",
    [accountId],
  );
  return rows.map((r) => ({ install: r.install_id, snapshot: r.snapshot, observedAt: iso(r.observed_at) }));
}

async function pricingMap(q: Queryable, accountId: string): Promise<Map<string, Pricing>> {
  return new Map((await snapshots(q, accountId)).map((s) => [pricingKey(s.install, s.snapshot.id), s.snapshot.pricing]));
}

/** Sandboxes that may have run inside [from, to): created before its end, not ended before its start. */
export async function sandboxesOverlapping(q: Queryable, accountId: string, from: number, to: number): Promise<SandboxRow[]> {
  const { rows } = await q.query<SandboxRow>(
    `SELECT ${SANDBOX_COLUMNS} FROM sandboxes WHERE account_id = $1 AND created_at < $3 AND (ended_at IS NULL OR ended_at >= $2)`,
    [accountId, new Date(from).toISOString(), new Date(to).toISOString()],
  );
  return rows;
}

/** Which of `days` the sweep's rollups still answer for: rolled up, and not changed since. */
export function rolledUp(days: string[], rolledThrough: string | null, dirtyFrom: string | null): Set<string> {
  if (!rolledThrough) return new Set();
  const dirtyDay = dirtyFrom ? dayKey(Date.parse(dirtyFrom)) : undefined;
  return new Set(days.filter((d) => d <= rolledThrough && (dirtyDay === undefined || d < dirtyDay)));
}

export async function usage(db: Db, accountId: string, days: number): Promise<UsageView> {
  return read(db, async (q) => {
    const now = await dbNow(q);
    const window = lastDays(now, days);
    const { rows: acct } = await q.query<{ rolled_through: string | null; rollup_dirty_from: Date | null }>(
      "SELECT rolled_through, rollup_dirty_from FROM accounts WHERE id = $1",
      [accountId],
    );
    const rolled = rolledUp(window, acct[0]?.rolled_through ?? null, acct[0]?.rollup_dirty_from ? iso(acct[0].rollup_dirty_from) : null);
    const live = window.filter((d) => !rolled.has(d));

    const points: UsagePoint[] = [];
    if (rolled.size) {
      const { rows } = await q.query<{ day: string; install_id: string; provider: string; sandboxes: number; sandbox_seconds: number; gib_seconds: number; usd: number | null }>(
        "SELECT day::text AS day, install_id, provider, sandboxes, sandbox_seconds, gib_seconds, usd FROM usage_daily WHERE account_id = $1 AND day = ANY($2::date[])",
        [accountId, [...rolled]],
      );
      for (const r of rows) {
        points.push({ day: r.day, install: r.install_id, provider: r.provider, sandboxes: r.sandboxes, sandboxHours: r.sandbox_seconds / 3600, gibHours: r.gib_seconds / 3600, usd: r.usd });
      }
    }
    const pricing = await pricingMap(q, accountId);
    if (live.length) {
      const rows = await sandboxesOverlapping(q, accountId, dayWindow(live[0]!).from, dayWindow(live.at(-1)!).to);
      points.push(...usageForDays(rows, pricing, live, now));
    }
    points.sort((a, b) => a.day.localeCompare(b.day) || a.provider.localeCompare(b.provider) || a.install.localeCompare(b.install));

    const from = dayWindow(window[0]!).from;
    const { rows: created } = await q.query<{ n: number }>("SELECT count(*)::int AS n FROM sandboxes WHERE account_id = $1 AND created_at >= $2", [
      accountId,
      new Date(from).toISOString(),
    ]);
    const { rows: liveRows } = await q.query<SandboxRow>(`SELECT ${SANDBOX_COLUMNS} FROM sandboxes WHERE account_id = $1 AND state IN ('creating', 'running', 'paused')`, [accountId]);
    return {
      now: new Date(now).toISOString(),
      days,
      from: window[0]!,
      installs: await installs(q, accountId),
      points,
      totals: {
        sandboxes: created[0]?.n ?? 0,
        live: liveRows.filter((r) => isLiveNow(r, now)).length,
        sandboxHours: points.reduce((s, p) => s + p.sandboxHours, 0),
        gibHours: points.reduce((s, p) => s + p.gibHours, 0),
        usd: points.reduce((s, p) => s + (p.usd ?? 0), 0),
        usdUnknown: points.some((p) => p.usd === null),
      },
      rolledUpDays: rolled.size,
    };
  });
}

export async function providers(db: Db, accountId: string): Promise<ProvidersView> {
  return read(db, async (q) => {
    const now = await dbNow(q);
    const snaps = await snapshots(q, accountId);
    // One-time credits count all time; everything else, this month at most.
    const monthStart = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), 1);
    const { rows } = await q.query<SandboxRow>(
      `SELECT ${SANDBOX_COLUMNS} FROM sandboxes s WHERE account_id = $1 AND (
         ended_at IS NULL OR ended_at >= $2 OR EXISTS (
           SELECT 1 FROM install_providers p WHERE p.account_id = s.account_id AND p.install_id = s.install_id AND p.provider = s.provider
             AND p.snapshot->'freeTier'->>'kind' = 'one-time-credit'))`,
      [accountId, new Date(monthStart).toISOString()],
    );
    const { rows: marks } = await q.query<MarkRow>("SELECT install_id, provider, kind, at, until, refusals FROM marks WHERE account_id = $1 AND status = 'set'", [accountId]);
    const out = [];
    for (const s of snaps) {
      const p = s.snapshot;
      const recs = rows.filter((r) => r.install_id === s.install && r.provider === p.id).map(recordOf);
      const ms = marks.filter((m) => m.install_id === s.install && m.provider === p.id).map(markOf);
      // The newest samples the router would keep (healthSamples), oldest first, as in the ledger.
      const { rows: samples } = await q.query<{ at: Date; op: "create" | "lost"; ok: boolean; ms: number | null; kind: HealthSample["kind"] | null }>(
        `SELECT at, op, ok, ms, kind FROM health_samples WHERE account_id = $1 AND install_id = $2 AND provider = $3 AND at > $4
         ORDER BY at DESC LIMIT $5`,
        [accountId, s.install, p.id, new Date(now - 7 * DAY_MS).toISOString(), p.healthSamples],
      );
      const health: HealthSample[] = samples.reverse().map((h) => ({
        at: iso(h.at),
        op: h.op,
        ok: h.ok,
        ...(h.ms === null ? {} : { ms: Number(h.ms) }),
        ...(h.kind === null ? {} : { kind: h.kind }),
      }));
      out.push(providerView(s.install, p, recs, ms, health, now, s.observedAt));
    }
    return { now: new Date(now).toISOString(), installs: await installs(q, accountId), providers: out };
  });
}

export async function sandboxes(db: Db, accountId: string, view: "live" | "recent", limit: number): Promise<SandboxesView> {
  return read(db, async (q) => {
    const now = await dbNow(q);
    const pricing = await pricingMap(q, accountId);
    const { rows } =
      view === "live"
        ? await q.query<SandboxRow>(`SELECT ${SANDBOX_COLUMNS} FROM sandboxes WHERE account_id = $1 AND state IN ('creating', 'running', 'paused') ORDER BY created_at DESC`, [accountId])
        : await q.query<SandboxRow>(`SELECT ${SANDBOX_COLUMNS} FROM sandboxes WHERE account_id = $1 ORDER BY created_at DESC, id LIMIT $2`, [accountId, limit]);
    let list = rows.map((r) => sandboxView(r, pricing.get(pricingKey(r.install_id, r.provider)), now));
    // "Live" by the derived state: a running sandbox past its deadline reads as expired, not live.
    if (view === "live") list = list.filter((s) => s.state === "creating" || s.state === "running" || s.state === "paused").slice(0, limit);
    return { now: new Date(now).toISOString(), view, sandboxes: list };
  });
}

export async function jobs(db: Db, accountId: string, limit: number): Promise<JobsView> {
  return read(db, async (q) => {
    const now = await dbNow(q);
    const { rows } = await q.query<JobRow>(
      `SELECT id, install_id, state, cursor, steps, migrations, created_at, updated_at, ended_at, lease_until, box, reason, placements
       FROM jobs WHERE account_id = $1 ORDER BY created_at DESC, id LIMIT $2`,
      [accountId, limit],
    );
    return { now: new Date(now).toISOString(), jobs: rows.map((r) => jobView(r, now)) };
  });
}

export async function refusals(db: Db, accountId: string, days: number): Promise<RefusalsView> {
  return read(db, async (q) => {
    const now = await dbNow(q);
    const window = lastDays(now, days);
    const from = new Date(dayWindow(window[0]!).from).toISOString();
    const { rows: occurred } = await q.query<{ install_id: string; provider: string; kind: MarkView["kind"]; at: Date; until: Date; refusals: number | null }>(
      "SELECT install_id, provider, kind, at, until, refusals FROM refusals WHERE account_id = $1 AND at >= $2 ORDER BY at DESC LIMIT 500",
      [accountId, from],
    );
    const { rows: marks } = await q.query<MarkRow>("SELECT install_id, provider, kind, at, until, refusals FROM marks WHERE account_id = $1 AND status = 'set'", [accountId]);
    const inForce: MarkView[] = [];
    const byInstallProvider = new Map<string, MarkRow[]>();
    for (const m of marks) byInstallProvider.set(pricingKey(m.install_id, m.provider), [...(byInstallProvider.get(pricingKey(m.install_id, m.provider)) ?? []), m]);
    for (const list of byInstallProvider.values()) {
      const first = list[0]!;
      const data = ledgerFor({ id: first.provider, priorUsd: {} } as WireProvider, [], list.map(markOf), []);
      inForce.push(...markViews(first.install_id, data, first.provider, now).filter((m) => m.standing !== "lapsed"));
    }
    // A failed record with no billing segment is a create that failed; the router moved on to the next provider.
    const { rows: failed } = await q.query<{ day: string; provider: string; n: number }>(
      `SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, provider, count(*)::int AS n FROM sandboxes
       WHERE account_id = $1 AND state = 'failed' AND segments = '[]'::jsonb AND created_at >= $2 GROUP BY 1, 2 ORDER BY 1, 2`,
      [accountId, from],
    );
    const { rows: infra } = await q.query<{ day: string; provider: string; n: number }>(
      `SELECT to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, provider, count(*)::int AS n FROM health_samples
       WHERE account_id = $1 AND NOT ok AND at >= $2 GROUP BY 1, 2 ORDER BY 1, 2`,
      [accountId, from],
    );
    const perDay = (rows: { day: string; provider: string; n: number }[]): FailedCreateDay[] => rows.map((r) => ({ day: r.day, provider: r.provider, count: r.n }));
    return {
      now: new Date(now).toISOString(),
      days,
      inForce: inForce.sort((a, b) => b.at.localeCompare(a.at)),
      refusals: occurred.map((r) => ({ install: r.install_id, provider: r.provider, kind: r.kind, at: iso(r.at), until: iso(r.until), refusals: r.refusals })),
      failedCreates: perDay(failed),
      infraFailures: perDay(infra),
    };
  });
}

export async function me(db: Db, accountId: string, keyId: string, scope: "ingest" | "admin") {
  return read(db, async (q) => {
    const now = await dbNow(q);
    const { rows } = await q.query<{ id: string; name: string }>("SELECT id, name FROM accounts WHERE id = $1", [accountId]);
    return { now: new Date(now).toISOString(), account: rows[0]!, key: { id: keyId, scope } };
  });
}
