// Stats across every account, for whoever runs this back: GET /v1/operator/stats, behind
// SBR_OPERATOR_TOKEN. One REPEATABLE READ, read-only transaction, so every number belongs to the
// same moment and the database's clock.
//
// Usage (sandbox-hours, USD) is each account's own usageIn(), the function behind its /v1/usage,
// summed: rolled-up days from usage_daily, the rest computed live, exactly as the dashboard shows
// it. Live sandboxes and job states are the router's derived states (isLiveNow, jobView).
//
// Definitions, each decided here once:
//   active     made a sandbox in the period
//   last seen  the newest of a dashboard sign-in or request, an API key used, a router reporting,
//              a sandbox made
//   connected  saved provider keys for the hosted router (even if removed since), or has a router
//              of its own reporting
//   retained   made a sandbox seven days or more after signing up
// The funnel's steps are nested: each counts only accounts that passed the step before.

import type { Db, Queryable } from "./db.js";
import { iso, isoOrUndefined } from "./db.js";
import { DAY_MS, SANDBOX_COLUMNS, dayWindow, dbNow, isLiveNow, jobView, lastDays, type JobRow, type SandboxRow } from "./derive.js";
import { HOSTED_INSTALL } from "./hosted-router/ledger.js";
import { usageIn } from "./reads.js";
import type { OperatorAccount, OperatorDay, OperatorProviderReliability, OperatorProviderUsage, OperatorStats, UsagePoint } from "./api.js";

const RETAINED_AFTER = "7 days";

interface AccountRow {
  id: string;
  name: string;
  status: "active" | "disabled";
  created_at: Date;
  github_id: string | null;
  login: string | null;
  session_at: Date | null;
  key_at: Date | null;
  install_at: Date | null;
  sandbox_at: Date | null;
  sandboxes: number;
  retained: boolean;
  providers: string[];
  ever_connected: boolean;
  hosted: boolean;
  reported: boolean;
}

const newest = (...ts: (Date | null)[]): string | null => {
  const ms = ts.filter((t): t is Date => t !== null).map((t) => new Date(t).getTime());
  return ms.length ? new Date(Math.max(...ms)).toISOString() : null;
};

const dayOf = (sql: string) => `to_char(${sql} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`;

async function accountRows(q: Queryable): Promise<AccountRow[]> {
  const { rows } = await q.query<AccountRow>(
    `SELECT a.id, a.name, a.status, a.created_at, u.github_id::text AS github_id, u.login,
       (SELECT max(coalesce(s.last_used_at, s.created_at)) FROM sessions s WHERE s.account_id = a.id) AS session_at,
       (SELECT max(k.last_used_at) FROM api_keys k WHERE k.account_id = a.id) AS key_at,
       (SELECT max(i.last_seen_at) FROM installs i WHERE i.account_id = a.id) AS install_at,
       (SELECT max(x.created_at) FROM sandboxes x WHERE x.account_id = a.id) AS sandbox_at,
       (SELECT count(*)::int FROM sandboxes x WHERE x.account_id = a.id) AS sandboxes,
       EXISTS (SELECT 1 FROM sandboxes x WHERE x.account_id = a.id AND x.created_at >= a.created_at + interval '${RETAINED_AFTER}') AS retained,
       ARRAY(SELECT c.provider FROM provider_credentials c WHERE c.account_id = a.id AND c.state = 'active' ORDER BY c.provider) AS providers,
       EXISTS (SELECT 1 FROM provider_credentials c WHERE c.account_id = a.id) AS ever_connected,
       EXISTS (SELECT 1 FROM installs i WHERE i.account_id = a.id AND i.id = $1) AS hosted,
       EXISTS (SELECT 1 FROM installs i WHERE i.account_id = a.id AND i.id <> $1) AS reported
     FROM accounts a
     LEFT JOIN account_members m ON m.account_id = a.id AND m.role = 'owner'
     LEFT JOIN users u ON u.id = m.user_id
     ORDER BY a.created_at, a.id`,
    [HOSTED_INSTALL],
  );
  return rows;
}

function funnelOf(rows: AccountRow[]): OperatorStats["funnel"] {
  const connected = rows.filter((a) => a.ever_connected || a.reported);
  const firstSandbox = connected.filter((a) => a.sandboxes > 0);
  return { signedUp: rows.length, connected: connected.length, firstSandbox: firstSandbox.length, retained: firstSandbox.filter((a) => a.retained).length };
}

async function activeSince(q: Queryable, since: number): Promise<number> {
  const { rows } = await q.query<{ n: number }>("SELECT count(DISTINCT account_id)::int AS n FROM sandboxes WHERE created_at >= $1", [new Date(since).toISOString()]);
  return rows[0]?.n ?? 0;
}

export async function operatorStats(db: Db, days: number): Promise<OperatorStats> {
  return db.tx(
    async (q) => {
      const now = await dbNow(q);
      const window = lastDays(now, days);
      const fromMs = dayWindow(window[0]!).from;
      const from = new Date(fromMs).toISOString();

      const rows = await accountRows(q);

      // Usage: each account's own numbers, summed.
      const points: (UsagePoint & { account: string })[] = [];
      const usageBy = new Map<string, { hours: number; usd: number; unknown: boolean }>();
      for (const a of rows) {
        const u = await usageIn(q, a.id, days, now);
        usageBy.set(a.id, { hours: u.totals.sandboxHours, usd: u.totals.usd, unknown: u.totals.usdUnknown });
        for (const p of u.points) points.push({ ...p, account: a.id });
      }

      const accounts: OperatorAccount[] = rows.map((a) => {
        const u = usageBy.get(a.id)!;
        return {
          id: a.id,
          name: a.name,
          status: a.status,
          createdAt: iso(a.created_at),
          github: a.github_id && a.login ? { id: Number(a.github_id), login: a.login } : null,
          lastSeenAt: newest(a.session_at, a.key_at, a.install_at, a.sandbox_at),
          lastSandboxAt: isoOrUndefined(a.sandbox_at) ?? null,
          providers: a.providers,
          everConnected: a.ever_connected,
          sandboxes: a.sandboxes,
          sandboxHours: u.hours,
          usd: u.usd,
          usdUnknown: u.unknown,
          via: { hosted: a.hosted, reported: a.reported },
        };
      });

      // Per day: sign-ups, accounts that made a sandbox, sandboxes made; hours and USD from usage.
      const { rows: made } = await q.query<{ day: string; active: number; sandboxes: number }>(
        `SELECT ${dayOf("created_at")} AS day, count(DISTINCT account_id)::int AS active, count(*)::int AS sandboxes
         FROM sandboxes WHERE created_at >= $1 GROUP BY 1`,
        [from],
      );
      const { rows: joined } = await q.query<{ day: string; n: number }>(`SELECT ${dayOf("created_at")} AS day, count(*)::int AS n FROM accounts WHERE created_at >= $1 GROUP BY 1`, [from]);
      const daily: OperatorDay[] = window.map((day) => {
        const m = made.find((r) => r.day === day);
        const ps = points.filter((p) => p.day === day);
        return {
          day,
          signups: joined.find((r) => r.day === day)?.n ?? 0,
          active: m?.active ?? 0,
          sandboxes: m?.sandboxes ?? 0,
          sandboxHours: ps.reduce((s, p) => s + p.sandboxHours, 0),
          usd: ps.reduce((s, p) => s + (p.usd ?? 0), 0),
        };
      });

      // Per provider: sandboxes made in the window; hours, USD and accounts from usage.
      const { rows: madeBy } = await q.query<{ provider: string; n: number }>("SELECT provider, count(*)::int AS n FROM sandboxes WHERE created_at >= $1 GROUP BY 1", [from]);
      const providerIds = [...new Set([...madeBy.map((r) => r.provider), ...points.map((p) => p.provider)])].sort();
      const providers: OperatorProviderUsage[] = providerIds
        .map((provider) => {
          const ps = points.filter((p) => p.provider === provider);
          return {
            provider,
            sandboxes: madeBy.find((r) => r.provider === provider)?.n ?? 0,
            sandboxHours: ps.reduce((s, p) => s + p.sandboxHours, 0),
            usd: ps.reduce((s, p) => s + (p.usd ?? 0), 0),
            accounts: new Set(ps.map((p) => p.account)).size,
          };
        })
        .sort((a, b) => b.sandboxHours - a.sandboxHours || b.sandboxes - a.sandboxes);

      const { rows: billed } = await q.query<{ billing: "free" | "paid" | "self-hosted" | null; n: number }>(
        "SELECT billing, count(*)::int AS n FROM sandboxes WHERE created_at >= $1 GROUP BY 1",
        [from],
      );
      const billingCount = (b: string | null) => billed.find((r) => r.billing === b)?.n ?? 0;

      // Reliability: the routers' own health samples and refusals.
      const { rows: health } = await q.query<{ provider: string; creates: number; failed: number; p50: number | null; p95: number | null; lost: number }>(
        `SELECT provider,
           count(*) FILTER (WHERE op = 'create')::int AS creates,
           count(*) FILTER (WHERE op = 'create' AND NOT ok)::int AS failed,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY ms) FILTER (WHERE op = 'create' AND ok AND ms IS NOT NULL) AS p50,
           percentile_cont(0.95) WITHIN GROUP (ORDER BY ms) FILTER (WHERE op = 'create' AND ok AND ms IS NOT NULL) AS p95,
           count(*) FILTER (WHERE op = 'lost')::int AS lost
         FROM health_samples WHERE at >= $1 GROUP BY provider`,
        [from],
      );
      const { rows: refused } = await q.query<{ provider: string; kind: "quota" | "rate_limit" | "auth"; n: number }>(
        "SELECT provider, kind, count(*)::int AS n FROM refusals WHERE at >= $1 GROUP BY 1, 2",
        [from],
      );
      const reliability: OperatorProviderReliability[] = [...new Set([...health.map((h) => h.provider), ...refused.map((r) => r.provider)])]
        .sort()
        .map((provider) => {
          const h = health.find((x) => x.provider === provider);
          const count = (kind: "quota" | "rate_limit" | "auth") => refused.find((r) => r.provider === provider && r.kind === kind)?.n ?? 0;
          return {
            provider,
            creates: h?.creates ?? 0,
            failedCreates: h?.failed ?? 0,
            p50Ms: h?.p50 === null || h?.p50 === undefined ? null : Number(h.p50),
            p95Ms: h?.p95 === null || h?.p95 === undefined ? null : Number(h.p95),
            lost: h?.lost ?? 0,
            refusals: { quota: count("quota"), rate_limit: count("rate_limit"), auth: count("auth") },
          };
        });

      const { rows: jobRows } = await q.query<JobRow>(
        `SELECT id, install_id, state, cursor, steps, migrations, created_at, updated_at, ended_at, lease_until, box, reason, placements
         FROM jobs WHERE created_at >= $1`,
        [from],
      );
      const byState: Record<string, number> = {};
      for (const j of jobRows) {
        const s = jobView(j, now).state;
        byState[s] = (byState[s] ?? 0) + 1;
      }

      const { rows: liveRows } = await q.query<SandboxRow>(`SELECT ${SANDBOX_COLUMNS} FROM sandboxes WHERE state IN ('creating', 'running', 'paused')`);

      return {
        now: new Date(now).toISOString(),
        days,
        from: window[0]!,
        totals: {
          accounts: accounts.length,
          githubUsers: accounts.filter((a) => a.github).length,
          active7: await activeSince(q, now - 7 * DAY_MS),
          active30: await activeSince(q, now - 30 * DAY_MS),
          signupsInWindow: daily.reduce((s, d) => s + d.signups, 0),
          sandboxesInWindow: daily.reduce((s, d) => s + d.sandboxes, 0),
          liveSandboxes: liveRows.filter((r) => isLiveNow(r, now)).length,
          sandboxHours: points.reduce((s, p) => s + p.sandboxHours, 0),
          usd: points.reduce((s, p) => s + (p.usd ?? 0), 0),
        },
        funnel: funnelOf(rows),
        daily,
        providers,
        billing: { free: billingCount("free"), paid: billingCount("paid"), selfHosted: billingCount("self-hosted"), unknown: billingCount(null) },
        source: {
          hostedHours: points.filter((p) => p.install === HOSTED_INSTALL).reduce((s, p) => s + p.sandboxHours, 0),
          reportedHours: points.filter((p) => p.install !== HOSTED_INSTALL).reduce((s, p) => s + p.sandboxHours, 0),
        },
        reliability,
        jobs: { created: jobRows.length, moves: jobRows.reduce((s, j) => s + Number(j.migrations), 0), byState },
        accounts,
      };
    },
    { isolation: "repeatable read", readOnly: true },
  );
}
