// The job runner against local-shell boxes (temp dirs with HOME set to them): files really
// move between boxes only through checkpoints. A fake clock and an injected sleep make every
// wait instant. Tests assert continuity (files, which steps ran, how often) more than which
// provider was picked, except where a provider is made to refuse.

import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxRouter } from "../src/core/router.js";
import { MemoryLedger, type Ledger, type LedgerData } from "../src/core/ledger.js";
import { recordHealth } from "../src/core/health.js";
import { ConflictError, SandboxRouterError } from "../src/core/errors.js";
import { MemoryCheckpointStore } from "../src/core/jobs/checkpoint.js";
import { JobManager } from "../src/core/jobs/manager.js";
import { newJob, transitionJob } from "../src/core/jobs/state.js";
import type { CheckpointRef, JobEvent, JobRecord, JobView, RunnerEvent, StepSpec } from "../src/core/jobs/types.js";
import type { SandboxView } from "../src/core/router.js";
import type { Capability, ProviderAdapter } from "../src/core/types.js";
import { clock } from "./fake.js";
import { localShellProvider, type LocalShell, type LocalShellOpts } from "./localshell.js";

const TAG = "sandboxrouting.job";
type Clock = ReturnType<typeof clock>;
const iso = (ms: number) => new Date(ms).toISOString();

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

function setup(providers: ProviderAdapter[], o: { config?: unknown; ledger?: Ledger; c?: Clock } = {}) {
  const c = o.c ?? clock();
  const r = new SandboxRouter({ providers, config: o.config ?? {}, ledger: o.ledger ?? new MemoryLedger(), env: {}, now: c.now });
  const store = new MemoryCheckpointStore(c.now);
  const manager = (ownerId = "runner-1") => new JobManager(r, { store, ownerId, sleep: async (ms) => c.advance(ms) });
  return { r, c, store, jobs: manager(), manager };
}

/** Counts how often each `#marker` in a step command was executed, on any box. */
function runs() {
  const n: Record<string, number> = {};
  const see = (command: string) => {
    for (const m of command.matchAll(/#(\w+)/g)) n[m[1]!] = (n[m[1]!] ?? 0) + 1;
  };
  return { n, see };
}

function recorder() {
  const events: RunnerEvent[] = [];
  return {
    events,
    onEvent: (e: RunnerEvent) => void events.push(e),
    of: <T extends RunnerEvent["type"]>(type: T) => events.filter((e): e is Extract<RunnerEvent, { type: T }> => e.type === type),
  };
}

const notFound = () => Object.assign(new Error("sandbox not found"), { status: 404 });
const outOfCredit = () => Object.assign(new Error("Payment required: out of credits"), { status: 402 });

/** A provider whose box vanishes the first time a command containing `marker` runs. */
function loseOnce(marker: string, seen: ReturnType<typeof runs>): LocalShell {
  return loseAt([marker], seen);
}

/** A provider whose box vanishes at each marker in turn: the first command with the first one, then the next… */
function loseAt(markers: string[], seen: ReturnType<typeof runs>): LocalShell {
  const left = [...markers];
  const a: LocalShell = shell({
    id: "a",
    execHook: (id, cmd) => {
      seen.see(cmd);
      if (!left.length || !cmd.includes(left[0]!)) return undefined;
      left.shift();
      void a.lose(id);
      return notFound();
    },
  });
  return a;
}

/** Extracts a workspace archive on the host; returns a reader for its files. */
async function unpack(archive: Uint8Array | undefined): Promise<(path: string) => Promise<string>> {
  if (!archive) throw new Error("no workspace archive");
  const dir = await mkdtemp(join(tmpdir(), "sbr-unpack-"));
  dirs.push(dir);
  await writeFile(join(dir, "ws.tgz"), archive);
  await mkdir(join(dir, "ws"));
  execFileSync("tar", ["-xzf", join(dir, "ws.tgz"), "-C", join(dir, "ws")]);
  return (path) => readFile(join(dir, "ws", path), "utf8");
}

/** A MemoryLedger that can make its writer "die" once, just before or just after a write is saved. */
class CrashingLedger implements Ledger {
  private readonly inner = new MemoryLedger();
  /** The first write after which a job matches is lost. */
  crashBefore?: (job: JobRecord) => boolean;
  /** The first write after which a job matches is saved, then its writer dies. */
  crashAfter?: (job: JobRecord) => boolean;

  read(): Promise<LedgerData> {
    return this.inner.read();
  }

  async update<T>(fn: (data: LedgerData) => T | Promise<T>): Promise<T> {
    let died = false;
    const out = await this.inner.update(async (d) => {
      const result = await fn(d);
      const jobs = Object.values(d.jobs);
      const before = this.crashBefore;
      if (before && jobs.some((j) => before(j))) {
        this.crashBefore = undefined;
        throw new Error("simulated crash");
      }
      const after = this.crashAfter;
      if (after && jobs.some((j) => after(j))) {
        this.crashAfter = undefined;
        died = true;
      }
      return result;
    });
    if (died) throw new Error("simulated crash");
    return out;
  }
}

/**
 * A MemoryLedger whose writer stalls once: after the first write that leaves a job matching
 * `stallAfter`, its next read or write first waits for `meanwhile` (another owner taking over).
 */
class StallingLedger implements Ledger {
  private readonly inner = new MemoryLedger();
  stallAfter?: (job: JobRecord) => boolean;
  meanwhile?: () => Promise<void>;
  private stalled = false;

  async read(): Promise<LedgerData> {
    await this.wake();
    return this.inner.read();
  }

  async update<T>(fn: (data: LedgerData) => T | Promise<T>): Promise<T> {
    await this.wake();
    return this.inner.update(async (d) => {
      const out = await fn(d);
      const match = this.stallAfter;
      if (match && Object.values(d.jobs).some((j) => match(j))) {
        this.stallAfter = undefined;
        this.stalled = true;
      }
      return out;
    });
  }

  private async wake(): Promise<void> {
    if (!this.stalled) return;
    this.stalled = false;
    await this.meanwhile?.();
  }
}

/**
 * Spend on `provider` that no reservation covered: a box someone ran outside the router for
 * `seconds` (1 vCPU), recorded once it was over. A free box reserves its whole lifetime, so only
 * spend like this can run its tier short under it.
 */
function spentOutside(r: SandboxRouter, provider: string, seconds: number, now: number): Promise<void> {
  return r.ledger.update((d) => {
    const id = `sbr_outside_${provider}`;
    const start = iso(now - seconds * 1000);
    d.sandboxes[id] = {
      id,
      provider,
      state: "stopped",
      cpu: 1,
      memoryMiB: 1024,
      createdAt: start,
      metadata: {},
      providerSandboxId: `${provider}-outside`,
      segments: [{ start, end: iso(now) }],
      endedAt: iso(now),
      reason: "killed",
    };
  });
}

/**
 * Runner 1's lease lapses and "runner-2" claims the job, then applies `then` as its owner. On a
 * MemoryLedger the write is queued at once, so it lands before any write runner 1 makes later.
 */
function takeOver(r: SandboxRouter, c: Clock, id: string, then: JobEvent[] = []): Promise<void> {
  c.advance(61_000);
  return r.ledger.update((d) => {
    const now = c.now();
    let job = transitionJob(d.jobs[id]!, { type: "claim", lease: { owner: "runner-2", until: iso(now + 60_000) } }, now, "runner-2");
    for (const ev of then) job = transitionJob(job, ev, now, "runner-2");
    d.jobs[id] = job;
  });
}

describe("running a job", () => {
  it("runs setup and steps in order on one box; each step sees what the last one wrote", async () => {
    const a = shell({ id: "a" });
    const { r, store, jobs } = setup([a]);
    const put = vi.spyOn(store, "put");
    const prune = vi.spyOn(store, "prune");
    const rec = recorder();
    const out: string[] = [];
    const view = await jobs.run(
      {
        name: "pipeline",
        files: { "in.txt": "hello\n" },
        setup: [{ run: "echo ready >> $HOME/setup.log" }],
        env: { GREETING: "hi" },
        steps: [
          { run: "cat in.txt > a.txt && echo $GREETING >> a.txt" },
          { run: "mkdir -p sub && cat a.txt > sub/b.txt && echo $EXTRA >> sub/b.txt", env: { EXTRA: "two" } },
          { run: "cat b.txt", cwd: "sub" },
        ],
      },
      { onEvent: rec.onEvent, onStdout: (s) => out.push(s) },
    );

    expect(view).toMatchObject({ state: "succeeded", name: "pipeline", cursor: 3, steps: 3, migrations: 0 });
    expect(view.results.map((x) => x.exitCode)).toEqual([0, 0, 0]);
    expect(view.results[2]!.stdoutTail).toBe("hello\nhi\ntwo\n");
    expect(out.join("")).toContain("hello\nhi\ntwo\n");
    expect(view.placements).toEqual([expect.objectContaining({ provider: "a", billing: "free", endReason: "finished" })]);
    const perStep = ["stepStarted", "stepFinished", "checkpointed"];
    expect(rec.events.map((e) => e.type)).toEqual(["placed", "prepared", ...perStep, ...perStep, ...perStep, "succeeded"]);
    expect(rec.of("stepStarted").map((e) => e.step)).toEqual([0, 1, 2]);
    expect(rec.of("checkpointed").map((e) => e.step)).toEqual([0, 1, 2]);

    // The box is gone, only the last archive is kept, and it holds the final workspace.
    expect((await r.get(view.placements[0]!.sandboxId))!.state).toBe("stopped");
    const refs = await Promise.all(put.mock.results.map((x) => x.value as Promise<CheckpointRef>));
    expect(refs.map((x) => x.step)).toEqual([0, 1, 2]);
    expect(view.checkpoint).toEqual(refs[2]);
    // Older archives go as soon as a newer one is recorded, so a long job keeps just one.
    expect(prune.mock.calls.map(([, keep]) => keep?.step)).toEqual([0, 1, 2, 2]);
    await expect(store.get(view.id, refs[0]!)).rejects.toThrow(/missing/);
    const file = await unpack(await jobs.workspace(view.id));
    expect(await file("sub/b.txt")).toBe("hello\nhi\ntwo\n");
  });

  it("noCheckpoint skips the archive after that step", async () => {
    const { store, jobs } = setup([shell({ id: "a" })]);
    const put = vi.spyOn(store, "put");
    const view = await jobs.run({ steps: [{ run: "echo a > a.txt" }, { run: "cat a.txt", noCheckpoint: true }] });
    expect(view.state).toBe("succeeded");
    expect(put).toHaveBeenCalledTimes(1);
    expect(view.checkpoint?.step).toBe(0);
  });

  it("a non-zero exit fails the job with that step's result, and the box is killed", async () => {
    const { r, jobs } = setup([shell({ id: "a" })]);
    const view = await jobs.run({ steps: [{ run: "echo fine" }, { run: "echo out; echo err >&2; exit 3", name: "build" }, { run: "echo never" }] });
    expect(view).toMatchObject({ state: "failed", error: "step 1 (build) exited 3", cursor: 1 });
    const job = (await r.ledger.read()).jobs[view.id]!;
    expect(job.state === "failed" && job.result).toMatchObject({ step: 1, exitCode: 3, stdoutTail: "out\n", stderrTail: "err\n" });
    expect(view.placements[0]!.endReason).toBe("failed");
    expect((await r.get(view.placements[0]!.sandboxId))!.state).toBe("stopped");
  });

  it("retries: a step that exits non-zero runs again from the workspace before it", async () => {
    const seen = runs();
    const { r, jobs } = setup([shell({ id: "a", execHook: (_id, cmd) => void seen.see(cmd) })]);
    // Appends to the workspace, and passes on its third run (the counter lives outside the workdir).
    const flaky = 'echo x >> log.txt; n=$(cat "$HOME/n" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$HOME/n"; [ "$n" -ge 3 ] #s1';
    const view = await jobs.run({ steps: [{ run: "echo base > log.txt #s0" }, { run: flaky, retries: 2 }, { run: "cat log.txt #s2" }] });
    expect(view.state).toBe("succeeded");
    expect(seen.n).toEqual({ s0: 1, s1: 3, s2: 1 });
    // Each retry started from the checkpoint after step 0: only the last run's line is there.
    expect(view.results[2]!.stdoutTail).toBe("base\nx\n");
    expect((await r.ledger.read()).jobs[view.id]!.attempts["1"]).toEqual({ total: 3, exitFailures: 2 });
  });

  it("retries run out: the job fails with the last exit", async () => {
    const seen = runs();
    const { jobs } = setup([shell({ id: "a", execHook: (_id, cmd) => void seen.see(cmd) })]);
    const view = await jobs.run({ steps: [{ run: "exit 1 #s0", retries: 1 }] });
    expect(view).toMatchObject({ state: "failed", error: "step 0 exited 1" });
    expect(seen.n.s0).toBe(2);
  });

  it("rejects a bad spec or policy before recording anything", async () => {
    const { r, jobs } = setup([shell({ id: "a" })]);
    await expect(jobs.run({ steps: [{ run: " " }] })).rejects.toThrow(/steps\[0\]\.run/);
    await expect(jobs.submit({ steps: [{ run: "true" }], policy: { leaseSec: -1 } })).rejects.toThrow(/leaseSec/);
    expect((await r.ledger.read()).jobs).toEqual({});
  });
});

describe("moving between boxes", () => {
  it("a box destroyed mid-step that reports an exit code (Docker says 137) is a lost box, not the step's failure", async () => {
    const seen = runs();
    let lost = false;
    const a: LocalShell = shell({
      id: "a",
      execHook: (id, cmd) => {
        seen.see(cmd);
        if (!cmd.includes("#s1") || lost) return undefined;
        lost = true;
        void a.lose(id);
        // What `docker exec` returns when the container is removed under it: no error, just a kill.
        return { stdout: "", stderr: "", exitCode: 137 };
      },
    });
    const { jobs } = setup([a]);
    const view = await jobs.run({ steps: [{ run: "echo one > a.txt #s0" }, { run: "echo two >> a.txt #s1" }, { run: "cat a.txt #s2" }] });
    expect(view.state).toBe("succeeded");
    expect(view.placements.map((p) => p.endReason)).toEqual(["lost", "finished"]);
    expect(seen.n).toEqual({ s0: 1, s1: 2, s2: 1 });
    expect(view.results[2]!.stdoutTail).toBe("one\ntwo\n");
  });

  it("a step that exits non-zero on a box that is still fine fails the job as before", async () => {
    const { jobs } = setup([shell({ id: "a" })]);
    const view = await jobs.run({ steps: [{ run: "echo nope >&2; exit 3" }] });
    expect(view.state).toBe("failed");
    expect(view.result).toMatchObject({ exitCode: 3, stderrTail: "nope\n" });
    expect(view.migrations).toBe(0);
  });

  it("a box lost mid-step: the job continues on a new box from the last checkpoint, re-running only that step", async () => {
    const seen = runs();
    const { r, jobs } = setup([loseOnce("#s1", seen)]);
    const create = vi.spyOn(r, "create");
    const rec = recorder();
    const view = await jobs.run(
      { steps: [{ run: "echo one > a.txt #s0" }, { run: "cat a.txt > b.txt && echo two >> b.txt #s1" }, { run: "cat b.txt #s2" }] },
      { onEvent: rec.onEvent },
    );
    expect(view.state).toBe("succeeded");
    expect(seen.n).toEqual({ s0: 1, s1: 2, s2: 1 });
    expect(view.results[2]!.stdoutTail).toBe("one\ntwo\n");
    expect(view.placements.map((p) => p.endReason)).toEqual(["lost", "finished"]);
    expect(view.migrations).toBe(1);
    expect(rec.of("migrating")).toEqual([expect.objectContaining({ reason: "lost", from: "a" })]);
    expect(rec.of("prepared")).toEqual([
      { type: "prepared", fromStep: 0, restored: false },
      { type: "prepared", fromStep: 1, restored: true },
    ]);
    // The next box was asked for away from the provider that lost one, tagged with the job.
    expect(create.mock.calls[1]![0]).toMatchObject({ avoid: ["a"], metadata: { [TAG]: view.id }, execTimeoutSec: 600 });
    expect((await r.ledger.read()).health["a"]).toContainEqual(expect.objectContaining({ op: "lost", ok: false }));
  });

  it("a box lost while saving a step's workspace: the success is recorded, and the next box re-runs the step from the checkpoint before it", async () => {
    const seen = runs();
    let ranS1 = false;
    let lost = false;
    const a: LocalShell = shell({
      id: "a",
      execHook: (id, cmd) => {
        seen.see(cmd);
        if (cmd.includes("#s1")) ranS1 = true;
        else if (ranS1 && !lost && cmd.includes("tar -czf")) {
          lost = true;
          void a.lose(id);
          return notFound();
        }
        return undefined;
      },
    });
    const { jobs } = setup([a]);
    const rec = recorder();
    const view = await jobs.run({ steps: [{ run: "echo one > a.txt #s0" }, { run: "echo two >> a.txt #s1" }, { run: "cat a.txt #s2" }] }, { onEvent: rec.onEvent });
    expect(view.state).toBe("succeeded");
    expect(seen.n).toEqual({ s0: 1, s1: 2, s2: 1 });
    expect(view.results[2]!.stdoutTail).toBe("one\ntwo\n");
    expect(view.history.filter((h) => h.type === "stepSucceeded").map((h) => h.detail?.split(",")[0])).toEqual(["step 0", "step 1", "step 1", "step 2"]);
    expect(rec.of("prepared").map((e) => e.fromStep)).toEqual([0, 1]);
  });

  it("a checkpoint store that can't save (disk full): the step's success is recorded, then the job fails saying why, and the box is killed", async () => {
    const seen = runs();
    const { r, store, jobs } = setup([shell({ id: "a", execHook: (_id, cmd) => void seen.see(cmd) })]);
    const put = store.put.bind(store);
    vi.spyOn(store, "put").mockImplementation(async (jobId, step, data) => {
      if (step === 1) throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
      return put(jobId, step, data);
    });
    const view = await jobs.run({ steps: [{ run: "echo one > a.txt #s0" }, { run: "echo notify #s1", idempotent: false }, { run: "cat a.txt #s2" }] });
    expect(view).toMatchObject({ state: "failed", cursor: 2 });
    expect(view.error).toBe("couldn't save the workspace after step 1: ENOSPC: no space left on device, write");
    // Step 1 did run, once: its result is kept, and it is not called unknown.
    expect(view.results.map((x) => x.step)).toEqual([0, 1]);
    expect(view.checkpoint?.step).toBe(0);
    expect(seen.n).toEqual({ s0: 1, s1: 1 });
    expect(view.placements.map((p) => p.endReason)).toEqual(["failed"]);
    expect((await r.get(view.placements[0]!.sandboxId))!.state).toBe("stopped");
  });

  it("a box lost during a step that isn't idempotent fails the job instead of running the step twice", async () => {
    const seen = runs();
    const { r, jobs } = setup([loseOnce("#s1", seen)]);
    const view = await jobs.run({ steps: [{ run: "echo one #s0" }, { run: "echo notify #s1", idempotent: false }, { run: "echo after #s2" }] });
    expect(view.state).toBe("failed");
    expect(view.error).toMatch(/step 1 isn't idempotent and its outcome is unknown/);
    expect(seen.n).toEqual({ s0: 1, s1: 1 });
    expect(view.placements.map((p) => p.endReason)).toEqual(["failed"]);
    expect((await r.ledger.read()).jobs[view.id]!.migrations).toBe(0);
  });

  it("a quota refusal during a step marks the provider, and the step runs again elsewhere", async () => {
    const seen = runs();
    const a = shell({ id: "a", execHook: (_id, cmd) => (seen.see(cmd), cmd.includes("#s1") ? outOfCredit() : undefined) });
    const b = shell({ id: "b", tier: { kind: "one-time-credit", usd: 30 }, execHook: (_id, cmd) => void seen.see(cmd) });
    const { r, jobs } = setup([a, b]);
    const view = await jobs.run({ steps: [{ run: "echo one > a.txt #s0" }, { run: "cat a.txt > b.txt && echo two >> b.txt #s1" }, { run: "cat b.txt #s2" }] });
    expect(view.state).toBe("succeeded");
    expect(view.placements.map((p) => [p.provider, p.endReason])).toEqual([
      ["a", "provider-refused"],
      ["b", "finished"],
    ]);
    expect((await r.ledger.read()).marks).toEqual([expect.objectContaining({ provider: "a", kind: "quota" })]);
    expect(seen.n).toEqual({ s0: 1, s1: 2, s2: 1 });
    expect(view.results[2]).toMatchObject({ provider: "b", stdoutTail: "one\ntwo\n" });
  });

  it("a quota or auth mark that lands on the box's provider moves the job at the next step boundary", async () => {
    const a = shell({ id: "a" });
    const b = shell({ id: "b", tier: { kind: "one-time-credit", usd: 30 } });
    const { r, jobs } = setup([a, b]);
    const view = await jobs.run(
      { steps: [{ run: "echo one > a.txt" }, { run: "cat a.txt" }] },
      {
        onEvent: (e) => {
          if (e.type === "stepFinished" && e.step === 0) void r.markFromError("a", new SandboxRouterError("auth", "invalid api key", "a"));
        },
      },
    );
    expect(view.state).toBe("succeeded");
    expect(view.placements.map((p) => [p.provider, p.endReason])).toEqual([
      ["a", "provider-refused"],
      ["b", "finished"],
    ]);
    expect(view.results[1]).toMatchObject({ provider: "b", stdoutTail: "one\n" });
  });

  it("a circuit that opens on the box's provider moves the job at the next step boundary", async () => {
    const a = shell({ id: "a" });
    const b = shell({ id: "b", tier: { kind: "one-time-credit", usd: 30 } });
    const { r, c, jobs } = setup([a, b]);
    const failure = () => ({ at: new Date(c.now()).toISOString(), op: "create" as const, ok: false, kind: "transient" as const });
    const view = await jobs.run(
      { steps: [{ run: "echo one > a.txt" }, { run: "cat a.txt" }] },
      {
        onEvent: (e) => {
          // Other requests' creates on "a" fail three times in a row while step 0 runs.
          if (e.type === "stepFinished" && e.step === 0) void r.ledger.update((d) => [1, 2, 3].forEach(() => recordHealth(d, "a", failure(), 50)));
        },
      },
    );
    expect(view.state).toBe("succeeded");
    expect(view.placements.map((p) => [p.provider, p.endReason])).toEqual([
      ["a", "circuit-open"],
      ["b", "finished"],
    ]);
    expect(view.results[1]).toMatchObject({ provider: "b", stdoutTail: "one\n" });
  });

  it("a step's call that breaks off (a proxy idle timeout) may still be running: the step re-runs on a new box, never beside itself", async () => {
    const seen = runs();
    const calls: { id: string; cmd: string }[] = [];
    let broke: string | undefined;
    const a = shell({
      id: "a",
      execHook: (id, cmd) => {
        seen.see(cmd);
        calls.push({ id, cmd });
        if (!cmd.includes("#s1") || broke) return undefined;
        broke = id;
        return new Error("socket hang up");
      },
    });
    const { r, jobs } = setup([a]);
    const rec = recorder();
    const view = await jobs.run({ steps: [{ run: "echo one > a.txt #s0" }, { run: "echo two >> a.txt #s1" }, { run: "cat a.txt #s2" }] }, { onEvent: rec.onEvent });
    expect(view.state).toBe("succeeded");
    expect(rec.of("retrying")).toEqual([]);
    expect(rec.of("migrating")).toEqual([expect.objectContaining({ reason: "unhealthy" })]);
    // Nothing else ran on that box: no restore wiping the workspace under the first copy, no second copy.
    const brokeAt = calls.findIndex((c) => c.cmd.includes("#s1"));
    expect(calls.slice(brokeAt + 1).filter((c) => c.id === broke)).toEqual([]);
    expect(seen.n).toEqual({ s0: 1, s1: 2, s2: 1 });
    expect(view.results[2]!.stdoutTail).toBe("one\ntwo\n");
    expect((await r.ledger.read()).jobs[view.id]!.attempts["1"]).toEqual({ total: 2, exitFailures: 0 });
  });

  it("a step that isn't idempotent fails when its call breaks off, instead of running twice", async () => {
    const seen = runs();
    const a = shell({ id: "a", execHook: (_id, cmd) => (seen.see(cmd), cmd.includes("#s1") ? new Error("socket hang up") : undefined) });
    const { jobs } = setup([a]);
    const view = await jobs.run({ steps: [{ run: "echo one #s0" }, { run: "echo notify #s1", idempotent: false }] });
    expect(view.state).toBe("failed");
    expect(view.error).toMatch(/step 1 isn't idempotent and its outcome is unknown \(step 1: socket hang up\)/);
    expect(seen.n).toEqual({ s0: 1, s1: 1 });
  });

  it("other calls on the box (here, saving the workspace) retry transient errors on the same box twice, 1 s then 2 s apart, then the job moves: unhealthy", async () => {
    const seen = runs();
    let first: string | undefined;
    let ranS1 = false;
    const a = shell({
      id: "a",
      execHook: (id, cmd) => {
        seen.see(cmd);
        first ??= id;
        if (cmd.includes("#s1")) ranS1 = true;
        return id === first && ranS1 && cmd.includes("tar -czf") ? new Error("socket hang up") : undefined;
      },
    });
    const { jobs } = setup([a]);
    const rec = recorder();
    const view = await jobs.run({ steps: [{ run: "echo one > a.txt #s0" }, { run: "echo two >> a.txt #s1" }, { run: "cat a.txt #s2" }] }, { onEvent: rec.onEvent });
    expect(view.state).toBe("succeeded");
    expect(rec.of("retrying").map((e) => [e.step, e.delayMs])).toEqual([
      [1, 1000],
      [1, 2000],
    ]);
    expect(rec.of("migrating")).toEqual([expect.objectContaining({ reason: "unhealthy" })]);
    // Step 1's archive was never saved, so the next box rewinds to step 0's and runs step 1 again.
    expect(seen.n).toEqual({ s0: 1, s1: 2, s2: 1 });
    expect(view.results[2]!.stdoutTail).toBe("one\ntwo\n");
  });

  it("exit 137 with growMemoryOnOom moves to a box with twice the memory", async () => {
    let first: string | undefined;
    const a = shell({
      id: "a",
      execHook: (id, cmd) => {
        if (!cmd.includes("#big")) return undefined;
        first ??= id;
        return id === first ? { exitCode: 137, stdout: "", stderr: "Killed\n" } : undefined;
      },
    });
    const { r, jobs } = setup([a]);
    const view = await jobs.run({ policy: { growMemoryOnOom: true }, steps: [{ run: "echo one > a.txt" }, { run: "cat a.txt #big" }] });
    expect(view.state).toBe("succeeded");
    expect(view.placements.map((p) => p.endReason)).toEqual(["oom", "finished"]);
    const data = await r.ledger.read();
    expect(view.placements.map((p) => data.sandboxes[p.sandboxId]!.memoryMiB)).toEqual([1024, 2048]);
    expect(data.jobs[view.id]!.memoryMiB).toBe(2048);
    expect(view.results[1]!.stdoutTail).toBe("one\n");
  });

  it("fails once the job has moved maxMigrations times", async () => {
    const a: LocalShell = shell({ id: "a", execHook: (id, cmd) => (cmd.includes("#s0") ? (void a.lose(id), notFound()) : undefined) });
    const { jobs } = setup([a]);
    const view = await jobs.run({ policy: { maxMigrations: 1 }, steps: [{ run: "echo hi #s0" }] });
    expect(view.state).toBe("failed");
    expect(view.error).toMatch(/already moved 1 time\(s\), the most maxMigrations allows/);
    expect(view.placements.map((p) => p.endReason)).toEqual(["lost", "failed"]);
  });

  it("fails when a step keeps losing its box past maxStepAttempts", async () => {
    const a: LocalShell = shell({ id: "a", execHook: (id, cmd) => (cmd.includes("#s0") ? (void a.lose(id), notFound()) : undefined) });
    const { jobs } = setup([a]);
    const view = await jobs.run({ policy: { maxStepAttempts: 2 }, steps: [{ run: "echo hi #s0" }] });
    expect(view.state).toBe("failed");
    expect(view.error).toMatch(/didn't finish in 2 attempts/);
    expect(view.placements.map((p) => p.endReason)).toEqual(["lost", "failed"]);
  });
});

describe("planned moves at step boundaries", () => {
  it("a fresh box has room for preparing it: a provider that can't extend doesn't send every job away (regression)", async () => {
    const c = clock();
    // Every command takes a second, as on a real box: finding the workdir, writing files, setup.
    const a = shell({ id: "a", capabilities: [], execHook: () => void c.advance(1_000) });
    const { jobs } = setup([a], { c });
    // No setup steps: the box's life has no setup budget to absorb the time spent preparing it.
    const view = await jobs.run({ steps: [{ run: "echo one > a.txt" }, { run: "cat a.txt" }] });
    expect(view.state).toBe("succeeded");
    expect(view.migrations).toBe(0);
    expect(view.results[1]!.stdoutTail).toBe("one\n");
  });

  it("a box that still comes up short when it's fresh grows the next request instead of moving in a loop", async () => {
    const c = clock();
    // Preparing takes far longer than any allowance: 120 s per command.
    const a = shell({ id: "a", capabilities: [], execHook: () => void c.advance(120_000) });
    // No 300 s default floor on the box's life to hide the shortfall.
    const { r, jobs } = setup([a], { c, config: { defaults: { timeoutSec: 1 } } });
    const view = await jobs.run({ policy: { defaultStepTimeoutSec: 30, deadlineMarginSec: 10 }, steps: [{ run: "true" }] });
    expect(view.state).toBe("succeeded");
    expect(view.migrations).toBeLessThanOrEqual(2);
    const lifetimes = await Promise.all(view.placements.map(async (p) => r.get(p.sandboxId)));
    // Each box after a too-short fresh one was asked for more time than the one before.
    const asked = lifetimes.map((s) => Date.parse(s!.expiresAt ?? s!.endedAt!) - Date.parse(s!.createdAt));
    for (let i = 1; i < asked.length; i++) expect(asked[i]!).toBeGreaterThan(asked[i - 1]!);
  });

  it("extends the box when the next step won't fit in its remaining life and the provider can", async () => {
    const c = clock();
    const a = shell({ id: "a", execHook: (_id, cmd) => void (cmd.includes("#s0") && c.advance(30_000)) });
    const { r, jobs } = setup([a], { c });
    const rec = recorder();
    const start = c.now();
    let extended: Promise<SandboxView | undefined> | undefined;
    // Box life 60 s; each step needs 30 s plus a 10 s margin. After step 0 (30 s) only 30 s are left.
    const view = await jobs.run(
      { sandbox: { timeoutSec: 60 }, policy: { defaultStepTimeoutSec: 30, deadlineMarginSec: 10 }, steps: [{ run: "echo one > a.txt #s0" }, { run: "cat a.txt" }] },
      {
        onEvent: (e) => {
          rec.onEvent(e);
          if (e.type === "extended") extended = r.get(e.sandboxId);
        },
      },
    );
    expect(view.state).toBe("succeeded");
    const box = view.placements[0]!.sandboxId;
    expect(rec.of("extended")).toEqual([{ type: "extended", sandboxId: box, timeoutSec: 40 }]);
    // The deadline moved to 40 s after the extension, which happened 30 s in.
    expect((await extended)!.expiresAt).toBe(new Date(start + 70_000).toISOString());
    expect(view.placements).toHaveLength(1);
    expect(view.results[1]!.stdoutTail).toBe("one\n");
  });

  it.each([
    ["the provider can't extend a live box", { capabilities: [] as Capability[] }],
    ["extending would pass the provider's maximum lifetime", { maxTimeoutSec: 65 }],
  ])("moves to a new box when %s: deadline", async (_why, extra) => {
    const c = clock();
    const a = shell({ id: "a", ...extra, execHook: (_id, cmd) => void (cmd.includes("#s0") && c.advance(30_000)) });
    const { jobs } = setup([a], { c });
    const rec = recorder();
    const view = await jobs.run(
      { sandbox: { timeoutSec: 60 }, policy: { defaultStepTimeoutSec: 30, deadlineMarginSec: 10 }, steps: [{ run: "echo one > a.txt #s0" }, { run: "cat a.txt" }] },
      { onEvent: rec.onEvent },
    );
    expect(view.state).toBe("succeeded");
    expect(rec.of("extended")).toEqual([]);
    expect(view.placements.map((p) => p.endReason)).toEqual(["deadline", "finished"]);
    expect(view.results[1]!.stdoutTail).toBe("one\n");
  });

  it("moves off a free tier that ran out, when the router now ranks another provider first", async () => {
    const c = clock();
    // $10 of monthly credit covers the job's whole box (7200 s × $0.001/s), which the router
    // reserves there. Step 0 runs for 20 minutes.
    const a = shell({ id: "a", tier: { kind: "monthly-credit", usd: 10 }, rate: 0.001, execHook: (_id, cmd) => void (cmd.includes("#s0") && c.advance(1_200_000)) });
    const b = shell({ id: "b", tier: { kind: "one-time-credit", usd: 10 }, rate: 0.001 });
    const { r, jobs } = setup([a, b], { c });
    const view = await jobs.run(
      { sandbox: { timeoutSec: 7200 }, policy: { leaseSec: 3600 }, steps: [{ run: "echo one > a.txt #s0" }, { run: "cat a.txt" }] },
      {
        onEvent: (e) => {
          // Meanwhile $9 goes on a outside the router: with the job's $1.20, the credit is gone.
          if (e.type === "stepFinished" && e.step === 0) void spentOutside(r, "a", 9000, c.now());
        },
      },
    );
    expect(view.state).toBe("succeeded");
    expect(view.placements.map((p) => [p.provider, p.endReason])).toEqual([
      ["a", "free-credit"],
      ["b", "finished"],
    ]);
    expect(view.results[1]).toMatchObject({ provider: "b", stdoutTail: "one\n" });
  });

  it("stays on a free tier that won't cover the next step while the router still ranks it first", async () => {
    const c = clock();
    // As above, with a 15-minute step 0. The only other provider costs twice as much.
    const a = shell({ id: "a", tier: { kind: "monthly-credit", usd: 10 }, rate: 0.001, execHook: (_id, cmd) => void (cmd.includes("#s0") && c.advance(900_000)) });
    const b = shell({ id: "b", tier: { kind: "none" }, rate: 0.002 });
    const { r, jobs } = setup([a, b], { c, config: { allowPaid: true } });
    const plan = vi.spyOn(r, "plan");
    const view = await jobs.run(
      { sandbox: { timeoutSec: 7200 }, policy: { leaseSec: 3600 }, steps: [{ run: "echo one > a.txt #s0" }, { run: "cat a.txt" }] },
      {
        onEvent: (e) => {
          // $9 goes on a outside the router: $0.10 is left, less than step 1 could cost
          // (600 s × $0.001), but not used up.
          if (e.type === "stepFinished" && e.step === 0) void spentOutside(r, "a", 9000, c.now());
        },
      },
    );
    expect(view.state).toBe("succeeded");
    // The short tier made the runner ask the router before step 1, and a was still its first pick.
    expect(plan).toHaveBeenCalledTimes(1);
    expect(view.placements.map((p) => [p.provider, p.endReason])).toEqual([["a", "finished"]]);
  });

  it("rebalance: moves off a paid box once a free provider can take the job", async () => {
    const c = clock();
    const paid = shell({ id: "paid", tier: { kind: "none" }, execHook: (_id, cmd) => void (cmd.includes("#s0") && c.advance(61_000)) });
    const free = shell({ id: "free", tier: { kind: "monthly-credit", usd: 30 } });
    const { r, jobs } = setup([paid, free], { config: { allowPaid: true }, c });
    await r.markFromError("free", new SandboxRouterError("rate_limit", "slow down", "free")); // lapses after 60 s
    const view = await jobs.run({ policy: { rebalance: true, leaseSec: 600 }, steps: [{ run: "echo one > a.txt #s0" }, { run: "cat a.txt" }] });
    expect(view.state).toBe("succeeded");
    expect(view.placements.map((p) => [p.provider, p.billing, p.endReason])).toEqual([
      ["paid", "paid", "rebalance"],
      ["free", "free", "finished"],
    ]);
    expect(view.results[1]).toMatchObject({ provider: "free", stdoutTail: "one\n" });
  });
});

describe("on-migrate checkpoints", () => {
  it("an unplanned loss rewinds to the last checkpoint and replays the steps since", async () => {
    const seen = runs();
    const { store, jobs } = setup([loseOnce("#s2", seen)]);
    const put = vi.spyOn(store, "put");
    const view = await jobs.run({ policy: { checkpoint: "on-migrate" }, steps: [{ run: "echo 0 > a.txt #s0" }, { run: "echo 1 >> a.txt #s1" }, { run: "cat a.txt #s2" }] });
    expect(view.state).toBe("succeeded");
    expect(seen.n).toEqual({ s0: 2, s1: 2, s2: 2 });
    expect(view.results[2]!.stdoutTail).toBe("0\n1\n");
    expect(put).not.toHaveBeenCalled();
  });

  it("replays don't use up the attempts of steps that had succeeded: boxes lost at steps 3, 1 and 2 still finish", async () => {
    const seen = runs();
    const { r, jobs } = setup([loseAt(["#s3", "#s1", "#s2"], seen)]);
    const view = await jobs.run({
      policy: { checkpoint: "on-migrate" },
      steps: [{ run: "echo 0 > a.txt #s0" }, { run: "echo 1 >> a.txt #s1" }, { run: "echo 2 >> a.txt #s2" }, { run: "cat a.txt #s3" }],
    });
    expect(view.error).toBeUndefined();
    expect(view).toMatchObject({ state: "succeeded", migrations: 3 });
    expect(seen.n).toEqual({ s0: 4, s1: 4, s2: 3, s3: 2 });
    expect(view.results[3]!.stdoutTail).toBe("0\n1\n2\n");
    // What still counts: each step's own unfinished runs, plus the one that worked.
    expect((await r.ledger.read()).jobs[view.id]!.attempts).toEqual({
      "0": { total: 1, exitFailures: 0 },
      "1": { total: 1, exitFailures: 0 },
      "2": { total: 2, exitFailures: 0 },
      "3": { total: 2, exitFailures: 0 },
    });
  });

  it("fails rather than replay a step that isn't idempotent", async () => {
    const seen = runs();
    const { jobs } = setup([loseOnce("#s2", seen)]);
    const steps: StepSpec[] = [{ run: "echo 0 > a.txt #s0" }, { run: "echo 1 >> a.txt #s1", idempotent: false }, { run: "cat a.txt #s2" }];
    const view = await jobs.run({ policy: { checkpoint: "on-migrate" }, steps });
    expect(view.state).toBe("failed");
    expect(view.error).toMatch(/would run step 1 again, and it isn't idempotent/);
    expect(seen.n).toEqual({ s0: 1, s1: 1, s2: 1 });
    expect(view.placements.map((p) => p.endReason)).toEqual(["failed"]); // no box made just to refuse it
  });

  it("a planned move saves the workspace first, so nothing is replayed", async () => {
    const c = clock();
    const seen = runs();
    const a = shell({ id: "a", capabilities: [], execHook: (_id, cmd) => (seen.see(cmd), void (cmd.includes("#s0") && c.advance(30_000))) });
    const { store, jobs } = setup([a], { c });
    const put = vi.spyOn(store, "put");
    const view = await jobs.run({
      sandbox: { timeoutSec: 60 },
      policy: { checkpoint: "on-migrate", defaultStepTimeoutSec: 30, deadlineMarginSec: 10 },
      steps: [{ run: "echo one > a.txt #s0" }, { run: "cat a.txt #s1" }],
    });
    expect(view.state).toBe("succeeded");
    expect(view.placements.map((p) => p.endReason)).toEqual(["deadline", "finished"]);
    expect(put).toHaveBeenCalledTimes(1);
    expect(seen.n).toEqual({ s0: 1, s1: 1 });
    expect(view.results[1]!.stdoutTail).toBe("one\n");
  });
});

describe("waiting for capacity", () => {
  it("waits while every provider is rate limited, then places once the mark lapses", async () => {
    const { r, c, jobs } = setup([shell({ id: "a" })]);
    await r.markFromError("a", new SandboxRouterError("rate_limit", "too many sandboxes", "a"));
    const started = c.now();
    const rec = recorder();
    const view = await jobs.run({ steps: [{ run: "echo hi" }] }, { onEvent: rec.onEvent });
    expect(view.state).toBe("succeeded");
    expect(rec.of("waiting").map((e) => e.delayMs)).toEqual([15_000, 15_000, 15_000, 15_000]);
    expect(c.now() - started).toBe(60_000);
  });

  it("gives up at once, with every provider's reason, when nothing frees up before maxWaitSec", async () => {
    const { r, c, jobs } = setup([shell({ id: "a" })]);
    await r.markFromError("a", new SandboxRouterError("rate_limit", "too many sandboxes", "a")); // lapses in 60 s
    const started = c.now();
    const rec = recorder();
    const view = await jobs.run({ policy: { maxWaitSec: 20 }, steps: [{ run: "echo hi" }] }, { onEvent: rec.onEvent });
    expect(view.state).toBe("failed");
    expect(view.error).toMatch(/No sandbox provider could take this request[\s\S]*a: skipped \(too many sandboxes/);
    expect(view.error).toMatch(/nothing frees up within maxWaitSec \(20 s\)/);
    expect(rec.of("waiting")).toEqual([]);
    expect(c.now()).toBe(started);
    expect(view.placements).toEqual([]);
  });

  it("fails at once when waiting can't help: no provider could ever take the request", async () => {
    const { c, jobs } = setup([shell({ id: "a" })]);
    const started = c.now();
    const rec = recorder();
    const view = await jobs.run({ sandbox: { needs: ["gpu"] }, steps: [{ run: "echo hi" }] }, { onEvent: rec.onEvent });
    expect(view.state).toBe("failed");
    expect(view.error).toMatch(/a: skipped \(lacks gpu\)/);
    expect(rec.of("waiting")).toEqual([]);
    expect(c.now()).toBe(started);
  });

  it("a full free tier: polls while someone else's sandbox holds the slot, and places once it's killed", async () => {
    const { r, c, store } = setup([shell({ id: "a", concurrency: 1 })]);
    // Someone else's 15-minute sandbox holds the only free slot, past maxWaitSec (300 s)...
    const other = await r.create({ timeoutSec: 900 });
    let waits = 0;
    // ...and is killed during the fourth wait (in the sleep, so the kill finishes before the next try).
    const jobs = new JobManager(r, { store, ownerId: "runner-1", sleep: async (ms) => (c.advance(ms), ++waits === 4 && (await other.kill())) });
    const started = c.now();
    const rec = recorder();
    const view = await jobs.run({ steps: [{ run: "echo hi" }] }, { onEvent: rec.onEvent });
    expect(view.error).toBeUndefined();
    expect(view.state).toBe("succeeded");
    expect(rec.of("waiting").map((e) => e.delayMs)).toEqual([5_000, 5_000, 5_000, 5_000]);
    expect(c.now() - started).toBe(20_000);
  });
});

describe("knowing the job while it runs", () => {
  it("onClaimed hands over the job as soon as it is recorded and claimed, before any box exists", async () => {
    const { jobs } = setup([shell({ id: "a" })]);
    const claimed: JobView[] = [];
    const view = await jobs.run({ steps: [{ run: "echo hi" }] }, { onClaimed: (v) => void claimed.push(v) });
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({ id: view.id, state: "placing", placements: [] });
    expect(view.state).toBe("succeeded");
  });

  it("resume calls onClaimed only once the claim went through", async () => {
    const { jobs } = setup([shell({ id: "a" })]);
    const queued = await jobs.submit({ steps: [{ run: "echo hi" }] });
    const claimed: string[] = [];
    await jobs.resume(queued.id, { onClaimed: (v) => void claimed.push(v.state) });
    expect(claimed).toEqual(["placing"]);
  });

  /** Starts a resume and keeps how it settled: its view, or the error it was refused with. */
  const settle = (p: Promise<JobView>) => p.then((view) => ({ view }), (error: unknown) => ({ error }));

  it("resuming a job that just ended returns how it ended, though its drive here is still cleaning up", async () => {
    const { jobs } = setup([shell({ id: "a" })]);
    let id = "";
    let resumed: Promise<{ view?: JobView; error?: unknown }> | undefined;
    const view = await jobs.run(
      { steps: [{ run: "echo hi" }] },
      {
        onClaimed: (v) => void (id = v.id),
        // Sent once the end is recorded, before the box is killed and the archives pruned.
        onEvent: (e) => void (e.type === "succeeded" && (resumed = settle(jobs.resume(id)))),
      },
    );
    expect(view.state).toBe("succeeded");
    const outcome = await resumed;
    expect(outcome?.error).toBeUndefined();
    expect(outcome?.view).toMatchObject({ id, state: "succeeded" });
  });

  it("a process won't claim a job it is still driving, even after the lease lapsed during a long call", async () => {
    const { c, jobs } = setup([shell({ id: "a" })]);
    let id = "";
    let resumed: Promise<{ view?: JobView; error?: unknown }> | undefined;
    const view = await jobs.run(
      { steps: [{ run: "echo one" }, { run: "echo two" }] },
      {
        onClaimed: (v) => void (id = v.id),
        onEvent: (e) => {
          if (e.type !== "stepStarted" || e.step !== 1 || resumed) return;
          c.advance(61_000);
          resumed = settle(jobs.resume(id));
        },
      },
    );
    const outcome = await resumed;
    expect(outcome?.error).toBeInstanceOf(ConflictError);
    expect(String(outcome?.error)).toMatch(/already being driven by this process/);
    expect(view.state).toBe("succeeded");
  });
});

describe("ownership and takeover", () => {
  /** Runs a job whose first runner dies at the write `crash` picks; returns the orphan-to-be. */
  async function crashed(steps: StepSpec[], crash: (ledger: CrashingLedger) => void) {
    const seen = runs();
    const ledger = new CrashingLedger();
    const env = setup([shell({ id: "a", execHook: (_id, cmd) => void seen.see(cmd) })], { ledger });
    crash(ledger);
    await expect(env.jobs.run({ steps })).rejects.toThrow("simulated crash");
    const [job] = await env.jobs.list();
    return { ...env, seen, job: job! };
  }

  /** The first runner dies after starting step 1, before its success is saved. */
  const crashMidStep = async (step1: StepSpec) => {
    const env = await crashed([{ run: "echo one > a.txt #s0" }, step1, { run: "cat a.txt b.txt #s2" }], (l) => (l.crashBefore = (j) => j.cursor === 2));
    expect(env.job).toMatchObject({ state: "running", cursor: 1 });
    return { ...env, id: env.job.id };
  };

  it("a second runner can't claim a job while the first one's lease is live; after it lapses the step in flight runs again on a new box", async () => {
    const { manager, r, c, seen, id } = await crashMidStep({ run: "echo two >> b.txt #s1" });
    const second = manager("runner-2");
    await expect(second.resume(id)).rejects.toBeInstanceOf(ConflictError);

    c.advance(61_000);
    expect((await second.get(id))!.state).toBe("orphaned");
    const view = await second.resume(id);
    expect(view.state).toBe("succeeded");
    expect(seen.n).toEqual({ s0: 1, s1: 2, s2: 1 });
    // The re-run started from the checkpoint before it: b.txt has one line, not two.
    expect(view.results[2]!.stdoutTail).toBe("one\ntwo\n");
    // A copy of the step might still have been running on the old box, so it was retired.
    expect(view.placements.map((p) => p.endReason)).toEqual(["orphaned", "finished"]);
    expect((await r.get(view.placements[0]!.sandboxId))!.state).toBe("stopped");
    expect(view.history.some((h) => h.type === "claim" && /took over/.test(h.detail ?? ""))).toBe(true);
  });

  it("an orphaned box doesn't count against its provider: the next box goes back to the provider ranked first", async () => {
    const ledger = new CrashingLedger();
    const env = setup([shell({ id: "a" }), shell({ id: "b" })], { ledger, config: { providers: { a: { priority: 1 } } } });
    ledger.crashBefore = (j) => j.cursor === 2;
    await expect(env.jobs.run({ steps: [{ run: "echo one > a.txt" }, { run: "echo two > b.txt" }, { run: "cat a.txt b.txt" }] })).rejects.toThrow("simulated crash");
    const [job] = await env.jobs.list();
    env.c.advance(61_000);
    const view = await env.manager("runner-2").resume(job!.id);
    expect(view.state).toBe("succeeded");
    // Had the takeover counted as the provider's failure ("unhealthy"), the job would have moved to b.
    expect(view.placements.map((p) => [p.provider, p.endReason])).toEqual([
      ["a", "orphaned"],
      ["a", "finished"],
    ]);
  });

  it("a runner that died between a retry and its restore: the next owner restores before running the step", async () => {
    // Appends to the workspace and passes on its second run (the counter lives outside the workdir).
    const flaky = 'echo x >> log.txt; n=$(cat "$HOME/n" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$HOME/n"; [ "$n" -ge 2 ] #s1';
    const steps: StepSpec[] = [{ run: "echo base > log.txt #s0" }, { run: flaky, retries: 1 }, { run: "cat log.txt #s2" }];
    const { manager, c, seen, job } = await crashed(steps, (l) => (l.crashAfter = (j) => j.attempts["1"]?.exitFailures === 1));
    expect(job).toMatchObject({ state: "running", cursor: 1 });

    c.advance(61_000);
    const view = await manager("runner-2").resume(job.id);
    expect(view.state).toBe("succeeded");
    expect(seen.n).toEqual({ s0: 1, s1: 2, s2: 1 });
    expect(view.results[2]!.stdoutTail).toBe("base\nx\n");
    expect(view.placements).toHaveLength(1); // nothing was in flight: the box was safe to keep
  });

  it("a step in flight that isn't idempotent fails the job instead of running twice", async () => {
    const { manager, r, c, seen, id } = await crashMidStep({ run: "echo two >> b.txt #s1", idempotent: false });
    c.advance(61_000);
    const view = await manager("runner-2").resume(id);
    expect(view.state).toBe("failed");
    expect(view.error).toMatch(/outcome is unknown and it isn't idempotent/);
    expect(seen.n).toEqual({ s0: 1, s1: 1 });
    expect((await r.get(view.placements[0]!.sandboxId))!.state).toBe("stopped");
  });

  it("the sweep resumes orphaned jobs in the background", async () => {
    const { manager, c, id } = await crashMidStep({ run: "echo two >> b.txt #s1" });
    const sweeper = manager("sweeper");
    const resume = vi.spyOn(sweeper, "resume");
    expect(await sweeper.sweep({ resumeOrphans: true })).toEqual({ reaped: 0, resumed: 0 }); // lease still live
    c.advance(61_000);
    expect(await sweeper.sweep({ resumeOrphans: true })).toEqual({ reaped: 0, resumed: 1 });
    const view = await (resume.mock.results[0]!.value as Promise<JobView>);
    expect(view).toMatchObject({ id, state: "succeeded" });
  });

  it("an orphaned placing job: the new owner kills the box the old one never recorded, then places", async () => {
    const { r, c, jobs } = setup([shell({ id: "a" })]);
    const id = "job_orphan1";
    const now = c.now();
    const lease = { owner: "dead-runner", until: new Date(now + 30_000).toISOString() };
    const placing = transitionJob(newJob(id, { steps: [{ run: "echo done > out.txt" }, { run: "cat out.txt" }] }, now), { type: "claim", lease }, now, "dead-runner");
    const stray = await r.create({ metadata: { [TAG]: id } });
    await r.ledger.update((d) => {
      d.jobs[id] = placing;
    });

    c.advance(31_000);
    expect((await jobs.get(id))!.state).toBe("orphaned");
    const view = await jobs.resume(id);
    expect(view.state).toBe("succeeded");
    expect(view.results[1]!.stdoutTail).toBe("done\n");
    expect(view.placements.map((p) => p.sandboxId)).not.toContain(stray.id);
    expect((await r.get(stray.id))!.state).toBe("stopped");
  });

  it.each([
    ["killed by someone outside the job", "stopped", "a"],
    ["paused outside the job", "stopped", "a"],
    ["past its deadline", "deadline", "a"],
    ["gone at the provider", "lost", "b"],
  ] as const)("a box %s while its runner was away: the job moves (%s), and only a lost box sends it to another provider", async (how, reason, next) => {
    const ledger = new CrashingLedger();
    const a = shell({ id: "a" });
    const env = setup([a, shell({ id: "b" })], { ledger, config: { providers: { a: { priority: 1 } } } });
    ledger.crashBefore = (j) => j.cursor === 2;
    await expect(env.jobs.run({ steps: [{ run: "echo one > a.txt" }, { run: "echo two > b.txt" }, { run: "cat a.txt b.txt" }] })).rejects.toThrow("simulated crash");
    const [job] = await env.jobs.list();
    const box = job!.sandboxId!;
    if (how === "killed by someone outside the job") await env.r.kill(box);
    else if (how === "paused outside the job") await env.r.apply(box, { type: "paused" });
    else if (how === "past its deadline") env.c.advance(3_600_000);
    else await a.lose(a.created[0]!).then(() => env.r.markGone(box));

    env.c.advance(61_000);
    const view = await env.manager("runner-2").resume(job!.id);
    expect(view.state).toBe("succeeded");
    expect(view.placements.map((p) => [p.provider, p.endReason])).toEqual([
      ["a", reason],
      [next, "finished"],
    ]);
    expect(view.results[2]!.stdoutTail).toBe("one\ntwo\n");
  });
});

describe("an owner that stalls past its lease and wakes after a takeover", () => {
  it("doesn't wipe the workspace its successor now uses, restoring it for a retry", async () => {
    // Fails its first run and passes after (the counter lives outside the workdir).
    const flaky = 'n=$(cat "$HOME/n" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$HOME/n"; [ "$n" -ge 2 ]';
    const a = shell({ id: "a" });
    const { r, c, jobs } = setup([a]);
    let id = "";
    let takeover: Promise<void> | undefined;
    const run = jobs.run(
      { steps: [{ run: "echo one > a.txt" }, { run: flaky, retries: 1 }] },
      {
        onClaimed: (v) => void (id = v.id),
        onEvent: (e) => {
          if (e.type !== "retrying" || takeover) return;
          // Runner 1 stalls between recording the retry and restoring the workspace for it, and
          // runner 2 starts the step on the same box.
          takeover = takeOver(r, c, id, [{ type: "stepStarted", step: 1 }]);
          writeFileSync(join(a.dirs.get(a.created[0]!)!, "work", "theirs.txt"), "runner 2 at work\n");
        },
      },
    );
    await expect(run).rejects.toBeInstanceOf(ConflictError);
    await takeover;
    expect(readFileSync(join(a.dirs.get(a.created[0]!)!, "work", "theirs.txt"), "utf8")).toBe("runner 2 at work\n");
    expect(a.killed).toEqual([]);
  });

  it("doesn't wipe the workspace its successor now uses, writing the initial files on a box it was preparing", async () => {
    let id = "";
    let takeover: Promise<void> | undefined;
    const a: LocalShell = shell({
      id: "a",
      execHook: (box, cmd) => {
        if (!cmd.includes("#setup") || takeover) return undefined;
        // Runner 1 stalls during setup, and runner 2 prepares the box and starts step 0 there.
        takeover = takeOver(env.r, env.c, id, [{ type: "prepared", cursor: 0 }, { type: "stepStarted", step: 0 }]);
        writeFileSync(join(a.dirs.get(box)!, "work", "theirs.txt"), "runner 2 at work\n");
        return undefined;
      },
    });
    const env = setup([a]);
    const run = env.jobs.run({ files: { "in.txt": "hi\n" }, setup: [{ run: "true #setup" }], steps: [{ run: "cat in.txt" }] }, { onClaimed: (v) => void (id = v.id) });
    await expect(run).rejects.toBeInstanceOf(ConflictError);
    await takeover;
    expect(readFileSync(join(a.dirs.get(a.created[0]!)!, "work", "theirs.txt"), "utf8")).toBe("runner 2 at work\n");
    expect(a.killed).toEqual([]);
  });

  it("doesn't delete the newer archive its successor recorded, pruning old ones after a checkpoint", async () => {
    const a = shell({ id: "a" });
    const { r, c, store, jobs } = setup([a]);
    let id = "";
    let takeover: Promise<unknown> | undefined;
    const theirs = new TextEncoder().encode("runner 2's workspace after step 1");
    const run = jobs.run(
      { steps: [{ run: "echo one > a.txt" }, { run: "echo two >> a.txt" }, { run: "cat a.txt" }] },
      {
        onClaimed: (v) => void (id = v.id),
        onEvent: (e) => {
          if (e.type !== "checkpointed" || takeover) return;
          // Runner 1 stalls between recording step 0's archive and pruning the others, and runner 2
          // runs step 1 and records its own archive.
          c.advance(61_000);
          const put = store.put(id, 1, theirs);
          takeover = r.ledger.update(async (d) => {
            const now = c.now();
            const checkpoint = await put;
            const result = { step: 1, exitCode: 0, sandboxId: "sbr_theirs", provider: "a", startedAt: iso(now), endedAt: iso(now), stdoutTail: "", stderrTail: "" };
            let job = transitionJob(d.jobs[id]!, { type: "claim", lease: { owner: "runner-2", until: iso(now + 60_000) } }, now, "runner-2");
            job = transitionJob(job, { type: "stepStarted", step: 1 }, now, "runner-2");
            d.jobs[id] = transitionJob(job, { type: "stepSucceeded", result, checkpoint }, now, "runner-2");
          });
        },
      },
    );
    await expect(run).rejects.toBeInstanceOf(ConflictError);
    await takeover;
    const job = (await r.ledger.read()).jobs[id]!;
    expect(job.checkpoint?.step).toBe(1);
    expect(await store.get(id, job.checkpoint!)).toEqual(theirs);
  });

  it("doesn't kill the box its successor just placed, reaping strays before placing its own", async () => {
    const seen = runs();
    const ledger = new StallingLedger();
    const a = loseOnce("#s1", seen);
    const { r, c, jobs } = setup([a], { ledger });
    let id = "";
    let theirs = "";
    // Runner 1 stalls right after leaving its lost box, before it places the next one...
    ledger.stallAfter = (j) => j.state === "placing" && j.migrations === 1;
    ledger.meanwhile = async () => {
      // ...and runner 2 claims the job and places a box of its own, tagged with the job.
      await takeOver(r, c, id);
      theirs = (await r.create({ metadata: { [TAG]: id } })).id;
      await r.ledger.update((d) => {
        d.jobs[id] = transitionJob(d.jobs[id]!, { type: "placed", box: { sandboxId: theirs, provider: "a", placedAt: iso(c.now()) } }, c.now(), "runner-2");
      });
    };
    const run = jobs.run({ steps: [{ run: "echo one > a.txt #s0" }, { run: "echo two >> a.txt #s1" }] }, { onClaimed: (v) => void (id = v.id) });
    await expect(run).rejects.toBeInstanceOf(ConflictError);
    expect(theirs).not.toBe("");
    expect((await r.get(theirs))!.state).toBe("running");
    // Runner 1 made no box after it woke up, either.
    expect(a.created).toHaveLength(2);
  });
});

describe("cancel and sweep", () => {
  it("cancel while a step runs: the runner stops at its next write, the box is killed, later steps never run", async () => {
    const seen = runs();
    const { r, jobs } = setup([shell({ id: "a", execHook: (_id, cmd) => void seen.see(cmd) })]);
    const { id } = await jobs.submit({ steps: [{ run: "echo one #s0" }, { run: "echo two #s1" }, { run: "echo three #s2" }] });
    let cancelled: Promise<JobView> | undefined;
    const rec = recorder();
    const view = await jobs.resume(id, {
      onEvent: (e) => {
        rec.onEvent(e);
        if (e.type === "stepStarted" && e.step === 1) cancelled = jobs.cancel(id);
      },
    });
    expect(view.state).toBe("cancelled");
    expect((await cancelled)!.state).toBe("cancelled");
    expect(rec.events.at(-1)).toEqual({ type: "cancelled" });
    expect(seen.n.s2).toBeUndefined();
    expect(view.placements[0]!.endReason).toBe("cancelled");
    expect((await r.get(view.placements[0]!.sandboxId))!.state).toBe("stopped");
  });

  it("cancel while placing: the box created meanwhile is killed, since the job never recorded it", async () => {
    const a = shell({ id: "a" });
    const { r, c, jobs } = setup([a]);
    const now = c.now();
    await r.ledger.update((d) => {
      d.marks.push({ provider: "a", kind: "rate_limit", at: new Date(now).toISOString(), until: new Date(now + 10_000).toISOString() });
    });
    const { id } = await jobs.submit({ steps: [{ run: "echo hi" }] });
    let cancelled: Promise<JobView> | undefined;
    const view = await jobs.resume(id, { onEvent: (e) => void (e.type === "waiting" && (cancelled ??= jobs.cancel(id))) });
    expect(view.state).toBe("cancelled");
    expect((await cancelled)!.placements).toEqual([]);
    expect(a.created).toHaveLength(1); // made after the cancel, during the wait
    expect((await r.list()).filter((s) => s.state === "running")).toEqual([]);
  });

  it("cancelling a queued job ends it; resuming it then returns how it ended", async () => {
    const { jobs } = setup([shell({ id: "a" })]);
    const { id } = await jobs.submit({ steps: [{ run: "true" }] });
    expect((await jobs.cancel(id)).state).toBe("cancelled");
    expect((await jobs.resume(id)).state).toBe("cancelled");
    expect(await jobs.list()).toEqual([]);
    expect((await jobs.list({ all: true })).map((j) => j.state)).toEqual(["cancelled"]);
  });

  it("the sweep reaps a box a finished job left alive, and boxes tagged with a job that never recorded them", async () => {
    const ledger = new CrashingLedger();
    const a = shell({ id: "a" });
    const { r, jobs } = setup([a], { ledger });
    // The runner records the end, then dies before it kills the box.
    ledger.crashAfter = (j) => j.state === "succeeded";
    await expect(jobs.run({ steps: [{ run: "true" }] })).rejects.toThrow("simulated crash");
    const [job] = await jobs.list({ all: true });
    expect(job!.state).toBe("succeeded");
    const box = job!.placements[0]!.sandboxId;
    expect((await r.get(box))!.state).toBe("running");
    const stray = await r.create({ metadata: { [TAG]: job!.id } });

    expect(await jobs.sweep()).toEqual({ reaped: 2, resumed: 0 });
    expect((await r.get(box))!.state).toBe("stopped");
    expect((await r.get(stray.id))!.state).toBe("stopped");
    expect(a.killed).toHaveLength(2);
    expect(await jobs.sweep()).toEqual({ reaped: 0, resumed: 0 });
  });
});
