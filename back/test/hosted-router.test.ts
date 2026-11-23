// The hosted router end to end: router keys call MCP and REST, each account's router runs on its
// own saved keys and its own ledger, every ledger write lands in the dashboard's tables in the
// same transaction, and a key revoked mid-request can't record what it made.
import { afterEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { closeAll, fixture, type Fixture } from "./helpers.js";
import { createAccount, createKey } from "../src/keys.js";
import { LocalSecretBox } from "../src/secrets.js";
import { createHostedServer, type HostedOptions } from "../src/hosted-router/server.js";
import { PostgresLedger } from "../src/hosted-router/ledger.js";
import { defineProvider, type ProviderAdapter } from "../../src/index.js";
import type { ConnectionResult, SandboxView } from "../src/api.js";

const servers: Server[] = [];
afterEach(async () => {
  while (servers.length) await new Promise((r) => servers.pop()!.close(r));
  await closeAll();
});

const box = new LocalSecretBox(randomBytes(32).toString("base64"));

/** A provider in the hosted catalog's place (id e2b, its variable), recording which key each call used. */
function fakeE2b(o: { onCreate?: () => Promise<void>; enforcesTimeout?: boolean } = {}) {
  let n = 0;
  const calls: { op: string; key: string | undefined; id?: string }[] = [];
  const alive = new Set<string>();
  const adapter: ProviderAdapter = defineProvider({
    info: {
      id: "e2b",
      name: "E2B",
      homepage: "https://example.test",
      env: ["E2B_API_KEY"],
      capabilities: [],
      freeTier: { tier: { kind: "unlimited" } },
      pricing: { vcpuSecondUsd: 0.00001, gibSecondUsd: 0, defaultCpu: 1, defaultMemoryMiB: 1024 },
      ...(o.enforcesTimeout === false ? { enforcesTimeout: false } : {}),
    },
    async create(_spec, ctx) {
      const id = `box-${++n}`;
      calls.push({ op: "create", key: ctx.env["E2B_API_KEY"], id });
      alive.add(id);
      await o.onCreate?.();
      return { providerSandboxId: id };
    },
    async exec(id, command, _o, ctx) {
      calls.push({ op: "exec", key: ctx.env["E2B_API_KEY"], id });
      return { stdout: `${id}: ${command}\n`, stderr: "", exitCode: 0 };
    },
    async kill(id, ctx) {
      calls.push({ op: "kill", key: ctx.env["E2B_API_KEY"], id });
      alive.delete(id);
    },
    async listAlive() {
      return [...alive];
    },
  });
  return { adapter, calls, alive };
}

interface Setup {
  f: Fixture;
  url: string;
  routerKey: string;
  fake: ReturnType<typeof fakeE2b>;
  clock: { t: number };
}

async function setup(o: { fake?: ReturnType<typeof fakeE2b>; hosted?: Partial<HostedOptions>; key?: string } = {}): Promise<Setup> {
  const f = await fixture({ secrets: box });
  const routerKey = await f.db.tx(async (q) => (await createKey(q, f.accountId, "mcp", "router")).token);
  expect((await f.call("PUT", "/v1/credentials/e2b", { body: { values: { E2B_API_KEY: o.key ?? "e2b_key_of_account_a" }, expectedVersion: 0 } })).status).toBe(200);
  const fake = o.fake ?? fakeE2b();
  const clock = { t: Date.now() };
  const server = createHostedServer({ db: f.db, secrets: box, adapters: () => [fake.adapter], sweepToken: "sweep-token", log: () => undefined, now: () => clock.t, ...o.hosted });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { f, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, routerKey, fake, clock };
}

async function rest<T = unknown>(s: { url: string }, method: string, path: string, token: string | undefined, body?: unknown) {
  const res = await fetch(`${s.url}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: (text ? JSON.parse(text) : undefined) as T };
}

async function mcpClient(s: { url: string }, token: string) {
  const client = new Client({ name: "test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${s.url}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return client;
}

const toolText = (r: unknown) => ((r as { content: { text: string }[] }).content[0]!.text);
const toolJson = <T>(r: unknown) => JSON.parse(toolText(r)) as T;

describe("MCP over streamable HTTP", () => {
  it("creates with the account's own saved key, shows it on the dashboard at once, and kills it", async () => {
    const s = await setup();
    const client = await mcpClient(s, s.routerKey);
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).toEqual(expect.arrayContaining(["create_sandbox", "run_command", "kill_sandbox", "list_connections", "connect_provider", "set_config"]));
    // Jobs need a process that lives on; the hosted router has none.
    expect(tools).not.toContain("run_job");

    const made = toolJson<{ id: string; provider: string }>(await client.callTool({ name: "create_sandbox", arguments: { timeoutSec: 600 } }));
    expect(made.provider).toBe("e2b");
    expect(s.fake.calls[0]).toMatchObject({ op: "create", key: "e2b_key_of_account_a" });
    expect(toolText(await client.callTool({ name: "run_command", arguments: { id: made.id, command: "echo hi" } }))).toContain("box-1: echo hi");

    // The ledger write and the dashboard's row committed together: no delivery to wait for.
    const live = await s.f.call<{ sandboxes: SandboxView[] }>("GET", "/v1/sandboxes");
    expect(live.body.sandboxes).toEqual([expect.objectContaining({ id: made.id, provider: "e2b", state: "running" })]);

    expect(toolText(await client.callTool({ name: "kill_sandbox", arguments: { id: made.id } }))).toBe(`killed ${made.id}`);
    const recent = await s.f.call<{ sandboxes: SandboxView[] }>("GET", "/v1/sandboxes?view=recent");
    expect(recent.body.sandboxes).toEqual([expect.objectContaining({ id: made.id, state: "stopped" })]);
    await client.close();
  });

  it("saves and removes keys with compare-and-set, never showing a whole key", async () => {
    const s = await setup();
    const client = await mcpClient(s, s.routerKey);
    const list = toolJson<{ id: string; connection: { state: string; version: number; hints?: Record<string, string> } }[]>(await client.callTool({ name: "list_connections", arguments: {} }));
    const e2b = list.find((p) => p.id === "e2b")!;
    expect(e2b.connection).toMatchObject({ state: "active", version: 1, hints: { E2B_API_KEY: "…nt_a" } });
    expect(JSON.stringify(list)).not.toContain("e2b_key_of_account_a");

    const stale = await client.callTool({ name: "connect_provider", arguments: { provider: "e2b", values: { E2B_API_KEY: "e2b_new_key_123" }, expectedVersion: 0 } });
    expect(stale.isError).toBe(true);
    expect(toolJson<{ connection: { version: number } }>(stale).connection.version).toBe(1);

    const saved = await client.callTool({ name: "connect_provider", arguments: { provider: "e2b", values: { E2B_API_KEY: "e2b_new_key_123" }, expectedVersion: 1 } });
    expect(toolJson<ConnectionResult>(saved).connection).toMatchObject({ state: "active", version: 2 });
    // The next request runs on the new key: the cache is keyed by the credential's version.
    await client.callTool({ name: "create_sandbox", arguments: {} });
    expect(s.fake.calls.at(-1)).toMatchObject({ op: "create", key: "e2b_new_key_123" });

    const bad = await client.callTool({ name: "connect_provider", arguments: { provider: "e2b", values: { E2B_API_URL: "http://169.254.169.254" }, expectedVersion: 2 } });
    expect(bad.isError).toBe(true);
    await client.close();
  });

  it("is stateless: GET and DELETE are refused, and a request without a key gets a Bearer challenge", async () => {
    const s = await setup();
    expect((await rest(s, "GET", "/mcp", s.routerKey)).status).toBe(405);
    expect((await rest(s, "DELETE", "/mcp", s.routerKey)).status).toBe(405);
    const anon = await rest(s, "POST", "/mcp", undefined, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(anon.status).toBe(401);
    expect(anon.headers.get("www-authenticate")).toMatch(/^Bearer/);
  });
});

describe("REST", () => {
  it("serves the router's API without jobs, to router and admin keys only", async () => {
    const s = await setup();
    const made = await rest<{ id: string; provider: string }>(s, "POST", "/v1/sandboxes", s.routerKey, { timeoutSec: 300 });
    expect(made.status).toBe(201);
    expect((await rest(s, "GET", `/v1/sandboxes/${made.body.id}`, s.routerKey)).body).toMatchObject({ id: made.body.id, state: "running" });
    expect((await rest(s, "GET", "/v1/jobs", s.routerKey)).status).toBe(404);
    expect((await rest(s, "GET", "/v1/sandboxes", s.f.admin)).status).toBe(200);
    expect((await rest(s, "GET", "/v1/sandboxes", s.f.ingestKey)).status).toBe(403);
    await s.f.db.query("UPDATE api_keys SET state = 'revoked', revoked_at = now() WHERE scope = 'router'");
    expect((await rest(s, "GET", "/v1/sandboxes", s.routerKey)).status).toBe(401);
  });

  it("refuses a create past the account's live limit", async () => {
    const s = await setup({ hosted: { maxLive: 1 } });
    expect((await rest(s, "POST", "/v1/sandboxes", s.routerKey, {})).status).toBe(201);
    const second = await rest<{ error: string }>(s, "POST", "/v1/sandboxes", s.routerKey, {});
    expect(second.status).toBe(402);
    expect(second.body.error).toMatch(/at most 1 at once/);
  });

  it("a provider whose key was removed is no longer used", async () => {
    const s = await setup();
    expect((await s.f.call("DELETE", "/v1/credentials/e2b?expectedVersion=1")).status).toBe(200);
    expect((await rest(s, "POST", "/v1/sandboxes", s.routerKey, {})).status).toBe(503);
    expect(s.fake.calls).toEqual([]);
  });
});

describe("accounts are apart", () => {
  it("another account's router has its own keys and its own ledger", async () => {
    const s = await setup();
    const b = await createAccount(s.f.db, "b");
    const bKey = await s.f.db.tx(async (q) => (await createKey(q, b.accountId, "mcp", "router")).token);
    const put = await s.f.call("PUT", "/v1/credentials/e2b", { token: b.adminToken, body: { values: { E2B_API_KEY: "e2b_key_of_account_b" }, expectedVersion: 0 } });
    expect(put.status).toBe(200);

    const a1 = await rest<{ id: string }>(s, "POST", "/v1/sandboxes", s.routerKey, {});
    const b1 = await rest<{ id: string }>(s, "POST", "/v1/sandboxes", bKey, {});
    expect(s.fake.calls.map((c) => c.key)).toEqual(["e2b_key_of_account_a", "e2b_key_of_account_b"]);
    expect((await rest<SandboxView[]>(s, "GET", "/v1/sandboxes", s.routerKey)).body.map((v) => v.id)).toEqual([a1.body.id]);
    expect((await rest<SandboxView[]>(s, "GET", "/v1/sandboxes", bKey)).body.map((v) => v.id)).toEqual([b1.body.id]);
    // B can't reach A's sandbox by its id.
    expect((await rest(s, "GET", `/v1/sandboxes/${a1.body.id}`, bKey)).status).toBe(404);
    expect((await rest(s, "DELETE", `/v1/sandboxes/${a1.body.id}`, bKey)).status).toBe(404);
  });
});

describe("authority under the lock", () => {
  it("a router key revoked while its create was on the way can't record the box, and the box is deleted", async () => {
    const ref: { db?: Fixture["db"] } = {};
    const fake = fakeE2b({ onCreate: () => ref.db!.query("UPDATE api_keys SET state = 'revoked', revoked_at = now() WHERE scope = 'router'").then(() => undefined) });
    const s = await setup({ fake });
    ref.db = s.f.db;
    const res = await rest<{ error: string }>(s, "POST", "/v1/sandboxes", s.routerKey, {});
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(fake.calls.map((c) => c.op)).toEqual(["create", "kill"]);
    const { rows } = await s.f.db.query<{ state: string }>("SELECT state FROM sandboxes");
    expect(rows.map((r) => r.state)).not.toContain("running");
  });
});

describe("the Postgres ledger", () => {
  it("serializes concurrent updates on an account", async () => {
    const f = await fixture();
    const ledger = new PostgresLedger(f.db, f.accountId);
    await Promise.all(
      Array.from({ length: 8 }, () =>
        ledger.update((d) => {
          const n = (d.archivedUsd["x"] ??= {});
          n["2026-11"] = (n["2026-11"] ?? 0) + 1;
        }),
      ),
    );
    expect((await ledger.read()).archivedUsd).toEqual({ x: { "2026-11": 8 } });
  });

  it("a write that fails rolls back with what it reported: no ledger change and no dashboard row", async () => {
    const f = await fixture();
    let reported = 0;
    const ledger = new PostgresLedger(f.db, f.accountId, {
      afterWrite: async (q) => {
        reported++;
        await q.query("INSERT INTO installs (account_id, id) VALUES ($1, 'ins_hosted')", [f.accountId]);
        throw new Error("the dashboard write failed");
      },
    });
    await expect(
      ledger.update((d) => {
        d.marks.push({ provider: "e2b", kind: "auth", at: new Date().toISOString(), until: new Date(Date.now() + 60_000).toISOString() });
      }),
    ).rejects.toThrow(/dashboard write failed/);
    expect(reported).toBe(1);
    expect((await ledger.read()).marks).toEqual([]);
    expect((await f.db.query("SELECT 1 FROM installs WHERE id = 'ins_hosted'")).rows).toHaveLength(0);
  });

  it("a read-only update writes nothing", async () => {
    const f = await fixture();
    await new PostgresLedger(f.db, f.accountId).update((d) => Object.keys(d.sandboxes).length);
    expect((await f.db.query("SELECT 1 FROM router_ledgers")).rows).toHaveLength(0);
  });
});

describe("the sweep", () => {
  it("needs the sweep token, and deletes boxes past a deadline their provider doesn't enforce", async () => {
    const fake = fakeE2b({ enforcesTimeout: false });
    const s = await setup({ fake });
    const made = await rest<{ id: string }>(s, "POST", "/v1/sandboxes", s.routerKey, { timeoutSec: 60 });
    expect(made.status).toBe(201);
    expect((await rest(s, "POST", "/internal/sweep", "wrong")).status).toBe(401);
    expect((await rest(s, "POST", "/internal/sweep", "sweep-token")).body).toMatchObject({ accounts: 1, stopped: 0, reaped: 0 });
    s.clock.t += 61_000;
    expect((await rest(s, "POST", "/internal/sweep", "sweep-token")).body).toMatchObject({ accounts: 1, stopped: 1, errors: 0 });
    expect(fake.calls.filter((c) => c.op === "kill").map((c) => c.key)).toEqual(["e2b_key_of_account_a"]);
    expect(fake.alive.size).toBe(0);
  });
});
