import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkJobSpec,
  currentBox,
  effectiveJobState,
  InvalidJobTransitionError,
  newJob,
  transitionJob,
  validateJob,
} from "../src/core/jobs/state.js";
import type { Box, CheckpointRef, JobEvent, JobRecord, StepResult } from "../src/core/jobs/types.js";
import { ConflictError } from "../src/core/errors.js";
import { FileLedger } from "../src/core/ledger.js";

const T0 = Date.UTC(2026, 10, 11, 12);
const ME = "host:1:aaa";
const OTHER = "host:2:bbb";
const lease = (owner: string, until = T0 + 60_000) => ({ owner, until: new Date(until).toISOString() });
const box = (n: number, provider = "p"): Box => ({ sandboxId: `sbr_${n}`, provider, lane: "free-recurring", placedAt: new Date(T0).toISOString() });
const result = (step: number, sandboxId = "sbr_1"): StepResult => ({
  step,
  exitCode: 0,
  sandboxId,
  provider: "p",
  startedAt: new Date(T0).toISOString(),
  endedAt: new Date(T0).toISOString(),
  stdoutTail: "",
  stderrTail: "",
});
const ckpt = (step: number): CheckpointRef => ({ key: `${step}-abc`, sha256: "abc", bytes: 10, step, at: new Date(T0).toISOString() });

/** Applies events as `actor`, checking every intermediate record against the invariants. */
function run(rec: JobRecord, events: JobEvent[], actor = ME, now = T0): JobRecord {
  for (const ev of events) {
    rec = transitionJob(rec, ev, now, actor);
    expect(validateJob(rec)).toBeUndefined();
  }
  return rec;
}

const spec = { steps: [{ run: "echo a" }, { run: "echo b" }] };
const running = () => run(newJob("job_1", spec, T0), [{ type: "claim", lease: lease(ME) }, { type: "placed", box: box(1) }, { type: "prepared", cursor: 0 }]);

describe("job lifecycle", () => {
  it("queued → placing → preparing → running → succeeded, with a checkpoint per step", () => {
    let rec = running();
    expect(rec.state).toBe("running");
    rec = run(rec, [
      { type: "stepStarted", step: 0 },
      { type: "stepSucceeded", result: result(0), checkpoint: ckpt(0) },
      { type: "stepStarted", step: 1 },
      { type: "stepSucceeded", result: result(1), checkpoint: ckpt(1) },
      { type: "succeed" },
    ]);
    expect(rec.state).toBe("succeeded");
    expect(rec.cursor).toBe(2);
    expect(rec.checkpoint?.step).toBe(1);
    expect(rec.placements).toEqual([expect.objectContaining({ sandboxId: "sbr_1", endReason: "finished" })]);
    expect(rec.version).toBe(9);
    expect(rec.history.map((h) => h.type)).toEqual(["submitted", "claim", "placed", "prepared", "stepStarted", "stepSucceeded", "stepStarted", "stepSucceeded", "succeed"]);
  });

  it("a migration closes the old placement, counts the move, and keeps the checkpoint", () => {
    let rec = run(running(), [{ type: "stepStarted", step: 0 }, { type: "stepSucceeded", result: result(0), checkpoint: ckpt(0) }, { type: "stepStarted", step: 1 }]);
    rec = run(rec, [{ type: "migrate", reason: "lost", detail: "404" }]);
    expect(rec.state === "migrating" && rec.box?.sandboxId).toBe("sbr_1");
    expect(currentBox(rec)?.sandboxId).toBe("sbr_1");
    rec = run(rec, [{ type: "left" }]);
    expect(rec.state).toBe("placing");
    expect(rec.migrations).toBe(1);
    expect(rec.placements[0]).toMatchObject({ endReason: "lost" });
    rec = run(rec, [{ type: "placed", box: box(2) }, { type: "prepared", cursor: 1 }, { type: "stepStarted", step: 1 }]);
    // The step that was in flight when the box died is attempted a second time.
    expect(rec.state === "running" && rec.inFlight).toMatchObject({ step: 1, attempt: 2, sandboxId: "sbr_2" });
    expect(rec.attempts["1"]).toEqual({ total: 2, exitFailures: 0 });
  });

  it("prepared rewinds to just after the checkpoint and drops results past it", () => {
    let rec = run(running(), [
      { type: "stepStarted", step: 0 },
      { type: "stepSucceeded", result: result(0), checkpoint: ckpt(0) },
      { type: "stepStarted", step: 1 },
      { type: "stepSucceeded", result: result(1) }, // noCheckpoint step: the checkpoint still holds step 0
      { type: "migrate", reason: "lost" },
      { type: "left" },
      { type: "placed", box: box(2) },
    ]);
    expect(rec.cursor).toBe(2);
    expect(() => transitionJob(rec, { type: "prepared", cursor: 2 }, T0, ME)).toThrow(/continue after the checkpoint, at 1/);
    rec = run(rec, [{ type: "prepared", cursor: 1 }]);
    expect(rec.cursor).toBe(1);
    expect(rec.results).toHaveLength(1);
    expect(rec.history.at(-1)?.detail).toMatch(/rewound from step 2 to 1/);
  });

  it("a rewind starts over the attempts of the steps it replays, since they had succeeded; the step that was running keeps its count", () => {
    const three = { steps: [{ run: "echo a" }, { run: "echo b" }, { run: "echo c" }] };
    const rec = run(newJob("job_1", three, T0), [
      { type: "claim", lease: lease(ME) },
      { type: "placed", box: box(1) },
      { type: "prepared", cursor: 0 },
      { type: "stepStarted", step: 0 },
      { type: "stepSucceeded", result: result(0) },
      { type: "stepStarted", step: 1 },
      { type: "stepRetry", reason: "exit 1", exit: true },
      { type: "stepStarted", step: 1 },
      { type: "stepSucceeded", result: result(1) },
      { type: "stepStarted", step: 2 },
      // No checkpoint (on-migrate): the next box starts over from step 0.
      { type: "migrate", reason: "lost" },
      { type: "left" },
      { type: "placed", box: box(2) },
      { type: "prepared", cursor: 0 },
    ]);
    expect(rec.attempts).toEqual({ "2": { total: 1, exitFailures: 0 } });
  });

  it("exit-code retries are counted apart from attempts", () => {
    const rec = run(running(), [{ type: "stepStarted", step: 0 }, { type: "stepRetry", reason: "exit 1", exit: true }, { type: "stepStarted", step: 0 }]);
    expect(rec.attempts["0"]).toEqual({ total: 2, exitFailures: 1 });
  });

  it("refuses moves the table does not allow", () => {
    const queued = newJob("job_1", spec, T0);
    expect(() => transitionJob(queued, { type: "placed", box: box(1) }, T0, ME)).toThrow(InvalidJobTransitionError);
    const rec = running();
    expect(() => transitionJob(rec, { type: "stepStarted", step: 1 }, T0, ME)).toThrow(/next step is 0/);
    expect(() => transitionJob(rec, { type: "succeed" }, T0, ME)).toThrow(/2 step\(s\) left/);
    expect(() => transitionJob(rec, { type: "stepSucceeded", result: result(0) }, T0, ME)).toThrow(/no step is in flight/);
    const started = run(rec, [{ type: "stepStarted", step: 0 }]);
    expect(() => transitionJob(started, { type: "stepSucceeded", result: result(0), checkpoint: ckpt(1) }, T0, ME)).toThrow(/checkpoint must be of the step/);
    expect(() => transitionJob(started, { type: "checkpointed", checkpoint: ckpt(0) }, T0, ME)).toThrow(/in flight/);
    const failed = run(rec, [{ type: "fail", error: "boom" }]);
    expect(() => transitionJob(failed, { type: "cancel" }, T0)).toThrow(InvalidJobTransitionError);
  });

  it("refuses a checkpoint before any step ran (it would hold step -1, which no ledger load accepts)", () => {
    const rec = running();
    expect(() => transitionJob(rec, { type: "checkpointed", checkpoint: ckpt(-1) }, T0, ME)).toThrow(/no step has run/);
  });
});

describe("job ownership", () => {
  it("only the lease holder may move an active job", () => {
    const rec = running();
    expect(() => transitionJob(rec, { type: "stepStarted", step: 0 }, T0, OTHER)).toThrow(ConflictError);
    expect(() => transitionJob(rec, { type: "renew", until: new Date(T0 + 120_000).toISOString() }, T0, OTHER)).toThrow(ConflictError);
  });

  it("a live lease can't be claimed; a lapsed one can, keeping the box and the step in flight", () => {
    const rec = run(running(), [{ type: "stepStarted", step: 0 }]);
    expect(() => transitionJob(rec, { type: "claim", lease: lease(OTHER, T0 + 120_000) }, T0 + 1000, OTHER)).toThrow(ConflictError);
    expect(effectiveJobState(rec, T0 + 59_999)).toBe("running");
    expect(effectiveJobState(rec, T0 + 60_000)).toBe("orphaned");
    const taken = transitionJob(rec, { type: "claim", lease: lease(OTHER, T0 + 180_000) }, T0 + 120_000, OTHER);
    expect(taken.state).toBe("running");
    expect(taken.state === "running" && taken.inFlight?.step).toBe(0);
    expect(taken.history.at(-1)?.detail).toMatch(/took over from host:1:aaa/);
    // The old owner's next write is refused: it must stop without touching the box.
    expect(() => transitionJob(taken, { type: "stepRetry", reason: "x", exit: false }, T0 + 121_000, ME)).toThrow(ConflictError);
  });

  it("the holder can still write after its lease lapsed if nobody claimed it, and renew it", () => {
    const rec = running();
    const later = T0 + 90_000;
    const renewed = transitionJob(rec, { type: "renew", until: new Date(later + 60_000).toISOString() }, later, ME);
    expect(effectiveJobState(renewed, later)).toBe("running");
    expect(renewed.history).toHaveLength(rec.history.length); // renewals aren't logged
  });

  it("anyone may cancel; anyone may fail a queued or orphaned job, but not a live one", () => {
    expect(transitionJob(running(), { type: "cancel" }, T0).state).toBe("cancelled");
    expect(transitionJob(newJob("job_1", spec, T0), { type: "fail", error: "bad spec" }, T0).state).toBe("failed");
    expect(() => transitionJob(running(), { type: "fail", error: "x" }, T0, OTHER)).toThrow(ConflictError);
    expect(transitionJob(running(), { type: "fail", error: "x" }, T0 + 61_000, OTHER).state).toBe("failed");
  });

  it("writes to a finished job are conflicts (someone else ended it)", () => {
    const cancelled = transitionJob(running(), { type: "cancel" }, T0);
    expect(() => transitionJob(cancelled, { type: "stepStarted", step: 0 }, T0, ME)).toThrow(ConflictError);
  });
});

describe("job records on disk", () => {
  it("the invariants catch impossible combinations", () => {
    const rec = running();
    expect(validateJob({ ...rec, cursor: 5 })).toMatch(/outside 0..2/);
    expect(validateJob({ ...rec, checkpoint: ckpt(0) })).toMatch(/ahead of cursor 0/);
    expect(validateJob({ ...rec, placements: [] })).toMatch(/one open placement/);
    const { box: _box, ...noBox } = rec as Extract<JobRecord, { state: "running" }>;
    expect(validateJob(noBox as JobRecord)).toMatch(/needs a box/);
    const failed = transitionJob(rec, { type: "fail", error: "x" }, T0, ME);
    expect(validateJob({ ...failed, placements: [{ ...box(1) }] })).toMatch(/cannot have an open placement/);
  });

  it("history is capped", () => {
    let rec = running();
    for (let i = 0; i < 150; i++) rec = run(rec, [{ type: "stepStarted", step: 0 }, { type: "stepRetry", reason: `try ${i}`, exit: false }]);
    expect(rec.history).toHaveLength(200);
    expect(rec.history.at(-1)?.detail).toBe("try 149");
  });

  it("checkJobSpec explains what's wrong with a request", () => {
    expect(checkJobSpec({ steps: [{ run: "make" }] })).toBeUndefined();
    expect(checkJobSpec(null)).toMatch(/spec object/);
    expect(checkJobSpec({ steps: "make" })).toMatch(/steps must be a list/);
    expect(checkJobSpec({ steps: [{ run: "" }] })).toMatch(/steps\[0\]\.run/);
    expect(checkJobSpec({ steps: [{ run: "x", timeoutSec: -1 }] })).toMatch(/positive/);
    expect(checkJobSpec({ steps: [{ run: "x" }], setup: [{}] })).toMatch(/setup\[0\]\.run/);
    expect(checkJobSpec({ steps: [{ run: "x" }], files: { "a.txt": 3 } })).toMatch(/must be a string/);
    expect(checkJobSpec({ steps: [] })).toMatch(/at least one step/);
    expect(checkJobSpec({ steps: [{ run: "x" }], sandbox: "e2b" })).toMatch(/sandbox must be/);
  });

  describe("a ledger written before jobs and health existed", () => {
    let dir: string;
    beforeAll(async () => {
      dir = await mkdtemp(join(tmpdir(), "sbr-oldledger-"));
    });
    afterAll(() => rm(dir, { recursive: true, force: true }));

    it("loads, keeps every old row, and gains the new fields on the next write", async () => {
      const path = join(dir, "ledger.json");
      // The shape v0.1.0 wrote: no `health`, no `jobs`, realistic records in every state.
      const old = {
        version: 1,
        marks: [{ provider: "e2b", kind: "quota", at: "2026-11-01T00:00:00.000Z", until: "2026-12-01T00:00:00.000Z", detail: "402" }],
        archivedUsd: { e2b: { "2026-08": 1.25 } },
        sandboxes: {
          sbr_a: {
            id: "sbr_a",
            provider: "modal",
            state: "running",
            cpu: 2,
            memoryMiB: 2048,
            createdAt: "2026-11-11T10:00:00.000Z",
            metadata: { "sandboxrouting.id": "sbr_a" },
            providerSandboxId: "sb-1",
            expiresAt: "2026-11-11T11:00:00.000Z",
            segments: [{ start: "2026-11-11T10:00:00.000Z" }],
          },
          sbr_b: {
            id: "sbr_b",
            provider: "e2b",
            state: "stopped",
            cpu: 2,
            memoryMiB: 512,
            createdAt: "2026-11-10T10:00:00.000Z",
            metadata: {},
            providerSandboxId: "e-1",
            segments: [{ start: "2026-11-10T10:00:00.000Z", end: "2026-11-10T10:05:00.000Z" }],
            endedAt: "2026-11-10T10:05:00.000Z",
            reason: "killed",
          },
          sbr_c: { id: "sbr_c", provider: "daytona", state: "failed", cpu: 1, memoryMiB: 1024, createdAt: "2026-11-09T10:00:00.000Z", metadata: {}, segments: [], endedAt: "2026-11-09T10:00:01.000Z", error: "402" },
        },
      };
      await writeFile(path, JSON.stringify(old));
      const ledger = new FileLedger(path);
      const data = await ledger.read();
      expect(data.jobs).toEqual({});
      expect(data.health).toEqual({});
      expect(Object.keys(data.sandboxes)).toEqual(["sbr_a", "sbr_b", "sbr_c"]);

      await ledger.update((d) => {
        d.jobs["job_1"] = newJob("job_1", spec, T0);
      });
      const after = JSON.parse(await (await import("node:fs/promises")).readFile(path, "utf8"));
      expect(after.sandboxes).toEqual(old.sandboxes);
      expect(after.marks).toEqual(old.marks);
      expect(after.archivedUsd).toEqual(old.archivedUsd);
      expect(after.health).toEqual({});
      expect(after.jobs.job_1.state).toBe("queued");
    });

    it("refuses a ledger whose job breaks the invariants", async () => {
      const path = join(dir, "badjob.json");
      const rec = running();
      await writeFile(path, JSON.stringify({ version: 1, sandboxes: {}, marks: [], archivedUsd: {}, health: {}, jobs: { job_1: { ...rec, cursor: 9 } } }));
      await expect(new FileLedger(path).read()).rejects.toThrow(/job job_1: cursor 9/);
    });
  });
});
