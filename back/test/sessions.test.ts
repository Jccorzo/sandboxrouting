// GitHub sign-in: a first sign-in makes one account and opens a session; signing in again finds
// it; a session stops working once it is signed out, expired, or its account is disabled, and a
// write in flight re-checks it under the account's lock.
import { afterEach, describe, expect, it } from "vitest";
import { closeAll, emptyDb, fixture, type Fixture } from "./helpers.js";
import { migrate, MIGRATIONS } from "../src/migrate.js";
import { createAccount, createKey } from "../src/keys.js";
import { defaultAuth, signIn } from "../src/sessions.js";
import { allowEverything, type BackPlugins } from "../src/plugins.js";
import type { GitHubConfig } from "../src/github.js";
import type { ApiError, AuthConfig, CreatedKey, Me, SignedIn } from "../src/api.js";

afterEach(closeAll);

const VERIFIER = "v".repeat(43);
const REDIRECT = "https://app.example/api/auth/github/callback";

/** A fake GitHub: each code maps to a profile; anything else is a bad code. */
function fakeGitHub(users: Record<string, { id: number; login: string }>, opts: { down?: boolean } = {}): GitHubConfig & { calls: string[] } {
  const calls: string[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (opts.down) return new Response("down", { status: 503 });
    if (url.endsWith("/login/oauth/access_token")) {
      const body = JSON.parse(String(init?.body)) as { code: string; code_verifier: string; client_secret: string };
      if (body.client_secret !== "secret" || body.code_verifier !== VERIFIER || !users[body.code]) return Response.json({ error: "bad_verification_code" });
      return Response.json({ access_token: `tok-${body.code}` });
    }
    if (url.endsWith("/user")) {
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      const code = auth.replace("Bearer tok-", "");
      const u = users[code];
      return u ? Response.json({ ...u, created_at: "2020-01-01T00:00:00Z" }) : new Response("no", { status: 401 });
    }
    return new Response("?", { status: 404 });
  }) as typeof fetch;
  return { clientId: "cid", clientSecret: "secret", fetch: f, calls };
}

async function signInAs(f: Fixture, code: string) {
  return f.call<SignedIn & ApiError>("POST", "/v1/sessions/github", { token: "", body: { code, verifier: VERIFIER, redirectUri: REDIRECT } });
}

describe("auth config", () => {
  it("says GitHub is off without a client, and gives the client id with one", async () => {
    const off = await fixture();
    expect((await off.call<AuthConfig>("GET", "/v1/auth/config", { token: "" })).body).toEqual({ github: null });
    // The same database: making a second one is what takes the time here.
    const f = await fixture({ db: off.db, github: fakeGitHub({}) });
    expect((await f.call<AuthConfig>("GET", "/v1/auth/config", { token: "" })).body).toEqual({ github: { clientId: "cid" } });
  });

  it("refuses a GitHub callback when GitHub sign-in isn't set up", async () => {
    const f = await fixture();
    expect((await signInAs(f, "x")).status).toBe(404);
  });
});

describe("GitHub sign-in", () => {
  it("a first sign-in makes the account; the session works as its admin; signing in again finds the same account", async () => {
    const f = await fixture({ github: fakeGitHub({ c1: { id: 42, login: "ada" }, c2: { id: 42, login: "ada-renamed" } }) });
    const first = await signInAs(f, "c1");
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ created: true, account: { name: "ada" }, user: { login: "ada" } });
    expect(first.body.token).toMatch(/^sbrs_/);

    const me = await f.call<Me>("GET", "/v1/me", { token: first.body.token });
    expect(me.body).toMatchObject({ via: "session", key: { scope: "admin" }, user: { login: "ada" }, account: { id: first.body.account.id } });
    expect((await f.call("GET", "/v1/usage", { token: first.body.token })).status).toBe(200);

    const again = await signInAs(f, "c2");
    expect(again.body).toMatchObject({ created: false, account: { id: first.body.account.id }, user: { login: "ada-renamed" } });
    const { rows } = await f.db.query<{ n: number }>("SELECT count(*)::int AS n FROM account_members m JOIN users u ON u.id = m.user_id WHERE u.github_id = 42");
    expect(rows[0]!.n).toBe(1);
    // Only the hash is stored.
    expect(JSON.stringify((await f.db.query("SELECT * FROM sessions")).rows)).not.toContain(first.body.token);
  });

  it("two first sign-ins racing make one account", async () => {
    const f = await fixture();
    const who = { githubId: 7, login: "racer" };
    const [a, b] = await Promise.all([signIn(f.db, allowEverything, who), signIn(f.db, allowEverything, who)]);
    expect(a.outcome === "signed-in" && b.outcome === "signed-in").toBe(true);
    if (a.outcome !== "signed-in" || b.outcome !== "signed-in") return;
    expect(a.accountId).toBe(b.accountId);
    expect([a.created, b.created].sort()).toEqual([false, true]);
  });

  it("a bad code is a 401 and GitHub being down a 502; neither makes anything", async () => {
    const f = await fixture({ github: fakeGitHub({ good: { id: 1, login: "x" } }) });
    expect((await signInAs(f, "nope")).body.error.code).toBe("bad_code");
    const down = await fixture({ db: f.db, github: fakeGitHub({ good: { id: 1, login: "x" } }, { down: true }) });
    expect((await signInAs(down, "good")).status).toBe(502);
    expect((await f.db.query("SELECT 1 FROM users")).rows).toHaveLength(0);
  });

  it("allowSignup can refuse a newcomer, and isn't asked about someone who has an account", async () => {
    const asked: string[] = [];
    let open = true;
    const plugins: BackPlugins = {
      entitlements: {
        ...allowEverything,
        async allowSignup(who) {
          asked.push(who.login);
          return open ? { ok: true } : { ok: false, status: 403, reason: "sign-ups are closed" };
        },
      },
    };
    const f = await fixture({ plugins, github: fakeGitHub({ old: { id: 1, login: "old" }, oldAgain: { id: 1, login: "old" }, new: { id: 2, login: "new" } }) });
    expect((await signInAs(f, "old")).status).toBe(201);
    open = false;
    expect((await signInAs(f, "oldAgain")).status).toBe(201);
    const refused = await signInAs(f, "new");
    expect(refused.status).toBe(403);
    expect(refused.body.error.message).toBe("sign-ups are closed");
    expect(asked).toEqual(["old", "new"]);
    expect((await f.db.query("SELECT 1 FROM users WHERE github_id = 2")).rows).toHaveLength(0);
  });

  it("a disabled account can't sign in", async () => {
    const f = await fixture({ github: fakeGitHub({ c: { id: 5, login: "d" } }) });
    const s = await signInAs(f, "c");
    await f.db.query("UPDATE accounts SET status = 'disabled', disabled_at = now() WHERE id = $1", [s.body.account.id]);
    expect((await signInAs(f, "c")).body.error.code).toBe("account_disabled");
    expect((await f.call("GET", "/v1/me", { token: s.body.token })).status).toBe(401);
  });
});

describe("sessions", () => {
  async function session() {
    const f = await fixture({ github: fakeGitHub({ c: { id: 9, login: "s" } }) });
    const s = await signInAs(f, "c");
    return { f, token: s.body.token, accountId: s.body.account.id };
  }

  it("signing out revokes the session: it stops working at once", async () => {
    const { f, token } = await session();
    expect((await f.call<{ outcome: string }>("DELETE", "/v1/sessions/current", { token })).body).toEqual({ outcome: "revoked" });
    expect((await f.call("GET", "/v1/me", { token })).status).toBe(401);
  });

  it("an expired session stops working, judged by the database's clock", async () => {
    const { f, token } = await session();
    await f.db.query("UPDATE sessions SET created_at = now() - interval '31 days', expires_at = now() - interval '1 second'");
    expect((await f.call("GET", "/v1/me", { token })).status).toBe(401);
  });

  it("an API key can't be signed out as a session", async () => {
    const f = await fixture();
    expect((await f.call<ApiError>("DELETE", "/v1/sessions/current")).body.error.code).toBe("not_a_session");
  });

  it("a session manages keys like an admin key", async () => {
    const { f, token } = await session();
    const made = await f.call<CreatedKey>("POST", "/v1/keys", { token, body: { name: "router", scope: "ingest" } });
    expect(made.status).toBe(201);
    expect((await f.call<Me>("GET", "/v1/me", { token: made.body.token })).body.key.scope).toBe("ingest");
  });

  it("a write re-checks the session under the account's lock: one signed out after it authenticated can't make a key", async () => {
    const { f, token, accountId } = await session();
    const p = (await defaultAuth.authenticate(token, f.db))!;
    expect(p).toMatchObject({ via: "session", accountId, scope: "admin" });
    await f.db.query("UPDATE sessions SET state = 'revoked', revoked_at = now()");
    expect(await f.db.tx((q) => defaultAuth.stillAuthorized(p, q))).toBe(false);
    // A key principal with the session's id doesn't pass as a session, nor the other way round.
    expect(await f.db.tx((q) => defaultAuth.stillAuthorized({ ...p, via: "key" }, q))).toBe(false);
  });
});

describe("migration 2 on a database with data", () => {
  it("adds users and sessions without touching existing accounts and keys", async () => {
    const db = await emptyDb();
    await migrate(db, MIGRATIONS.slice(0, 1));
    const { accountId, adminToken } = await createAccount(db, "before");
    const ingest = await db.tx(async (q) => (await createKey(q, accountId, "r", "ingest")).token);
    expect(await migrate(db, MIGRATIONS.slice(0, 2))).toEqual([2]);
    expect(await defaultAuth.authenticate(adminToken, db)).toMatchObject({ accountId, via: "key", scope: "admin" });
    expect(await defaultAuth.authenticate(ingest, db)).toMatchObject({ accountId, via: "key", scope: "ingest" });
  });
});
