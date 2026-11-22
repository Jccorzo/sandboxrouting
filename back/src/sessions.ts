// Sign-in sessions: someone who signed in with GitHub, working in the dashboard as their account's
// admin. A session token (sbrs_…) is shown to the dashboard once; only its SHA-256 is stored.
//
// A session works while it is active, not past its expiry (the database's now(), checked on every
// request), its membership still exists and its account is active. stillAuthorized checks all of
// that again under the account's lock in every write, so signing out, being removed or a disabled
// account stops a write in flight too.

import { randomBytes } from "node:crypto";
import type { Db, Queryable } from "./db.js";
import { apiKeyAuth, hashToken, lockAccount } from "./keys.js";
import type { AuthProvider, Decision, Entitlements, Newcomer, Principal } from "./plugins.js";

export const SESSION_PREFIX = "sbrs_";
/** How long a sign-in lasts. The dashboard's cookie lasts as long. */
export const SESSION_DAYS = 30;

export const newSessionToken = () => `${SESSION_PREFIX}${randomBytes(32).toString("base64url")}`;
export const isSessionToken = (token: string) => token.startsWith(SESSION_PREFIX);

/** Everything a session needs to stand, in one place: both checks below use it. */
const LIVE = `s.state = 'active' AND s.expires_at > now() AND a.status = 'active'`;
const FROM = `sessions s JOIN accounts a ON a.id = s.account_id
  JOIN account_members m ON m.account_id = s.account_id AND m.user_id = s.user_id`;

export const sessionAuth: AuthProvider = {
  async authenticate(token, db) {
    if (!isSessionToken(token) || token.length > 200) return undefined;
    const { rows } = await db.query<{ id: string; account_id: string }>(`SELECT s.id, s.account_id FROM ${FROM} WHERE s.hash = $1 AND ${LIVE}`, [hashToken(token)]);
    const row = rows[0];
    if (!row) return undefined;
    await db
      .query("UPDATE sessions SET last_used_at = now() WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')", [row.id])
      .catch(() => undefined);
    return { accountId: row.account_id, via: "session", credentialId: row.id, scope: "admin" };
  },
  async stillAuthorized(p, q) {
    if (p.via !== "session") return false;
    const { rows } = await q.query(`SELECT 1 FROM ${FROM} WHERE s.id = $1 AND s.account_id = $2 AND ${LIVE}`, [p.credentialId, p.accountId]);
    return rows.length === 1;
  },
};

/** The default: API keys (sbrk_…, or any token from the environment) and sessions (sbrs_…). */
export const defaultAuth: AuthProvider = {
  authenticate: (token, db) => (isSessionToken(token) ? sessionAuth.authenticate(token, db) : apiKeyAuth.authenticate(token, db)),
  stillAuthorized: (p, q) => (p.via === "session" ? sessionAuth.stillAuthorized(p, q) : apiKeyAuth.stillAuthorized(p, q)),
};

/** Who GitHub says signed in. */
export type GitHubIdentity = Newcomer;

export type SignInOutcome =
  | { outcome: "signed-in"; token: string; accountId: string; accountName: string; userId: string; login: string; created: boolean }
  | { outcome: "refused"; decision: Extract<Decision, { ok: false }> }
  | { outcome: "account-disabled" };

/**
 * Signs a GitHub user in: finds or makes their user, finds or makes the one account they own, and
 * opens a session. All in one transaction. The upsert locks the user's row, so two first sign-ins
 * racing each other make one account: the second waits, then finds the first one's membership.
 */
export async function signIn(db: Db, entitlements: Entitlements, who: GitHubIdentity): Promise<SignInOutcome> {
  // A newcomer is asked about before the transaction (the hook may be slow or call out); someone
  // with an account already isn't asked at all.
  const { rows: known } = await db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM users u JOIN account_members m ON m.user_id = u.id AND m.role = 'owner' WHERE u.github_id = $1",
    [who.githubId],
  );
  if (!known[0]?.n && entitlements.allowSignup) {
    const d = await entitlements.allowSignup(who, { db });
    if (!d.ok) return { outcome: "refused", decision: d };
  }

  return db.tx(async (q) => {
    const { rows: users } = await q.query<{ id: string }>(
      `INSERT INTO users (github_id, login) VALUES ($1, $2)
       ON CONFLICT (github_id) DO UPDATE SET login = EXCLUDED.login RETURNING id`,
      [who.githubId, who.login],
    );
    const userId = users[0]!.id;
    let created = false;
    const { rows: owned } = await q.query<{ account_id: string }>("SELECT account_id FROM account_members WHERE user_id = $1 AND role = 'owner'", [userId]);
    let accountId = owned[0]?.account_id;
    if (!accountId) {
      const { rows: acct } = await q.query<{ id: string }>("INSERT INTO accounts (name) VALUES ($1) RETURNING id", [who.login]);
      accountId = acct[0]!.id;
      await q.query("INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'owner')", [accountId, userId]);
      created = true;
    }
    const account = await lockAccount(q, accountId);
    if (account?.status !== "active") return { outcome: "account-disabled" as const };
    const { rows: names } = await q.query<{ name: string }>("SELECT name FROM accounts WHERE id = $1", [accountId]);
    const token = newSessionToken();
    await q.query(
      `INSERT INTO sessions (account_id, user_id, hash, expires_at) VALUES ($1, $2, $3, now() + make_interval(days => $4))`,
      [accountId, userId, hashToken(token), SESSION_DAYS],
    );
    return { outcome: "signed-in" as const, token, accountId, accountName: names[0]!.name, userId, login: who.login, created };
  });
}

/** Signs a session out. Revoking one that is already revoked or gone says so; nothing else changes. */
export async function revokeSession(q: Queryable, p: Principal): Promise<"revoked" | "already-revoked"> {
  const { rowCount } = await q.query("UPDATE sessions SET state = 'revoked', revoked_at = now() WHERE id = $1 AND account_id = $2 AND state = 'active'", [
    p.credentialId,
    p.accountId,
  ]);
  return rowCount === 1 ? "revoked" : "already-revoked";
}

/** The person behind a session, for /v1/me. */
export async function sessionUser(q: Queryable, sessionId: string): Promise<{ id: string; login: string } | undefined> {
  const { rows } = await q.query<{ id: string; login: string }>("SELECT u.id, u.login FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = $1", [sessionId]);
  return rows[0];
}
