// The HTTP API. Hono, so the same app runs on Node (main.ts) or on any runtime a host prefers.
//
//   POST /v1/ingest                 ingest key   a router's batch of events
//   GET  /v1/me                     any key      who the key belongs to
//   GET  /v1/usage?days=30          admin        sandboxes, sandbox-hours, GiB-hours, USD per day and provider
//   GET  /v1/providers              admin        spend, free usage left, marks, health and breaker per provider
//   GET  /v1/sandboxes?view=live    admin        live (or recent) sandboxes with their effective state
//   GET  /v1/jobs                   admin        jobs and their moves
//   GET  /v1/refusals?days=30       admin        refusals, marks in force, failed creates
//   GET  /v1/keys, POST /v1/keys, POST /v1/keys/:id/revoke   admin
//   POST /v1/sweep                  sweep token (all accounts) or admin key (its own account)
//   GET  /health, /healthz          checks the database (Cloud Run's front end swallows paths ending in z, so it gets /health)

import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { Db } from "./db.js";
import { IngestError, ingest } from "./ingest.js";
import { createKey, listKeys, lockAccount, revokeKey, sameSecret } from "./keys.js";
import { resolvePlugins, type Action, type BackPlugins, type Principal, type Scope } from "./plugins.js";
import * as reads from "./reads.js";
import { sweep } from "./sweep.js";
import { deliverUsage } from "./usage.js";
import { dbNow } from "./derive.js";
import type { ApiError, CreatedKey, KeysView } from "./api.js";

export interface AppOptions {
  db: Db;
  plugins?: BackPlugins;
  /** Lets a cron trigger sweep every account (SBR_SWEEP_TOKEN). Without it, admin keys sweep their own. */
  sweepToken?: string;
  /** Logs errors the client can't see; default console.error. */
  log?: (msg: string, err?: unknown) => void;
}

type Env = { Variables: { principal: Principal } };

const fail = (c: Context, status: 400 | 401 | 402 | 403 | 404 | 409 | 413 | 429 | 500, code: string, message: string, extra: Partial<ApiError["error"]> = {}) =>
  c.json({ error: { code, message, ...extra } } satisfies ApiError, status);

const intParam = (v: string | undefined, def: number, min: number, max: number) => {
  const n = v === undefined ? def : Number(v);
  return Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : def;
};

export function createApp(opts: AppOptions): Hono<Env> {
  const { db } = opts;
  const plugins = resolvePlugins(opts.plugins);
  const log = opts.log ?? ((msg, err) => console.error(msg, err));
  const app = new Hono<Env>();

  app.onError((err, c) => {
    if (err instanceof IngestError) return fail(c, err.status, err.code, err.message);
    log(`${c.req.method} ${c.req.path} failed`, err);
    return fail(c, 500, "internal", "something went wrong on our side");
  });
  app.notFound((c) => fail(c, 404, "not_found", "no such endpoint"));

  const health = async (c: Context<Env>) => {
    await db.query("SELECT 1");
    return c.json({ ok: true });
  };
  app.get("/health", health);
  app.get("/healthz", health);

  const bearer = (c: Context) => {
    const h = c.req.header("authorization") ?? "";
    return h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : "";
  };

  /** Authenticates, checks the scope, then asks entitlements. */
  const guard = (scopes: Scope[], action: Action) =>
    async function (c: Context<Env>, next: () => Promise<void>) {
      const p = await plugins.auth.authenticate(bearer(c), db);
      if (!p) return fail(c, 401, "unauthorized", "missing, unknown or revoked API key");
      if (!scopes.includes(p.scope)) return fail(c, 403, "wrong_scope", `this needs ${scopes.join(" or ")} key; this one is ${p.scope}`);
      const d = await plugins.entitlements.check(p, action, { db });
      if (!d.ok) return fail(c, d.status, "not_entitled", d.reason);
      c.set("principal", p);
      await next();
    };

  // ---------------------------------------------------------------- ingest
  app.post("/v1/ingest", bodyLimit({ maxSize: 4 * 1024 * 1024, onError: (c) => fail(c, 413, "too_large", "a batch may be at most 4 MiB") }), guard(["ingest"], "ingest"), async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return fail(c, 400, "invalid_json", "the body must be JSON");
    }
    const res = await ingest(db, plugins, c.get("principal"), body);
    // Usage reaches the hook after commit; if this fails, the sweep delivers it.
    if (plugins.onUsage) void deliverUsage(db, plugins.onUsage).catch((err) => log("delivering usage failed", err));
    return c.json(res);
  });

  // ---------------------------------------------------------------- reads
  app.get("/v1/me", guard(["ingest", "admin"], "read"), async (c) => {
    const p = c.get("principal");
    return c.json(await reads.me(db, p.accountId, p.keyId, p.scope));
  });
  app.get("/v1/usage", guard(["admin"], "read"), async (c) => c.json(await reads.usage(db, c.get("principal").accountId, intParam(c.req.query("days"), 30, 1, 366))));
  app.get("/v1/providers", guard(["admin"], "read"), async (c) => c.json(await reads.providers(db, c.get("principal").accountId)));
  app.get("/v1/sandboxes", guard(["admin"], "read"), async (c) => {
    const view = c.req.query("view") === "recent" ? "recent" : "live";
    return c.json(await reads.sandboxes(db, c.get("principal").accountId, view, intParam(c.req.query("limit"), 100, 1, 500)));
  });
  app.get("/v1/jobs", guard(["admin"], "read"), async (c) => c.json(await reads.jobs(db, c.get("principal").accountId, intParam(c.req.query("limit"), 100, 1, 500))));
  app.get("/v1/refusals", guard(["admin"], "read"), async (c) => c.json(await reads.refusals(db, c.get("principal").accountId, intParam(c.req.query("days"), 30, 1, 366))));

  // ---------------------------------------------------------------- keys
  app.get("/v1/keys", guard(["admin"], "keys.manage"), async (c) => {
    const p = c.get("principal");
    const out = await db.tx(async (q) => ({ now: new Date(await dbNow(q)).toISOString(), keys: await listKeys(q, p.accountId) }) satisfies KeysView, {
      isolation: "repeatable read",
      readOnly: true,
    });
    return c.json(out);
  });

  const newKey = z.object({ name: z.string().trim().min(1).max(100), scope: z.enum(["ingest", "admin"]) }).strict();
  app.post("/v1/keys", guard(["admin"], "keys.manage"), async (c) => {
    const parsed = newKey.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return fail(c, 400, "invalid", "send { name, scope: \"ingest\" | \"admin\" }");
    const p = c.get("principal");
    const out = await db.tx(async (q) => {
      await lockAccount(q, p.accountId);
      if (!(await plugins.auth.stillAuthorized(p, q))) return undefined;
      return createKey(q, p.accountId, parsed.data.name, parsed.data.scope);
    });
    if (!out) return fail(c, 401, "unauthorized", "This key was revoked meanwhile.");
    return c.json(out satisfies CreatedKey, 201);
  });

  app.post("/v1/keys/:id/revoke", guard(["admin"], "keys.manage"), async (c) => {
    const p = c.get("principal");
    const id = c.req.param("id") ?? "";
    if (!/^[0-9a-f-]{36}$/i.test(id)) return fail(c, 404, "not_found", "no such key");
    const out = await db.tx(async (q) => {
      await lockAccount(q, p.accountId);
      if (!(await plugins.auth.stillAuthorized(p, q))) return "unauthorized" as const;
      return revokeKey(q, p.accountId, id);
    });
    if (out === "unauthorized") return fail(c, 401, "unauthorized", "This key was revoked meanwhile.");
    switch (out.outcome) {
      case "revoked":
        return c.json({ key: out.key });
      case "not-found":
        return fail(c, 404, "not_found", "no such key");
      case "already-revoked":
        return fail(c, 409, "already_revoked", "This key was already revoked.", { key: out.key });
      case "last-admin-key":
        return fail(c, 409, "last_admin_key", "This is the account's last admin key. Make another admin key before revoking it.", { key: out.key });
    }
  });

  // ---------------------------------------------------------------- sweep
  app.post("/v1/sweep", async (c) => {
    const token = bearer(c);
    if (opts.sweepToken && token && sameSecret(token, opts.sweepToken)) return c.json(await sweep(db, plugins));
    const p = await plugins.auth.authenticate(token, db);
    if (!p || p.scope !== "admin") return fail(c, 401, "unauthorized", "send the sweep token, or an admin key to sweep its own account");
    const d = await plugins.entitlements.check(p, "sweep", { db });
    if (!d.ok) return fail(c, d.status, "not_entitled", d.reason);
    return c.json(await sweep(db, plugins, { accountId: p.accountId }));
  });

  plugins.routes?.(app as unknown as Hono, { db });
  return app;
}
