// Providers that bill only active CPU (Pricing.billing = "active-cpu"): strategies rank them by
// the expected cost at `activeCpuShare`, while free-tier reservations, the paid budget and the
// ledger's metering stay on wall clock, so no free tier or budget is overspent when a box turns
// out to be busy.

import { describe, expect, it } from "vitest";
import { fakeProvider } from "./fake.js";
import { parseConfig } from "../src/core/config.js";
import { emptyLedger, type LedgerData } from "../src/core/ledger.js";
import { DEFAULT_ACTIVE_CPU_SHARE, expectedRatePerSecond, freeStatus, ratePerSecond } from "../src/core/metering.js";
import { plan, type Plan, type PolicyInput } from "../src/core/policy.js";
import { balanced, cheapest, freeFirst } from "../src/core/routing/strategies.js";
import type { FreeTier, Pricing, ProviderAdapter, SandboxSpec } from "../src/core/types.js";

const NOW = Date.UTC(2026, 10, 11, 12, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();

/** A provider priced per vCPU-second and GiB-second; `active` bills only active CPU. */
function box(id: string, tier: FreeTier, pricing: Partial<Pricing>): ProviderAdapter {
  const a = fakeProvider({ id, tier });
  a.info.pricing = { ...a.info.pricing, vcpuSecondUsd: 0, gibSecondUsd: 0, defaultCpu: 2, defaultMemoryMiB: 4096, ...pricing };
  return a;
}

function input(adapters: ProviderAdapter[], config: unknown = {}, spec: SandboxSpec = {}, data: LedgerData = emptyLedger()): PolicyInput {
  return {
    adapters,
    config: parseConfig(config),
    data,
    spec: { cpu: 2, memoryMiB: 4096, timeoutSec: 3600, env: {}, metadata: {}, ...spec },
    now: NOW,
    ctxFor: () => ({ env: {}, options: {} }),
  };
}

const order = (p: Plan) => p.ordered.map((e) => e.provider);
const reasons = (p: Plan) => Object.fromEntries(p.skipped.map((s) => [s.provider, s.reason]));

// Vercel-like: $0.128 per active vCPU-hour, $0.0212 per GB-hour of memory, about $0.34/h at full CPU.
const VERCEL = { vcpuSecondUsd: 0.128 / 3600, gibSecondUsd: 0.0212 / 3600, billing: "active-cpu" as const };
// A wall-clock provider at $0.20/h for 2 vCPU / 4 GiB: cheaper than Vercel at full CPU, dearer at 30%.
const WALL = { vcpuSecondUsd: 0.08 / 3600, gibSecondUsd: 0.01 / 3600 };

describe("expected cost of an active-CPU provider", () => {
  it("discounts only the CPU part, by the expected share; memory is billed while it runs", () => {
    const p: Pricing = { ...VERCEL, defaultCpu: 2, defaultMemoryMiB: 4096 };
    expect(ratePerSecond(p, 2, 4096) * 3600).toBeCloseTo(0.3408);
    expect(DEFAULT_ACTIVE_CPU_SHARE).toBe(0.3);
    expect(expectedRatePerSecond(p, 2, 4096) * 3600).toBeCloseTo(2 * 0.128 * 0.3 + 4 * 0.0212);
    expect(expectedRatePerSecond({ ...p, activeCpuShare: 0.1 }, 2, 4096) * 3600).toBeCloseTo(2 * 0.128 * 0.1 + 4 * 0.0212);
    // The routing default applies where pricing sets no share; pricing's own share wins.
    expect(expectedRatePerSecond(p, 2, 4096, 1) * 3600).toBeCloseTo(0.3408);
    expect(expectedRatePerSecond({ ...p, activeCpuShare: 0.5 }, 2, 4096, 1) * 3600).toBeCloseTo(2 * 0.128 * 0.5 + 4 * 0.0212);
  });

  it("never ranks under the share a provider bills however idle the box is", () => {
    const p: Pricing = { vcpuSecondUsd: 0.07 / 3600, gibSecondUsd: 0, billing: "active-cpu", activeCpuFloor: 0.2, defaultCpu: 1, defaultMemoryMiB: 1024 };
    expect(expectedRatePerSecond(p, 1, 1024, 0.1) * 3600).toBeCloseTo(0.07 * 0.2);
    expect(expectedRatePerSecond(p, 1, 1024, 0.5) * 3600).toBeCloseTo(0.07 * 0.5);
  });

  it("is the wall-clock rate for wall-clock providers, and for a flat per-size rate", () => {
    const wall: Pricing = { ...WALL, defaultCpu: 2, defaultMemoryMiB: 4096 };
    expect(expectedRatePerSecond(wall, 2, 4096)).toBe(ratePerSecond(wall, 2, 4096));
    const flat: Pricing = { vcpuSecondUsd: 0, gibSecondUsd: 0, sandboxSecondUsd: 0.0001, billing: "active-cpu", defaultCpu: 2, defaultMemoryMiB: 4096 };
    expect(expectedRatePerSecond(flat, 2, 4096)).toBe(0.0001);
  });
});

describe("ranking by expected cost", () => {
  it("cheapest puts an active-CPU provider ahead of a wall-clock one that only looks cheaper at full CPU", () => {
    const p = plan({ ...input([box("wall", { kind: "none" }, WALL), box("vercel", { kind: "none" }, VERCEL)], { allowPaid: true }), strategy: cheapest });
    expect(order(p)).toEqual(["vercel", "wall"]);
    const vercel = p.ordered.find((e) => e.provider === "vercel")!;
    expect(vercel.ratePerSecondUsd * 3600).toBeCloseTo(0.1616);
    expect(vercel.maxRatePerSecondUsd * 3600).toBeCloseTo(0.3408);
    expect(vercel.why).toEqual(["paid", "~$0.1616/h at 30% CPU (up to $0.3408/h)"]);
    expect(p.ordered.find((e) => e.provider === "wall")!.why).toEqual(["paid", "$0.2000/h"]);
  });

  it("cheapest orders free tiers by expected cost too", () => {
    const tier: FreeTier = { kind: "monthly-credit", usd: 100 };
    const p = plan({ ...input([box("wall", tier, WALL), box("vercel", tier, VERCEL)]), strategy: cheapest });
    expect(order(p)).toEqual(["vercel", "wall"]);
  });

  it("free-first and balanced rank the paid lane by expected cost", () => {
    for (const strategy of [freeFirst, balanced]) {
      const p = plan({ ...input([box("wall", { kind: "none" }, WALL), box("vercel", { kind: "none" }, VERCEL)], { allowPaid: true }), strategy });
      expect(order(p)).toEqual(["vercel", "wall"]);
    }
  });

  it("routing.activeCpuShare sets the expected share for a CPU-bound workload", () => {
    const adapters = [box("wall", { kind: "none" }, WALL), box("vercel", { kind: "none" }, VERCEL)];
    const p = plan({ ...input(adapters, { allowPaid: true, routing: { activeCpuShare: 1 } }), strategy: cheapest });
    expect(order(p)).toEqual(["wall", "vercel"]);
  });

  it("a provider's config overrides its billing and share", () => {
    const adapters = [box("wall", { kind: "none" }, WALL), box("vercel", { kind: "none" }, VERCEL)];
    const share = plan({ ...input(adapters, { allowPaid: true, providers: { vercel: { pricing: { activeCpuShare: 0.9 } } } }), strategy: cheapest });
    expect(order(share)).toEqual(["wall", "vercel"]);
    const wall = plan({ ...input(adapters, { allowPaid: true, providers: { vercel: { pricing: { billing: "wall" } } } }), strategy: cheapest });
    expect(order(wall)).toEqual(["wall", "vercel"]);
    const turnedOn = plan({
      ...input([box("wall", { kind: "none" }, WALL), box("other", { kind: "none" }, { ...VERCEL, billing: "wall" })], {
        allowPaid: true,
        providers: { other: { pricing: { billing: "active-cpu" } } },
      }),
      strategy: cheapest,
    });
    expect(order(turnedOn)).toEqual(["other", "wall"]);
  });

  it("config rejects a share outside 0..1", () => {
    expect(() => parseConfig({ routing: { activeCpuShare: 1.5 } })).toThrow();
    expect(() => parseConfig({ providers: { vercel: { pricing: { activeCpuShare: -0.1 } } } })).toThrow();
  });
});

describe("reservations stay on wall clock", () => {
  it("a free credit takes a request only if it covers the whole timeout at full CPU", () => {
    // An hour at full CPU costs $0.34; at 30% it would be $0.16. $0.25 covers only the expected cost.
    const p = plan({ ...input([box("vercel", { kind: "monthly-credit", usd: 0.25 }, VERCEL)]), strategy: cheapest });
    expect(order(p)).toEqual([]);
    expect(reasons(p)["vercel"]).toMatch(/won't cover this request \(\$0\.34\)/);
  });

  it("the paid budget holds the wall-clock cost", () => {
    const p = plan({ ...input([box("vercel", { kind: "none" }, VERCEL)], { allowPaid: true, maxPaidUsdPerMonth: 0.25 }), strategy: cheapest });
    expect(order(p)).toEqual([]);
    expect(reasons(p)["vercel"]).toMatch(/won't cover this request \(\$0\.34\)/);
  });

  it("the ledger meters a finished box by wall clock: the router can't see its CPU time", () => {
    const adapter = box("vercel", { kind: "monthly-credit", usd: 10 }, VERCEL);
    const data = emptyLedger();
    const start = iso(NOW - 3_600_000);
    data.sandboxes["a"] = {
      id: "a", provider: "vercel", state: "stopped", cpu: 2, memoryMiB: 4096, createdAt: start, metadata: {},
      providerSandboxId: "a", segments: [{ start, end: iso(NOW) }], endedAt: iso(NOW), reason: "killed",
    };
    const free = freeStatus(adapter.info, undefined, data, NOW);
    expect(free.state === "available" && free.remaining).toBeCloseTo(10 - 0.3408);
  });
});
