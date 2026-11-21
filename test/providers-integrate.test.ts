// Follow-ups from merging the 2026-11-21 provider branches: active-CPU billing on the adapters
// written before the field existed, smol's wall-clock base, and one euro rate.

import { describe, expect, it } from "vitest";
import { expectedRatePerSecond, ratePerSecond } from "../src/core/metering.js";
import { USD_PER_EUR } from "../src/providers/currency.js";
import { boxdProvider } from "../src/providers/boxd.js";
import { briqProvider } from "../src/providers/briq.js";
import { digitaloceanProvider } from "../src/providers/digitalocean.js";
import { railwayProvider } from "../src/providers/railway.js";
import { runtimeProvider } from "../src/providers/runtime.js";
import { smolProvider } from "../src/providers/smol.js";

const perHour = (rate: number) => rate * 3600;

describe("active-CPU billing on the new adapters", () => {
  it("runtime, digitalocean, railway and smol bill the vCPU part only while it is busy", () => {
    for (const p of [runtimeProvider, digitaloceanProvider, railwayProvider, smolProvider]) {
      expect(p.info.pricing.billing, p.info.id).toBe("active-cpu");
    }
  });

  it("smol: $0.04/h wall-clock base + $0.05/vCPU-h used + $0.0162/GB-h, at 2 vCPU / 4 GiB", () => {
    const pricing = smolProvider.info.pricing;
    // Busy and full: the base, both vCPUs and all 4 GiB.
    expect(perHour(ratePerSecond(pricing, 2, 4096))).toBeCloseTo(0.04 + 2 * 0.05 + 4 * 0.0162, 6);
    // Idle CPU still pays the whole base: it is not scaled by the CPU share.
    expect(perHour(expectedRatePerSecond(pricing, 2, 4096, 0))).toBeCloseTo(0.04 + 4 * 0.0162, 6);
    // At 30% CPU: the base, 30% of the vCPUs, the memory.
    expect(perHour(expectedRatePerSecond(pricing, 2, 4096, 0.3))).toBeCloseTo(0.04 + 0.3 * 2 * 0.05 + 4 * 0.0162, 6);
  });
});

describe("one euro rate", () => {
  it("is the ECB reference rate of 2026-11-20", () => {
    expect(USD_PER_EUR).toBe(1.099);
  });

  it("boxd and briq convert prices and credit with it", () => {
    expect(boxdProvider.info.freeTier.tier).toEqual({ kind: "one-time-credit", usd: 30 * USD_PER_EUR });
    expect(perHour(ratePerSecond(boxdProvider.info.pricing, 1, 1024))).toBeCloseTo((0.039 + 0.012) * USD_PER_EUR, 9);
    expect(briqProvider.info.freeTier.tier).toEqual({ kind: "one-time-credit", usd: 10 * USD_PER_EUR });
    expect(perHour(ratePerSecond(briqProvider.info.pricing, 2, 4096))).toBeCloseTo(0.03 * USD_PER_EUR, 9);
  });
});
