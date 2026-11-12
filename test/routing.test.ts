import { describe, expect, it } from "vitest";
import { fakeProvider, router, clock } from "./fake.js";
import { NoProviderAvailableError } from "../src/index.js";

const quotaError = () => Object.assign(new Error("Payment required: out of credits"), { status: 402 });

describe("free-first routing", () => {
  it("orders lanes: monthly free, one-time free, self-hosted, then paid", async () => {
    const providers = [
      fakeProvider({ id: "paid", tier: { kind: "none" }, rate: 0.000001 }),
      fakeProvider({ id: "local", tier: { kind: "unlimited" }, selfHosted: true, rate: 0 }),
      fakeProvider({ id: "onetime", tier: { kind: "one-time-credit", usd: 100 } }),
      fakeProvider({ id: "monthly", tier: { kind: "monthly-credit", usd: 30 } }),
    ];
    const { router: r } = router(providers, { allowPaid: true });
    const p = await r.plan();
    expect(p.ordered.map((e) => [e.provider, e.lane])).toEqual([
      ["monthly", "free-recurring"],
      ["onetime", "free-one-time"],
      ["local", "self-hosted"],
      ["paid", "paid"],
    ]);
  });

  it("never routes to paid usage unless allowPaid is on", async () => {
    const { router: r } = router([fakeProvider({ id: "paid", tier: { kind: "none" } })]);
    const p = await r.plan();
    expect(p.ordered).toEqual([]);
    expect(p.skipped[0]?.reason).toMatch(/paid usage is off/);
    await expect(r.create()).rejects.toBeInstanceOf(NoProviderAvailableError);
  });

  it("among monthly tiers, burns the one with the most at risk before its reset first", async () => {
    const c = clock(Date.UTC(2026, 10, 25)); // 6 days before the reset
    const big = fakeProvider({ id: "big", tier: { kind: "monthly-credit", usd: 30 } });
    const small = fakeProvider({ id: "small", tier: { kind: "monthly-credit", usd: 5 } });
    const { router: r } = router([small, big], {}, c);
    // Spend most of "big" this month: its remaining share drops below "small"'s.
    const sbx = await r.create({ providers: ["big"], cpu: 100, timeoutSec: 86400 });
    c.advance(200_000); // 200 s × $0.001/s = $0.20 spent on "big"
    await sbx.kill();
    const p = await r.plan();
    expect(p.ordered[0]!.provider).toBe("small");
  });

  it("skips providers missing a needed capability, an image they can't run, or keys", async () => {
    const { router: r } = router([
      fakeProvider({ id: "noports", tier: { kind: "monthly-credit", usd: 10 } }),
      fakeProvider({ id: "nokey", tier: { kind: "monthly-credit", usd: 10 }, env: ["NOKEY_API_KEY"], capabilities: ["ports", "customImage"] }),
      fakeProvider({ id: "good", tier: { kind: "one-time-credit", usd: 10 }, capabilities: ["ports", "customImage"] }),
    ]);
    const p = await r.plan({ needs: ["ports"], image: "python:3.12" });
    expect(p.ordered.map((e) => e.provider)).toEqual(["good"]);
    expect(Object.fromEntries(p.skipped.map((s) => [s.provider, s.reason]))).toMatchObject({
      noports: expect.stringMatching(/lacks ports/),
      nokey: expect.stringMatching(/not configured.*NOKEY_API_KEY/),
    });
  });

  it("a timeout over the free tier's lifetime cap is not free", async () => {
    const { router: r } = router([fakeProvider({ id: "e", tier: { kind: "one-time-credit", usd: 100 }, maxLifetimeSec: 3600 })]);
    expect((await r.plan({ timeoutSec: 3600 })).ordered).toHaveLength(1);
    const over = await r.plan({ timeoutSec: 7200 });
    expect(over.ordered).toHaveLength(0);
    expect(over.skipped[0]!.reason).toMatch(/3600s limit/);
  });

  it("free credit runs out from metered usage, then the next provider takes over", async () => {
    const c = clock();
    const a = fakeProvider({ id: "a", tier: { kind: "one-time-credit", usd: 1 }, rate: 0.001 }); // $3.6/h at 1 vCPU
    const b = fakeProvider({ id: "b", tier: { kind: "one-time-credit", usd: 1 }, rate: 0.001 });
    const { router: r } = router([a, b], { providers: { a: { priority: 1 } } }, c);
    const first = await r.create({ timeoutSec: 3600 });
    expect(first.provider).toBe("a");
    c.advance(1500 * 1000); // 1500 s × $0.001 = $1.50 > $1 credit
    await first.kill();
    const status = await r.status();
    expect(status.find((s) => s.id === "a")!.free.state).toBe("exhausted");
    expect((await r.create()).provider).toBe("b");
  });

  it("usedBeforeUsd counts credit spent before the router was tracking", async () => {
    const { router: r } = router([fakeProvider({ id: "e2b", tier: { kind: "one-time-credit", usd: 100 } })], {
      providers: { e2b: { usedBeforeUsd: 100 } },
    });
    expect((await r.status())[0]!.free.state).toBe("exhausted");
  });

  it("a monthly tier comes back at the reset", async () => {
    const c = clock(Date.UTC(2026, 10, 30, 23, 0));
    const m = fakeProvider({ id: "m", tier: { kind: "monthly-credit", usd: 1 }, rate: 0.01 });
    const { router: r } = router([m], {}, c);
    const s = await r.create({ timeoutSec: 3000 });
    c.advance(200_000);
    await s.kill();
    expect((await r.status())[0]!.free.state).toBe("exhausted");
    c.set(Date.UTC(2026, 11, 1, 0, 0, 1));
    expect((await r.status())[0]!.free.state).toBe("available");
  });
});

describe("failover", () => {
  it("a quota refusal marks the provider exhausted and the request moves on", async () => {
    const a = fakeProvider({ id: "a", tier: { kind: "monthly-credit", usd: 30 }, createErrors: [quotaError()] });
    const b = fakeProvider({ id: "b", tier: { kind: "one-time-credit", usd: 30 } });
    const { router: r, clock: c } = router([a, b]);
    const sbx = await r.create();
    expect(sbx.provider).toBe("b");
    expect(sbx.route.map((x) => [x.provider, x.outcome, x.kind])).toEqual([
      ["a", "failed", "quota"],
      ["b", "created", undefined],
    ]);
    // Monthly tier: exhausted until the reset, so the next request skips it without asking.
    const p = await r.plan();
    expect(p.ordered.map((e) => e.provider)).toEqual(["b"]);
    expect(p.skipped[0]!.reason).toMatch(/used up/);
    c.set(Date.UTC(2026, 11, 1, 0, 0, 1));
    expect((await r.plan()).ordered[0]!.provider).toBe("a");
  });

  it("a rate limit cools the provider down for a minute", async () => {
    const a = fakeProvider({ id: "a", tier: { kind: "monthly-credit", usd: 30 }, createErrors: [Object.assign(new Error("Too many requests"), { status: 429 })] });
    const b = fakeProvider({ id: "b", tier: { kind: "one-time-credit", usd: 30 } });
    const { router: r, clock: c } = router([a, b]);
    expect((await r.create()).provider).toBe("b");
    expect((await r.plan()).ordered[0]!.provider).toBe("b");
    c.advance(61_000);
    expect((await r.plan()).ordered[0]!.provider).toBe("a");
  });

  it("the failed attempt is recorded as failed, never left creating", async () => {
    const a = fakeProvider({ id: "a", tier: { kind: "monthly-credit", usd: 30 }, createErrors: [new Error("ECONNRESET")] });
    const { router: r } = router([a]);
    await expect(r.create()).rejects.toBeInstanceOf(NoProviderAvailableError);
    const all = await r.list({ all: true });
    expect(all.map((s) => s.state)).toEqual(["failed"]);
  });
});

describe("concurrency caps", () => {
  it("parallel creates can't overrun a free tier's concurrency (guard in the write)", async () => {
    const capped = fakeProvider({ id: "capped", tier: { kind: "monthly-credit", usd: 30 }, concurrency: 1, createDelayMs: 20 });
    const other = fakeProvider({ id: "other", tier: { kind: "one-time-credit", usd: 30 } });
    const { router: r } = router([capped, other]);
    const made = await Promise.all([r.create(), r.create(), r.create()]);
    expect(made.filter((s) => s.provider === "capped")).toHaveLength(1);
    expect(made.filter((s) => s.provider === "other")).toHaveLength(2);
  });

  it("a killed sandbox frees its slot", async () => {
    const capped = fakeProvider({ id: "capped", tier: { kind: "monthly-credit", usd: 30 }, concurrency: 1 });
    const { router: r } = router([capped]);
    const s = await r.create();
    await expect(r.create()).rejects.toBeInstanceOf(NoProviderAvailableError);
    await s.kill();
    expect((await r.create()).provider).toBe("capped");
  });
});

describe("paid budget", () => {
  it("stops paid routing once maxPaidUsdPerMonth is spent", async () => {
    const c = clock();
    const paid = fakeProvider({ id: "paid", tier: { kind: "none" }, rate: 0.001 });
    const { router: r } = router([paid], { allowPaid: true, maxPaidUsdPerMonth: 1 }, c);
    const s = await r.create({ timeoutSec: 3600 });
    c.advance(1100 * 1000);
    await s.kill();
    const p = await r.plan();
    expect(p.ordered).toHaveLength(0);
    expect(p.skipped[0]!.reason).toMatch(/paid budget/);
  });
});

describe("providers that don't enforce the timeout", () => {
  it("are killed at the deadline, and the remote sweep reaps any kill that failed", async () => {
    const c = clock();
    const p = fakeProvider({ id: "nottl", tier: { kind: "monthly-credit", usd: 30 } });
    p.info.enforcesTimeout = false;
    const alive = new Set<string>();
    const realCreate = p.create.bind(p);
    p.create = async (...args) => {
      const out = await realCreate(...args);
      alive.add(out.providerSandboxId);
      return out;
    };
    let failKill = true;
    p.kill = async (id) => {
      if (failKill) throw new Error("ECONNRESET");
      alive.delete(id);
    };
    p.listAlive = async () => [...alive];
    const { router: r } = router([p], {}, c);
    const s = await r.create({ timeoutSec: 60 });
    c.advance(61_000);
    // The kill at expiry fails: the ledger still closes it at the deadline...
    expect((await r.sweep()).reaped).toBe(0);
    expect((await s.info())!.state).toBe("stopped");
    expect(alive.has(s.providerSandboxId)).toBe(true);
    // ...and the remote sweep deletes what is still alive at the provider.
    failKill = false;
    expect((await r.sweep({ remote: true })).reaped).toBe(1);
    expect(alive.size).toBe(0);
  });
});
