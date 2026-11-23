// GET /v1/operator/stats: only the operator token reads it, and its usage is each account's own
// /v1/usage summed, so the operator's numbers and the dashboard's can't disagree.
import { afterEach, describe, expect, it } from "vitest";
import { closeAll, fakeProvider, fixture, routerSide, HOUR } from "./helpers.js";
import { allowEverything } from "../src/plugins.js";
import { signIn } from "../src/sessions.js";
import type { OperatorStats, UsageView } from "../src/api.js";

afterEach(closeAll);

const TOKEN = "op_".padEnd(40, "x");

describe("who may read it", () => {
  it("doesn't exist without an operator token", async () => {
    const f = await fixture();
    expect((await f.call("GET", "/v1/operator/stats", { token: TOKEN })).status).toBe(404);
  });

  it("answers only the operator token: no account key or sign-in, whatever its scope", async () => {
    const f = await fixture({ operatorToken: TOKEN });
    expect((await f.call("GET", "/v1/operator/stats", { token: "" })).status).toBe(401);
    expect((await f.call("GET", "/v1/operator/stats")).status).toBe(401); // the account's admin key
    expect((await f.call("GET", "/v1/operator/stats", { token: f.ingestKey })).status).toBe(401);
    expect((await f.call("GET", "/v1/operator/stats", { token: TOKEN.slice(0, -1) + "y" })).status).toBe(401);
    const ok = await f.call<OperatorStats>("GET", "/v1/operator/stats", { token: TOKEN });
    expect(ok.status).toBe(200);
  });
});

describe("the numbers", () => {
  it("sums each account's own usage, and follows people from sign-up to a second week", async () => {
    const f = await fixture({ operatorToken: TOKEN });
    // The fixture's account: made with an admin key, reports from its own router.
    const r = routerSide([fakeProvider("a", { kind: "none" }, { rate: 0.00001 })], { allowPaid: true }, Date.now() - 3 * HOUR);
    const sbx = await r.router.create({ cpu: 2, memoryMiB: 2048, timeoutSec: 7200 });
    r.advance(HOUR);
    await sbx.kill();
    await f.send(await r.install(), await r.events());

    // Two people sign in with GitHub; one connects a provider; the other signed up 8 days ago.
    const ana = await signIn(f.db, allowEverything, { githubId: 101, login: "ana" });
    const bo = await signIn(f.db, allowEverything, { githubId: 102, login: "bo" });
    if (ana.outcome !== "signed-in" || bo.outcome !== "signed-in") throw new Error("sign-in failed");
    await f.db.query(
      "INSERT INTO provider_credentials (account_id, provider, state, version, updated_by) VALUES ($1, 'e2b', 'removed', 2, 'test')",
      [ana.accountId],
    );
    await f.db.query("UPDATE accounts SET created_at = now() - interval '8 days' WHERE id = $1", [f.accountId]);

    const res = await f.call<OperatorStats>("GET", "/v1/operator/stats?days=7", { token: TOKEN });
    expect(res.status).toBe(200);
    const s = res.body;

    const own = await f.call<UsageView>("GET", "/v1/usage?days=7");
    const mine = s.accounts.find((a) => a.id === f.accountId)!;
    expect(mine.sandboxHours).toBeCloseTo(own.body.totals.sandboxHours, 9);
    expect(mine.usd).toBeCloseTo(own.body.totals.usd, 9);
    expect(s.totals.sandboxHours).toBeCloseTo(own.body.totals.sandboxHours, 9);
    expect(s.totals.sandboxHours).toBeCloseTo(1, 6);
    expect(mine).toMatchObject({ github: null, sandboxes: 1, via: { hosted: false, reported: true } });

    expect(s.accounts.find((a) => a.id === ana.accountId)).toMatchObject({ github: { id: 101, login: "ana" }, everConnected: true, providers: [], sandboxes: 0 });
    expect(s.totals).toMatchObject({ accounts: 3, githubUsers: 2, active7: 1, active30: 1, sandboxesInWindow: 1, liveSandboxes: 0 });
    // The fixture's account is dated 8 days back, so it isn't a sign-up in this window.
    expect(s.totals.signupsInWindow).toBe(2);
    // Connected: ana saved keys (removed since); the fixture's account reports from its own
    // router. Its sandbox came 8 days after it signed up: retained. Each step nests in the last.
    expect(s.funnel).toEqual({ signedUp: 3, connected: 2, firstSandbox: 1, retained: 1 });
    expect(s.providers).toEqual([expect.objectContaining({ provider: "a", sandboxes: 1, accounts: 1 })]);
    expect(s.source.reportedHours).toBeCloseTo(1, 6);
    expect(s.source.hostedHours).toBe(0);
    expect(s.daily).toHaveLength(7);
    expect(s.daily.reduce((n, d) => n + d.sandboxes, 0)).toBe(1);
    expect(mine.lastSeenAt).not.toBeNull();
  });

  it("counts failed creates and refusals per provider from the routers' own samples", async () => {
    const f = await fixture({ operatorToken: TOKEN });
    const err = () => Object.assign(new Error("503 Service Unavailable"), { status: 503 });
    const r = routerSide([fakeProvider("a", { kind: "unlimited" }, { errors: [err(), err()] }), fakeProvider("b", { kind: "unlimited" })], { providers: { a: { priority: 1 } } });
    await r.router.create();
    await r.router.create();
    await f.send(await r.install(), await r.events());

    const s = (await f.call<OperatorStats>("GET", "/v1/operator/stats", { token: TOKEN })).body;
    const a = s.reliability.find((p) => p.provider === "a")!;
    const b = s.reliability.find((p) => p.provider === "b")!;
    expect(a.failedCreates).toBe(2);
    expect(b.creates).toBe(2);
    expect(b.failedCreates).toBe(0);
    expect(s.totals.liveSandboxes).toBe(2);
  });
});
