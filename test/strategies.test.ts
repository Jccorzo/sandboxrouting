import { describe, expect, it } from "vitest";
import { fakeProvider, router } from "./fake.js";
import { parseConfig } from "../src/core/config.js";
import { emptyLedger, type HealthSample, type LedgerData } from "../src/core/ledger.js";
import { isLive } from "../src/core/state.js";
import { committed, effectivePricing, freeStatus, liveCount, paidSpendThisMonth, ratePerSecond } from "../src/core/metering.js";
import { eligibility, plan, type Plan, type PolicyInput } from "../src/core/policy.js";
import { StrategyRegistry } from "../src/core/routing/registry.js";
import { balanced, cheapest, fastest, freeFirst, spread } from "../src/core/routing/strategies.js";
import type { RoutingStrategy } from "../src/core/routing/types.js";
import type { FreeTier, Isolation, ProviderAdapter, SandboxSpec } from "../src/core/types.js";
import { SandboxRouterError } from "../src/core/errors.js";

const NOW = Date.UTC(2026, 10, 11, 12, 0, 0); // 19.5 days before the monthly reset
const iso = (ms: number) => new Date(ms).toISOString();

function input(adapters: ProviderAdapter[], config: unknown = {}, spec: SandboxSpec = {}, data = emptyLedger(), now = NOW): PolicyInput {
  return {
    adapters,
    config: parseConfig(config),
    data,
    spec: { cpu: 2, memoryMiB: 2048, timeoutSec: 300, env: {}, metadata: {}, ...spec },
    now,
    ctxFor: () => ({ env: {}, options: {} }),
  };
}

const order = (p: Plan) => p.ordered.map((e) => e.provider);
const reasons = (p: Plan) => Object.fromEntries(p.skipped.map((s) => [s.provider, s.reason]));

/** A finished box that ran `seconds` up to `end`: spends free credit (and paid budget). */
function used(data: LedgerData, provider: string, seconds: number, cpu = 1, end = NOW): void {
  const id = `${provider}-${Object.keys(data.sandboxes).length}`;
  const start = iso(end - seconds * 1000);
  data.sandboxes[id] = {
    id, provider, state: "stopped", cpu, memoryMiB: 1024, createdAt: start, metadata: {},
    providerSandboxId: id, segments: [{ start, end: iso(end) }], endedAt: iso(end), reason: "killed",
  };
}

/** A live box, holding one of the provider's free slots. */
function running(data: LedgerData, provider: string, now = NOW): void {
  const id = `${provider}-${Object.keys(data.sandboxes).length}`;
  data.sandboxes[id] = {
    id, provider, state: "running", cpu: 1, memoryMiB: 1024, createdAt: iso(now - 60_000), metadata: {},
    providerSandboxId: id, expiresAt: iso(now + 3_600_000), segments: [{ start: iso(now - 60_000) }],
  };
}

function creating(data: LedgerData, provider: string, at: number): void {
  const id = `${provider}-${Object.keys(data.sandboxes).length}`;
  data.sandboxes[id] = { id, provider, state: "creating", cpu: 1, memoryMiB: 1024, createdAt: iso(at), metadata: {} };
}

const ok = (at: number, ms: number): HealthSample => ({ at: iso(at), op: "create", ok: true, ms });
const fail = (at: number): HealthSample => ({ at: iso(at), op: "create", ok: false, kind: "transient" });

/** Every lane, prices, history and load, so each built-in orders it differently. */
function mixed(): PolicyInput {
  const data = emptyLedger();
  const quick = (ms: number) => [ok(NOW, ms), ok(NOW, ms), ok(NOW, ms)];
  data.health = {
    hours: quick(4000),
    monthly: quick(800),
    credit: quick(300),
    local: quick(2000),
    "paid-cheap": quick(200),
    onetime: [fail(NOW), fail(NOW)], // flaky, but two failures don't open the circuit
  };
  used(data, "monthly", 10_000); // $10 of its $30
  used(data, "credit", 5_000, 100); // $5 of its $10
  for (let i = 0; i < 3; i++) used(data, "hours", 60, 1, NOW - 600_000); // busy in the last hour
  running(data, "credit");
  running(data, "credit"); // 2 of its 4 free slots
  const adapters = [
    fakeProvider({ id: "hours", tier: { kind: "monthly-hours", hours: 10 }, rate: 0.00002 }),
    fakeProvider({ id: "monthly", tier: { kind: "monthly-credit", usd: 30 }, rate: 0.001 }),
    fakeProvider({ id: "onetime", tier: { kind: "one-time-credit", usd: 100 }, rate: 0.00001 }),
    fakeProvider({ id: "credit", tier: { kind: "one-time-credit", usd: 10 }, rate: 0.00001, concurrency: 4 }),
    fakeProvider({ id: "local", tier: { kind: "unlimited" }, selfHosted: true, rate: 0 }),
    fakeProvider({ id: "paid-cheap", tier: { kind: "none" }, rate: 0.000001 }),
    fakeProvider({ id: "paid-dear", tier: { kind: "none" }, rate: 0.0001 }),
  ];
  return input(adapters, { allowPaid: true }, {}, data);
}

describe("built-in strategies on a mixed set", () => {
  const lanes = (p: Plan) => p.ordered.map((e) => `${e.provider}:${e.lane}`);

  it("free-first: monthly free by most at risk per day, one-time by share left, your hardware, paid by price", () => {
    const p = plan({ ...mixed(), strategy: freeFirst });
    expect(lanes(p)).toEqual([
      "hours:free-recurring",
      "monthly:free-recurring",
      "onetime:free-one-time",
      "credit:free-one-time",
      "local:self-hosted",
      "paid-cheap:paid",
      "paid-dear:paid",
    ]);
    const monthly = p.ordered.find((e) => e.provider === "monthly")!;
    expect(monthly.why).toEqual(["free-recurring", "67% left, resets in 19.5 d"]);
    expect(monthly.score).toBeCloseTo(20 / 30 / 19.5); // share left per day left
    const paid = p.ordered.find((e) => e.provider === "paid-cheap")!;
    expect(paid.why).toEqual(["paid", "$0.0072/h"]);
    expect(paid.score).toBe(-0.000002);
  });

  it("cheapest: any free usage by price, then your hardware, then paid by price", () => {
    const p = plan({ ...mixed(), strategy: cheapest });
    expect(lanes(p)).toEqual([
      "credit:free-one-time",
      "onetime:free-one-time",
      "hours:free-one-time",
      "monthly:free-one-time",
      "local:self-hosted",
      "paid-cheap:paid",
      "paid-dear:paid",
    ]);
  });

  it("balanced: free-first lanes, then health and speed can beat a bigger share of free credit", () => {
    const p = plan({ ...mixed(), strategy: balanced });
    expect(order(p)).toEqual(["hours", "monthly", "credit", "onetime", "local", "paid-cheap", "paid-dear"]);
    expect(p.ordered.find((e) => e.provider === "monthly")!.why![1]).toMatch(/^score [\d.]+ \(free 0\.67, health 0\.96, speed 0\.92, coverage 1\.00, load 1\.00\)$/);
  });

  it("balanced: the weights come from config", () => {
    const loadOnly = { freeValue: 0, health: 0, speed: 0, coverage: 0, load: 1 };
    const data = emptyLedger();
    data.health["busy"] = [ok(NOW, 100), ok(NOW, 100), ok(NOW, 100)]; // healthy and quick, but 3 of 4 slots taken
    data.health["idle"] = [ok(NOW, 9000), ok(NOW, 9000), ok(NOW, 9000)]; // free slots, but slow
    running(data, "busy");
    running(data, "busy");
    running(data, "busy");
    const adapters = ["busy", "idle"].map((id) => fakeProvider({ id, tier: { kind: "one-time-credit", usd: 10 }, concurrency: 4 }));
    expect(order(plan({ ...input(adapters, {}, {}, data), strategy: balanced }))).toEqual(["busy", "idle"]);
    expect(order(plan({ ...input(adapters, { routing: { weights: loadOnly } }, {}, data), strategy: balanced }))).toEqual(["idle", "busy"]);
  });

  it("fastest: unbilled before paid, each by expected time to a ready box, keeping the real lane", () => {
    const p = plan({ ...mixed(), strategy: fastest });
    expect(lanes(p)).toEqual([
      "credit:free-one-time",
      "monthly:free-recurring",
      "local:self-hosted",
      "hours:free-recurring",
      "onetime:free-one-time",
      // Never tried, so assumed as fast as the best seen: it gets one try before its median decides.
      "paid-dear:paid",
      "paid-cheap:paid",
    ]);
    expect(p.ordered[0]!.why).toEqual(["free-one-time", "~0.3 s to ready (p50 300 ms, 96% ok)"]);
    expect(p.ordered.find((e) => e.provider === "paid-dear")!.why).toEqual(["paid", "~0.2 s to ready (not tried yet, so assumed as fast as the fastest)"]);
    expect(p.ordered.find((e) => e.provider === "onetime")!.why).toEqual(["free-one-time", "~22.2 s to ready (no successful create yet, 45% ok)"]);
  });

  it("spread: free-first lanes, then the most free headroom and fewest recent creates", () => {
    const p = plan({ ...mixed(), strategy: spread });
    expect(order(p)).toEqual(["monthly", "hours", "onetime", "credit", "local", "paid-cheap", "paid-dear"]);
    expect(p.ordered.find((e) => e.provider === "credit")!.why).toEqual(["free-one-time", "2/4 live, 2 created in the last hour"]);
  });

  it("spread: with equal headroom, the bigger share of free credit goes first", () => {
    const data = emptyLedger();
    used(data, "a", 5_000, 100); // half of a's credit
    const adapters = ["a", "b"].map((id) => fakeProvider({ id, tier: { kind: "one-time-credit", usd: 10 } }));
    expect(order(plan({ ...input(adapters, {}, {}, data), strategy: spread }))).toEqual(["b", "a"]);
  });

  it("every entry says why, and paid lanes are billed as paid", () => {
    for (const strategy of [freeFirst, cheapest, balanced, fastest, spread]) {
      const p = plan({ ...mixed(), strategy });
      expect(p.strategy).toBe(strategy.name);
      for (const e of p.ordered) {
        expect(e.why?.[0]).toBe(e.lane);
        expect(e.billing).toBe(e.lane === "paid" ? "paid" : e.provider === "local" ? "self-hosted" : "free");
      }
    }
  });
});

describe("free-first and cheapest order exactly as before strategies existed", () => {
  // policy.ts as of 71a4401, frozen: lanes and sort only (the filters' reasons are pinned by
  // routing.test.ts). `quirk` flags one deliberate change: old `cheapest` routed a self-hosted
  // provider for free even past its concurrency cap or the free lifetime cap. The other is applied
  // instead of flagged: free usage, and paid usage under a budget, now take a request only when
  // what is left after what live sandboxes will still spend covers all of it (accounting.test.ts).
  function legacy(inp: PolicyInput, policy: "free-first" | "cheapest") {
    const { adapters, config, data, spec, now } = inp;
    const ordered: { provider: string; lane: string; score: number; rate: number }[] = [];
    const skipped: string[] = [];
    let quirk = false;
    const paidSoFar = adapters.reduce((sum, a) => {
      const cfg = config.providers[a.info.id];
      return sum + paidSpendThisMonth(a.info, cfg, data, now) + committed(a.info, cfg, data, now).paid.usd;
    }, 0);
    const paidBudgetLeft = config.maxPaidUsdPerMonth === undefined ? Number.POSITIVE_INFINITY : config.maxPaidUsdPerMonth - paidSoFar;
    for (const { info } of adapters) {
      const cfg = config.providers[info.id];
      if (spec.providers && !spec.providers.includes(info.id)) {
        skipped.push(info.id);
        continue;
      }
      if (info.selfHosted && config.selfHosted === "never" && !spec.providers?.includes(info.id)) {
        skipped.push(info.id);
        continue;
      }
      const free = freeStatus(info, cfg, data, now);
      const rate = ratePerSecond(effectivePricing(info, cfg), spec.cpu, spec.memoryMiB);
      const live = liveCount(data, info.id, now, isLive);
      const cap = cfg?.concurrency ?? info.freeTier.concurrency;
      const overLifetime = info.freeTier.maxLifetimeSec !== undefined && spec.timeoutSec > info.freeTier.maxLifetimeSec;
      const held = committed(info, cfg, data, now).free;
      const covers =
        free.state === "unlimited" ||
        (free.state === "available" &&
          (free.unit === "hours"
            ? free.remaining * 3600 - held.sandboxSeconds >= spec.timeoutSec - 1e-9
            : free.remaining - held.usd >= rate * spec.timeoutSec - 1e-9));
      const freeUsable = covers && !overLifetime && (cap === undefined || live < cap);
      const paid = (cfg?.allowPaid ?? config.allowPaid) && paidBudgetLeft > 0 && paidBudgetLeft >= rate * spec.timeoutSec - 1e-9;
      let lane: string | undefined;
      let score = 0;
      if (policy === "cheapest") {
        if (free.state === "unlimited") lane = "self-hosted";
        else if (freeUsable) lane = "free-one-time";
        else if (paid) lane = "paid";
        score = -rate;
        if (free.state === "unlimited" && !freeUsable) quirk = true;
      } else if (free.state === "unlimited" && freeUsable) {
        lane = config.selfHosted === "first" ? "self-hosted-first" : "self-hosted";
      } else if (freeUsable && free.state === "available") {
        if (free.resetsAt !== undefined) {
          lane = "free-recurring";
          score = free.fraction / Math.max((free.resetsAt - now) / 86_400_000, 1 / 24);
        } else {
          lane = "free-one-time";
          score = free.fraction;
        }
      } else if (paid) {
        lane = "paid";
        score = -rate;
      }
      if (lane) ordered.push({ provider: info.id, lane, score, rate });
      else skipped.push(info.id);
    }
    const laneOrder = ["self-hosted-first", "free-recurring", "free-one-time", "self-hosted", "paid"];
    const preference = spec.providers ?? [];
    ordered.sort((a, b) => {
      const lane = laneOrder.indexOf(a.lane) - laneOrder.indexOf(b.lane);
      if (lane) return lane;
      const pa = config.providers[a.provider]?.priority ?? 100;
      const pb = config.providers[b.provider]?.priority ?? 100;
      if (pa !== pb) return pa - pb;
      if (preference.length) {
        const d = preference.indexOf(a.provider) - preference.indexOf(b.provider);
        if (d) return d;
      }
      if (b.score !== a.score) return b.score - a.score;
      if (a.rate !== b.rate) return a.rate - b.rate;
      return a.provider.localeCompare(b.provider);
    });
    return { ordered: ordered.map((e) => `${e.provider}:${e.lane}`), skipped: skipped.sort(), quirk };
  }

  function prng(seed: number) {
    return () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function scenario(seed: number): PolicyInput {
    const rand = prng(seed);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
    const now = Date.UTC(2026, 10, 1 + Math.floor(rand() * 29), Math.floor(rand() * 24));
    const data = emptyLedger();
    const tiers: FreeTier[] = [
      { kind: "none" },
      { kind: "one-time-credit", usd: 1 },
      { kind: "one-time-credit", usd: 5 },
      { kind: "monthly-credit", usd: 1 },
      { kind: "monthly-credit", usd: 5 },
      { kind: "monthly-hours", hours: 1 },
      { kind: "monthly-hours", hours: 10 },
      { kind: "unlimited" },
    ];
    const adapters: ProviderAdapter[] = [];
    const providers: Record<string, object> = {};
    for (let i = 0, n = 1 + Math.floor(rand() * 7); i < n; i++) {
      const id = `p${i}`;
      const tier = pick(tiers);
      adapters.push(
        fakeProvider({
          id,
          tier,
          selfHosted: tier.kind === "unlimited",
          rate: pick([0, 0.000001, 0.00001, 0.0001]),
          concurrency: pick([undefined, undefined, 1, 2]),
          maxLifetimeSec: pick([undefined, undefined, 600]),
        }),
      );
      providers[id] = { priority: pick([undefined, undefined, 1, 100, 200]), allowPaid: pick([undefined, undefined, true, false]) };
      for (let k = pick([0, 0, 1, 2]); k > 0; k--) used(data, id, pick([600, 36_000, 360_000]), pick([1, 4]), now - pick([0, 3_600_000]));
      for (let k = pick([0, 0, 1, 2]); k > 0; k--) running(data, id, now);
      if (rand() < 0.1) data.marks.push({ provider: id, kind: "quota", at: iso(now), until: iso(now + 86_400_000) });
    }
    const ids = adapters.map((a) => a.info.id);
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    }
    const config = {
      allowPaid: pick([true, false]),
      maxPaidUsdPerMonth: pick([undefined, 0, 0.5, 100]),
      selfHosted: pick(["first", "after-free", "never"]),
      providers,
    };
    const spec = { timeoutSec: pick([300, 3600]), providers: pick([undefined, undefined, ids.slice(0, 1 + Math.floor(rand() * ids.length))]) };
    return input(adapters, config, spec, data, now);
  }

  it("on 300 random scenarios", () => {
    let compared = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const inp = scenario(seed);
      for (const strategy of [freeFirst, cheapest]) {
        const want = legacy(inp, strategy.name as "free-first" | "cheapest");
        if (want.quirk) continue;
        const p = plan({ ...inp, strategy });
        expect(p.ordered.map((e) => `${e.provider}:${e.lane}`), `seed ${seed}, ${strategy.name}`).toEqual(want.ordered);
        expect(p.skipped.map((s) => s.provider).sort(), `seed ${seed}, ${strategy.name}`).toEqual(want.skipped);
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(500);
  });

  it("except that cheapest no longer routes your hardware past its concurrency cap for free", () => {
    const data = emptyLedger();
    running(data, "local");
    const local = fakeProvider({ id: "local", tier: { kind: "unlimited" }, selfHosted: true, concurrency: 1, rate: 0 });
    const p = plan({ ...input([local], {}, {}, data), strategy: cheapest });
    expect(p.ordered).toEqual([]);
    expect(p.skipped[0]!.reason).toBe("free tier allows 1 at once and 1 are live; paid usage is off (allowPaid)");
  });
});

describe("avoid and prefer", () => {
  const providers = () => [
    fakeProvider({ id: "m1", tier: { kind: "monthly-credit", usd: 30 } }),
    fakeProvider({ id: "m2", tier: { kind: "monthly-credit", usd: 30 } }),
    fakeProvider({ id: "o1", tier: { kind: "one-time-credit", usd: 30 } }),
    fakeProvider({ id: "o2", tier: { kind: "one-time-credit", usd: 30 } }),
    fakeProvider({ id: "paid", tier: { kind: "none" } }),
  ];

  it("avoided goes last within its lane, but never behind a lane it would pay for", () => {
    const p = plan(input(providers(), { allowPaid: true }, { avoid: ["m1", "o1", "o2"] }));
    expect(order(p)).toEqual(["m2", "m1", "o1", "o2", "paid"]);
    expect(p.ordered[1]!.why).toContain("avoided");
  });

  it("preferred goes first within its lane", () => {
    const p = plan(input(providers(), {}, { prefer: ["m2", "o2"] }));
    expect(order(p)).toEqual(["m2", "m1", "o2", "o1"]);
    expect(p.ordered[0]!.why).toContain("preferred");
  });

  it("avoid outranks config priority, which outranks prefer", () => {
    const config = { providers: { m1: { priority: 1 }, o1: { priority: 1 } } };
    expect(order(plan(input(providers(), config, { avoid: ["m1"], prefer: ["o2"] })))).toEqual(["m2", "m1", "o1", "o2"]);
  });

  it("the request's providers order sits between prefer and the score", () => {
    const p = plan(input(providers(), {}, { providers: ["o2", "m2", "o1", "m1"], prefer: ["m1"] }));
    expect(order(p)).toEqual(["m1", "m2", "o2", "o1"]);
  });
});

describe("hard filters every strategy shares", () => {
  it("minIsolation skips weaker and unknown isolation; config can declare it", () => {
    const declared: Record<string, Isolation | undefined> = {
      container: "container",
      gvisor: "gvisor",
      microvm: "microvm",
      vm: "vm",
      unknown: undefined,
      docker: "container", // runs runsc here, which config says
    };
    const adapters = Object.entries(declared).map(([id, isolation]) => {
      const p = fakeProvider({ id, tier: { kind: "monthly-credit", usd: 30 } });
      p.info.isolation = isolation;
      return p;
    });
    const config = { providers: { docker: { isolation: "gvisor" } } };
    const gvisor = plan(input(adapters, config, { minIsolation: "gvisor" }));
    expect(order(gvisor).sort()).toEqual(["docker", "gvisor", "microvm", "vm"]);
    expect(reasons(gvisor)).toEqual({
      container: "isolation container is weaker than gvisor",
      unknown: "isolation unknown (set providers.unknown.isolation if it is gvisor or stronger)",
    });
    expect(order(plan(input(adapters, config, { minIsolation: "microvm" }))).sort()).toEqual(["microvm", "vm"]);
    expect(order(plan(input(adapters, config)))).toHaveLength(6);
  });

  it("execTimeoutSec skips providers that cut commands off sooner", () => {
    const exe = fakeProvider({ id: "exe", tier: { kind: "monthly-credit", usd: 30 } });
    exe.info.maxExecSec = 30;
    expect(reasons(plan(input([exe], {}, { execTimeoutSec: 60 })))).toEqual({ exe: "exec timeout 60s is over its per-command maximum 30s" });
    expect(order(plan(input([exe], {}, { execTimeoutSec: 30 })))).toEqual(["exe"]);
    expect(order(plan(input([exe])))).toEqual(["exe"]);
  });

  describe("circuit breaker", () => {
    const flaky = () => fakeProvider({ id: "flaky", tier: { kind: "monthly-credit", usd: 30 } });
    const tripped = (lastFailure: number) => {
      const data = emptyLedger();
      data.health["flaky"] = [fail(lastFailure - 2000), fail(lastFailure - 1000), fail(lastFailure)];
      return data;
    };

    it("skips a provider while its circuit is open", () => {
      const p = plan(input([flaky()], {}, {}, tripped(NOW - 60_000)));
      expect(reasons(p)).toEqual({ flaky: `circuit open after 3 failures (until ${iso(NOW + 60_000)})` });
    });

    it("lets one probe through once it is half-open", () => {
      const data = tripped(NOW - 120_000);
      expect(order(plan(input([flaky()], {}, {}, data)))).toEqual(["flaky"]);
      const e = eligibility(input([flaky()], {}, {}, data), "flaky");
      expect(e.ok && e.candidate.health.circuit).toBe("half-open");
      // A create still in flight from before the last failure is not the probe...
      creating(data, "flaky", NOW - 130_000);
      expect(order(plan(input([flaky()], {}, {}, data)))).toEqual(["flaky"]);
      // ...one started since is, and a second request waits for it.
      creating(data, "flaky", NOW - 1000);
      expect(reasons(plan(input([flaky()], {}, {}, data)))).toEqual({ flaky: "circuit half-open; a probe is in flight" });
    });

    it("is off with failures: 0", () => {
      expect(order(plan(input([flaky()], { routing: { circuitBreaker: { failures: 0 } } }, {}, tripped(NOW))))).toEqual(["flaky"]);
    });
  });
});

describe("custom strategies can't route around the rules", () => {
  const providers = () => [
    fakeProvider({ id: "free", tier: { kind: "one-time-credit", usd: 30 } }),
    fakeProvider({ id: "monthly", tier: { kind: "monthly-credit", usd: 30 } }),
    fakeProvider({ id: "nofree", tier: { kind: "none" } }),
  ];
  const entry = (provider: string, billing: "free" | "paid") =>
    ({ provider, lane: billing === "paid" ? "paid" : "free-one-time", billing, free: { state: "none" }, ratePerSecondUsd: 0, score: 0 }) as const;

  it("drops paid entries while allowPaid is off, providers the filters skipped, duplicates and unknown names", () => {
    const hostile: RoutingStrategy = {
      name: "hostile",
      description: "bills a free provider as paid and brings back a skipped one",
      rank: () => ({
        ordered: [entry("nofree", "free"), entry("free", "paid"), entry("monthly", "free"), entry("monthly", "paid"), entry("ghost", "free")],
      }),
    };
    const p = plan({ ...input(providers()), strategy: hostile });
    expect(p.strategy).toBe("hostile");
    expect(p.ordered.map((e) => [e.provider, e.billing])).toEqual([["monthly", "free"]]);
    expect(p.skipped).toEqual([
      { provider: "nofree", reason: "no free tier; paid usage is off (allowPaid)" },
      { provider: "free", reason: "strategy hostile billed it as paid: paid usage is off or this month's paid budget is spent" },
    ]);
  });

  it("drops free entries for a provider whose free usage can't take the request", () => {
    const data = emptyLedger();
    running(data, "capped");
    const capped = fakeProvider({ id: "capped", tier: { kind: "monthly-credit", usd: 30 }, concurrency: 1 });
    const sneaky: RoutingStrategy = { name: "sneaky", description: "", rank: () => ({ ordered: [entry("capped", "free")] }) };
    const p = plan({ ...input([capped], { allowPaid: true }, {}, data), strategy: sneaky });
    expect(p.ordered).toEqual([]);
    expect(reasons(p)).toEqual({ capped: "strategy sneaky billed it as free: no free capacity (free tier allows 1 at once and 1 are live)" });
  });

  it("can't rewrite a candidate's billing facts", () => {
    const forger: RoutingStrategy = {
      name: "forger",
      description: "",
      rank(candidates) {
        for (const c of candidates) (c as { paidAllowed: boolean }).paidAllowed = true;
        return { ordered: [entry("free", "paid")] };
      },
    };
    expect(() => plan({ ...input(providers()), strategy: forger })).toThrow(TypeError);
  });

  it("reports what it left out, with its own reason when it gives one", () => {
    const picky: RoutingStrategy = {
      name: "picky",
      description: "",
      rank: () => ({ ordered: [entry("monthly", "free")], skipped: [{ provider: "free", reason: "too slow" }, { provider: "monthly", reason: "ignored" }] }),
    };
    const p = plan({ ...input([...providers(), fakeProvider({ id: "other", tier: { kind: "monthly-credit", usd: 5 } })]), strategy: picky });
    expect(order(p)).toEqual(["monthly"]);
    expect(reasons(p)).toEqual({ nofree: "no free tier; paid usage is off (allowPaid)", free: "too slow", other: "left out by strategy picky" });
  });
});

describe("choosing a strategy", () => {
  it("the registry lists the built-ins and refuses unknown or duplicate names", () => {
    const registry = new StrategyRegistry();
    expect(registry.list().map((s) => s.name)).toEqual(["free-first", "cheapest", "balanced", "fastest", "spread"]);
    const unknown = (() => {
      try {
        registry.get("nope");
      } catch (err) {
        return err;
      }
    })();
    expect(unknown).toBeInstanceOf(SandboxRouterError);
    expect(unknown).toMatchObject({
      kind: "invalid",
      message: 'unknown routing strategy "nope" (have: free-first, cheapest, balanced, fastest, spread)',
    });
    expect(() => registry.register({ ...cheapest })).toThrow(/"cheapest" is already registered/);
    const mine: RoutingStrategy = { name: "mine", description: "", rank: () => ({ ordered: [] }) };
    expect(registry.register(mine).has("mine")).toBe(true);
    expect(registry.get("mine")).toBe(mine);
    expect(new StrategyRegistry([]).list()).toEqual([]);
  });

  it("plan() uses the request's strategy, else routing.strategy, else the legacy policy, else free-first", () => {
    const adapters = [fakeProvider({ id: "a", tier: { kind: "monthly-credit", usd: 30 } })];
    expect(plan(input(adapters)).strategy).toBe("free-first");
    expect(plan(input(adapters, { policy: "cheapest" })).strategy).toBe("cheapest");
    expect(plan(input(adapters, { policy: "cheapest", routing: { strategy: "spread" } })).strategy).toBe("spread");
    expect(plan(input(adapters, { routing: { strategy: "spread" } }, { strategy: "fastest" })).strategy).toBe("fastest");
    expect(() => plan(input(adapters, { routing: { strategy: "nope" } }))).toThrow(/unknown routing strategy "nope"/);
  });

  it("works through the router, per request and from config", async () => {
    const providers = () => [
      fakeProvider({ id: "monthly", tier: { kind: "monthly-credit", usd: 30 }, rate: 0.001 }),
      fakeProvider({ id: "onetime", tier: { kind: "one-time-credit", usd: 30 }, rate: 0.00001 }),
    ];
    const { router: r } = router(providers());
    expect((await r.plan()).strategy).toBe("free-first");
    expect(order(await r.plan())).toEqual(["monthly", "onetime"]);
    expect(order(await r.plan({ strategy: "cheapest" }))).toEqual(["onetime", "monthly"]);
    const { router: cheap } = router(providers(), { routing: { strategy: "cheapest" } });
    expect((await cheap.create()).provider).toBe("onetime");
  });
});

describe("eligibility", () => {
  it("is the hard filters and billing for one provider", () => {
    const adapters = [
      fakeProvider({ id: "free", tier: { kind: "monthly-credit", usd: 30 } }),
      fakeProvider({ id: "local", tier: { kind: "unlimited" }, selfHosted: true }),
      fakeProvider({ id: "paid", tier: { kind: "none" } }),
    ];
    const inp = input(adapters, { allowPaid: true });
    expect(eligibility(inp, "free")).toMatchObject({ ok: true, billing: "free", candidate: { provider: "free", freeUsable: true } });
    expect(eligibility(inp, "local")).toMatchObject({ ok: true, billing: "self-hosted" });
    expect(eligibility(inp, "paid")).toMatchObject({ ok: true, billing: "paid" });
    expect(eligibility(input(adapters), "paid")).toEqual({ ok: false, reason: "no free tier; paid usage is off (allowPaid)" });
    expect(eligibility(inp, "ghost")).toEqual({ ok: false, reason: 'unknown provider "ghost"' });
  });

  it("counts the paid budget across every provider, not just the one re-checked", () => {
    const data = emptyLedger();
    used(data, "a", 1100); // $1.10 at $0.001/s, over the $1 budget
    const adapters = ["a", "b"].map((id) => fakeProvider({ id, tier: { kind: "none" }, rate: 0.001 }));
    const config = { allowPaid: true, maxPaidUsdPerMonth: 1 };
    expect(eligibility(input(adapters, config, {}, data), "b")).toEqual({
      ok: false,
      reason: "no free tier; paid budget for this month is spent",
      until: Date.UTC(2026, 11, 1), // the budget is monthly: waiting until then can help
    });
  });

  it("fills the facts strategies rank by", () => {
    const data = emptyLedger();
    used(data, "p", 60, 1, NOW - 600_000); // created in the last hour
    used(data, "p", 60, 1, NOW - 7_200_000); // not
    running(data, "p");
    const credit = (usd: number) => fakeProvider({ id: "p", tier: { kind: "one-time-credit", usd }, rate: 0.00001, concurrency: 3 });
    const e = eligibility(input([credit(0.06)], { providers: { p: { priority: 7 } } }, { providers: ["p"], prefer: ["p"], timeoutSec: 600 }, data), "p");
    expect(e.ok).toBe(true);
    if (!e.ok) return;
    expect(e.candidate).toMatchObject({
      ratePerSecondUsd: 0.00002,
      live: 1,
      cap: 3,
      recentCreates: 2,
      priority: 7,
      preferenceIndex: 0,
      preferred: true,
      avoided: false,
      health: { samples: 0, successRate: 0.9, circuit: "closed" },
    });
    // $0.0582 of free credit left, $0.036 of it held by the running box's last hour: room for
    // 600 s at $0.00002/s ($0.012), so free usage covers all of it, and $0.0222 is 1.85 such
    // requests: headroom 0.185 of the 10 that count as plenty.
    expect(e.candidate).toMatchObject({ freeUsable: true, freeCoverage: expect.closeTo(0.185, 6) });
    // $0.02 less, and the same numbers leave no room: it can only be paid for.
    expect(eligibility(input([credit(0.04)], { allowPaid: true }, { timeoutSec: 600 }, data), "p")).toMatchObject({
      ok: true,
      billing: "paid",
      candidate: { freeUsable: false, freeCoverage: 0, freeBlocked: "free credit left ($0.0022 after $0.036 committed) won't cover this request ($0.012)" },
    });
  });
});

describe("what the simulator showed (bench/simulate.ts)", () => {
  it("balanced and spread rank paid providers by price first, so a monthly budget buys the most sandboxes", () => {
    const data = emptyLedger();
    // The pricey one is faster, healthier and idle; the cheap one is slower and busier.
    data.health = { pricey: [ok(NOW - 60_000, 500), ok(NOW - 30_000, 500)], cheap: [ok(NOW - 60_000, 9_000), fail(NOW - 30_000)] };
    running(data, "cheap");
    const adapters = [
      fakeProvider({ id: "pricey", tier: { kind: "none" }, rate: 0.0001 }),
      fakeProvider({ id: "cheap", tier: { kind: "none" }, rate: 0.00001 }),
    ];
    const inp = input(adapters, { allowPaid: true }, {}, data);
    expect(order(plan({ ...inp, strategy: balanced }))).toEqual(["cheap", "pricey"]);
    expect(order(plan({ ...inp, strategy: spread }))).toEqual(["cheap", "pricey"]);
    // fastest is the one that pays for speed, by design.
    expect(order(plan({ ...inp, strategy: fastest }))).toEqual(["pricey", "cheap"]);
  });

  it("a provider never tried isn't assumed slow: fastest tries it, then its real latency decides", () => {
    const adapters = [fakeProvider({ id: "known", tier: { kind: "monthly-credit", usd: 30 } }), fakeProvider({ id: "new", tier: { kind: "monthly-credit", usd: 30 } })];
    const data = emptyLedger();
    data.health = { known: [ok(NOW - 60_000, 3_000)] };
    expect(order(plan({ ...input(adapters, {}, {}, data), strategy: fastest }))).toEqual(["new", "known"]);
    data.health["new"] = [ok(NOW - 30_000, 8_000)];
    expect(order(plan({ ...input(adapters, {}, {}, data), strategy: fastest }))).toEqual(["known", "new"]);
  });
});
