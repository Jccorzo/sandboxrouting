// Test helpers: a real Postgres for every test (PGlite in memory by default; set
// TEST_DATABASE_URL to a postgres:// server to run the same tests there, each in its own
// database), an account with keys, and events made by the router's real reporter.

import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { inject } from "vitest";
import pg from "pg";
import { createApp, type AppOptions } from "../src/app.js";
import { pgDb, pgliteDb, type Db } from "../src/db.js";
import { createKey, createAccount } from "../src/keys.js";
import { migrate } from "../src/migrate.js";
import type { BackPlugins } from "../src/plugins.js";
import type { GitHubConfig } from "../src/github.js";
import type { SecretBox } from "../src/secrets.js";
import { MemoryOutbox } from "../../src/report/outbox.js";
import { observeInto, providerSnapshots } from "../../src/report/reporter.js";
import { MemoryLedger, SandboxRouter, defineProvider, parseConfig, type FreeTier, type ProviderAdapter } from "../../src/index.js";
import type { IngestResponse, WireEvent } from "../src/router.js";

const opened: (() => Promise<void>)[] = [];

/** Each test gets its own copy of a database global-setup.ts made once for the run. */
async function pgliteCopy(which: "blank" | "migrated"): Promise<Db> {
  const paths = inject("pgliteTemplates");
  const db = await pgliteDb(undefined, paths ? { loadDataDir: new Blob([await readFile(paths[which])]) } : {});
  if (!paths && which === "migrated") await migrate(db);
  opened.push(() => db.close());
  return db;
}

/** An empty database, migrations not yet run. */
export async function emptyDb(): Promise<Db> {
  const url = process.env["TEST_DATABASE_URL"];
  if (!url) return pgliteCopy("blank");
  const name = `sbr_test_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const u = new URL(url);
  u.pathname = `/${name}`;
  const db = pgDb(u.toString(), 5);
  opened.push(async () => {
    await db.close();
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await c.end();
  });
  return db;
}

/** A database with every migration run. */
export async function freshDb(): Promise<Db> {
  if (!process.env["TEST_DATABASE_URL"]) return pgliteCopy("migrated");
  const db = await emptyDb();
  await migrate(db);
  return db;
}

export async function closeAll(): Promise<void> {
  while (opened.length) await opened.pop()!().catch(() => undefined);
}

export interface Fixture {
  db: Db;
  app: ReturnType<typeof createApp>;
  accountId: string;
  admin: string;
  ingestKey: string;
  call: <T = unknown>(method: string, path: string, opts?: { token?: string; body?: unknown }) => Promise<{ status: number; body: T }>;
  send: (install: string, events: WireEvent[], token?: string) => Promise<{ status: number; body: IngestResponse }>;
}

export async function fixture(opts: { plugins?: BackPlugins; sweepToken?: string; db?: Db; github?: GitHubConfig; secrets?: SecretBox; operatorToken?: string } = {}): Promise<Fixture> {
  const db = opts.db ?? (await freshDb());
  const { accountId, adminToken } = await createAccount(db, "test");
  const ingestKey = await db.tx(async (q) => (await createKey(q, accountId, "router", "ingest")).token);
  const appOpts: AppOptions = { db, log: () => undefined, ...(opts.plugins ? { plugins: opts.plugins } : {}), ...(opts.sweepToken ? { sweepToken: opts.sweepToken } : {}), ...(opts.github ? { github: opts.github } : {}), ...(opts.secrets ? { secrets: opts.secrets } : {}), ...(opts.operatorToken ? { operatorToken: opts.operatorToken } : {}) };
  const app = createApp(appOpts);
  const call: Fixture["call"] = async (method, path, o = {}) => {
    const res = await app.request(path, {
      method,
      headers: { ...(o.token === undefined ? { authorization: `Bearer ${adminToken}` } : o.token ? { authorization: `Bearer ${o.token}` } : {}), "content-type": "application/json" },
      ...(o.body === undefined ? {} : { body: typeof o.body === "string" ? o.body : JSON.stringify(o.body) }),
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : undefined) as never };
  };
  const send: Fixture["send"] = (install, events, token = ingestKey) => call("POST", "/v1/ingest", { token, body: { install, events } });
  return { db, app, accountId, admin: adminToken, ingestKey, call, send };
}

// ------------------------------------------------------------------ the router side

export function fakeProvider(id: string, tier: FreeTier, o: { rate?: number; errors?: unknown[]; gibRate?: number } = {}): ProviderAdapter {
  let n = 0;
  const errors = [...(o.errors ?? [])];
  return defineProvider({
    info: {
      id,
      name: id.toUpperCase(),
      homepage: "https://example.test",
      env: [],
      capabilities: ["pause"],
      freeTier: { tier },
      pricing: { vcpuSecondUsd: o.rate ?? 0.00002, gibSecondUsd: o.gibRate ?? 0.000002, defaultCpu: 1, defaultMemoryMiB: 1024 },
    },
    async create() {
      const err = errors.shift();
      if (err) throw err;
      return { providerSandboxId: `${id}-${++n}` };
    },
    async exec() {
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    async kill() {},
    async pause() {},
    async resume() {},
  });
}

/** A router with a controllable clock, and a reporter's observation of its ledger to turn into events. */
export function routerSide(providers: ProviderAdapter[], config: unknown = {}, start = Date.now()) {
  let t = start;
  const now = () => t;
  const cfg = parseConfig(config);
  const ledger = new MemoryLedger();
  const router = new SandboxRouter({ providers, config: cfg, ledger, env: {}, now });
  const outbox = new MemoryOutbox();
  const snapshots = providerSnapshots(providers, cfg, {});
  return {
    router,
    now,
    advance: (ms: number) => {
      t += ms;
    },
    set: (ms: number) => {
      t = ms;
    },
    /** Events for whatever changed since the last call, as the reporter would queue them (and clears them from its outbox). */
    async events(metadataKeys: string[] = []): Promise<WireEvent[]> {
      return outbox.update(async (box) => {
        observeInto(box, await ledger.read(), now(), metadataKeys, snapshots);
        const out = box.pending;
        box.pending = [];
        return out;
      });
    },
    async install(): Promise<string> {
      return (await outbox.read()).installId;
    },
  };
}

export const HOUR = 3_600_000;
export const DAY = 86_400_000;
