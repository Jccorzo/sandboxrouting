// The HTTP API. Hono, so the same app runs on Node (main.ts) or on any runtime a host prefers.
//
//   GET  /v1/auth/config            none         how to sign in: {github: {clientId} | null}
//   POST /v1/sessions/github        none         {code, verifier, redirectUri} from GitHub's redirect → a session (201)
//   DELETE /v1/sessions/current     session      signs that session out
//   POST /v1/ingest                 ingest key   a router's batch of events
//   GET  /v1/me                     any key      who the key (or session) belongs to
//   (admin: an admin key, or a signed-in session)
//   GET  /v1/usage?days=30          admin        sandboxes, sandbox-hours, GiB-hours, USD per day and provider
//   GET  /v1/providers              admin        spend, free usage left, marks, health and breaker per provider
//   GET  /v1/sandboxes?view=live    admin        live (or recent) sandboxes with their effective state
//   GET  /v1/jobs                   admin        jobs and their moves
//   GET  /v1/refusals?days=30       admin        refusals, marks in force, failed creates
//   GET  /v1/keys, POST /v1/keys, POST /v1/keys/:id/revoke   admin
//   GET  /v1/credentials            admin        the hosted router's providers and what this account saved (hints only)
//   PUT  /v1/credentials/:provider  admin        {values, expectedVersion} → saved, or 409 with the row as it is
//   DELETE /v1/credentials/:provider?expectedVersion=n   admin   forgets the values, or 409
//   GET  /v1/config, PUT /v1/config {config, expectedVersion}   admin   routing config for the hosted router
//   POST /v1/sweep                  sweep token (all accounts) or admin key (its own account)
//   GET  /health, /healthz          checks the database (Cloud Run's front end swallows paths ending in z, so it gets /health)

import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { Db } from "./db.js";
import { IngestError, ingest } from "./ingest.js";
import { createKey, listKeys, lockAccount, revokeKey, sameSecret } from "./keys.js";
import { exchangeCode, GitHubError, type GitHubConfig } from "./github.js";
import { revokeSession, signIn } from "./sessions.js";
import type { SecretBox } from "./secrets.js";
import { getConfig, listCredentials, removeCredentials, saveConfig, saveCredentials } from "./vault.js";
import { catalogEntry, checkCredentials, checkHostedConfig } from "./hosted.js";
import { resolvePlugins, type Action, type BackPlugins, type Principal, type Scope } from "./plugins.js";
import * as reads from "./reads.js";
import { sweep } from "./sweep.js";
import { deliverUsage } from "./usage.js";
import { dbNow } from "./derive.js";
import type { ApiError, AuthConfig, ConnectionResult, CreatedKey, CredentialsView, KeysView, RouterConfigView, SignedIn } from "./api.js";

export interface AppOptions {
  db: Db;
  plugins?: BackPlugins;
  /** Lets a cron trigger sweep every account (SBR_SWEEP_TOKEN). Without it, admin keys sweep their own. */
  sweepToken?: string;
  /** GitHub sign-in (GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET). Without it the dashboard signs in with admin keys. */
  github?: GitHubConfig;
  /** Seals the provider keys people save (SBR_KMS_KEY or SBR_SECRETS_KEY). Without it, saving keys is off. */
  secrets?: SecretBox;
  /** Logs errors the client can't see; default console.error. */
  log?: (msg: string, err?: unknown) => void;
}

type Env = { Variables: { principal: Principal } };

const fail = (c: Context, status: 400 | 401 | 402 | 403 | 404 | 409 | 413 | 429 | 500 | 502, code: string, message: string, extra: Partial<ApiError["error"]> = {}) =>
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
      if (!p) return fail(c, 401, "unauthorized", "missing, unknown, expired or revoked key or sign-in");
      if (!scopes.includes(p.scope)) return fail(c, 403, "wrong_scope", `this needs ${scopes.join(" or ")} key; this one is ${p.scope}`);
      const d = await plugins.entitlements.check(p, action, { db });
      if (!d.ok) return fail(c, d.status, "not_entitled", d.reason);
      c.set("principal", p);
      await next();
    };

  // ---------------------------------------------------------------- sign-in
  app.get("/v1/auth/config", (c) => c.json({ github: opts.github ? { clientId: opts.github.clientId } : null } satisfies AuthConfig));

  const githubCallback = z.object({ code: z.string().min(1).max(500), verifier: z.string().min(43).max(128), redirectUri: z.string().url().max(500) }).strict();
  app.post("/v1/sessions/github", async (c) => {
    if (!opts.github) return fail(c, 404, "github_off", "GitHub sign-in isn't set up on this server; sign in with an admin key.");
    const parsed = githubCallback.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return fail(c, 400, "invalid", "send { code, verifier, redirectUri }");
    let who;
    try {
      who = await exchangeCode(opts.github, parsed.data.code, parsed.data.verifier, parsed.data.redirectUri);
    } catch (err) {
      if (!(err instanceof GitHubError)) throw err;
      return err.code === "bad_code" ? fail(c, 401, "bad_code", err.message) : fail(c, 502, "github_unavailable", err.message);
    }
    const out = await signIn(db, plugins.entitlements, who);
    switch (out.outcome) {
      case "refused":
        return fail(c, out.decision.status, "not_entitled", out.decision.reason);
      case "account-disabled":
        return fail(c, 403, "account_disabled", "This account is disabled.");
      case "signed-in":
        return c.json(
          { token: out.token, account: { id: out.accountId, name: out.accountName }, user: { id: out.userId, login: out.login }, created: out.created } satisfies SignedIn,
          201,
        );
    }
  });

  app.delete("/v1/sessions/current", guard(["admin"], "read"), async (c) => {
    const p = c.get("principal");
    if (p.via !== "session") return fail(c, 400, "not_a_session", "This is an API key, not a sign-in. Revoke keys with POST /v1/keys/:id/revoke.");
    const out = await db.tx(async (q) => {
      await lockAccount(q, p.accountId);
      return revokeSession(q, p);
    });
    return c.json({ outcome: out });
  });

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
    return c.json(await reads.me(db, p));
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
    if (!out) return fail(c, 401, "unauthorized", "Your key or sign-in was revoked meanwhile.");
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
    if (out === "unauthorized") return fail(c, 401, "unauthorized", "Your key or sign-in was revoked meanwhile.");
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

  // ---------------------------------------------------------------- saved provider keys and config
  /** Runs a write under the account's lock, after re-checking the caller's authority there. */
  const locked = <T>(p: Principal, fn: (q: Parameters<Parameters<Db["tx"]>[0]>[0]) => Promise<T>) =>
    db.tx(async (q) => {
      await lockAccount(q, p.accountId);
      if (!(await plugins.auth.stillAuthorized(p, q))) return { unauthorized: true as const };
      return { value: await fn(q) };
    });
  const revokedMeanwhile = (c: Context) => fail(c, 401, "unauthorized", "Your key or sign-in was revoked meanwhile.");
  const version = z.number().int().min(0).max(2 ** 31 - 2);

  app.get("/v1/credentials", guard(["admin"], "read"), async (c) => {
    const p = c.get("principal");
    const out = await db.tx(async (q) => listCredentials(q, p.accountId, new Date(await dbNow(q)).toISOString(), Boolean(opts.secrets)), { isolation: "repeatable read", readOnly: true });
    return c.json(out satisfies CredentialsView);
  });

  const saveBody = z.object({ values: z.record(z.unknown()), expectedVersion: version }).strict();
  app.put("/v1/credentials/:provider", bodyLimit({ maxSize: 64 * 1024, onError: (c) => fail(c, 413, "too_large", "at most 64 KiB") }), guard(["admin"], "credentials.manage"), async (c) => {
    const box = opts.secrets;
    if (!box) return fail(c, 404, "secrets_off", "Saving provider keys isn't set up on this server (SBR_KMS_KEY or SBR_SECRETS_KEY).");
    const provider = c.req.param("provider") ?? "";
    if (!catalogEntry(provider)) return fail(c, 404, "not_found", `${provider} isn't a provider the hosted router runs`);
    const parsed = saveBody.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return fail(c, 400, "invalid", "send { values: { VARIABLE: value }, expectedVersion }");
    const checked = checkCredentials(provider, parsed.data.values);
    if (!checked.ok) return fail(c, 400, "invalid", checked.message);
    const p = c.get("principal");
    const out = await locked(p, (q) => saveCredentials(q, box, p, provider, checked.values, parsed.data.expectedVersion));
    if ("unauthorized" in out) return revokedMeanwhile(c);
    if (out.value.outcome === "stale") return fail(c, 409, "stale", "Someone changed these keys since you loaded them. Here is how they stand now.", { connection: out.value.connection });
    return c.json({ provider, connection: out.value.connection } satisfies ConnectionResult);
  });

  app.delete("/v1/credentials/:provider", guard(["admin"], "credentials.manage"), async (c) => {
    const provider = c.req.param("provider") ?? "";
    if (!catalogEntry(provider)) return fail(c, 404, "not_found", `${provider} isn't a provider the hosted router runs`);
    const expected = version.safeParse(Number(c.req.query("expectedVersion") ?? "NaN"));
    if (!expected.success) return fail(c, 400, "invalid", "send ?expectedVersion=<the version you saw>");
    const p = c.get("principal");
    const out = await locked(p, (q) => removeCredentials(q, p, provider, expected.data));
    if ("unauthorized" in out) return revokedMeanwhile(c);
    if (out.value.outcome === "stale") return fail(c, 409, "stale", "These keys changed (or were removed) since you loaded them. Here is how they stand now.", { connection: out.value.connection });
    return c.json({ provider, connection: out.value.connection } satisfies ConnectionResult);
  });

  app.get("/v1/config", guard(["admin"], "read"), async (c) => {
    const p = c.get("principal");
    const out = await db.tx(async (q) => getConfig(q, p.accountId, new Date(await dbNow(q)).toISOString()), { isolation: "repeatable read", readOnly: true });
    return c.json(out satisfies RouterConfigView);
  });

  const configBody = z.object({ config: z.unknown(), expectedVersion: version }).strict();
  app.put("/v1/config", bodyLimit({ maxSize: 128 * 1024, onError: (c) => fail(c, 413, "too_large", "at most 128 KiB") }), guard(["admin"], "config.manage"), async (c) => {
    const parsed = configBody.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return fail(c, 400, "invalid", "send { config, expectedVersion }");
    const checked = checkHostedConfig(parsed.data.config);
    if (!checked.ok) return fail(c, 400, "invalid", checked.message);
    const p = c.get("principal");
    const out = await locked(p, async (q) => saveConfig(q, p, checked.config, parsed.data.expectedVersion, new Date(await dbNow(q)).toISOString()));
    if ("unauthorized" in out) return revokedMeanwhile(c);
    if (out.value.outcome === "stale") return fail(c, 409, "stale", "The config changed since you loaded it. Here is how it stands now.", { config: out.value.view });
    return c.json(out.value.view satisfies RouterConfigView);
  });

  // ---------------------------------------------------------------- sweep
  app.post("/v1/sweep", async (c) => {
    const token = bearer(c);
    if (opts.sweepToken && token && sameSecret(token, opts.sweepToken)) return c.json(await sweep(db, plugins));
    const p = await plugins.auth.authenticate(token, db);
    if (!p || p.scope !== "admin") return fail(c, 401, "unauthorized", "send the sweep token, or an admin key (or sign-in) to sweep its own account");
    const d = await plugins.entitlements.check(p, "sweep", { db });
    if (!d.ok) return fail(c, d.status, "not_entitled", d.reason);
    return c.json(await sweep(db, plugins, { accountId: p.accountId }));
  });

  plugins.routes?.(app as unknown as Hono, { db });
  return app;
}
