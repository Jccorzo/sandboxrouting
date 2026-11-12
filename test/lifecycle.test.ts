// Bugs in the sandbox lifecycle: a false "gone" that left a live box running, a create whose
// record couldn't be written, a kill racing a call on the same box, and the ledger's temp
// file. Each test failed on the router before the fix.
import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxRouter } from "../src/core/router.js";
import { FileLedger, MemoryLedger, type Ledger, type LedgerData } from "../src/core/ledger.js";
import type { Sandbox } from "../src/core/sandbox.js";
import { clock, fakeProvider, router } from "./fake.js";
import { localShellProvider, type LocalShell, type LocalShellOpts } from "./localshell.js";

const shells: LocalShell[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(shells.splice(0).map((s) => s.cleanup()));
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function shell(o: LocalShellOpts): LocalShell {
  const s = localShellProvider(o);
  shells.push(s);
  return s;
}

const lostSamples = async (r: SandboxRouter, provider: string) => ((await r.ledger.read()).health[provider] ?? []).filter((s) => s.op === "lost");

/**
 * A MemoryLedger whose first write matching `when` fails: unsaved, as a lock timeout would, or
 * with `saved`, saved and then failing anyway (releasing the lock, say).
 */
class FailingLedger implements Ledger {
  private readonly inner = new MemoryLedger();
  constructor(
    private when?: (before: LedgerData, after: LedgerData) => boolean,
    private readonly saved = false,
  ) {}

  read(): Promise<LedgerData> {
    return this.inner.read();
  }

  async update<T>(fn: (data: LedgerData) => T | Promise<T>): Promise<T> {
    let failAfter = false;
    const out = await this.inner.update(async (d) => {
      const before = structuredClone(d);
      const result = await fn(d);
      if (this.when?.(before, d)) {
        this.when = undefined;
        if (!this.saved) throw new Error("timed out waiting for ledger.json.lock");
        failAfter = true;
      }
      return result;
    });
    if (failAfter) throw new Error("EPERM: operation not permitted, unlink 'ledger.json.lock'");
    return out;
  }
}

/** The write that records a box on provider "a" as created. */
const recordsCreatedOnA = (before: LedgerData, after: LedgerData) =>
  Object.values(after.sandboxes).some((s) => s.provider === "a" && s.state === "running" && before.sandboxes[s.id]?.state === "creating");

describe("a false gone", () => {
  it("a missing file is not a missing box: the box stays running, and a kill reaches the provider", async () => {
    const p = fakeProvider({ id: "p", tier: { kind: "monthly-credit", usd: 30 } });
    const { router: r } = router([p]);
    const sbx = await r.create();
    await expect(sbx.files.read("nope.txt")).rejects.toMatchObject({ kind: "not_found", message: expect.stringContaining("nope.txt") });
    expect((await sbx.info())?.state).toBe("running");
    expect(await lostSamples(r, "p")).toEqual([]);
    await sbx.kill();
    expect(p.killed).toEqual([sbx.providerSandboxId]);
    expect((await sbx.info())?.state).toBe("stopped");
  });

  it("a file call on a box that really is gone still records it as gone", async () => {
    const p = fakeProvider({ id: "p", tier: { kind: "monthly-credit", usd: 30 } });
    const { router: r } = router([p]);
    const sbx = await r.create();
    p.killed.push(sbx.providerSandboxId); // the provider lost it
    await expect(sbx.files.read("a.txt")).rejects.toMatchObject({ kind: "not_found" });
    expect(await r.ledger.read().then((d) => d.sandboxes[sbx.id])).toMatchObject({ state: "stopped", reason: "gone" });
    expect(await lostSamples(r, "p")).toHaveLength(1);
  });

  it("a box the ledger wrongly thinks is gone still gets killed at the provider", async () => {
    const p = fakeProvider({ id: "p", tier: { kind: "monthly-credit", usd: 30 } });
    const { router: r } = router([p]);
    const sbx = await r.create();
    await r.markGone(sbx.id); // the box is alive
    await r.kill(sbx.id);
    expect(p.killed).toEqual([sbx.providerSandboxId]);
    // Kill records a stop only for a running or paused box; this record keeps what it said.
    expect(await r.ledger.read().then((d) => d.sandboxes[sbx.id])).toMatchObject({ state: "stopped", reason: "gone" });
  });

  it("killing a box the provider already deleted succeeds: its not-found counts as done", async () => {
    const a = shell({ id: "a" });
    const { router: r } = router([a]);
    const sbx = await r.create();
    await a.lose(sbx.providerSandboxId);
    await sbx.kill();
    expect(await r.ledger.read().then((d) => d.sandboxes[sbx.id])).toMatchObject({ state: "stopped", reason: "killed" });
    await sbx.kill();
  });

  it("a create that finishes while the remote sweep lists the provider's boxes stays running", async () => {
    const a = shell({ id: "a" });
    const { router: r, clock: c } = router([a]);
    const listAlive = a.listAlive!.bind(a);
    let late: Sandbox | undefined;
    a.listAlive = async (ctx) => {
      const alive = await listAlive(ctx);
      c.advance(1000);
      late ??= await r.create(); // not on the list just taken
      return alive;
    };
    expect((await r.sweep({ remote: true })).stopped).toBe(0);
    expect((await late!.info())?.state).toBe("running");
    // The next sweep's list has it.
    await r.sweep({ remote: true });
    expect((await late!.info())?.state).toBe("running");
    expect(a.killed).toEqual([]);
  });

  it("the remote sweep deletes a box the ledger closed but the provider still runs, on any provider", async () => {
    const a = shell({ id: "a" }); // enforces its timeout
    const { router: r } = router([a]);
    const sbx = await r.create();
    await r.markGone(sbx.id); // closed in the ledger; the box runs on
    expect((await r.sweep({ remote: true })).reaped).toBe(1);
    expect(a.killed).toEqual([sbx.providerSandboxId]);
  });

  it("the remote sweep leaves a box alone that a newer record (an adoption) says is running", async () => {
    const a = shell({ id: "a" });
    const { router: r } = router([a]);
    const sbx = await r.create();
    await r.markGone(sbx.id);
    const adopted = await r.connect(`a:${sbx.providerSandboxId}`);
    expect((await r.sweep({ remote: true })).reaped).toBe(0);
    expect(a.killed).toEqual([]);
    expect((await adopted.info())?.state).toBe("running");
  });
});

describe("a create whose record can't be written", () => {
  it("a failed ledger write after the provider's create: the box is killed, its id kept on a failed record, and the next provider tried", async () => {
    const a = fakeProvider({ id: "a", tier: { kind: "monthly-credit", usd: 30 } });
    const b = fakeProvider({ id: "b", tier: { kind: "one-time-credit", usd: 30 } });
    const c = clock();
    const r = new SandboxRouter({ providers: [a, b], ledger: new FailingLedger(recordsCreatedOnA), env: {}, now: c.now });

    const sbx = await r.create();
    expect(sbx.provider).toBe("b");
    expect(a.created).toHaveLength(1);
    expect(a.killed).toEqual(a.created);
    const data = await r.ledger.read();
    expect(Object.values(data.sandboxes).filter((s) => s.provider === "a")).toEqual([
      expect.objectContaining({ state: "failed", providerSandboxId: a.created[0], error: expect.stringContaining("timed out waiting") }),
    ]);
    expect(sbx.route.find((x) => x.provider === "a")).toMatchObject({ outcome: "failed", kind: "transient", until: c.now() });
    // The ledger's trouble isn't the provider's: nothing against its health.
    expect((data.health["a"] ?? []).filter((s) => !s.ok)).toEqual([]);
  });

  it("a write that was saved but reported a failure: the box is killed, its record says so, and the next provider tried", async () => {
    const a = fakeProvider({ id: "a", tier: { kind: "monthly-credit", usd: 30 } });
    const b = fakeProvider({ id: "b", tier: { kind: "one-time-credit", usd: 30 } });
    const c = clock();
    const r = new SandboxRouter({ providers: [a, b], ledger: new FailingLedger(recordsCreatedOnA, true), env: {}, now: c.now });

    const sbx = await r.create();
    expect(sbx.provider).toBe("b");
    expect(a.killed).toEqual(a.created);
    const recs = Object.values((await r.ledger.read()).sandboxes).filter((s) => s.provider === "a");
    expect(recs).toEqual([expect.objectContaining({ state: "stopped", reason: "killed", providerSandboxId: a.created[0] })]);
  });

  it("a create slower than the sweep's 10 minutes: when it returns, its box is killed, its id kept, and the next provider tried", async () => {
    const a = fakeProvider({ id: "a", tier: { kind: "monthly-credit", usd: 30 } });
    const b = fakeProvider({ id: "b", tier: { kind: "one-time-credit", usd: 30 } });
    const { router: r, clock: c } = router([a, b]);
    const create = a.create.bind(a);
    a.create = async (spec, ctx) => {
      const made = await create(spec, ctx);
      c.advance(11 * 60_000);
      await r.sweep(); // another process's sweep: the create looks abandoned
      return made;
    };

    const sbx = await r.create();
    expect(sbx.provider).toBe("b");
    expect(a.killed).toEqual(a.created);
    const rec = Object.values((await r.ledger.read()).sandboxes).find((s) => s.provider === "a");
    expect(rec).toMatchObject({ state: "failed", providerSandboxId: a.created[0] });
    expect(sbx.route.find((x) => x.provider === "a")).toMatchObject({ outcome: "failed", kind: "transient" });
  });
});

describe("a kill racing a call on the same box", () => {
  it("killing boxes while an exec on each is in flight records no lost box, so three kills don't open the circuit", async () => {
    const p = fakeProvider({ id: "p", tier: { kind: "monthly-credit", usd: 30 } });
    const { router: r } = router([p]);
    const exec = p.exec.bind(p);
    const kill = p.kill.bind(p);
    const wake = new Map<string, () => void>();
    let inFlight: Promise<unknown> | undefined;
    p.exec = async (id, command, opts, ctx) => {
      if (command === "sleep 60") await new Promise<void>((resolve) => wake.set(id, resolve));
      return exec(id, command, opts, ctx); // 404 once the box is deleted
    };
    p.kill = async (id, ctx) => {
      await kill(id, ctx);
      wake.get(id)?.();
      // The exec in flight gets its 404 (a job's step, say) before the kill returns.
      await inFlight?.catch(() => undefined);
    };

    const boxes = [await r.create(), await r.create(), await r.create()];
    for (const sbx of boxes) {
      inFlight = sbx.commands.run("sleep 60");
      await sbx.kill();
      await expect(inFlight).rejects.toMatchObject({ kind: "not_found" });
    }
    expect(await lostSamples(r, "p")).toEqual([]);
    expect((await r.status())[0]!.health.circuit).toBe("closed");
    const data = await r.ledger.read();
    for (const sbx of boxes) expect(data.sandboxes[sbx.id]).toMatchObject({ state: "stopped", reason: "killed" });
  });

  it("a kill the provider fails: the record stays stopped, the error reaches the caller, and the remote sweep deletes the box", async () => {
    const a = shell({ id: "a" });
    const { router: r } = router([a]);
    const sbx = await r.create();
    const kill = a.kill.bind(a);
    let fail = true;
    a.kill = async (id, ctx) => {
      if (fail) throw Object.assign(new Error("upstream exploded"), { status: 500 });
      return kill(id, ctx);
    };
    await expect(sbx.kill()).rejects.toMatchObject({ kind: "transient" });
    expect((await sbx.info())?.state).toBe("stopped");
    expect(a.killed).toEqual([]);
    fail = false;
    expect((await r.sweep({ remote: true })).reaped).toBe(1);
    expect(a.killed).toEqual([sbx.providerSandboxId]);
  });
});

describe("FileLedger", () => {
  it("a write that fails takes its temp file with it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sbr-ledger-"));
    dirs.push(dir);
    const path = join(dir, "ledger.json");
    const ledger = new FileLedger(path);
    const at = new Date().toISOString();
    await ledger.update((d) => void d.marks.push({ provider: "p", kind: "rate_limit", at, until: at }));
    await expect(
      ledger.update(async (d) => {
        d.marks = [];
        // A directory where the ledger was: the rename onto it fails after the temp file is written.
        await rm(path);
        await mkdir(join(path, "blocker"), { recursive: true });
      }),
    ).rejects.toThrow();
    expect((await readdir(dir)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});
