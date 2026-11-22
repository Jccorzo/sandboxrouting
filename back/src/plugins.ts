// Extension points. The public defaults are a simple account + API key model, everything
// allowed, and no usage hook. A private package (the hosted version's billing, teams, abuse
// controls) passes its own to createApp instead of forking this code.

import type { Hono } from "hono";
import type { Db } from "./db.js";
import { apiKeyAuth } from "./keys.js";

export type Scope = "ingest" | "admin";

/** Who is calling: an account, through one of its keys. */
export interface Principal {
  accountId: string;
  /** The key used, so a write can re-check it under its lock. */
  keyId: string;
  scope: Scope;
}

export interface AuthProvider {
  /** The principal a bearer token stands for, or undefined. Called on every request. */
  authenticate(token: string, db: Db): Promise<Principal | undefined>;
  /**
   * Re-checks, inside a write's transaction and after it took the account's lock, that the
   * principal still holds its authority (key not revoked, account not disabled since).
   */
  stillAuthorized(p: Principal, q: import("./db.js").Queryable): Promise<boolean>;
}

export type Action = "ingest" | "read" | "keys.manage" | "sweep";

export type Decision = { ok: true } | { ok: false; status: 402 | 403 | 429; reason: string };

export interface Entitlements {
  /** Whether the principal may do this now. `events`: how many events an ingest carries. */
  check(p: Principal, action: Action, ctx: { db: Db; events?: number }): Promise<Decision>;
}

/** Usage a billing plugin can meter. Delivered at least once: `id` makes a repeat recognisable. */
export interface UsageEvent {
  id: string;
  accountId: string;
  kind: "events.ingested";
  quantity: number;
  at: string;
}

export interface BackPlugins {
  auth?: AuthProvider;
  entitlements?: Entitlements;
  /** Called after commit, and again by the sweep until it returns. Must be idempotent by `event.id`. */
  onUsage?: (event: UsageEvent) => Promise<void>;
  /** Extra routes (a billing webhook, an admin page), mounted on the same app. */
  routes?: (app: Hono, deps: { db: Db }) => void;
}

export const allowEverything: Entitlements = {
  async check() {
    return { ok: true };
  },
};

export interface ResolvedPlugins {
  auth: AuthProvider;
  entitlements: Entitlements;
  onUsage?: (event: UsageEvent) => Promise<void>;
  routes?: BackPlugins["routes"];
}

export function resolvePlugins(p: BackPlugins = {}): ResolvedPlugins {
  return { auth: p.auth ?? apiKeyAuth, entitlements: p.entitlements ?? allowEverything, ...(p.onUsage ? { onUsage: p.onUsage } : {}), ...(p.routes ? { routes: p.routes } : {}) };
}
