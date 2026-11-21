// Terms re-checked on 2026-11-21 (wave 0): each price below is the provider's own figure for a
// size the adapter creates, so a later edit that drifts from the page fails here.

import { describe, expect, it } from "vitest";
import { ratePerSecond } from "../src/core/metering.js";
import { koyebProvider } from "../src/providers/koyeb.js";
import { flyProvider } from "../src/providers/fly.js";
import { quaveProvider } from "../src/providers/quave.js";
import { zodeProvider } from "../src/providers/zode.js";
import { cathedralProvider } from "../src/providers/cathedral.js";
import { tenkiProvider } from "../src/providers/tenki.js";
import type { ProviderAdapter } from "../src/core/types.js";

const perHour = (p: ProviderAdapter, cpu: number, memoryMiB: number) => ratePerSecond(p.info.pricing, cpu, memoryMiB) * 3600;

describe("prices at the sizes the providers list", () => {
  it("Koyeb standard instances: $0.0144/h per vCPU, memory included", () => {
    expect(perHour(koyebProvider, 1, 1024)).toBeCloseTo(0.0144, 6); // small
    expect(perHour(koyebProvider, 2, 2048)).toBeCloseTo(0.0288, 6); // medium
    expect(perHour(koyebProvider, 0.25, 256)).toBeCloseTo(0.0036, 6); // nano
  });

  it("Fly shared-cpu presets, per 730-hour month", () => {
    expect(perHour(flyProvider, 1, 256) * 730).toBeCloseTo(2.19, 2);
    expect(perHour(flyProvider, 1, 1024) * 730).toBeCloseTo(6.69, 2); // listed $6.70
    expect(perHour(flyProvider, 2, 2048) * 730).toBeCloseTo(13.38, 2); // listed $13.39
  });

  it("Quave: zClouds by the larger of CPU or memory, $0.03125/h each", () => {
    expect(perHour(quaveProvider, 0.5, 512)).toBeCloseTo(0.03125, 6);
    expect(perHour(quaveProvider, 2, 4096)).toBeCloseTo(0.25, 6);
  });

  it("Zode $0.0175/h and Cathedral $0.01/h for 2 vCPU / 4 GiB", () => {
    expect(perHour(zodeProvider, 2, 4096)).toBeCloseTo(0.0175, 6);
    expect(perHour(cathedralProvider, 2, 4096)).toBeCloseTo(0.01, 6);
  });
});

describe("Luxor Agent Cloud (was Tenki)", () => {
  const configured = (env: Record<string, string>) => tenkiProvider.isConfigured!({ env, options: {} });

  it("keeps the id and takes the SDK's new LUXOR_* keys as well as the TENKI_* ones", () => {
    expect(tenkiProvider.info.id).toBe("tenki");
    expect(configured({ LUXOR_API_KEY: "lx_k" })).toBe(true);
    expect(configured({ LUXOR_AUTH_TOKEN: "lx_t" })).toBe(true);
    expect(configured({ TENKI_API_KEY: "tk_k" })).toBe(true);
    expect(configured({ TENKI_AUTH_TOKEN: "tk_t" })).toBe(true);
    expect(configured({})).toBe(false);
  });
});
