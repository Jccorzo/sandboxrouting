// What happens after a provider refuses a create with a 402. A burst that arrived once the mark
// lapsed sent every create into the same refusal, and a spent one-time credit was asked again
// every day for ever. Each test failed on the router before the quota mark had a lifecycle.
import { describe, expect, it } from "vitest";
import { clock, fakeProvider, router } from "./fake.js";
import { MemoryLedger, SandboxRouter, type LedgerData } from "../src/index.js";

const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
const refusal = () => Object.assign(new Error("402 Payment Required: the account's credit is used up"), { status: 402 });
const refusals = (n: number) => Array.from({ length: n }, refusal);

/** "a" goes first (priority 1) and fails creates as told; "b" takes what "a" doesn't. */
function providers(errors: (unknown | undefined)[], delayMs?: number) {
  return [
    fakeProvider({ id: "a", tier: { kind: "one-time-credit", usd: 100 }, createErrors: errors, createDelayMs: delayMs }),
    fakeProvider({ id: "b", tier: { kind: "one-time-credit", usd: 100 } }),
  ];
}
const config = { providers: { a: { priority: 1 } } };

async function quotaMark(r: SandboxRouter, provider = "a") {
  return (await r.ledger.read()).marks.find((m) => m.provider === provider && m.kind === "quota");
}
async function lapsesAt(r: SandboxRouter): Promise<number> {
  const mark = await quotaMark(r);
  if (!mark) throw new Error("no quota mark on a");
  return Date.parse(mark.until);
}

describe("after a quota mark lapses", () => {
  it("one create checks whether the free tier is back; parallel ones skip it instead of joining the refusal", async () => {
    const { router: r, clock: c } = router(providers(refusals(4), 20), config);
    expect((await r.create()).provider).toBe("b"); // a refuses: marked for a day
    c.set(await lapsesAt(r));

    const made = await Promise.all([r.create(), r.create(), r.create()]);
    expect(made.map((s) => s.provider)).toEqual(["b", "b", "b"]);
    const onA = made.map((s) => s.route.find((x) => x.provider === "a")!);
    expect(onA.filter((x) => x.outcome === "failed")).toHaveLength(1);
    // Skipped for a moment, not for a day: the probe may come back any time.
    const waited = { outcome: "skipped", detail: expect.stringMatching(/probe is in flight/), until: c.now() };
    expect(onA.filter((x) => x.outcome === "skipped")).toEqual([expect.objectContaining(waited), expect.objectContaining(waited)]);
  });

  it("a free create that works clears the mark, and a later refusal counts from one day again", async () => {
    const { router: r, clock: c } = router(providers([refusal(), refusal(), undefined, refusal()]), config);
    await r.create(); // refused
    c.set(await lapsesAt(r));
    await r.create(); // the probe is refused too
    c.set(await lapsesAt(r));
    expect((await r.create()).provider).toBe("a"); // the probe works: the free tier is back
    expect(await quotaMark(r)).toBeUndefined();

    const again = await r.create();
    expect(again.route[0]).toMatchObject({ provider: "a", outcome: "failed", kind: "quota", until: c.now() + DAY });
  });

  it("a refused probe and its new mark land in one write, so no second probe slips in between", async () => {
    // Every state the ledger commits, with the clock when it did.
    class Recording extends MemoryLedger {
      readonly states: { at: number; data: LedgerData }[] = [];
      constructor(private readonly clockNow: () => number) {
        super();
      }
      override update<T>(fn: (data: LedgerData) => T | Promise<T>): Promise<T> {
        return super.update(async (data) => {
          const out = await fn(data);
          this.states.push({ at: this.clockNow(), data: structuredClone(data) });
          return out;
        });
      }
    }
    const c = clock();
    const ledger = new Recording(c.now);
    const r = new SandboxRouter({ providers: providers(refusals(2)), config, ledger, env: {}, now: c.now });
    await r.create();
    c.set(await lapsesAt(r));
    await r.create(); // the probe, refused

    // A state with the mark lapsed and its probe already failed would let the next request send
    // another create into the same refusal.
    const halfOpenAfterRefusal = ledger.states.filter(({ at, data }) => {
      const mark = data.marks.find((m) => m.provider === "a" && m.kind === "quota");
      if (!mark || Date.parse(mark.until) > at) return false;
      return Object.values(data.sandboxes).some((s) => s.provider === "a" && s.state === "failed" && Date.parse(s.createdAt) >= Date.parse(mark.until));
    });
    expect(halfOpenAfterRefusal).toEqual([]);
  });
});

describe("a refusal that keeps coming back", () => {
  it("a one-time credit is asked again after 1, 2 and 4 days, then once a week", async () => {
    const { router: r, clock: c } = router(providers(refusals(6)), config);
    const t0 = c.now();
    await r.create();
    expect(await lapsesAt(r)).toBe(t0 + DAY);
    for (const days of [2, 4, 7, 7]) {
      c.set(await lapsesAt(r));
      const probe = await r.create();
      expect(probe.route[0], `after ${days} days`).toMatchObject({ provider: "a", outcome: "failed", kind: "quota", until: c.now() + days * DAY });
    }
  });

  it("while the mark is in force, the provider is skipped with the time it lapses", async () => {
    const { router: r, clock: c } = router(providers(refusals(1)), config);
    const t0 = c.now();
    await r.create();
    c.advance(DAY - 1);
    const skip = (await r.plan()).skipped.find((s) => s.provider === "a");
    expect(skip).toMatchObject({ reason: expect.stringMatching(/402/), until: t0 + DAY });
  });

  it("refusals from creates already in flight when the mark was set neither renew it nor count again", async () => {
    const [a, b] = providers(refusals(3), 20);
    const { router: r, clock: c } = router([a!, b!], config);
    // Each refusal comes back a second after the one before it.
    const create = a!.create.bind(a);
    a!.create = async (...args) => {
      try {
        return await create(...args);
      } finally {
        c.advance(1000);
      }
    };
    const t0 = c.now();
    await Promise.all([r.create(), r.create(), r.create()]); // all three planned before the first 402
    expect(await quotaMark(r)).toMatchObject({ until: iso(t0 + 1000 + DAY), refusals: 1 });
  });

  it("a monthly tier's refusal lasts until the reset, however often it repeats", async () => {
    const c = clock(Date.UTC(2026, 10, 20));
    const m = fakeProvider({ id: "a", tier: { kind: "monthly-credit", usd: 30 }, createErrors: refusals(2) });
    const { router: r } = router([m, fakeProvider({ id: "b", tier: { kind: "one-time-credit", usd: 100 } })], {}, c);
    await r.create();
    expect(await lapsesAt(r)).toBe(Date.UTC(2026, 11, 1));
    c.set(Date.UTC(2026, 11, 1));
    await r.create(); // refused again just after the reset
    expect(await lapsesAt(r)).toBe(Date.UTC(2027, 0, 1));
  });
});
