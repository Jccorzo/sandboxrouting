// The generated data must say what the router says. These read the router's own registry and
// compare, so a provider added, removed or re-checked without regenerating fails here.

import { describe, expect, it } from "vitest";
import { parseConfig } from "../../../src/core/config";
import { builtinStrategies } from "../../../src/core/routing/strategies";
import { builtinProviders } from "../../../src/providers/index";
import providersJson from "../../src/generated/providers.json";
import siteJson from "../../src/generated/site.json";
import { COMPARE_IDS } from "../../src/lib/compare-set";
import type { ProviderDoc, SiteData } from "../../src/lib/generated-types";

const providers = providersJson as unknown as ProviderDoc[];
const site = siteJson as unknown as SiteData;
const adapters = builtinProviders();

describe("providers.json", () => {
  it("has exactly the router's built-in providers", () => {
    expect(providers.map((p) => p.id).sort()).toEqual(adapters.map((a) => a.info.id).sort());
    expect(site.counts.total).toBe(adapters.length);
  });

  it("carries each adapter's terms, checked date and pricing link", () => {
    for (const a of adapters) {
      const p = providers.find((x) => x.id === a.info.id)!;
      expect(p.checked, a.info.id).toBe(a.info.freeTier.checked);
      expect(p.pricingUrl, a.info.id).toBe(a.info.pricing.source ?? a.info.freeTier.source);
      expect(p.freeTier.kind, a.info.id).toBe(a.info.freeTier.tier.kind);
      expect(p.capabilities, a.info.id).toEqual(a.info.capabilities);
      expect(p.isolation, a.info.id).toBe(a.info.isolation);
    }
  });

  it("gives every provider with terms a checked date and a pricing link", () => {
    const missing = providers.filter((p) => !p.selfHosted && (!p.checked || !p.pricingUrl)).map((p) => p.id);
    expect(missing).toEqual([]);
  });

  it("offers config overrides the router accepts", () => {
    for (const p of providers) {
      const freeTier =
        p.freeTier.kind === "none" || p.freeTier.kind === "unlimited"
          ? { kind: p.freeTier.kind }
          : { kind: p.freeTier.kind, ...(p.freeTier.usd !== undefined ? { usd: p.freeTier.usd } : {}), ...(p.freeTier.hours !== undefined ? { hours: p.freeTier.hours } : {}) };
      expect(() => parseConfig({ providers: { [p.id]: { freeTier, priority: 10 } } }), p.id).not.toThrow();
    }
  });
});

describe("site.json", () => {
  it("names the router's strategies", () => {
    expect(site.strategies.map((s) => s.name)).toEqual(builtinStrategies().map((s) => s.name));
  });

  it("compares only built-in providers, every pair once", () => {
    const n = COMPARE_IDS.length;
    expect(site.comparisons).toHaveLength((n * (n - 1)) / 2);
    for (const c of site.comparisons) {
      expect(adapters.some((a) => a.info.id === c.a)).toBe(true);
      expect(adapters.some((a) => a.info.id === c.b)).toBe(true);
    }
  });

  it("tells a failover that refuses, marks and then routes around", () => {
    const [first, second] = site.failover;
    expect(first!.attempts.map((a) => a.outcome)).toEqual(["failed", "failed", "failed", "created"]);
    expect(first!.attempts.map((a) => a.kind).slice(0, 3)).toEqual(["quota", "rate_limit", "auth"]);
    expect(second!.attempts.slice(0, 3).every((a) => a.outcome === "skipped")).toBe(true);
  });

  it("opens the circuit after the configured failures and closes it on a probe that works", () => {
    const cfg = site.defaults.circuitBreaker;
    const open = site.circuit.find((p) => p.circuit === "open")!;
    expect(open.consecutiveFailures).toBe(cfg.failures);
    expect(open.openUntilSec! - open.atSec).toBe(cfg.cooldownSec);
    expect(site.circuit.at(-1)!.circuit).toBe("closed");
  });

  it("only draws sandbox moves the router allows", () => {
    const moves = site.sandbox.cells.filter((c) => c.to).map((c) => `${c.from}-${c.event}`);
    expect(moves).toContain("creating-created");
    expect(moves).not.toContain("creating-paused");
    expect(site.sandbox.cells.find((c) => c.from === "creating" && c.event === "paused")!.error).toMatch(/cannot go through/);
  });

  it("plays a job that loses its box and finishes on another", () => {
    const states = site.job.frames.map((f) => f.state);
    expect(states[0]).toBe("queued");
    expect(states).toContain("migrating");
    expect(states.at(-1)).toBe("succeeded");
    expect(site.job.frames.at(-1)!.placements.map((p) => p.endReason)).toEqual(["lost", "finished"]);
  });
});
