// Saved provider keys and routing config: reads that never return a secret, and writes that are
// compare-and-set on the version the caller saw. The caller holds the account's lock and has
// re-checked its authority under it (app.ts), so a key revoked or a session signed out meanwhile
// can't save.

import type { Queryable } from "./db.js";
import { iso } from "./db.js";
import type { Principal } from "./plugins.js";
import { HOSTED_CATALOG, builtinStrategies, credentialHints } from "./hosted.js";
import { credentialAad, seal, type SecretBox } from "./secrets.js";
import type { ConnectionView, CredentialsView, RouterConfigView } from "./api.js";

interface CredRow {
  provider: string;
  state: "active" | "removed";
  version: number;
  hints: Record<string, string>;
  updated_at: Date | string;
}

const CRED_COLUMNS = "provider, state, version, hints, updated_at";

const by = (p: Principal) => `${p.via}:${p.credentialId}`;

function connection(row: CredRow | undefined): ConnectionView {
  if (!row) return { state: "none", version: 0 };
  return row.state === "active"
    ? { state: "active", version: row.version, hints: row.hints, updatedAt: iso(row.updated_at) }
    : { state: "removed", version: row.version, updatedAt: iso(row.updated_at) };
}

export async function listCredentials(q: Queryable, accountId: string, now: string, enabled: boolean): Promise<CredentialsView> {
  const { rows } = await q.query<CredRow>(`SELECT ${CRED_COLUMNS} FROM provider_credentials WHERE account_id = $1`, [accountId]);
  const byId = new Map(rows.map((r) => [r.provider, r]));
  return { now, enabled, providers: HOSTED_CATALOG.map((e) => ({ ...e, connection: connection(byId.get(e.id)) })) };
}

async function current(q: Queryable, accountId: string, provider: string): Promise<ConnectionView> {
  const { rows } = await q.query<CredRow>(`SELECT ${CRED_COLUMNS} FROM provider_credentials WHERE account_id = $1 AND provider = $2`, [accountId, provider]);
  return connection(rows[0]);
}

export type SaveOutcome = { outcome: "saved"; connection: ConnectionView } | { outcome: "stale"; connection: ConnectionView };

/**
 * Saves a provider's values, replacing whatever was there, if the row is still at `expected`
 * (0: there is no row yet). The new version is sealed into the ciphertext's associated data.
 */
export async function saveCredentials(
  q: Queryable,
  box: SecretBox,
  p: Principal,
  provider: string,
  values: Record<string, string>,
  expected: number,
): Promise<SaveOutcome> {
  const version = expected + 1;
  const sealed = await seal(box, JSON.stringify(values), credentialAad(p.accountId, provider, version));
  const hints = JSON.stringify(credentialHints(provider, values));
  const params = [p.accountId, provider, version, sealed.ciphertext, sealed.wrapped, sealed.kekId, hints, by(p)];
  const { rows } =
    expected === 0
      ? await q.query<CredRow>(
          `INSERT INTO provider_credentials (account_id, provider, state, version, ciphertext, wrapped_key, kek_id, hints, updated_by)
           VALUES ($1, $2, 'active', $3, $4, $5, $6, $7, $8) ON CONFLICT (account_id, provider) DO NOTHING RETURNING ${CRED_COLUMNS}`,
          params,
        )
      : await q.query<CredRow>(
          `UPDATE provider_credentials SET state = 'active', version = $3, ciphertext = $4, wrapped_key = $5, kek_id = $6, hints = $7,
             updated_by = $8, updated_at = now()
           WHERE account_id = $1 AND provider = $2 AND version = $3 - 1 RETURNING ${CRED_COLUMNS}`,
          params,
        );
  return rows[0] ? { outcome: "saved", connection: connection(rows[0]) } : { outcome: "stale", connection: await current(q, p.accountId, provider) };
}

/** Forgets a provider's values (the row keeps its version), if it is still active at `expected`. */
export async function removeCredentials(q: Queryable, p: Principal, provider: string, expected: number): Promise<SaveOutcome> {
  const { rows } = await q.query<CredRow>(
    `UPDATE provider_credentials SET state = 'removed', version = version + 1, ciphertext = NULL, wrapped_key = NULL, kek_id = NULL,
       hints = '{}'::jsonb, updated_by = $4, updated_at = now()
     WHERE account_id = $1 AND provider = $2 AND version = $3 AND state = 'active' RETURNING ${CRED_COLUMNS}`,
    [p.accountId, provider, expected, by(p)],
  );
  return rows[0] ? { outcome: "saved", connection: connection(rows[0]) } : { outcome: "stale", connection: await current(q, p.accountId, provider) };
}

interface ConfigRow {
  config: Record<string, unknown>;
  version: number;
  updated_at: Date | string;
}

const STRATEGIES = builtinStrategies().map((s) => ({ name: s.name, description: s.description }));

function configView(row: ConfigRow | undefined, now: string): RouterConfigView {
  return row ? { now, config: row.config, version: row.version, updatedAt: iso(row.updated_at), strategies: STRATEGIES } : { now, config: {}, version: 0, strategies: STRATEGIES };
}

export async function getConfig(q: Queryable, accountId: string, now: string): Promise<RouterConfigView> {
  const { rows } = await q.query<ConfigRow>("SELECT config, version, updated_at FROM account_router_config WHERE account_id = $1", [accountId]);
  return configView(rows[0], now);
}

export type ConfigOutcome = { outcome: "saved"; view: RouterConfigView } | { outcome: "stale"; view: RouterConfigView };

/** Replaces the account's config if it is still at `expected` (0: never saved). */
export async function saveConfig(q: Queryable, p: Principal, config: Record<string, unknown>, expected: number, now: string): Promise<ConfigOutcome> {
  const params = [p.accountId, JSON.stringify(config), expected + 1, by(p)];
  const { rows } =
    expected === 0
      ? await q.query<ConfigRow>(
          `INSERT INTO account_router_config (account_id, config, version, updated_by) VALUES ($1, $2, $3, $4)
           ON CONFLICT (account_id) DO NOTHING RETURNING config, version, updated_at`,
          params,
        )
      : await q.query<ConfigRow>(
          `UPDATE account_router_config SET config = $2, version = $3, updated_by = $4, updated_at = now()
           WHERE account_id = $1 AND version = $3 - 1 RETURNING config, version, updated_at`,
          params,
        );
  return rows[0] ? { outcome: "saved", view: configView(rows[0], now) } : { outcome: "stale", view: await getConfig(q, p.accountId, now) };
}
