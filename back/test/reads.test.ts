// Reads: every derived value is the router's own, computed with the database's clock. Where the
// router can say the same thing about the same ledger, the test asks it and compares.
import { afterEach, describe, expect, it } from "vitest";
import { closeAll, fakeProvider, fixture, routerSide, DAY, HOUR } from "./helpers.js";
import { transitionJob } from "../../src/core/jobs/state.js";
import { jobView, type JobRow } from "../src/derive.js";
import type { JobsView, ProvidersView, RefusalsView, SandboxesView, UsageView } from "../src/api.js";

afterEach(closeAll);

const midnight = (t: number) => Date.parse(new Date(t).toISOString().slice(0, 10) + "T00:00:00Z");

describe("usage over time", () => {
  it("counts sandboxes, sandbox-hours, memory GiB-hours and USD per UTC day, splitting a sandbox that crosses midnight", async () => {
    const f = await fixture();
    const today = midnight(Date.now());
    // 22:00 two days ago until 02:00 yesterday: 2 h on each day. 2 vCPU, 4 GiB.
    const r = routerSide([fakeProvider("a", { kind: "none" }, { rate: 0.00001, gibRate: 0.000001 })], { allowPaid: true }, today - 2 * DAY + 22 * HOUR);
    const sbx = await r.router.create({ cpu: 2, memoryMiB: 4096, timeoutSec: 6 * 3600 });
    r.advance(4 * HOUR);
    await sbx.kill();
    await f.send(await r.install(), await r.events());

    const res = await f.call<UsageView>("GET", "/v1/usage?days=3");
    expect(res.status).toBe(200);
    const byDay = Object.fromEntries(res.body.points.map((p) => [p.day, p]));
    const d2 = new Date(today - 2 * DAY).toISOString().slice(0, 10);
    const d1 = new Date(today - DAY).toISOString().slice(0, 10);
    const perHourUsd = 3600 * (2 * 0.00001 + 4 * 0.000001);
    for (const d of [d2, d1]) {
      expect(byDay[d]).toMatchObject({ provider: "a", sandboxes: 1 });
      expect(byDay[d]!.sandboxHours).toBeCloseTo(2, 6);
      expect(byDay[d]!.gibHours).toBeCloseTo(8, 6);
      expect(byDay[d]!.usd).toBeCloseTo(2 * perHourUsd, 9);
    }
    expect(res.body.totals.sandboxHours).toBeCloseTo(4, 6);
    expect(res.body.totals.gibHours).toBeCloseTo(16, 6);
  });

  it("says USD is unknown, not zero, for a provider back has no prices for yet", async () => {
    const f = await fixture();
    const r = routerSide([fakeProvider("a", { kind: "unlimited" })], {}, Date.now() - HOUR);
    const sbx = await r.router.create();
    r.advance(10 * 60_000);
    await sbx.kill();
    await f.send(await r.install(), (await r.events()).filter((e) => e.type !== "provider"));
    // Two days: an hour ago is yesterday (UTC) during the first hour of the day.
    const res = await f.call<UsageView>("GET", "/v1/usage?days=2");
    expect(res.body.points[0]!.usd).toBeNull();
    expect(res.body.totals.usdUnknown).toBe(true);
  });
});

describe("providers", () => {
  it("free usage left and this month's spend are the router's own numbers", async () => {
    const f = await fixture();
    const r = routerSide([fakeProvider("a", { kind: "monthly-credit", usd: 5 }, { rate: 0.0001 })], {}, Date.now() - 3 * HOUR);
    const sbx = await r.router.create({ cpu: 2, memoryMiB: 2048, timeoutSec: 7200 });
    r.advance(2 * HOUR);
    await sbx.kill();
    await f.send(await r.install(), await r.events());

    const res = await f.call<ProvidersView>("GET", "/v1/providers");
    const a = res.body.providers.find((p) => p.provider === "a")!;
    const [mine] = await r.router.status();
    expect(a.free).toMatchObject({ state: "available", unit: "usd" });
    expect(mine!.free).toMatchObject({ state: "available" });
    expect((a.free as { remaining: number }).remaining).toBeCloseTo((mine!.free as { remaining: number }).remaining, 9);
    expect(a.monthUsd).toBeCloseTo(7200 * (2 * 0.0001 + 2 * 0.000002), 9);
    expect(a.live).toBe(0);
  });

  it("opens the circuit after repeated transient failures, as the router does", async () => {
    const f = await fixture();
    const err = () => Object.assign(new Error("503 Service Unavailable"), { status: 503 });
    const r = routerSide([fakeProvider("a", { kind: "unlimited" }, { errors: [err(), err(), err()] }), fakeProvider("b", { kind: "unlimited" })], { providers: { a: { priority: 1 } } });
    for (let i = 0; i < 3; i++) await r.router.create();
    await f.send(await r.install(), await r.events());
    const res = await f.call<ProvidersView>("GET", "/v1/providers");
    const a = res.body.providers.find((p) => p.provider === "a")!;
    expect(a.health).toMatchObject({ circuit: "open", consecutiveFailures: 3 });
    expect(res.body.providers.find((p) => p.provider === "b")!.health.circuit).toBe("closed");
  });

  it("a quota mark reads as in force, then half-open once its until passes by the database's clock", async () => {
    const f = await fixture();
    const quota = () => Object.assign(new Error("402 credit used up"), { status: 402 });
    // Two days ago: a one-time credit is checked again a day after its first refusal.
    const r = routerSide([fakeProvider("a", { kind: "one-time-credit", usd: 5 }, { errors: [quota()] }), fakeProvider("b", { kind: "unlimited" })], { providers: { a: { priority: 1 } } }, Date.now() - 2 * DAY);
    await r.router.create();
    await f.send(await r.install(), await r.events());
    const res = await f.call<ProvidersView>("GET", "/v1/providers");
    const a = res.body.providers.find((p) => p.provider === "a")!;
    expect(a.quota.state).toBe("half-open");
    expect(a.marks[0]).toMatchObject({ kind: "quota", standing: "half-open", refusals: 1 });

    const g = await fixture();
    const fresh = routerSide([fakeProvider("a", { kind: "one-time-credit", usd: 5 }, { errors: [quota()] }), fakeProvider("b", { kind: "unlimited" })], { providers: { a: { priority: 1 } } });
    await fresh.router.create();
    await g.send(await fresh.install(), await fresh.events());
    const now = (await g.call<ProvidersView>("GET", "/v1/providers")).body.providers.find((p) => p.provider === "a")!;
    expect(now.quota.state).toBe("refused");
    expect(now.free.state).toBe("exhausted");
    expect(now.marks[0]!.standing).toBe("in-force");
  });
});

describe("sandboxes and jobs", () => {
  it("lists live sandboxes with their cost and memory, newest first", async () => {
    const f = await fixture();
    const r = routerSide([fakeProvider("a", { kind: "unlimited" })], {}, Date.now() - 30 * 60_000);
    await r.router.create({ cpu: 1, memoryMiB: 2048, timeoutSec: 3600, metadata: { team: "infra" } });
    r.advance(60_000);
    const second = await r.router.create({ cpu: 1, memoryMiB: 1024, timeoutSec: 3600 });
    await f.send(await r.install(), await r.events(["team"]));
    const res = await f.call<SandboxesView>("GET", "/v1/sandboxes?view=live");
    expect(res.body.sandboxes.map((s) => s.id)[0]).toBe(second.id);
    expect(res.body.sandboxes[1]).toMatchObject({ state: "running", memoryMiB: 2048, metadata: { team: "infra" } });
    expect(res.body.sandboxes[1]!.gibHours).toBeGreaterThan(0.9);
  });

  it("a job whose runner's lease lapsed reads as orphaned", async () => {
    const f = await fixture();
    const r = routerSide([fakeProvider("a", { kind: "unlimited" })], {}, Date.now() - 10 * 60_000);
    const job = await r.router.jobs.submit({ steps: [{ run: "true" }] });
    await r.router.ledger.update((d) => {
      d.jobs[job.id] = transitionJob(d.jobs[job.id]!, { type: "claim", lease: { owner: "runner-1", until: new Date(r.now() + 60_000).toISOString() } }, r.now(), "runner-1");
    });
    await f.send(await r.install(), await r.events());
    const res = await f.call<JobsView>("GET", "/v1/jobs");
    expect(res.body.jobs[0]).toMatchObject({ id: job.id, state: "orphaned" });
  });

  it("turns a job's placements into moves: from, to and why", () => {
    const t = "2026-11-20T10:00:00.000Z";
    const row: JobRow = {
      id: "job_1",
      install_id: "ins_1",
      state: "succeeded",
      cursor: 2,
      steps: 2,
      migrations: 1,
      created_at: t,
      updated_at: t,
      ended_at: t,
      lease_until: null,
      box: null,
      reason: null,
      placements: [
        { sandboxId: "s1", provider: "e2b", placedAt: t, endedAt: "2026-11-20T10:05:00.000Z", endReason: "free-credit" },
        { sandboxId: "s2", provider: "modal", placedAt: "2026-11-20T10:05:01.000Z", endedAt: "2026-11-20T10:09:00.000Z", endReason: "finished" },
      ],
    };
    expect(jobView(row, Date.parse(t)).moves).toEqual([
      { at: "2026-11-20T10:05:00.000Z", fromProvider: "e2b", fromSandbox: "s1", toProvider: "modal", toSandbox: "s2", reason: "free-credit" },
    ]);
  });
});

describe("refusals", () => {
  it("lists refusals, marks in force and failed creates per day", async () => {
    const f = await fixture();
    const r = routerSide(
      [fakeProvider("a", { kind: "monthly-credit", usd: 5 }, { errors: [Object.assign(new Error("429 slow down"), { status: 429 })] }), fakeProvider("b", { kind: "unlimited" })],
      { providers: { a: { priority: 1 } } },
    );
    await r.router.create();
    await f.send(await r.install(), await r.events());
    const res = await f.call<RefusalsView>("GET", "/v1/refusals?days=7");
    expect(res.body.refusals).toEqual([expect.objectContaining({ provider: "a", kind: "rate_limit" })]);
    expect(res.body.inForce).toEqual([expect.objectContaining({ provider: "a", kind: "rate_limit", standing: "in-force" })]);
    expect(res.body.failedCreates).toEqual([expect.objectContaining({ provider: "a", count: 1 })]);
  });
});
