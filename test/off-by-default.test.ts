// A provider that is built in but off unless config turns it on (Runloop, whose API host stopped
// resolving): a key alone must not route there.

import { describe, expect, it } from "vitest";
import { fakeProvider, router } from "./fake.js";
import { runloopProvider } from "../src/providers/runloop.js";
import { SandboxRouter, MemoryLedger } from "../src/index.js";

describe("off by default", () => {
  const retired = () => {
    const p = fakeProvider({ id: "retired", tier: { kind: "monthly-credit", usd: 30 } });
    p.info.offByDefault = "its API went away";
    return p;
  };

  it("is skipped, saying why, until config sets enabled: true", async () => {
    const off = router([retired()]).router;
    const plan = await off.plan();
    expect(plan.ordered).toEqual([]);
    expect(plan.skipped[0]?.reason).toMatch(/off by default: its API went away/);
    expect((await off.status())[0]?.enabled).toBe(false);

    const on = router([retired()], { providers: { retired: { enabled: true } } }).router;
    expect((await on.plan()).ordered.map((e) => e.provider)).toEqual(["retired"]);
    expect((await on.status())[0]?.enabled).toBe(true);
  });

  it("covers Runloop: its key alone doesn't route there", async () => {
    expect(runloopProvider.info.offByDefault).toMatch(/runloop/i);
    const r = new SandboxRouter({ providers: [runloopProvider], ledger: new MemoryLedger(), env: { RUNLOOP_API_KEY: "k" }, config: {} });
    expect((await r.plan()).ordered).toEqual([]);
  });
});
