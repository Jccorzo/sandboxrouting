// Free credit and the paid budget are reserved for what live sandboxes will still spend, so
// parallel requests can't all fit in what's left: a free tier takes a request only when it covers
// all of it, and paid usage only when the month's budget does. Each test failed on the router
// before the fix.
import { describe, expect, it } from "vitest";
import { clock, fakeProvider, router } from "./fake.js";
import { NoProviderAvailableError, type Sandbox, type SandboxRouter } from "../src/index.js";
import { parseConfig } from "../src/core/config.js";
import { emptyLedger, type LedgerData } from "../src/core/ledger.js";
import { committed } from "../src/core/metering.js";
import { eligibility, type PolicyInput } from "../src/core/policy.js";
import type { ProviderAdapter, SandboxSpec } from "../src/core/types.js";

const NOW = Date.UTC(2026, 10, 11, 12, 0, 0);
const RESET = Date.UTC(2026, 11, 1);
const iso = (ms: number) => new Date(ms).toISOString();
const HOUR_AT_1_VCPU = { cpu: 1, timeoutSec: 3600 }; // explicit cpu: the projected cost is the real one

/** `n` creates at the same instant: what was made, and why the rest weren't. */
async function parallel(r: SandboxRouter, n: number, spec: SandboxSpec) {
  const settled = await Promise.allSettled(Array.from({ length: n }, () => r.create(spec)));
  const made = settled.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));
  const refused = settled.flatMap((s) => (s.status === "rejected" ? [s.reason as unknown] : []));
  for (const err of refused) expect(err).toBeInstanceOf(NoProviderAvailableError);
  return { made, refused: refused as NoProviderAvailableError[] };
}

const details = (err: NoProviderAvailableError, provider: string) => err.attempts.filter((a) => a.provider === provider).map((a) => a.detail);

describe("parallel creates can't spend more than is left", () => {
  it("5 parallel 1-hour paid boxes ($18) against a $1 budget: none is created", async () => {
    const paid = fakeProvider({ id: "paid", tier: { kind: "none" }, rate: 0.001 }); // $3.60 an hour at 1 vCPU
    const { router: r } = router([paid], { allowPaid: true, maxPaidUsdPerMonth: 1 });
    const { made, refused } = await parallel(r, 5, HOUR_AT_1_VCPU);
    expect(made).toHaveLength(0);
    for (const err of refused) expect(details(err, "paid")).toEqual(["no free tier; paid budget left this month ($1.00) won't cover this request ($3.60)"]);
  });

  it("only as many paid boxes as the budget covers are created; the rest fail with the coverage reason", async () => {
    const paid = fakeProvider({ id: "paid", tier: { kind: "none" }, rate: 0.0001 }); // $0.36 an hour at 1 vCPU
    const { router: r } = router([paid], { allowPaid: true, maxPaidUsdPerMonth: 1 });
    const { made, refused } = await parallel(r, 5, HOUR_AT_1_VCPU);
    expect(made).toHaveLength(2); // $0.72; a third would make it $1.08
    expect(refused).toHaveLength(3);
    for (const err of refused) {
      expect(details(err, "paid")).toEqual([expect.stringMatching(/paid budget left this month \(\$0\.28 after \$0\.72 committed\) won't cover this request \(\$0\.36\)$/)]);
    }
  });

  it("an exact fit still fits: five $0.20 boxes in a $1 budget", async () => {
    const paid = fakeProvider({ id: "paid", tier: { kind: "none" }, rate: 0.0001 });
    const { router: r } = router([paid], { allowPaid: true, maxPaidUsdPerMonth: 1 });
    // Summed in floats, four $0.20 commitments leave $0.19999999999999996.
    const { made } = await parallel(r, 6, { cpu: 1, timeoutSec: 2000 });
    expect(made).toHaveLength(5);
  });

  it("5 parallel 1-hour boxes against $0.01 of free credit with allowPaid off: none is created", async () => {
    const tiny = fakeProvider({ id: "tiny", tier: { kind: "one-time-credit", usd: 0.01 } }); // $0.036 an hour at 1 vCPU
    const { router: r } = router([tiny]);
    const { made, refused } = await parallel(r, 5, HOUR_AT_1_VCPU);
    expect(made).toHaveLength(0);
    for (const err of refused) {
      expect(details(err, "tiny")).toEqual(["free credit left ($0.010) won't cover this request ($0.036); paid usage is off (allowPaid)"]);
    }
    expect((await r.list({ all: true })).length).toBe(0);
  });

  it("a small free tier takes only what it covers; with paid off the rest fail with the coverage reason", async () => {
    const tiny = fakeProvider({ id: "tiny", tier: { kind: "one-time-credit", usd: 0.01 }, rate: 0.000001 }); // $0.0036 an hour
    const { router: r } = router([tiny]);
    const { made, refused } = await parallel(r, 5, HOUR_AT_1_VCPU);
    expect(made).toHaveLength(2);
    for (const err of refused) {
      expect(details(err, "tiny")).toEqual([
        expect.stringMatching(/^free credit left \(\$0\.0028 after \$0\.0072 committed\) won't cover this request \(\$0\.0036\); paid usage is off/),
      ]);
    }
  });

  it("...and the rest go to the next provider instead", async () => {
    const tiny = fakeProvider({ id: "tiny", tier: { kind: "one-time-credit", usd: 0.01 }, rate: 0.000001 });
    const big = fakeProvider({ id: "big", tier: { kind: "one-time-credit", usd: 100 } });
    const { router: r } = router([tiny, big], { providers: { tiny: { priority: 1 } } });
    const { made } = await parallel(r, 5, HOUR_AT_1_VCPU);
    expect(made.map((s) => s.provider).sort()).toEqual(["big", "big", "big", "tiny", "tiny"]);
    for (const s of made.filter((x) => x.provider === "big")) {
      expect(s.route.find((a) => a.provider === "tiny")?.detail).toMatch(/free credit left \(\$0\.0028 after \$0\.0072 committed\) won't cover this request/);
    }
  });
});

describe("a commitment ends with its sandbox", () => {
  it("free: a box killed early gives back the rest of its lifetime, so the next request fits", async () => {
    const c = clock();
    const tiny = fakeProvider({ id: "tiny", tier: { kind: "one-time-credit", usd: 0.01 }, rate: 0.000001 });
    const { router: r } = router([tiny], {}, c);
    const a = await r.create(HOUR_AT_1_VCPU);
    await r.create(HOUR_AT_1_VCPU);
    const third = await r.create(HOUR_AT_1_VCPU).catch((e: unknown) => e);
    expect(third).toBeInstanceOf(NoProviderAvailableError);
    // Live boxes hold the credit and may end at any moment.
    expect((third as NoProviderAvailableError).retryAt).toBe(c.now());
    c.advance(600_000); // each has spent $0.0006 and holds $0.003 more
    await a.kill();
    // $0.0088 left, $0.003 of it held by the other box: room for another hour ($0.0036).
    expect((await r.create(HOUR_AT_1_VCPU)).provider).toBe("tiny");
  });

  it("paid: a box killed early gives back the rest of its projected cost", async () => {
    const c = clock();
    const paid = fakeProvider({ id: "paid", tier: { kind: "none" }, rate: 0.0001 });
    const { router: r } = router([paid], { allowPaid: true, maxPaidUsdPerMonth: 1 }, c);
    const a = await r.create(HOUR_AT_1_VCPU);
    await r.create(HOUR_AT_1_VCPU);
    const third = await r.create(HOUR_AT_1_VCPU).catch((e: unknown) => e);
    expect((third as NoProviderAvailableError).retryAt).toBe(c.now());
    c.advance(600_000); // $0.06 spent by each
    await a.kill();
    // $0.12 spent, $0.30 held by the other box: $0.58 left.
    expect((await r.create(HOUR_AT_1_VCPU)).provider).toBe("paid");
  });

  it("a box that runs to its deadline turns its commitment into spend: the room left doesn't change", async () => {
    const c = clock();
    const tiny = fakeProvider({ id: "tiny", tier: { kind: "monthly-credit", usd: 0.01 }, rate: 0.000001 });
    const { router: r } = router([tiny], {}, c);
    await r.create(HOUR_AT_1_VCPU);
    await r.create(HOUR_AT_1_VCPU);
    const before = (await r.plan(HOUR_AT_1_VCPU)).skipped[0]!.reason;
    c.advance(3_600_000);
    const after = await r.plan(HOUR_AT_1_VCPU);
    expect(before).toMatch(/\$0\.0028 after \$0\.0072 committed/);
    // Both ended at their deadlines: $0.0028 is still all there is, and only the reset brings more.
    expect(after.skipped[0]).toEqual({
      provider: "tiny",
      reason: "free credit left ($0.0028) won't cover this request ($0.0036); paid usage is off (allowPaid)",
      until: RESET,
    });
  });
});

describe("free hours", () => {
  it("are reserved in sandbox-seconds, whatever the size", async () => {
    const c = clock();
    const hours = fakeProvider({ id: "hours", tier: { kind: "monthly-hours", hours: 1 } });
    const { router: r } = router([hours], {}, c);
    await r.create({ cpu: 4, timeoutSec: 1800 });
    await r.create({ cpu: 1, timeoutSec: 1800 }); // exactly the half hour left
    const third = await r.create({ timeoutSec: 600 }).catch((e: unknown) => e);
    expect(third).toBeInstanceOf(NoProviderAvailableError);
    expect(details(third as NoProviderAvailableError, "hours")).toEqual([
      "free hours left (0.00 h after 1.00 h committed) won't cover this request (0.17 h); paid usage is off (allowPaid)",
    ]);
    expect((third as NoProviderAvailableError).retryAt).toBe(c.now());
  });

  it("parallel creates take only what the hours cover", async () => {
    const hours = fakeProvider({ id: "hours", tier: { kind: "monthly-hours", hours: 1 } });
    const { router: r } = router([hours]);
    const { made } = await parallel(r, 5, { timeoutSec: 1500 });
    expect(made).toHaveLength(2); // 50 minutes of the hour
  });
});

describe("when a coverage reason may lapse", () => {
  const spec = HOUR_AT_1_VCPU;

  it("with nothing live: at the reset for a monthly tier, never for a one-time credit", async () => {
    const { router: r } = router([
      fakeProvider({ id: "monthly", tier: { kind: "monthly-credit", usd: 0.01 } }),
      fakeProvider({ id: "onetime", tier: { kind: "one-time-credit", usd: 0.01 } }),
    ]);
    const until = Object.fromEntries((await r.plan(spec)).skipped.map((s) => [s.provider, s.until]));
    expect(until).toEqual({ monthly: RESET, onetime: undefined });
  });

  it("paid: next month with nothing live, at once while live paid boxes hold part of it", async () => {
    const paid = fakeProvider({ id: "paid", tier: { kind: "none" }, rate: 0.0001 });
    const { router: r, clock: c } = router([paid], { allowPaid: true, maxPaidUsdPerMonth: 0.3 });
    expect((await r.plan(spec)).skipped[0]).toEqual({
      provider: "paid",
      reason: "no free tier; paid budget left this month ($0.30) won't cover this request ($0.36)",
      until: RESET,
    });
    await r.create({ cpu: 1, timeoutSec: 1800 }); // $0.18
    expect((await r.plan({ cpu: 1, timeoutSec: 1800 })).skipped[0]?.until).toBe(c.now());
  });
});

// ------------------------------------------------------------------ the definition

function input(adapters: ProviderAdapter[], config: unknown = {}, spec: Partial<SandboxSpec> = {}, data = emptyLedger()): PolicyInput {
  return {
    adapters,
    config: parseConfig(config),
    data,
    spec: { cpu: 1, memoryMiB: 1024, timeoutSec: 3600, env: {}, metadata: {}, ...spec },
    now: NOW,
    ctxFor: () => ({ env: {}, options: {} }),
  };
}

type Rec = { billing?: string; cpu?: number };

/** Running since a minute ago, `leftSec` to its deadline. No `billing`, like a record from an older ledger. */
function running(data: LedgerData, provider: string, leftSec: number, o: Rec = {}): void {
  const id = `${provider}-${Object.keys(data.sandboxes).length}`;
  const start = iso(NOW - 60_000);
  data.sandboxes[id] = {
    id, provider, state: "running", cpu: o.cpu ?? 1, memoryMiB: 1024, createdAt: start, metadata: {},
    providerSandboxId: id, expiresAt: iso(NOW + leftSec * 1000), segments: [{ start }],
    ...(o.billing === undefined ? {} : { billing: o.billing }),
  };
}

function creating(data: LedgerData, provider: string, timeoutSec: number | undefined, o: Rec = {}): void {
  const id = `${provider}-${Object.keys(data.sandboxes).length}`;
  data.sandboxes[id] = {
    id, provider, state: "creating", cpu: o.cpu ?? 1, memoryMiB: 1024, createdAt: iso(NOW - 1000), metadata: {},
    ...(timeoutSec === undefined ? {} : { timeoutSec }),
    ...(o.billing === undefined ? {} : { billing: o.billing }),
  };
}

describe("committed(): what live sandboxes will still spend", () => {
  it("running until its deadline, creating for the lifetime it asked for, paused nothing; at each record's size, by billing", () => {
    const p = fakeProvider({ id: "p", tier: { kind: "monthly-credit", usd: 30 }, rate: 0.001 });
    const data = emptyLedger();
    running(data, "p", 1000, { billing: "free", cpu: 2 }); // 1000 s at $0.002/s
    running(data, "p", 500); // no billing, and p has a free tier: free
    creating(data, "p", 600, { billing: "paid" }); // 600 s at $0.001/s
    creating(data, "p", undefined, { billing: "free" }); // an older ledger's create: nothing known
    running(data, "p", -10, { billing: "free" }); // past its deadline
    running(data, "other", 1000, { billing: "free" }); // another provider's
    const id = Object.keys(data.sandboxes).length;
    data.sandboxes[`p-${id}`] = {
      id: `p-${id}`, provider: "p", state: "paused", cpu: 1, memoryMiB: 1024, createdAt: iso(NOW - 60_000), metadata: {},
      providerSandboxId: "x", segments: [{ start: iso(NOW - 60_000), end: iso(NOW - 30_000) }], billing: "free",
    };
    const held = committed(p.info, undefined, data, NOW);
    expect(held.free.sandboxSeconds).toBe(1500);
    expect(held.free.usd).toBeCloseTo(2 + 0.5);
    expect(held.paid.sandboxSeconds).toBe(600);
    expect(held.paid.usd).toBeCloseTo(0.6);
    expect(held["self-hosted"]).toEqual({ usd: 0, sandboxSeconds: 0 });
  });

  it("a record without billing counts as paid on a provider without a free tier", () => {
    const p = fakeProvider({ id: "p", tier: { kind: "none" }, rate: 0.001 });
    const data = emptyLedger();
    running(data, "p", 1000);
    expect(committed(p.info, undefined, data, NOW)).toMatchObject({ free: { usd: 0 }, paid: { sandboxSeconds: 1000 } });
  });
});

describe("records from older ledgers", () => {
  it("a running box without billing holds its provider's free credit, not the paid budget", () => {
    const credit = fakeProvider({ id: "credit", tier: { kind: "one-time-credit", usd: 1 }, rate: 0.0001 });
    const paid = fakeProvider({ id: "paid", tier: { kind: "none" }, rate: 0.0001 });
    const data = emptyLedger();
    running(data, "credit", 7200); // $0.72 more to come, out of the $1 credit
    const inp = input([credit, paid], { allowPaid: true, maxPaidUsdPerMonth: 1 }, {}, data);
    // $0.994 left, $0.72 held: a $0.36 hour doesn't fit in the credit...
    expect(eligibility(inp, "credit")).toMatchObject({ ok: true, billing: "paid", candidate: { freeUsable: false } });
    // ...and the $1 budget is untouched by it.
    expect(eligibility(inp, "paid")).toMatchObject({ ok: true, billing: "paid" });
  });

  it("a running box without billing on a provider without a free tier holds the paid budget", () => {
    const paid = fakeProvider({ id: "paid", tier: { kind: "none" }, rate: 0.0001 });
    const data = emptyLedger();
    running(data, "paid", 7200); // $0.006 spent, $0.72 to come
    expect(eligibility(input([paid], { allowPaid: true, maxPaidUsdPerMonth: 1 }, {}, data), "paid")).toEqual({
      ok: false,
      reason: "no free tier; paid budget left this month ($0.27 after $0.72 committed) won't cover this request ($0.36)",
      until: NOW,
    });
  });

  it("a create without timeoutSec holds nothing", () => {
    const tiny = fakeProvider({ id: "tiny", tier: { kind: "one-time-credit", usd: 0.01 }, rate: 0.000001 });
    const data = emptyLedger();
    creating(data, "tiny", undefined);
    creating(data, "tiny", undefined);
    creating(data, "tiny", undefined);
    expect(eligibility(input([tiny], {}, {}, data), "tiny")).toMatchObject({ ok: true, billing: "free" });
    creating(data, "tiny", 3600, { billing: "free" });
    creating(data, "tiny", 3600, { billing: "free" });
    expect(eligibility(input([tiny], {}, {}, data), "tiny")).toMatchObject({ ok: false, reason: expect.stringMatching(/after \$0\.0072 committed/) });
  });
});

describe("unchanged", () => {
  it("your hardware has nothing to run out of", async () => {
    const local = fakeProvider({ id: "local", tier: { kind: "unlimited" }, selfHosted: true, rate: 0 });
    const { router: r } = router([local]);
    const { made } = await parallel(r, 5, { timeoutSec: 86_400 });
    expect(made).toHaveLength(5);
  });

  it("without a budget, paid usage only needs allowPaid", async () => {
    const paid = fakeProvider({ id: "paid", tier: { kind: "none" }, rate: 0.001 });
    const { router: r } = router([paid], { allowPaid: true });
    const { made } = await parallel(r, 5, HOUR_AT_1_VCPU);
    expect(made.map((s: Sandbox) => s.provider)).toEqual(["paid", "paid", "paid", "paid", "paid"]);
  });
});

describe("the box a reservation prices is the one the provider will create", () => {
  // Free credit priced by memory, on a provider whose default box is 4 GiB (like freestyle,
  // cloudflare, boat and tenki): enough for 300 s of a 2 GiB box, not of a 4 GiB one.
  function bigDefault() {
    const p = fakeProvider({ id: "big", tier: { kind: "monthly-credit", usd: 0.008 } });
    p.info.pricing = { ...p.info.pricing, vcpuSecondUsd: 0, gibSecondUsd: 0.00001, defaultMemoryMiB: 4096 };
    return p;
  }

  it("a request that leaves the size to the provider reserves its default box, not the common ranking size", async () => {
    const { router: r } = router([bigDefault()]);
    const p = await r.plan({ timeoutSec: 300 });
    expect(p.ordered).toEqual([]);
    // 4 GiB × $0.00001/GiB-s × 300 s; priced at the 2 GiB ranking size it would have looked like $0.006.
    expect(p.skipped[0]!.reason).toMatch(/free credit left \(\$0\.0080\) won't cover this request \(\$0\.012\)/);
  });

  it("a request for 2 GiB on the same provider fits, because that's the box it gets", async () => {
    const { router: r } = router([bigDefault()]);
    const sbx = await r.create({ timeoutSec: 300, memoryMiB: 2048 });
    expect((await sbx.info())!.memoryMiB).toBe(2048);
  });
});
