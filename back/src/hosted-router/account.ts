// One account's router, made for one request: the hosted catalog's adapters, the account's saved
// config (with what only makes sense on someone's own machine taken out) and its own keys, and a
// ledger in Postgres whose every write also updates the dashboard's tables in its transaction.
//
// Nothing outlives the request but the ledger row: no router, no env, no job keeps running.

import type { Db } from "../db.js";
import type { Principal, ResolvedPlugins } from "../plugins.js";
import { applyBatch } from "../ingest.js";
import type { AccountCredentials } from "./credentials.js";
import { PostgresLedger } from "./ledger.js";
import { hostedAdapters, observeInto, providerSnapshots, SandboxRouter, toRouterConfig, type ProviderAdapter } from "./from-router.js";

export interface AccountRouterDeps {
  db: Db;
  plugins: ResolvedPlugins;
  credentials: AccountCredentials;
  /** The providers it runs. Default: the hosted catalog's. Tests pass fakes. */
  adapters?: () => ProviderAdapter[];
  /** Live sandboxes an account may have at once. */
  maxLive: number;
  /** The router's version, recorded on the account's "hosted" install. */
  version: string;
  now?: () => number;
  log: (msg: string, err?: unknown) => void;
}

/** Who the router acts for: a caller (its key is re-checked under the lock on every write), or the sweep. */
export type Acting = { principal: Principal } | { sweep: true; accountId: string };

export async function accountRouter(deps: AccountRouterDeps, acting: Acting): Promise<SandboxRouter> {
  const { db, plugins } = deps;
  const accountId = "principal" in acting ? acting.principal.accountId : acting.accountId;
  const { rows } = await db.query<{ config: Record<string, unknown> | string }>("SELECT config FROM account_router_config WHERE account_id = $1", [accountId]);
  const raw = rows[0]?.config;
  const config = toRouterConfig(typeof raw === "string" ? JSON.parse(raw) : (raw ?? {}));
  const env = await deps.credentials.env(db, accountId);
  const adapters = deps.adapters?.() ?? hostedAdapters();
  const now = deps.now ?? Date.now;
  const snapshots = providerSnapshots(adapters, config, env);

  const ledger = new PostgresLedger(db, accountId, {
    // The sweep only reconciles what already exists, so it goes on for a disabled account too.
    authorized:
      "principal" in acting ? async (q, account) => account.status === "active" && (await plugins.auth.stillAuthorized(acting.principal, q)) : undefined,
    afterWrite: async (q, data, report) => {
      observeInto(report, data, now(), [], snapshots);
      const events = report.pending;
      report.pending = [];
      if (!events.length) return;
      const out = await applyBatch(q, plugins, accountId, report.installId, deps.version, events);
      for (const r of out.results) if (r.outcome === "rejected") deps.log(`hosted: account ${accountId}: event ${r.id} was rejected: ${r.error ?? ""}`);
    },
  });

  return new SandboxRouter({ config, providers: adapters, ledger, env, maxLive: deps.maxLive, now });
}
