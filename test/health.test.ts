import { describe, expect, it } from "vitest";
import { providerHealth, recordHealth } from "../src/core/health.js";
import { emptyLedger, type HealthSample, type LedgerData } from "../src/core/ledger.js";

const NOW = Date.UTC(2026, 10, 11, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const breaker = { failures: 3, cooldownSec: 120, maxCooldownSec: 1800 };
const iso = (ms: number) => new Date(ms).toISOString();

const ok = (at: number, ms?: number): HealthSample => ({ at: iso(at), op: "create", ok: true, ms });
const fail = (at: number): HealthSample => ({ at: iso(at), op: "create", ok: false, kind: "transient" });
const lost = (at: number): HealthSample => ({ at: iso(at), op: "lost", ok: false, kind: "not_found" });

function ledger(samples: HealthSample[]): LedgerData {
  const data = emptyLedger();
  data.health["p"] = samples;
  return data;
}
const health = (samples: HealthSample[], now = NOW, cfg = breaker) => providerHealth(ledger(samples), "p", now, cfg);
const failures = (n: number, last: number) => Array.from({ length: n }, (_, i) => fail(last - (n - 1 - i) * 1000));

describe("success rate", () => {
  it("reads 0.9 with no data, with the circuit closed", () => {
    expect(health([])).toEqual({ samples: 0, successRate: 0.9, consecutiveFailures: 0, circuit: "closed" });
  });

  it("leans toward the 0.9 prior with few samples; many outweigh it", () => {
    expect(health([ok(NOW)]).successRate).toBeCloseTo(2.8 / 3); // (1 + 0.9·2) / (1 + 2)
    expect(health([fail(NOW)]).successRate).toBeCloseTo(1.8 / 3);
    expect(health(Array.from({ length: 50 }, () => ok(NOW))).successRate).toBeCloseTo(51.8 / 52);
    expect(health(Array.from({ length: 50 }, () => lost(NOW))).successRate).toBeCloseTo(1.8 / 52);
  });

  it("weighs recent outcomes more, with a half-life of an hour", () => {
    expect(health([fail(NOW - HOUR), ok(NOW)]).successRate).toBeCloseTo((1 + 1.8) / (1.5 + 2));
    expect(health([ok(NOW - HOUR), fail(NOW)]).successRate).toBeCloseTo((0.5 + 1.8) / (1.5 + 2));
    // A day-old failure has all but decayed back to the prior.
    expect(health([fail(NOW - DAY)]).successRate).toBeCloseTo(0.9, 5);
  });

  it("ignores samples older than 7 days", () => {
    expect(health(failures(5, NOW - 8 * DAY))).toEqual({ samples: 0, successRate: 0.9, consecutiveFailures: 0, circuit: "closed" });
  });
});

describe("create latency", () => {
  it("is the median of successful creates; failures, lost boxes and creates without a time don't count", () => {
    expect(health([ok(NOW, 300), fail(NOW), ok(NOW, 100), lost(NOW), ok(NOW), ok(NOW, 200)]).createP50Ms).toBe(200);
    expect(health([ok(NOW, 100), ok(NOW, 400), ok(NOW, 200), ok(NOW, 300)]).createP50Ms).toBe(250);
    expect(health([fail(NOW)]).createP50Ms).toBeUndefined();
  });
});

describe("consecutive failures and the circuit", () => {
  it("counts the trailing run of failures, newest backwards", () => {
    const h = health([fail(NOW - 5 * MIN), ok(NOW - 4 * MIN), fail(NOW - 3 * MIN), lost(NOW - 2 * MIN)]);
    expect(h).toMatchObject({ consecutiveFailures: 2, lastFailureAt: NOW - 2 * MIN, circuit: "closed" });
    expect(health([fail(NOW - 2 * MIN), ok(NOW - MIN)])).toMatchObject({ consecutiveFailures: 0, lastFailureAt: NOW - 2 * MIN });
  });

  it("opens after `failures` in a row for cooldownSec, then half-opens", () => {
    const samples = failures(3, NOW);
    expect(health(samples, NOW + 119_000)).toMatchObject({ circuit: "open", openUntil: NOW + 120_000, consecutiveFailures: 3 });
    expect(health(samples, NOW + 120_000).circuit).toBe("half-open");
    expect(health(samples, NOW + 120_000).openUntil).toBeUndefined();
  });

  it("doubles the cooldown with each further failure, up to maxCooldownSec", () => {
    expect(health(failures(4, NOW)).openUntil).toBe(NOW + 240_000);
    expect(health(failures(5, NOW)).openUntil).toBe(NOW + 480_000);
    expect(health(failures(8, NOW)).openUntil).toBe(NOW + 1_800_000); // 120 s × 32 is over the cap
    expect(health(failures(40, NOW)).openUntil).toBe(NOW + 1_800_000);
  });

  it("closes on a success", () => {
    expect(health([...failures(5, NOW - MIN), ok(NOW)])).toMatchObject({ circuit: "closed", consecutiveFailures: 0 });
  });

  it("never opens with failures: 0", () => {
    expect(health(failures(10, NOW), NOW, { ...breaker, failures: 0 }).circuit).toBe("closed");
  });
});

describe("recording", () => {
  it("keeps the newest `keep` samples, oldest first", () => {
    const data = emptyLedger();
    for (let i = 0; i < 5; i++) recordHealth(data, "p", ok(NOW + i * MIN, i), 3);
    expect(data.health["p"]!.map((s) => s.ms)).toEqual([2, 3, 4]);
  });

  it("drops samples older than 7 days", () => {
    const data = emptyLedger();
    recordHealth(data, "p", fail(NOW - 8 * DAY), 50);
    recordHealth(data, "p", fail(NOW - 6 * DAY), 50);
    recordHealth(data, "p", ok(NOW), 50);
    expect(data.health["p"]).toEqual([fail(NOW - 6 * DAY), ok(NOW)]);
  });

  it("files an outcome that arrives late in time order, so the newest one decides", () => {
    const data = emptyLedger();
    recordHealth(data, "p", ok(NOW), 50);
    recordHealth(data, "p", fail(NOW - MIN), 50); // a slow create that started and failed earlier
    expect(data.health["p"]).toEqual([fail(NOW - MIN), ok(NOW)]);
    expect(providerHealth(data, "p", NOW, breaker).consecutiveFailures).toBe(0);
  });
});
