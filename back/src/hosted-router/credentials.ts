// An account's saved provider keys, opened for one request of the hosted router. They become that
// account's router env and nothing else's: the router reads ctx.env, never process.env.
//
// Opening costs a KMS call per provider, so what was opened is kept a few minutes, keyed by the
// account and each provider's credential version. Every request reads the versions again, so a
// key replaced or removed in the dashboard is used, or dropped, from the next request on.

import type { Db } from "../db.js";
import { credentialAad, open, type SecretBox } from "../secrets.js";
import { checkCredentials } from "../hosted.js";

interface Row {
  provider: string;
  version: number;
  ciphertext: Buffer | Uint8Array;
  wrapped_key: Buffer | Uint8Array;
  kek_id: string;
}

interface Entry {
  signature: string;
  env: Record<string, string>;
  at: number;
}

export interface CredentialsOptions {
  /** How long opened values are kept. Default 5 minutes. */
  ttlMs?: number;
  /** Accounts kept at most; the oldest goes first. Default 1000. */
  max?: number;
  now?: () => number;
  log?: (msg: string, err?: unknown) => void;
}

export class AccountCredentials {
  private readonly cache = new Map<string, Entry>();
  private readonly ttlMs: number;
  private readonly max: number;
  private readonly now: () => number;
  private readonly log: (msg: string, err?: unknown) => void;

  constructor(
    private readonly box: SecretBox,
    opts: CredentialsOptions = {},
  ) {
    this.ttlMs = opts.ttlMs ?? 5 * 60_000;
    this.max = opts.max ?? 1000;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((msg, err) => console.error(msg, err));
  }

  /** The account's provider variables, from its active saved credentials. */
  async env(db: Db, accountId: string): Promise<Record<string, string>> {
    const { rows } = await db.query<Row>(
      "SELECT provider, version, ciphertext, wrapped_key, kek_id FROM provider_credentials WHERE account_id = $1 AND state = 'active' ORDER BY provider",
      [accountId],
    );
    const signature = rows.map((r) => `${r.provider}@${r.version}`).join(",");
    const hit = this.cache.get(accountId);
    if (hit && hit.signature === signature && this.now() - hit.at < this.ttlMs) return hit.env;

    const env: Record<string, string> = {};
    let complete = true;
    for (const r of rows) {
      try {
        const plain = await open(
          this.box,
          { ciphertext: Buffer.from(r.ciphertext), wrapped: Buffer.from(r.wrapped_key), kekId: r.kek_id },
          credentialAad(accountId, r.provider, r.version),
        );
        // Checked again on the way out: only variables the catalog lists for this provider, so a
        // row can never set another provider's variables, or one that names a host.
        const checked = checkCredentials(r.provider, JSON.parse(plain));
        if (!checked.ok) {
          this.log(`hosted: account ${accountId}'s ${r.provider} credentials no longer pass the catalog: ${checked.message}`);
          continue;
        }
        Object.assign(env, checked.values);
      } catch (err) {
        // That provider reads as not configured; the others still work.
        this.log(`hosted: opening account ${accountId}'s ${r.provider} credentials failed`, err);
        complete = false;
      }
    }
    this.cache.delete(accountId);
    // A failure may be passing (KMS unreachable): the next request tries again instead of
    // reusing an env that lacks that provider.
    if (!complete) return env;
    this.cache.set(accountId, { signature, env, at: this.now() });
    while (this.cache.size > this.max) this.cache.delete(this.cache.keys().next().value!);
    return env;
  }
}
