// The default auth model: accounts, and API keys that belong to one. A key is shown once when it
// is made; only its SHA-256 is stored. A key works while it is active and its account is
// active, checked on every request and again under the account's lock in every write, so a
// revoked key or a disabled account stops working at once, including for a write in flight.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Db, Queryable } from "./db.js";
import { iso, isoOrUndefined } from "./db.js";
import type { AuthProvider, Principal, Scope } from "./plugins.js";
import type { KeyView } from "./api.js";

const KEY_PREFIX = "sbrk_";

export function newToken(): string {
  return `${KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
}

export function hashToken(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

/**
 * The part of a key a list shows: enough to tell keys apart, useless to an attacker. A key made
 * here shows 6 of its 43 random characters; a token from the environment, of unknown shape, 4.
 */
export const displayPrefix = (token: string) => (token.startsWith(KEY_PREFIX) ? token.slice(0, KEY_PREFIX.length + 6) : token.slice(0, 4));

/** Constant-time comparison for shared secrets such as the sweep token. */
export function sameSecret(a: string, b: string): boolean {
  const x = createHash("sha256").update(a).digest();
  const y = createHash("sha256").update(b).digest();
  return timingSafeEqual(x, y);
}

export const apiKeyAuth: AuthProvider = {
  async authenticate(token, db) {
    if (!token || token.length > 200) return undefined;
    const { rows } = await db.query<{ id: string; account_id: string; scope: Scope }>(
      `SELECT k.id, k.account_id, k.scope FROM api_keys k JOIN accounts a ON a.id = k.account_id
       WHERE k.hash = $1 AND k.state = 'active' AND a.status = 'active'`,
      [hashToken(token)],
    );
    const row = rows[0];
    if (!row) return undefined;
    // At most once a minute, so polling doesn't write on every request.
    await db
      .query("UPDATE api_keys SET last_used_at = now() WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')", [row.id])
      .catch(() => undefined);
    return { accountId: row.account_id, via: "key", credentialId: row.id, scope: row.scope };
  },
  async stillAuthorized(p, q) {
    const { rows } = await q.query(
      `SELECT 1 FROM api_keys k JOIN accounts a ON a.id = k.account_id
       WHERE k.id = $1 AND k.account_id = $2 AND k.scope = $3 AND k.state = 'active' AND a.status = 'active'`,
      [p.credentialId, p.accountId, p.scope],
    );
    return rows.length === 1;
  },
};

/** Takes the account's row lock: every write that depends on the account's keys or state goes through here first. */
export async function lockAccount(q: Queryable, accountId: string): Promise<{ status: string } | undefined> {
  const { rows } = await q.query<{ status: string }>("SELECT status FROM accounts WHERE id = $1 FOR UPDATE", [accountId]);
  return rows[0];
}

interface KeyRow {
  id: string;
  name: string;
  scope: Scope;
  prefix: string;
  state: "active" | "revoked";
  created_at: Date | string;
  revoked_at: Date | string | null;
  last_used_at: Date | string | null;
}

const KEY_COLUMNS = "id, name, scope, prefix, state, created_at, revoked_at, last_used_at";

function keyView(r: KeyRow): KeyView {
  const base = { id: r.id, name: r.name, scope: r.scope, prefix: r.prefix, createdAt: iso(r.created_at), lastUsedAt: isoOrUndefined(r.last_used_at) ?? null };
  return r.state === "revoked" ? { ...base, state: "revoked", revokedAt: iso(r.revoked_at) } : { ...base, state: "active" };
}

export async function listKeys(q: Queryable, accountId: string): Promise<KeyView[]> {
  const { rows } = await q.query<KeyRow>(`SELECT ${KEY_COLUMNS} FROM api_keys WHERE account_id = $1 ORDER BY created_at DESC, id`, [accountId]);
  return rows.map(keyView);
}

/** Makes a key. The caller holds the account's lock. Returns the key's one-time token. */
export async function createKey(q: Queryable, accountId: string, name: string, scope: Scope): Promise<{ key: KeyView; token: string }> {
  const token = newToken();
  const { rows } = await q.query<KeyRow>(
    `INSERT INTO api_keys (account_id, name, scope, prefix, hash) VALUES ($1, $2, $3, $4, $5) RETURNING ${KEY_COLUMNS}`,
    [accountId, name, scope, displayPrefix(token), hashToken(token)],
  );
  return { key: keyView(rows[0]!), token };
}

export type RevokeOutcome =
  | { outcome: "revoked"; key: KeyView }
  | { outcome: "already-revoked"; key: KeyView }
  | { outcome: "last-admin-key"; key: KeyView }
  | { outcome: "not-found" };

/**
 * Revokes a key. The caller holds the account's lock, so two revokes can't each leave the other
 * as the last admin key and both go through. The account keeps at least one active admin key.
 */
export async function revokeKey(q: Queryable, accountId: string, keyId: string): Promise<RevokeOutcome> {
  const { rows } = await q.query<KeyRow>(`SELECT ${KEY_COLUMNS} FROM api_keys WHERE id = $1 AND account_id = $2`, [keyId, accountId]);
  const cur = rows[0];
  if (!cur) return { outcome: "not-found" };
  if (cur.state === "revoked") return { outcome: "already-revoked", key: keyView(cur) };
  if (cur.scope === "admin") {
    const { rows: admins } = await q.query<{ n: number }>("SELECT count(*)::int AS n FROM api_keys WHERE account_id = $1 AND scope = 'admin' AND state = 'active'", [accountId]);
    if ((admins[0]?.n ?? 0) <= 1) return { outcome: "last-admin-key", key: keyView(cur) };
  }
  const { rows: done } = await q.query<KeyRow>(
    `UPDATE api_keys SET state = 'revoked', revoked_at = now() WHERE id = $1 AND account_id = $2 AND state = 'active' RETURNING ${KEY_COLUMNS}`,
    [keyId, accountId],
  );
  return done[0] ? { outcome: "revoked", key: keyView(done[0]) } : { outcome: "already-revoked", key: keyView(cur) };
}

export async function createAccount(db: Db, name: string): Promise<{ accountId: string; adminToken: string }> {
  return db.tx(async (q) => {
    const { rows } = await q.query<{ id: string }>("INSERT INTO accounts (name) VALUES ($1) RETURNING id", [name]);
    const accountId = rows[0]!.id;
    const { token } = await createKey(q, accountId, "admin", "admin");
    return { accountId, adminToken: token };
  });
}

const BOOTSTRAP_LOCK = 7_270_720_002;

/**
 * Self-hosting: keys from the environment (SBR_ADMIN_TOKEN, SBR_INGEST_TOKEN) on the first
 * account, made if there is none. Idempotent, and it never brings back a key that was revoked:
 * a key that exists, in whatever state, is left as it is.
 */
export async function bootstrap(db: Db, tokens: { admin?: string; ingest?: string }, accountName = "default"): Promise<void> {
  const wanted = (
    [
      ["admin", tokens.admin],
      ["ingest", tokens.ingest],
    ] as const
  ).filter((t): t is readonly [Scope, string] => Boolean(t[1]));
  if (!wanted.length) return;
  for (const [scope, token] of wanted) {
    if (token.length < 24) throw new Error(`SBR_${scope.toUpperCase()}_TOKEN must be at least 24 characters (try: openssl rand -base64 32)`);
  }
  await db.tx(async (q) => {
    await q.query("SELECT pg_advisory_xact_lock($1)", [BOOTSTRAP_LOCK]);
    let { rows } = await q.query<{ id: string }>("SELECT id FROM accounts ORDER BY created_at, id LIMIT 1");
    if (!rows[0]) ({ rows } = await q.query<{ id: string }>("INSERT INTO accounts (name) VALUES ($1) RETURNING id", [accountName]));
    const accountId = rows[0]!.id;
    for (const [scope, token] of wanted) {
      await q.query(
        `INSERT INTO api_keys (account_id, name, scope, prefix, hash) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (hash) DO NOTHING`,
        [accountId, `${scope} (from environment)`, scope, displayPrefix(token), hashToken(token)],
      );
    }
  });
}

export type { Principal };
