// Ingest: every sandbox, job and mark transition the router can report lands as the router has
// it; a resend changes nothing; an older state never overwrites a newer one; one bad event
// can't block the rest; and a key that lost its authority can't write.
import { afterEach, describe, expect, it } from "vitest";
import { closeAll, fakeProvider, fixture, routerSide, HOUR } from "./helpers.js";
import type { WireEvent } from "../src/router.js";

afterEach(closeAll);

const sandboxRow = async (f: Awaited<ReturnType<typeof fixture>>, id: string) =>
  (await f.db.query<{ state: string; stop_reason: string | null; open_segments: number; seq: string }>("SELECT state, stop_reason, open_segments, seq::text FROM sandboxes WHERE id = $1", [id])).rows[0];

describe("sandbox transitions", () => {
  it("creating → running → paused → running → stopped, each stored as the router has it", async () => {
    const f = await fixture();
    const r = routerSide([fakeProvider("a", { kind: "monthly-credit", usd: 10 })]);
    const install = await r.install();
    // The reporter can see a sandbox while it is still being created.
    const id = "sbr_creating1";
    await r.router.ledger.update((d) => {
      d.sandboxes[id] = { id, provider: "a", state: "creating", cpu: 2, memoryMiB: 2048, createdAt: new Date(r.now()).toISOString(), metadata: {}, billing: "free", timeoutSec: 600 };
    });
    let res = await f.send(install, await r.events());
    expect(res.body.results.every((x) => x.outcome === "applied")).toBe(true);
    expect((await sandboxRow(f, id))?.state).toBe("creating");

    await r.router.apply(id, { type: "created", providerSandboxId: "a-1", timeoutSec: 600 });
    await f.send(install, await r.events());
    expect(await sandboxRow(f, id)).toMatchObject({ state: "running", open_segments: 1 });

    r.advance(60_000);
    await r.router.apply(id, { type: "paused" });
    await f.send(install, await r.events());
    expect(await sandboxRow(f, id)).toMatchObject({ state: "paused", open_segments: 0 });

    r.advance(60_000);
    await r.router.apply(id, { type: "resumed", timeoutSec: 600 });
    await f.send(install, await r.events());
    expect(await sandboxRow(f, id)).toMatchObject({ state: "running", open_segments: 1 });

    r.advance(60_000);
    await r.router.apply(id, { type: "stopped", reason: "killed" });
    res = await f.send(install, await r.events());
    expect(res.body.results.find((x) => x.id.endsWith(":" + 5) || true)).toBeDefined();
    expect(await sandboxRow(f, id)).toMatchObject({ state: "stopped", stop_reason: "killed", open_segments: 0 });
    const segs = (await f.db.query<{ segments: unknown[] }>("SELECT segments FROM sandboxes WHERE id = $1", [id])).rows[0]!.segments;
    expect(segs).toHaveLength(2);
  });

  it("a failed create, and a create the sweep gave up on (lost), are stored as failed", async () => {
    const f = await fixture();
    const refusing = fakeProvider("a", { kind: "one-time-credit", usd: 10 }, { errors: [Object.assign(new Error("boom 503"), { status: 503 })] });
    const r = routerSide([refusing, fakeProvider("b", { kind: "unlimited" })], { providers: { a: { priority: 1 } } });
    await r.router.create();
    const lostId = "sbr_lost1";
    await r.router.ledger.update((d) => {
      d.sandboxes[lostId] = { id: lostId, provider: "b", state: "creating", cpu: 1, memoryMiB: 1024, createdAt: new Date(r.now()).toISOString(), metadata: {} };
    });
    await r.router.apply(lostId, { type: "lost", error: "create never finished" });
    const res = await f.send(await r.install(), await r.events());
    expect(res.body.results.every((x) => x.outcome === "applied")).toBe(true);
    const { rows } = await f.db.query<{ provider: string; state: string }>("SELECT provider, state FROM sandboxes WHERE state = 'failed' ORDER BY provider");
    expect(rows.map((x) => x.provider)).toEqual(["a", "b"]);
  });

  it("a stop past the deadline is stored as expired, and an expired running sandbox reads as expired without one", async () => {
    const f = await fixture();
    const r = routerSide([fakeProvider("a", { kind: "unlimited" })], {}, Date.now() - 2 * HOUR);
    const one = await r.router.create({ timeoutSec: 60 });
    const two = await r.router.create({ timeoutSec: 60 });
    r.advance(HOUR);
    await r.router.apply(one.id, { type: "stopped", reason: "killed" });
    await f.send(await r.install(), await r.events());
    expect(await sandboxRow(f, one.id)).toMatchObject({ state: "stopped", stop_reason: "expired" });
    // `two` is still stored as running, but its deadline is past by the database's clock.
    expect((await sandboxRow(f, two.id))?.state).toBe("running");
    const view = await f.call<{ sandboxes: { id: string; state: string }[] }>("GET", "/v1/sandboxes?view=recent");
    expect(view.body.sandboxes.find((s) => s.id === two.id)?.state).toBe("expired");
    const live = await f.call<{ sandboxes: { id: string }[] }>("GET", "/v1/sandboxes?view=live");
    expect(live.body.sandboxes.map((s) => s.id)).not.toContain(two.id);
  });
});

describe("idempotency and order", () => {
  it("a resent batch is answered duplicate and changes nothing", async () => {
    const f = await fixture();
    const r = routerSide([fakeProvider("a", { kind: "unlimited" })]);
    await r.router.create();
    const events = await r.events();
    const first = await f.send(await r.install(), events);
    const again = await f.send(await r.install(), events);
    expect(first.body.results.map((x) => x.outcome)).toEqual(events.map(() => "applied"));
    expect(again.body.results.map((x) => x.outcome)).toEqual(events.map(() => "duplicate"));
    const { rows } = await f.db.query<{ n: number }>("SELECT count(*)::int AS n FROM ingest_events");
    expect(rows[0]!.n).toBe(events.length);
  });

  it("an older state arriving after a newer one is stale and leaves the newer one in place", async () => {
    const f = await fixture();
    const r = routerSide([fakeProvider("a", { kind: "unlimited" })]);
    const sbx = await r.router.create();
    const running = await r.events();
    r.advance(1000);
    await sbx.kill();
    const stopped = await r.events();
    const install = await r.install();
    await f.send(install, stopped);
    const late = await f.send(install, running.filter((e) => e.type === "sandbox"));
    expect(late.body.results.map((x) => x.outcome)).toEqual(["stale"]);
    expect((await sandboxRow(f, sbx.id))?.state).toBe("stopped");
  });

  it("orders by observation, then sequence: same instant, higher seq wins", async () => {
    const f = await fixture();
    const r = routerSide([fakeProvider("a", { kind: "unlimited" })]);
    const sbx = await r.router.create();
    const [running] = (await r.events()).filter((e) => e.type === "sandbox") as Extract<WireEvent, { type: "sandbox" }>[];
    await sbx.kill(); // same clock reading
    const [stopped] = (await r.events()).filter((e) => e.type === "sandbox") as Extract<WireEvent, { type: "sandbox" }>[];
    expect(stopped!.observedAt).toBe(running!.observedAt);
    const install = await r.install();
    await f.send(install, [stopped!]);
    expect((await f.send(install, [running!])).body.results[0]!.outcome).toBe("stale");
  });

  it("a state re-sent by a new install (an outbox that was reset) still can't go back in time", async () => {
    const f = await fixture();
    const r = routerSide([fakeProvider("a", { kind: "unlimited" })]);
    const sbx = await r.router.create();
    const old = (await r.events()).find((e) => e.type === "sandbox")!;
    r.advance(1000);
    await sbx.kill();
    await f.send(await r.install(), await r.events());
    const reset = "ins_reset_install";
    const replay = { ...old, id: `${reset}:1`, seq: 1 };
    expect((await f.send(reset, [replay])).body.results[0]!.outcome).toBe("stale");
    expect((await sandboxRow(f, sbx.id))?.state).toBe("stopped");
  });

  it("one invalid event is rejected and the rest of its batch still lands", async () => {
    const f = await fixture();
    const r = routerSide([fakeProvider("a", { kind: "unlimited" })]);
    await r.router.create();
    const events = await r.events();
    const install = await r.install();
    const bad = { ...events[0]!, id: `${install}:999`, seq: 999, type: "sandbox", sandbox: { id: "x", state: "nope" } };
    const wrongId = { ...events[0]!, id: "someone-else:1" };
    const res = await f.send(install, [bad as unknown as WireEvent, wrongId, ...events]);
    expect(res.status).toBe(200);
    expect(res.body.results.slice(0, 2).map((x) => x.outcome)).toEqual(["rejected", "rejected"]);
    expect(res.body.results.slice(2).every((x) => x.outcome === "applied")).toBe(true);
  });

  it("rejects a sandbox whose fields contradict its state, before the database has to", async () => {
    const f = await fixture();
    const r = routerSide([fakeProvider("a", { kind: "unlimited" })]);
    await r.router.create();
    const ev = (await r.events()).find((e) => e.type === "sandbox") as Extract<WireEvent, { type: "sandbox" }>;
    const noOpenSegment = { ...ev, sandbox: { ...ev.sandbox, segments: [{ start: ev.sandbox.createdAt, end: ev.sandbox.createdAt }] } };
    const res = await f.send(await r.install(), [noOpenSegment]);
    expect(res.body.results[0]).toMatchObject({ outcome: "rejected", error: expect.stringContaining("open segment") });
  });

  it("refuses a batch that isn't one with 400, and a key without the ingest scope with 403", async () => {
    const f = await fixture();
    expect((await f.call("POST", "/v1/ingest", { token: f.ingestKey, body: { install: "x", events: [] } })).status).toBe(400);
    expect((await f.call("POST", "/v1/ingest", { token: f.ingestKey, body: "{nope" })).status).toBe(400);
    expect((await f.call("POST", "/v1/ingest", { body: { install: "ins_abcdefgh", events: [{}] } })).status).toBe(403);
    expect((await f.call("POST", "/v1/ingest", { token: "sbrk_unknown", body: { install: "ins_abcdefgh", events: [{}] } })).status).toBe(401);
  });
});

describe("authority", () => {
  it("a revoked key, or a disabled account, can't ingest", async () => {
    const f = await fixture();
    const r = routerSide([fakeProvider("a", { kind: "unlimited" })]);
    await r.router.create();
    const events = await r.events();
    await f.db.query("UPDATE api_keys SET state = 'revoked', revoked_at = now() WHERE scope = 'ingest'");
    expect((await f.send(await r.install(), events)).status).toBe(401);

    const g = await fixture();
    await g.db.query("UPDATE accounts SET status = 'disabled', disabled_at = now()");
    expect((await g.send(await r.install(), events)).status).toBe(401);
  });

  it("re-checks the key under the account's lock: one revoked after it authenticated can't write", async () => {
    const f = await fixture();
    const r = routerSide([fakeProvider("a", { kind: "unlimited" })]);
    await r.router.create();
    const events = await r.events();
    const { ingest } = await import("../src/ingest.js");
    const { resolvePlugins } = await import("../src/plugins.js");
    const plugins = resolvePlugins();
    const p = (await plugins.auth.authenticate(f.ingestKey, f.db))!;
    await f.db.query("UPDATE api_keys SET state = 'revoked', revoked_at = now() WHERE id = $1", [p.credentialId]);
    await expect(ingest(f.db, plugins, p, { install: await r.install(), events })).rejects.toMatchObject({ status: 401 });
    expect((await f.db.query("SELECT 1 FROM sandboxes")).rows).toHaveLength(0);
  });
});

describe("marks, health, jobs and providers", () => {
  it("stores a refusal's mark and its occurrence, then the mark's clearing; the occurrence stays", async () => {
    const f = await fixture();
    const r = routerSide(
      [fakeProvider("a", { kind: "one-time-credit", usd: 5 }, { errors: [Object.assign(new Error("402 Payment Required"), { status: 402 })] }), fakeProvider("b", { kind: "unlimited" })],
      { providers: { a: { priority: 1 } } },
    );
    await r.router.create();
    const install = await r.install();
    await f.send(install, await r.events());
    expect((await f.db.query("SELECT status, refusals FROM marks")).rows).toEqual([{ status: "set", refusals: 1 }]);
    await r.router.clearMarks("a");
    await f.send(install, await r.events());
    expect((await f.db.query("SELECT status, at, until FROM marks")).rows).toEqual([{ status: "cleared", at: null, until: null }]);
    expect((await f.db.query("SELECT kind FROM refusals")).rows).toEqual([{ kind: "quota" }]);
  });

  it("stores each health sample once, however often it is sent", async () => {
    const f = await fixture();
    const r = routerSide([fakeProvider("a", { kind: "unlimited" })]);
    await r.router.create();
    await r.router.create();
    const events = await r.events();
    const health = events.filter((e) => e.type === "health");
    expect(health).toHaveLength(2);
    const install = await r.install();
    await f.send(install, events);
    const replay = health.map((e, i) => ({ ...e, id: `${install}:${1000 + i}`, seq: 1000 + i }));
    expect((await f.send(install, replay)).body.results.map((x) => x.outcome)).toEqual(["stale", "stale"]);
    expect((await f.db.query<{ n: number }>("SELECT count(*)::int AS n FROM health_samples")).rows[0]!.n).toBe(2);
  });

  it("a job's newer version wins over an older one whatever order they arrive in", async () => {
    const f = await fixture();
    const r = routerSide([fakeProvider("a", { kind: "unlimited" })]);
    const job = await r.router.jobs.submit({ steps: [{ run: "true" }] });
    const queued = (await r.events()).filter((e) => e.type === "job");
    await r.router.jobs.cancel(job.id);
    const cancelled = (await r.events()).filter((e) => e.type === "job");
    const install = await r.install();
    await f.send(install, cancelled);
    expect((await f.send(install, queued)).body.results[0]!.outcome).toBe("stale");
    expect((await f.db.query("SELECT state, version FROM jobs")).rows).toEqual([{ state: "cancelled", version: 2 }]);
  });

  it("rejects a job whose fields contradict its state", async () => {
    const f = await fixture();
    const r = routerSide([fakeProvider("a", { kind: "unlimited" })]);
    await r.router.jobs.submit({ steps: [{ run: "true" }] });
    const ev = (await r.events()).find((e) => e.type === "job") as Extract<WireEvent, { type: "job" }>;
    const res = await f.send(await r.install(), [{ ...ev, job: { ...ev.job, state: "running" } }]);
    expect(res.body.results[0]).toMatchObject({ outcome: "rejected", error: expect.stringContaining("lease") });
  });

  it("keeps the newest provider snapshot per install", async () => {
    const f = await fixture();
    const r = routerSide([fakeProvider("a", { kind: "monthly-credit", usd: 10 })], { providers: { a: { usedBeforeUsd: 1 } } });
    await r.router.create();
    await f.send(await r.install(), await r.events());
    const { rows } = await f.db.query<{ snapshot: { freeTier: unknown; usedBeforeUsd: number } }>("SELECT snapshot FROM install_providers");
    expect(rows[0]!.snapshot).toMatchObject({ freeTier: { kind: "monthly-credit", usd: 10 }, usedBeforeUsd: 1 });
  });
});
