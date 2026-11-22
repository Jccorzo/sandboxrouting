// API keys: made and shown once, revoked once, never the last admin key, and a revoked key or
// disabled account stops working at once. Bootstrap from the environment is idempotent and
// never brings back a revoked key.
import { afterEach, describe, expect, it } from "vitest";
import { closeAll, fixture, freshDb } from "./helpers.js";
import { bootstrap, hashToken } from "../src/keys.js";
import type { ApiError, CreatedKey, KeysView, Me } from "../src/api.js";

afterEach(closeAll);

describe("keys", () => {
  it("makes a key, shows its token once, lists it by prefix, and the token works", async () => {
    const f = await fixture();
    const made = await f.call<CreatedKey>("POST", "/v1/keys", { body: { name: "ci", scope: "ingest" } });
    expect(made.status).toBe(201);
    expect(made.body.token).toMatch(/^sbrk_/);
    const list = await f.call<KeysView>("GET", "/v1/keys");
    const listed = list.body.keys.find((k) => k.id === made.body.key.id)!;
    expect(listed).toMatchObject({ name: "ci", scope: "ingest", state: "active", prefix: made.body.token.slice(0, 11) });
    expect(JSON.stringify(list.body)).not.toContain(made.body.token);
    expect((await f.call<Me>("GET", "/v1/me", { token: made.body.token })).body.key.scope).toBe("ingest");
    // Only the hash is stored.
    const { rows } = await f.db.query<{ hash: Buffer }>("SELECT hash FROM api_keys WHERE id = $1", [made.body.key.id]);
    expect(Buffer.from(rows[0]!.hash).equals(hashToken(made.body.token))).toBe(true);
  });

  it("revokes once; a second revoke is a 409 that shows how it stands; the revoked token stops working", async () => {
    const f = await fixture();
    const made = await f.call<CreatedKey>("POST", "/v1/keys", { body: { name: "old", scope: "ingest" } });
    const first = await f.call<{ key: { state: string } }>("POST", `/v1/keys/${made.body.key.id}/revoke`);
    expect(first).toMatchObject({ status: 200, body: { key: { state: "revoked" } } });
    const second = await f.call<ApiError>("POST", `/v1/keys/${made.body.key.id}/revoke`);
    expect(second.status).toBe(409);
    expect(second.body.error).toMatchObject({ code: "already_revoked", key: { state: "revoked" } });
    expect((await f.call("GET", "/v1/me", { token: made.body.token })).status).toBe(401);
  });

  it("won't revoke the account's last admin key", async () => {
    const f = await fixture();
    const me = await f.call<Me>("GET", "/v1/me");
    const res = await f.call<ApiError>("POST", `/v1/keys/${me.body.key.id}/revoke`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("last_admin_key");
  });

  it("of two admins revoking each other at once, one wins and one admin key is left", async () => {
    const f = await fixture();
    const other = await f.call<CreatedKey>("POST", "/v1/keys", { body: { name: "second admin", scope: "admin" } });
    const me = await f.call<Me>("GET", "/v1/me");
    const [a, b] = await Promise.all([
      f.call("POST", `/v1/keys/${other.body.key.id}/revoke`),
      f.call("POST", `/v1/keys/${me.body.key.id}/revoke`, { token: other.body.token }),
    ]);
    // The loser's key is re-checked under the account's lock and found revoked.
    expect([a.status, b.status].sort()).toEqual([200, 401]);
    const { rows } = await f.db.query<{ n: number }>("SELECT count(*)::int AS n FROM api_keys WHERE scope = 'admin' AND state = 'active'");
    expect(rows[0]!.n).toBe(1);
  });

  it("an ingest key can't read or manage keys", async () => {
    const f = await fixture();
    expect((await f.call("GET", "/v1/usage", { token: f.ingestKey })).status).toBe(403);
    expect((await f.call("POST", "/v1/keys", { token: f.ingestKey, body: { name: "x", scope: "admin" } })).status).toBe(403);
  });

  it("a disabled account's keys stop working", async () => {
    const f = await fixture();
    await f.db.query("UPDATE accounts SET status = 'disabled', disabled_at = now()");
    expect((await f.call("GET", "/v1/me")).status).toBe(401);
  });
});

describe("bootstrap from the environment", () => {
  const admin = "admin-token-0123456789abcdefghij";
  it("makes the first account and its keys once, and never brings a revoked key back", async () => {
    const db = await freshDb();
    await bootstrap(db, { admin, ingest: "ingest-token-0123456789abcdefghij" });
    await bootstrap(db, { admin, ingest: "ingest-token-0123456789abcdefghij" });
    expect((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM accounts")).rows[0]!.n).toBe(1);
    expect((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM api_keys")).rows[0]!.n).toBe(2);
    await db.query("UPDATE api_keys SET state = 'revoked', revoked_at = now() WHERE scope = 'admin'");
    await bootstrap(db, { admin });
    expect((await db.query("SELECT state FROM api_keys WHERE scope = 'admin'")).rows).toEqual([{ state: "revoked" }]);
  });

  it("refuses a short token", async () => {
    const db = await freshDb();
    await expect(bootstrap(db, { admin: "short" })).rejects.toThrow(/24 characters/);
  });
});
