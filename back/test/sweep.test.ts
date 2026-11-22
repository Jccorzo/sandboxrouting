// The sweep: rollups give exactly what the live computation gives, a late event re-rolls the days
// it touches, a rollup that raced an ingest is dropped, and usage reaches a plugin's hook at
// least once whatever fails on the way.
import { afterEach, describe, expect, it } from "vitest";
import { closeAll, fakeProvider, fixture, routerSide, DAY, HOUR } from "./helpers.js";
import { rollupAccount } from "../src/sweep.js";
import type { UsageEvent } from "../src/plugins.js";
import type { UsageView } from "../src/api.js";

afterEach(closeAll);

const midnight = (t: number) => Date.parse(new Date(t).toISOString().slice(0, 10) + "T00:00:00Z");

async function usageWithAndWithoutRollups(f: Awaited<ReturnType<typeof fixture>>) {
  const live = (await f.call<UsageView>("GET", "/v1/usage?days=10")).body;
  const swept = await f.call<{ daysRolledUp: number }>("POST", "/v1/sweep");
  const rolled = (await f.call<UsageView>("GET", "/v1/usage?days=10")).body;
  return { live, rolled, swept: swept.body };
}

describe("rollups", () => {
  it("serve closed days with the same numbers the live computation gives", async () => {
    const f = await fixture();
    const today = midnight(Date.now());
    const r = routerSide([fakeProvider("a", { kind: "none" }), fakeProvider("b", { kind: "unlimited" })], { allowPaid: true, providers: { a: { priority: 1 } } }, today - 5 * DAY + 20 * HOUR);
    const one = await r.router.create({ cpu: 2, memoryMiB: 4096, timeoutSec: 3 * DAY });
    r.advance(30 * HOUR);
    await r.router.create({ providers: ["b"], timeoutSec: 600 });
    r.advance(20 * HOUR);
    await one.kill();
    await f.send(await r.install(), await r.events());

    const { live, rolled, swept } = await usageWithAndWithoutRollups(f);
    expect(swept.daysRolledUp).toBeGreaterThan(0);
    expect(live.rolledUpDays).toBe(0);
    expect(rolled.rolledUpDays).toBe(9); // every day but today
    expect(rolled.points).toHaveLength(live.points.length);
    for (const [i, p] of rolled.points.entries()) {
      const q = live.points[i]!;
      expect(p).toMatchObject({ day: q.day, provider: q.provider, sandboxes: q.sandboxes });
      expect(p.sandboxHours).toBeCloseTo(q.sandboxHours, 9);
      expect(p.gibHours).toBeCloseTo(q.gibHours, 9);
      expect(p.usd ?? 0).toBeCloseTo(q.usd ?? 0, 12);
    }
  });

  it("a late event about an old day makes that day read live again until the next sweep re-rolls it", async () => {
    const f = await fixture();
    const today = midnight(Date.now());
    const r = routerSide([fakeProvider("a", { kind: "unlimited" })], {}, today - 4 * DAY + HOUR);
    const early = await r.router.create({ timeoutSec: 600 });
    r.advance(5 * 60_000);
    await early.kill();
    await f.send(await r.install(), await r.events());
    await f.call("POST", "/v1/sweep");

    // A second router (another machine, offline until now) reports a sandbox from three days ago.
    const late = routerSide([fakeProvider("a", { kind: "unlimited" })], {}, today - 3 * DAY + HOUR);
    const sbx = await late.router.create({ timeoutSec: 3600 });
    late.advance(HOUR);
    await sbx.kill();
    await f.send(await late.install(), await late.events());

    const before = (await f.call<UsageView>("GET", "/v1/usage?days=5")).body;
    expect(before.rolledUpDays).toBe(1); // only the day before the late sandbox
    const day = new Date(today - 3 * DAY).toISOString().slice(0, 10);
    expect(before.points.find((p) => p.day === day)?.sandboxHours).toBeCloseTo(1, 6);

    await f.call("POST", "/v1/sweep");
    const after = (await f.call<UsageView>("GET", "/v1/usage?days=5")).body;
    expect(after.rolledUpDays).toBe(4);
    expect(after.points.find((p) => p.day === day)?.sandboxHours).toBeCloseTo(1, 6);
  });

  it("a rollup computed while an ingest changed the account is dropped, not committed", async () => {
    const f = await fixture();
    const today = midnight(Date.now());
    const r = routerSide([fakeProvider("a", { kind: "unlimited" })], {}, today - 2 * DAY);
    const sbx = await r.router.create({ timeoutSec: 600 });
    await sbx.kill();
    await f.send(await r.install(), await r.events());
    // Interleave: the ingest's change_seq bump lands between the rollup's read and its write.
    const originalTx = f.db.tx.bind(f.db);
    let calls = 0;
    f.db.tx = (async (fn: Parameters<typeof originalTx>[0], opts?: Parameters<typeof originalTx>[1]) => {
      const out = await originalTx(fn, opts);
      if (++calls === 1) await f.db.query("UPDATE accounts SET change_seq = change_seq + 1");
      return out;
    }) as typeof f.db.tx;
    expect(await rollupAccount(f.db, f.accountId)).toEqual({ outcome: "changed-meanwhile" });
    f.db.tx = originalTx;
    expect((await f.db.query("SELECT rolled_through FROM accounts")).rows).toEqual([{ rolled_through: null }]);
    expect(await rollupAccount(f.db, f.accountId)).toMatchObject({ outcome: "rolled" });
  });

  it("the sweep token sweeps every account; without it, an admin key sweeps only its own", async () => {
    const f = await fixture({ sweepToken: "sweep-token-0123456789abcdef" });
    expect((await f.call("POST", "/v1/sweep", { token: "sweep-token-0123456789abcdef" })).status).toBe(200);
    expect((await f.call("POST", "/v1/sweep", { token: "wrong" })).status).toBe(401);
    expect((await f.call("POST", "/v1/sweep", { token: f.ingestKey })).status).toBe(401);
    expect((await f.call<{ accounts: number }>("POST", "/v1/sweep")).body.accounts).toBe(1);
  });
});

describe("usage events for a plugin", () => {
  it("reach the hook after commit, and a failed hook gets them again from the sweep", async () => {
    const seen: UsageEvent[] = [];
    let failing = true;
    const f = await fixture({
      plugins: {
        onUsage: async (e) => {
          if (failing) throw new Error("billing down");
          seen.push(e);
        },
      },
    });
    const r = routerSide([fakeProvider("a", { kind: "unlimited" })]);
    await r.router.create();
    await f.send(await r.install(), await r.events());
    await new Promise((res) => setTimeout(res, 20));
    expect((await f.db.query("SELECT status, lease_until FROM usage_events")).rows).toEqual([{ status: "pending", lease_until: null }]);

    failing = false;
    await f.call("POST", "/v1/sweep");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ kind: "events.ingested", accountId: f.accountId });
    expect((await f.db.query("SELECT status FROM usage_events")).rows).toEqual([{ status: "delivered" }]);
    await f.call("POST", "/v1/sweep");
    expect(seen).toHaveLength(1);
  });

  it("a delivery whose process died is claimed again once its lease lapses", async () => {
    const seen: string[] = [];
    const f = await fixture({ plugins: { onUsage: async (e) => void seen.push(e.id) } });
    await f.db.query("INSERT INTO usage_events (account_id, kind, quantity, status, lease_until, attempts) VALUES ($1, 'events.ingested', 3, 'delivering', now() - interval '1 minute', 1)", [f.accountId]);
    await f.db.query("INSERT INTO usage_events (account_id, kind, quantity, status, lease_until, attempts) VALUES ($1, 'events.ingested', 4, 'delivering', now() + interval '1 minute', 1)", [f.accountId]);
    await f.call("POST", "/v1/sweep");
    expect(seen).toHaveLength(1); // the live lease is left to its holder
  });

  it("writes nothing for plugins that don't ask for usage", async () => {
    const f = await fixture();
    const r = routerSide([fakeProvider("a", { kind: "unlimited" })]);
    await r.router.create();
    await f.send(await r.install(), await r.events());
    expect((await f.db.query("SELECT 1 FROM usage_events")).rows).toHaveLength(0);
  });
});
