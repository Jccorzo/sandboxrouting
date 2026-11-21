import { describe, expect, it } from "vitest";
import { simulate, type Run, type Simulation } from "../bench/simulate.js";
import { EXTERNAL } from "../bench/scenarios.js";
import { parseConfig } from "../src/core/config.js";
import { billingOf } from "../src/core/policy.js";
import type { RoutingStrategy } from "../src/core/routing/types.js";

const DAY = 86_400_000;
const runs = (sim: Simulation): Run[] => sim.scenarios[0]!.runs;
const byStrategy = (sim: Simulation) => Object.fromEntries(runs(sim).map((r) => [r.strategy, r.metrics]));

describe("the simulator", () => {
  it("gives the same numbers for the same seed, and different ones for another", async () => {
    // Two strategies are enough to show determinism; all five only make the file slower.
    const options = { days: 0.5, scenarios: ["steady"], only: ["free-first", "balanced"] };
    const a = await simulate({ ...options, seed: 7 });
    const b = await simulate({ ...options, seed: 7 });
    const c = await simulate({ ...options, seed: 8 });
    expect(b).toEqual(a);
    expect(byStrategy(c)).not.toEqual(byStrategy(a));
  });

  it("gets the same numbers from its fast ledger as from the router's MemoryLedger", async () => {
    // tight runs free tiers out and spends a paid budget: the sums the folded records feed. The
    // router's MemoryLedger copies the whole ledger on every call, so keep this run small.
    const options = { days: 1, scenarios: ["tight"], only: ["free-first"], workload: { perDay: 120 } };
    expect(await simulate(options)).toEqual(await simulate({ ...options, memoryLedger: true }));
  });

  it("runs your own strategy through the router next to the built-ins", async () => {
    const alphabetical: RoutingStrategy = {
      name: "alphabetical",
      description: "By provider name.",
      rank: (candidates) => ({
        ordered: [...candidates]
          .sort((a, b) => a.provider.localeCompare(b.provider))
          .flatMap((c) => {
            const billing = billingOf(c);
            return billing ? [{ provider: c.provider, lane: "free-one-time" as const, billing, free: c.free, ratePerSecondUsd: c.ratePerSecondUsd, score: 0 }] : [];
          }),
      }),
    };
    const sim = await simulate({ days: 1, scenarios: ["steady"], strategies: [alphabetical], only: ["alphabetical"] });
    const share = runs(sim)[0]!.metrics.share;
    // daytona sorts first; only what overflows its 10 free slots goes elsewhere.
    expect(Object.entries(share).sort((a, b) => b[1] - a[1])[0]![0]).toBe("daytona");
  });
});

describe("allowPaid false", () => {
  // Free tiers a tenth of tight's (whose own, with Fly's free $2.50 since 2026-11-21, last the
  // run out) run dry within a day, which is where paid usage could slip in. With allowPaid on,
  // every strategy then bills 32 to 47 of these ~200 sandboxes as paid; one day keeps this fast.
  const tiny = {
    modal: { freeTier: { kind: "monthly-credit", usd: 0.3 } },
    northflank: { freeTier: { kind: "monthly-credit", usd: 0.1 } },
    freestyle: { freeTier: { kind: "monthly-credit", usd: 0.1 } },
    vercel: { freeTier: { kind: "monthly-credit", usd: 0.1 } },
    upstash: { freeTier: { kind: "monthly-hours", hours: 0.1 } },
    daytona: { freeTier: { kind: "one-time-credit", usd: 0.4 } },
    e2b: { freeTier: { kind: "one-time-credit", usd: 0.3 } },
    fly: { freeTier: { kind: "monthly-credit", usd: 0.25 } },
  };
  let tight: Promise<Simulation> | undefined;
  const run = () => (tight ??= simulate({ days: 1, scenarios: ["tight"], config: { allowPaid: false, providers: tiny } }));

  it("no strategy has a sandbox billed as paid, though the free tiers ran out", async () => {
    for (const r of runs(await run())) {
      expect(r.metrics.paidSandboxes, r.strategy).toBe(0);
      // Requests went unserved: free capacity was gone, so paid was the only way left.
      expect(r.metrics.unserved, r.strategy).toBeGreaterThan(0);
    }
  });

  // A free tier takes a request only when what is left after what live sandboxes will still spend
  // covers all of it, so no box starts on a tier's last cent and runs on past it into paid usage.
  it("no strategy spends paid USD", async () => {
    for (const r of runs(await run())) expect(r.metrics.paidUsd, r.strategy).toBe(0);
  });
});

describe("outage", () => {
  it("every strategy keeps serving, and failed creates on the down provider stay bounded", async () => {
    // Enough traffic and no bursts, so few failures can't just mean few requests: at 300 a day
    // about 115 requests fall in the outage against at most 15 failed creates (2026-11-21). The
    // simulation's cost grows faster than its traffic, so this stays well below 400 a day.
    const sim = await simulate({ days: 1, scenarios: ["outage"], trace: true, workload: { perDay: 300, burstsPerDay: 0 } });
    const breaker = parseConfig({}).routing.circuitBreaker;
    for (const r of runs(sim)) {
      const down = r.outage!;
      const during = (t: number) => t >= down.from && t < down.to;
      const requests = r.outcomes!.filter((o) => during(o.at));
      const failed = r.attempts!.filter((a) => a.provider === down.provider && a.outcome === "unavailable" && during(a.start));
      // The threshold, then one half-open probe per cooldown: doubling up to the max, then every max.
      const probes = Math.ceil(Math.log2(breaker.maxCooldownSec / breaker.cooldownSec)) + Math.ceil((down.to - down.from) / 1000 / breaker.maxCooldownSec);

      expect(r.metrics.unserved, r.strategy).toBe(0);
      expect(requests.every((o) => o.provider !== undefined), r.strategy).toBe(true);
      expect(failed.length, r.strategy).toBeGreaterThanOrEqual(breaker.failures);
      expect(failed.length, r.strategy).toBeLessThanOrEqual(breaker.failures + probes + 2);
      expect(requests.length, r.strategy).toBeGreaterThan(5 * failed.length);
    }
  });
});

describe("external usage", () => {
  it("after a 402 the provider is skipped until its quota mark ends, instead of failing every request", async () => {
    // Two days hold the refusal (fastest meets it on the first); whatever of the next day the run
    // still covers must be quiet.
    const sim = await simulate({ days: 2, scenarios: ["external-usage"], trace: true });
    let refusals = 0;
    for (const r of runs(sim)) {
      const attempts = r.attempts!.filter((a) => a.provider === EXTERNAL);
      const refused = attempts.filter((a) => a.outcome === "refused");
      refusals += refused.length;
      for (const no of refused) {
        // A one-time credit's mark lasts a day, and longer when it repeats. Creates already in flight when the 402 came back don't count.
        expect(attempts.filter((a) => a.start > no.end && a.start < no.end + DAY), r.strategy).toEqual([]);
      }
      expect(r.metrics.failures[EXTERNAL]?.["quota"] ?? 0, r.strategy).toBe(refused.length);
      expect(r.metrics.unserved, r.strategy).toBe(0);
    }
    expect(refusals).toBeGreaterThan(0);
  });
});

describe("flaky", () => {
  it("balanced and fastest don't fail over more than free-first", async () => {
    // Summed over seeds, since one seed is noisy. Over one day, seeds 1-4 give free-first 85
    // failovers, balanced 36 and fastest 6 (2026-11-21, with Runloop off by default); a second day
    // only doubles them, so one day keeps the file well inside the default timeout. Over 30 days
    // the gap is smaller: balanced was only ~4% better at 200 requests a day, and ~3% worse at 150.
    // No order within the lane does much better at 200: every monthly tier is spent by the reset,
    // modal's credit included, and its failovers are the creates that takes (docs/routing.md).
    const total: Record<string, number> = { "free-first": 0, balanced: 0, fastest: 0 };
    for (const seed of [1, 2, 3, 4]) {
      const sim = await simulate({ days: 1, seed, scenarios: ["flaky"], only: Object.keys(total) });
      for (const r of runs(sim)) total[r.strategy]! += r.metrics.failovers;
    }
    expect(total["fastest"]).toBeLessThanOrEqual(total["free-first"]!);
    expect(total["balanced"]).toBeLessThanOrEqual(total["free-first"]!);
  });
});
