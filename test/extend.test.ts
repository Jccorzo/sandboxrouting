// A later deadline (setTimeout) or a resume makes a sandbox hold more of its free tier or the
// month's paid budget. Both meet the rule a new request meets: what it may then spend must fit
// after every other live box's hold. Each test failed before the check existed.
import { afterEach, describe, expect, it } from "vitest";
import { fakeProvider, router, clock, type Fake } from "./fake.js";
import { localShellProvider, type LocalShell } from "./localshell.js";
import { SandboxRouter, MemoryLedger, MemoryCheckpointStore, JobManager, SandboxRouterError } from "../src/index.js";

const RATE = 0.00001; // $/vCPU-second; boxes here are 1 vCPU, so $/second

/** A provider that can move deadlines and pause, recording what it was asked. */
function extendable(id: string, usd: number | "paid"): Fake & { extended: number[]; resumed: string[] } {
  const p = fakeProvider({ id, tier: usd === "paid" ? { kind: "none" } : { kind: "monthly-credit", usd }, rate: RATE, capabilities: ["extendTimeout", "pause"] });
  const extended: number[] = [];
  const resumed: string[] = [];
  return Object.assign(p, {
    extended,
    resumed,
    async setTimeout(_id: string, timeoutSec: number) {
      extended.push(timeoutSec);
    },
    async pause() {},
    async resume(sid: string) {
      resumed.push(sid);
    },
  });
}

const deadline = async (r: SandboxRouter, id: string) => Date.parse((await r.get(id))!.expiresAt!);

describe("moving a sandbox's deadline", () => {
  it("past what its free tier still covers is refused: nothing changes and the provider isn't asked", async () => {
    const p = extendable("p", 600 * RATE); // covers 600 s of one box
    const { router: r, clock: c } = router([p]);
    const sbx = await r.create({ cpu: 1, timeoutSec: 300 });
    const before = await deadline(r, sbx.id);
    await expect(sbx.setTimeout(1000)).rejects.toMatchObject({ kind: "quota", message: expect.stringMatching(/won't cover/) });
    expect(p.extended).toEqual([]);
    expect(await deadline(r, sbx.id)).toBe(before);
    // Within what's left it's granted.
    await sbx.setTimeout(500);
    expect(p.extended).toEqual([500]);
    expect(await deadline(r, sbx.id)).toBe(c.now() + 500_000);
  });

  it("counts what the provider's other live boxes hold", async () => {
    const p = extendable("p", 700 * RATE);
    const { router: r } = router([p]);
    const a = await r.create({ cpu: 1, timeoutSec: 300 });
    await r.create({ cpu: 1, timeoutSec: 300 }); // holds 300 s of the 700
    await expect(a.setTimeout(500)).rejects.toMatchObject({ kind: "quota" });
    await a.setTimeout(400);
    expect(p.extended).toEqual([400]);
  });

  it("a paid box can't be kept past the month's budget", async () => {
    const p = extendable("p", "paid");
    const { router: r } = router([p], { allowPaid: true, maxPaidUsdPerMonth: 1000 * RATE });
    const sbx = await r.create({ cpu: 1, timeoutSec: 300 });
    await expect(sbx.setTimeout(2000)).rejects.toMatchObject({ kind: "quota", message: expect.stringMatching(/paid budget/) });
    await sbx.setTimeout(900);
    expect(p.extended).toEqual([900]);
  });

  it("a provider that fails to move it gets the old deadline back, and the hold shrinks again", async () => {
    const p = extendable("p", 700 * RATE);
    const { router: r } = router([p]);
    const sbx = await r.create({ cpu: 1, timeoutSec: 300 });
    const before = await deadline(r, sbx.id);
    p.setTimeout = async () => {
      throw Object.assign(new Error("upstream unavailable"), { status: 503 });
    };
    await expect(sbx.setTimeout(600)).rejects.toMatchObject({ kind: "transient" });
    expect(await deadline(r, sbx.id)).toBe(before);
    // With the old 300 s hold, a second 300 s box fits in the 700 s of credit.
    expect((await r.plan({ cpu: 1, timeoutSec: 300 })).ordered.map((e) => e.provider)).toEqual(["p"]);
  });

  it("resuming a paused box holds money again, under the same rule", async () => {
    const p = extendable("p", 600 * RATE);
    const { router: r } = router([p]);
    const sbx = await r.create({ cpu: 1, timeoutSec: 300 });
    await sbx.pause();
    await expect(sbx.resume(1000)).rejects.toMatchObject({ kind: "quota" });
    expect(p.resumed).toEqual([]);
    expect((await sbx.info())!.state).toBe("paused");
    await sbx.resume(500);
    expect((await sbx.info())!.state).toBe("running");
    expect(p.resumed).toEqual([sbx.providerSandboxId]);
  });

  it("a provider that fails to resume leaves the box paused, holding nothing", async () => {
    const p = extendable("p", 600 * RATE);
    const { router: r } = router([p]);
    const sbx = await r.create({ cpu: 1, timeoutSec: 300 });
    await sbx.pause();
    p.resume = async () => {
      throw Object.assign(new Error("upstream unavailable"), { status: 503 });
    };
    await expect(sbx.resume(500)).rejects.toMatchObject({ kind: "transient" });
    expect((await sbx.info())!.state).toBe("paused");
    expect((await r.plan({ cpu: 1, timeoutSec: 600 })).ordered.map((e) => e.provider)).toEqual(["p"]);
  });

  it("a sandbox that isn't running can't have its deadline moved", async () => {
    const p = extendable("p", 600 * RATE);
    const { router: r, clock: c } = router([p]);
    const sbx = await r.create({ cpu: 1, timeoutSec: 60 });
    c.advance(61_000);
    await expect(sbx.setTimeout(30)).rejects.toBeInstanceOf(SandboxRouterError);
    expect(p.extended).toEqual([]);
  });
});

describe("a job whose box can't be paid for longer", () => {
  const shells: LocalShell[] = [];
  afterEach(async () => {
    await Promise.all(shells.splice(0).map((s) => s.cleanup()));
  });

  it("moves to a new box instead of extending past its free tier", async () => {
    const c = clock();
    // a covers 65 s of a box: enough for the first 60 s box, not for 30 s spent plus 40 s more.
    const a = localShellProvider({ id: "a", tier: { kind: "monthly-credit", usd: 65 * RATE }, rate: RATE, capabilities: ["extendTimeout"], execHook: (_id, cmd) => void (cmd.includes("#s0") && c.advance(30_000)) });
    const b = localShellProvider({ id: "b", rate: RATE });
    shells.push(a, b);
    const r = new SandboxRouter({ providers: [a, b], config: { defaults: { timeoutSec: 60 }, providers: { a: { priority: 1 } } }, ledger: new MemoryLedger(), env: {}, now: c.now });
    const jobs = new JobManager(r, { store: new MemoryCheckpointStore(c.now), sleep: async (ms) => c.advance(ms) });
    const events: string[] = [];
    const view = await jobs.run(
      { policy: { defaultStepTimeoutSec: 30, deadlineMarginSec: 10 }, steps: [{ run: "echo one > a.txt #s0" }, { run: "cat a.txt" }] },
      { onEvent: (e) => void events.push(e.type) },
    );
    expect(view.state).toBe("succeeded");
    expect(events).not.toContain("extended");
    expect(view.placements.map((p) => [p.provider, p.endReason])).toEqual([
      ["a", "deadline"],
      ["b", "finished"],
    ]);
    expect(view.results[1]!.stdoutTail).toBe("one\n");
  });
});
