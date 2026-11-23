// Saved provider keys and config: sealed per row with the account, provider and version in the
// associated data; never returned; every save a compare-and-set on the version the caller saw.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { closeAll, fixture, type Fixture } from "./helpers.js";
import { KmsSecretBox, LocalSecretBox, credentialAad, open, seal, type SecretBox } from "../src/secrets.js";
import { toRouterConfig } from "../../src/hosted/config.js";
import type { ApiError, ConnectionResult, CreatedKey, CredentialsView, RouterConfigView } from "../src/api.js";

afterEach(closeAll);

const KEY = randomBytes(32).toString("base64");
const box = () => new LocalSecretBox(KEY);
const SECRET = "e2b_live_0123456789abcdef";

describe("secret boxes", () => {
  it("asks Cloud Run's metadata server for its service account's token at the documented path", async () => {
    const asked: { url: string; flavor: string | null }[] = [];
    const f = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).startsWith("http://metadata.google.internal/")) {
        asked.push({ url: String(url), flavor: new Headers(init?.headers).get("metadata-flavor") });
        return Response.json({ access_token: "tok", expires_in: 3600 });
      }
      return Response.json({ ciphertext: Buffer.from("w").toString("base64") });
    }) as typeof fetch;
    await new KmsSecretBox("projects/p/locations/l/keyRings/r/cryptoKeys/k", { fetch: f }).wrap(Buffer.alloc(32), Buffer.from("aad"));
    expect(asked).toEqual([{ url: "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token", flavor: "Google" }]);
  });

  it("opens only with the same account, provider and version", async () => {
    const b = box();
    const sealed = await seal(b, "hello", credentialAad("acct", "e2b", 1));
    expect(await open(b, sealed, credentialAad("acct", "e2b", 1))).toBe("hello");
    await expect(open(b, sealed, credentialAad("other", "e2b", 1))).rejects.toThrow();
    await expect(open(b, sealed, credentialAad("acct", "daytona", 1))).rejects.toThrow();
    await expect(open(b, sealed, credentialAad("acct", "e2b", 2))).rejects.toThrow();
  });

  it("still opens rows sealed before a key rotation, with the old key listed", async () => {
    const old = randomBytes(32).toString("base64");
    const sealed = await seal(new LocalSecretBox(old), "kept", credentialAad("a", "e2b", 1));
    expect(await open(new LocalSecretBox(KEY, [old]), sealed, credentialAad("a", "e2b", 1))).toBe("kept");
    await expect(open(new LocalSecretBox(KEY), sealed, credentialAad("a", "e2b", 1))).rejects.toThrow(/no key/);
  });

  it("refuses a KEK that isn't 32 bytes", () => {
    expect(() => new LocalSecretBox(Buffer.alloc(16).toString("base64"))).toThrow(/32 bytes/);
  });

  it("wraps through Cloud KMS's REST API with the associated data", async () => {
    const kek = randomBytes(32);
    const seen: string[] = [];
    const fakeKms = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push(String(url));
      const body = JSON.parse(String(init?.body)) as Record<string, string>;
      const aad = Buffer.from(body["additionalAuthenticatedData"]!, "base64");
      if (String(url).endsWith(":encrypt")) {
        const iv = randomBytes(12);
        const c = createCipheriv("aes-256-gcm", kek, iv).setAAD(aad);
        const ct = Buffer.concat([c.update(Buffer.from(body["plaintext"]!, "base64")), c.final()]);
        return Response.json({ ciphertext: Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64") });
      }
      const raw = Buffer.from(body["ciphertext"]!, "base64");
      try {
        const d = createDecipheriv("aes-256-gcm", kek, raw.subarray(0, 12)).setAAD(aad);
        d.setAuthTag(raw.subarray(12, 28));
        return Response.json({ plaintext: Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("base64") });
      } catch {
        return new Response("bad", { status: 400 });
      }
    }) as typeof fetch;
    const name = "projects/p/locations/global/keyRings/r/cryptoKeys/k";
    const kms: SecretBox = new KmsSecretBox(name, { fetch: fakeKms, accessToken: async () => "t" });
    const sealed = await seal(kms, "via kms", credentialAad("a", "e2b", 1));
    expect(sealed.kekId).toBe(`kms:${name}`);
    expect(await open(kms, sealed, credentialAad("a", "e2b", 1))).toBe("via kms");
    await expect(open(kms, sealed, credentialAad("a", "e2b", 2))).rejects.toThrow(/400/);
    expect(seen[0]).toBe(`https://cloudkms.googleapis.com/v1/${name}:encrypt`);
  });
});

async function vault(): Promise<Fixture & { box: LocalSecretBox }> {
  const b = box();
  return { ...(await fixture({ secrets: b })), box: b };
}

const put = (f: Fixture, provider: string, values: Record<string, unknown>, expectedVersion: number) =>
  f.call<ConnectionResult & ApiError>("PUT", `/v1/credentials/${provider}`, { body: { values, expectedVersion } });

describe("provider credentials", () => {
  it("lists the hosted catalog with nothing saved, and says when saving is off", async () => {
    const f = await vault();
    const list = await f.call<CredentialsView>("GET", "/v1/credentials");
    expect(list.body.enabled).toBe(true);
    const e2b = list.body.providers.find((p) => p.id === "e2b")!;
    expect(e2b).toMatchObject({ name: "E2B", connection: { state: "none", version: 0 }, fields: [{ name: "E2B_API_KEY", kind: "secret" }] });

    const off = await fixture({ db: f.db });
    expect((await off.call<CredentialsView>("GET", "/v1/credentials")).body.enabled).toBe(false);
    expect((await put(off, "e2b", { E2B_API_KEY: SECRET }, 0)).body.error.code).toBe("secrets_off");
  });

  it("saves sealed, shows only hints, and the row opens with its own account, provider and version", async () => {
    const f = await vault();
    const saved = await put(f, "e2b", { E2B_API_KEY: SECRET }, 0);
    expect(saved.status).toBe(200);
    expect(saved.body.connection).toMatchObject({ state: "active", version: 1, hints: { E2B_API_KEY: "…cdef" } });
    const list = await f.call<CredentialsView>("GET", "/v1/credentials");
    expect(JSON.stringify(list.body)).not.toContain(SECRET);
    const { rows } = await f.db.query<{ ciphertext: Buffer; wrapped_key: Buffer; kek_id: string; updated_by: string }>("SELECT * FROM provider_credentials");
    expect(JSON.stringify(rows)).not.toContain(SECRET);
    expect(rows[0]!.updated_by).toMatch(/^key:/);
    const sealed = { ciphertext: Buffer.from(rows[0]!.ciphertext), wrapped: Buffer.from(rows[0]!.wrapped_key), kekId: rows[0]!.kek_id };
    expect(JSON.parse(await open(f.box, sealed, credentialAad(f.accountId, "e2b", 1)))).toEqual({ E2B_API_KEY: SECRET });
    await expect(open(f.box, sealed, credentialAad(f.accountId, "e2b", 2))).rejects.toThrow();
  });

  it("is a compare-and-set: a save from a stale page gets 409 with the row as it stands", async () => {
    const f = await vault();
    expect((await put(f, "e2b", { E2B_API_KEY: SECRET }, 0)).body.connection.version).toBe(1);
    const stale = await put(f, "e2b", { E2B_API_KEY: "e2b_other_key_9999" }, 0);
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatchObject({ code: "stale", connection: { state: "active", version: 1, hints: { E2B_API_KEY: "…cdef" } } });
    expect((await put(f, "e2b", { E2B_API_KEY: "e2b_other_key_9999" }, 1)).body.connection).toMatchObject({ version: 2, hints: { E2B_API_KEY: "…9999" } });
    // A save naming a version that never existed doesn't create one.
    expect((await put(f, "daytona", { DAYTONA_API_KEY: SECRET }, 5)).status).toBe(409);
    expect((await f.db.query("SELECT 1 FROM provider_credentials WHERE provider = 'daytona'")).rows).toHaveLength(0);
  });

  it("removes once, keeping the version; a stale remove gets 409; saving again goes on from there", async () => {
    const f = await vault();
    await put(f, "e2b", { E2B_API_KEY: SECRET }, 0);
    expect((await f.call<ApiError>("DELETE", "/v1/credentials/e2b?expectedVersion=0")).status).toBe(409);
    const removed = await f.call<ConnectionResult>("DELETE", "/v1/credentials/e2b?expectedVersion=1");
    expect(removed.body.connection).toMatchObject({ state: "removed", version: 2 });
    const { rows } = await f.db.query<{ ciphertext: Buffer | null }>("SELECT ciphertext FROM provider_credentials");
    expect(rows[0]!.ciphertext).toBeNull();
    expect((await f.call<ApiError>("DELETE", "/v1/credentials/e2b?expectedVersion=2")).body.error.code).toBe("stale");
    expect((await put(f, "e2b", { E2B_API_KEY: SECRET }, 2)).body.connection).toMatchObject({ state: "active", version: 3 });
  });

  it("refuses providers outside the catalog, unknown variables, URL overrides, and bad settings", async () => {
    const f = await vault();
    expect((await put(f, "docker", {}, 0)).status).toBe(404);
    expect((await put(f, "e2b", { E2B_API_KEY: SECRET, E2B_API_URL: "http://169.254.169.254" }, 0)).body.error.message).toMatch(/doesn't take E2B_API_URL/);
    expect((await put(f, "e2b", {}, 0)).body.error.message).toMatch(/required/);
    expect((await put(f, "e2b", { E2B_API_KEY: "a\nb" }, 0)).status).toBe(400);
    expect((await put(f, "daytona", { DAYTONA_API_KEY: SECRET, DAYTONA_TARGET: "../x" }, 0)).body.error.message).toMatch(/Region/);
    expect((await put(f, "daytona", { DAYTONA_API_KEY: SECRET, DAYTONA_TARGET: "eu" }, 0)).body.connection).toMatchObject({ hints: { DAYTONA_TARGET: "eu" } });
  });

  it("needs an admin key or a session: an ingest key can't read or save", async () => {
    const f = await vault();
    expect((await f.call("GET", "/v1/credentials", { token: f.ingestKey })).status).toBe(403);
    expect((await f.call("PUT", "/v1/credentials/e2b", { token: f.ingestKey, body: { values: { E2B_API_KEY: SECRET }, expectedVersion: 0 } })).status).toBe(403);
  });

  it("refuses a save from a key revoked after it authenticated (re-checked under the account's lock)", async () => {
    const f = await vault();
    const made = await f.call<CreatedKey>("POST", "/v1/keys", { body: { name: "second", scope: "admin" } });
    const plugins = (await import("../src/plugins.js")).resolvePlugins();
    const p = (await plugins.auth.authenticate(made.body.token, f.db))!;
    await f.db.query("UPDATE api_keys SET state = 'revoked', revoked_at = now() WHERE id = $1", [p.credentialId]);
    expect((await f.call("PUT", "/v1/credentials/e2b", { token: made.body.token, body: { values: { E2B_API_KEY: SECRET }, expectedVersion: 0 } })).status).toBe(401);
    expect((await f.db.query("SELECT 1 FROM provider_credentials")).rows).toHaveLength(0);
  });
});

describe("migration 3 on a database with data", () => {
  it("adds the vault without touching accounts, keys or sessions", async () => {
    const { emptyDb } = await import("./helpers.js");
    const { migrate, MIGRATIONS } = await import("../src/migrate.js");
    const { createAccount } = await import("../src/keys.js");
    const { defaultAuth, signIn } = await import("../src/sessions.js");
    const { allowEverything } = await import("../src/plugins.js");
    const db = await emptyDb();
    await migrate(db, MIGRATIONS.slice(0, 2));
    const { accountId, adminToken } = await createAccount(db, "before");
    const s = await signIn(db, allowEverything, { githubId: 3, login: "pre" });
    expect(await migrate(db)).toEqual([3]);
    expect(await defaultAuth.authenticate(adminToken, db)).toMatchObject({ accountId });
    if (s.outcome !== "signed-in") throw new Error(s.outcome);
    expect(await defaultAuth.authenticate(s.token, db)).toMatchObject({ via: "session" });
  });
});

describe("routing config", () => {
  const putConfig = (f: Fixture, config: unknown, expectedVersion: number) => f.call<RouterConfigView & ApiError>("PUT", "/v1/config", { body: { config, expectedVersion } });

  it("starts empty at version 0, saves, and a stale save gets 409 with the config as it stands", async () => {
    const f = await vault();
    expect((await f.call<RouterConfigView>("GET", "/v1/config")).body).toMatchObject({ config: {}, version: 0 });
    const first = await putConfig(f, { routing: { strategy: "cheapest" }, allowPaid: true, maxPaidUsdPerMonth: 20 }, 0);
    expect(first.body).toMatchObject({ version: 1, config: { allowPaid: true } });
    const stale = await putConfig(f, { allowPaid: false }, 0);
    expect(stale.status).toBe(409);
    expect(stale.body.error.config).toMatchObject({ version: 1, config: { routing: { strategy: "cheapest" } } });
    expect((await putConfig(f, { allowPaid: false }, 1)).body.version).toBe(2);
  });

  it("refuses what doesn't belong on the hosted router", async () => {
    const f = await vault();
    for (const bad of [
      { serverToken: "x" },
      { report: { url: "https://x.example", token: "t" } },
      { selfHosted: "first" },
      { providers: { docker: { enabled: true } } },
      { providers: { e2b: { options: { url: "http://10.0.0.1" } } } },
      { allowPaid: "yes" },
      [],
    ]) {
      expect((await putConfig(f, bad, 0)).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await putConfig(f, { providers: { e2b: { enabled: false, priority: 10 } } }, 0)).status).toBe(200);
  });

  it("runs with self-hosted providers off whatever was stored", () => {
    expect(toRouterConfig({ allowPaid: true }).selfHosted).toBe("never");
    expect(toRouterConfig({ selfHosted: "first", serverToken: "x" } as Record<string, unknown>)).toMatchObject({ selfHosted: "never" });
    expect(toRouterConfig({ serverToken: "x" }).serverToken).toBeUndefined();
  });
});
