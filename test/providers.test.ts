// Every built-in adapter keeps the contract the router relies on.
import { describe, expect, it } from "vitest";
import { builtinProviders } from "../src/index.js";

describe("built-in providers", () => {
  const all = builtinProviders();

  it("have unique ids", () => {
    expect(new Set(all.map((p) => p.info.id)).size).toBe(all.length);
  });

  it.each(all.map((p) => [p.info.id, p] as const))("%s declares terms, prices and the required calls", (_id, p) => {
    expect(typeof p.create).toBe("function");
    expect(typeof p.exec).toBe("function");
    expect(typeof p.kill).toBe("function");
    expect(p.info.pricing.defaultCpu).toBeGreaterThan(0);
    expect(p.info.pricing.defaultMemoryMiB).toBeGreaterThan(0);
    if (p.info.selfHosted) {
      expect(p.info.freeTier.tier.kind).toBe("unlimited");
    } else {
      // Cloud providers must say where their free-tier terms come from, and cost something after.
      expect(p.info.freeTier.source).toMatch(/^https:\/\//);
      expect(p.info.freeTier.checked).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(p.info.pricing.vcpuSecondUsd + p.info.pricing.gibSecondUsd).toBeGreaterThan(0);
      expect(p.info.env.length).toBeGreaterThan(0);
    }
    // A capability claim needs the call that backs it.
    if (p.info.capabilities.includes("pause")) expect(p.pause && p.resume).toBeTruthy();
    if (p.info.capabilities.includes("ports")) expect(p.getUrl).toBeTruthy();
    if (p.info.capabilities.includes("extendTimeout")) expect(p.setTimeout).toBeTruthy();
    if (p.info.capabilities.includes("fileList")) expect(p.listFiles).toBeTruthy();
  });
});
