// End to end: the router's real reporter (src/report/) posting to this app, through outages and
// resends, and the reads showing what the router's own status says.
import { afterEach, describe, expect, it } from "vitest";
import { closeAll, fakeProvider, fixture } from "./helpers.js";
import { MemoryLedger, SandboxRouter, parseConfig } from "../../src/index.js";
import { MemoryOutbox } from "../../src/report/outbox.js";
import { providerSnapshots, Reporter, ReportingLedger } from "../../src/report/reporter.js";
import type { ProvidersView, SandboxesView } from "../src/api.js";

afterEach(closeAll);

describe("router → back", () => {
  it("delivers through an outage with the same event ids, applying each state once", async () => {
    const f = await fixture();
    let down = true;
    const sent: string[] = [];
    // The app itself, behind a fetch that can be down.
    const viaApp = (async (url: string, init: RequestInit) => {
      if (down) throw new TypeError("fetch failed");
      for (const e of (JSON.parse(String(init.body)) as { events: { id: string }[] }).events) sent.push(e.id);
      return f.app.request(new URL(url).pathname, init);
    }) as unknown as typeof fetch;

    let t = Date.now() - 3600_000;
    const now = () => t;
    const providers = [fakeProvider("a", { kind: "monthly-credit", usd: 10 }), fakeProvider("b", { kind: "unlimited" })];
    const config = parseConfig({ providers: { a: { priority: 1 } } });
    const inner = new MemoryLedger();
    const outbox = new MemoryOutbox();
    const reporter = new Reporter({ url: "http://back.test", token: f.ingestKey, metadataKeys: [], ledger: inner, outbox, providers: providerSnapshots(providers, config, {}), now, fetch: viaApp });
    const router = new SandboxRouter({ providers, config, ledger: new ReportingLedger(inner, reporter), env: {}, now });

    const sbx = await router.create({ cpu: 2, memoryMiB: 2048, timeoutSec: 1800 });
    t += 600_000;
    let status = await reporter.flush();
    expect(status.delivery.state).toBe("backoff");
    const pendingIds = (await outbox.read()).pending.map((e) => e.id);

    down = false;
    t += 15 * 60_000; // past the backoff
    status = await reporter.flush();
    expect(status).toMatchObject({ pending: 0, delivery: { state: "idle" } });
    expect(sent).toEqual(pendingIds);

    // A resend of everything (as if every answer had been lost) changes nothing.
    const res = await f.send((await outbox.read()).installId, (await f.db.query<{ payload: never }>("SELECT payload FROM ingest_events ORDER BY seq")).rows.map((r) => r.payload));
    expect(res.body.results.every((x) => x.outcome === "duplicate")).toBe(true);

    t += 60_000;
    await sbx.kill();
    await reporter.flush();
    const list = await f.call<SandboxesView>("GET", "/v1/sandboxes?view=recent");
    expect(list.body.sandboxes).toEqual([expect.objectContaining({ id: sbx.id, state: "stopped", provider: "a", memoryMiB: 2048 })]);

    // back's free usage left for "a" is the router's, to the cent.
    const mine = (await router.status()).find((p) => p.id === "a")!;
    const theirs = (await f.call<ProvidersView>("GET", "/v1/providers")).body.providers.find((p) => p.provider === "a")!;
    expect((theirs.free as { remaining: number }).remaining).toBeCloseTo((mine.free as { remaining: number }).remaining, 9);
  });
});
