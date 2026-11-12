// Bugs in the create path's reservation and health bookkeeping. Each test failed on the
// router before the fix.
import { describe, expect, it } from "vitest";
import { fakeProvider, router } from "./fake.js";
import { NoProviderAvailableError, SandboxRouterError } from "../src/index.js";

describe("reserving a provider under the lock", () => {
  it("a request planned as free moves on instead of becoming paid when a parallel request took the free slot", async () => {
    const capped = fakeProvider({ id: "capped", tier: { kind: "monthly-credit", usd: 30 }, concurrency: 1, createDelayMs: 20 });
    const other = fakeProvider({ id: "other", tier: { kind: "one-time-credit", usd: 30 } });
    // Paid is allowed, so "capped" is still eligible (as paid) once its free slot is taken.
    const { router: r } = router([capped, other], { allowPaid: true });
    const made = await Promise.all([r.create(), r.create()]);
    expect(made.map((s) => s.provider).sort()).toEqual(["capped", "other"]);
    const second = made.find((s) => s.provider === "other")!;
    expect(second.route.find((a) => a.provider === "capped")?.detail).toMatch(/free capacity/);
  });

  it("a created attempt records the lane it was billed under", async () => {
    const { router: r } = router([fakeProvider({ id: "m", tier: { kind: "monthly-credit", usd: 30 } })]);
    const sbx = await r.create();
    expect(sbx.route.at(-1)).toMatchObject({ outcome: "created", lane: "free-recurring" });
  });
});

describe("provider health from the create path", () => {
  it("repeated transient create failures open the circuit, so later requests skip the provider without trying it", async () => {
    const down = () => Object.assign(new Error("503 Service Unavailable"), { status: 503 });
    const flaky = fakeProvider({ id: "flaky", tier: { kind: "monthly-credit", usd: 30 }, createErrors: [down(), down(), down(), down()] });
    const steady = fakeProvider({ id: "steady", tier: { kind: "one-time-credit", usd: 30 } });
    const { router: r, clock: c } = router([flaky, steady]);
    for (let i = 0; i < 3; i++) expect((await r.create()).provider).toBe("steady");
    // Three failures in a row: the fourth request doesn't try "flaky" at all.
    const fourth = await r.create();
    expect(fourth.route.find((a) => a.provider === "flaky")).toMatchObject({ outcome: "skipped", detail: expect.stringMatching(/circuit open/) });
    // After the cooldown one probe goes through; it fails again, so the circuit reopens for longer.
    c.advance(121_000);
    const probe = await r.create();
    expect(probe.route.find((a) => a.provider === "flaky")?.outcome).toBe("failed");
    expect((await r.status()).find((s) => s.id === "flaky")?.health.circuit).toBe("open");
  });

  it("a box lost before its deadline counts against its provider; one past its deadline doesn't", async () => {
    const p = fakeProvider({ id: "p", tier: { kind: "monthly-credit", usd: 30 } });
    const { router: r, clock: c } = router([p]);
    const early = await r.create({ timeoutSec: 600 });
    p.killed.push(early.providerSandboxId); // the provider lost it
    await expect(early.commands.run("true")).rejects.toMatchObject({ kind: "not_found" });
    const late = await r.create({ timeoutSec: 60 });
    c.advance(61_000);
    p.killed.push(late.providerSandboxId); // the provider enforced the timeout
    await expect(late.commands.run("true")).rejects.toMatchObject({ kind: "not_found" });
    const data = await r.ledger.read();
    expect(data.health["p"]?.filter((s) => s.op === "lost")).toHaveLength(1);
    expect((await early.info())?.state).toBe("stopped");
  });
});

describe("when a skipped provider could take requests again", () => {
  it("time-bound reasons say when they lapse; permanent ones say nothing, so waiting is pointless", async () => {
    const marked = fakeProvider({ id: "marked", tier: { kind: "monthly-credit", usd: 30 } });
    const full = fakeProvider({ id: "full", tier: { kind: "monthly-credit", usd: 30 }, concurrency: 1 });
    const spent = fakeProvider({ id: "spent", tier: { kind: "monthly-credit", usd: 0.0001 } });
    const nogpu = fakeProvider({ id: "nogpu", tier: { kind: "monthly-credit", usd: 30 } });
    const { router: r, clock: c } = router([marked, full, spent, nogpu]);
    const t0 = c.now();
    await r.create({ providers: ["full"], timeoutSec: 600 }); // holds full's only slot until t0 + 600 s
    await r.markFromError("marked", new SandboxRouterError("rate_limit", "429", "marked"));
    // A box starts only on credit that covers its whole timeout: 10 s at $0.00001/s is all of it.
    const used = await r.create({ providers: ["spent"], cpu: 1, timeoutSec: 10 });
    c.advance(10_000);
    await used.kill();

    const p = await r.plan({ needs: ["fileList"] });
    const until = Object.fromEntries(p.skipped.map((s) => [s.provider, s.until]));
    expect(until["marked"]).toBe(t0 + 60_000);
    expect(until["full"]).toBe(c.now()); // a full free tier frees a slot whenever a box is killed
    expect(until["spent"]).toBe(Date.UTC(2026, 11, 1)); // the monthly reset
    expect(p.ordered.map((e) => e.provider)).toEqual(["nogpu"]);

    const gpu = await r.plan({ needs: ["gpu"] });
    expect(gpu.skipped.find((s) => s.provider === "nogpu")?.until).toBeUndefined();

    const err = await r.create({ providers: ["marked", "full", "spent"] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NoProviderAvailableError);
    // The full tier may free a slot at any moment, so that's the first possible change...
    expect((err as NoProviderAvailableError).retryAt).toBe(c.now());
    // ...and without it, the rate-limit mark lapses first.
    const marked1 = await r.create({ providers: ["marked", "spent"] }).catch((e: unknown) => e);
    expect((marked1 as NoProviderAvailableError).retryAt).toBe(t0 + 60_000);
    const never = await r.create({ providers: ["nogpu"], needs: ["gpu"] }).catch((e: unknown) => e);
    expect((never as NoProviderAvailableError).retryAt).toBeUndefined();
  });
});

describe("a request the router can't honour", () => {
  it("an unknown isolation level is refused instead of matching every provider", async () => {
    const { router: r } = router([fakeProvider({ id: "p", tier: { kind: "monthly-credit", usd: 30 } })]);
    await expect(r.plan({ minIsolation: "microVM" as never })).rejects.toMatchObject({ kind: "invalid", message: expect.stringMatching(/container, gvisor, microvm, vm/) });
    await expect(r.create({ minIsolation: "microVM" as never })).rejects.toMatchObject({ kind: "invalid" });
    // Inherited names are not levels either.
    await expect(r.plan({ minIsolation: "toString" as never })).rejects.toMatchObject({ kind: "invalid" });
  });
});
