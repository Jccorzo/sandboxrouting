// Drives one job through its lifecycle (docs/routing.md §3). Every move goes through
// transitionJob inside a ledger update, so the lease check sits in the write: this file only
// decides which event to send next and does the work on the box in between.

import { posix } from "node:path";
import type { SandboxRouter } from "../router.js";
import { shellQuote, type Sandbox } from "../sandbox.js";
import type { ExecOptions, ExecResult, SandboxSpec } from "../types.js";
import type { LedgerData } from "../ledger.js";
import { jobPolicySchema, type JobPolicy } from "../config.js";
import { classify, ConflictError, NoProviderAvailableError, SandboxRouterError } from "../errors.js";
import { effectivePricing, freeStatus, ratePerSecond } from "../metering.js";
import { activeMarks } from "../marks.js";
import { providerHealth } from "../health.js";
import { effectiveState, isLive, type SandboxRecord } from "../state.js";
import { boxPaths, captureWorkspace, restoreWorkspace, writeInitialFiles, type BoxPaths } from "./checkpoint.js";
import { currentBox, isTerminal, transitionJob } from "./state.js";
import type {
  Box,
  CheckpointRef,
  CheckpointStore,
  JobEvent,
  JobRecord,
  JobRunOptions,
  JobSpec,
  MigrationReason,
  RunnerEvent,
  StepResult,
  StepSpec,
} from "./types.js";

/** Metadata key on every sandbox made for a job, so a takeover or the sweep can find strays. */
export const JOB_TAG = "sandboxrouting.job";

const TAIL = 4000;
/** Longest single wait while no provider can take the job, or while rate limited. */
const WAIT_STEP_MS = 15_000;
/** Wait between tries for capacity that may come back at any moment (a killed box's slot, a probe's result). */
const MIN_WAIT_MS = 5_000;
/** Transient errors are retried this many times on the same box before the job moves. */
const TRANSIENT_RETRIES = 2;
/**
 * Placements that ended like this make the next placement avoid their provider. The others
 * (deadline, stopped, orphaned, oom, rebalance) say nothing against it.
 */
const AVOID = new Set(["lost", "unhealthy", "provider-refused", "circuit-open", "prepare-failed", "free-credit"]);

type Running = Extract<JobRecord, { state: "running" }>;
type Preparing = Extract<JobRecord, { state: "preparing" }>;
type Migrating = Extract<JobRecord, { state: "migrating" }>;
type LiveSandbox = Extract<SandboxRecord, { state: "running" }>;

const iso = (ms: number) => new Date(ms).toISOString();
const tail = (s: string, n = TAIL) => (s.length > n ? s.slice(-n) : s);
const label = (k: number, step: StepSpec) => (step.name ? `${k} (${step.name})` : `${k}`);

/** The config's job defaults plus the job's own overrides. Computed on every drive, never stored. */
export function jobPolicy(router: SandboxRouter, spec: JobSpec): JobPolicy {
  const parsed = jobPolicySchema.partial().safeParse(spec.policy ?? {});
  if (!parsed.success) {
    throw new SandboxRouterError("invalid", `job policy: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
  }
  const own = Object.fromEntries(Object.entries(parsed.data).filter(([, v]) => v !== undefined));
  return { ...router.config.jobs, ...own };
}

/** A call on the box failed for good. The drive loop turns it into a move or a failure. */
class BoxFailure extends Error {
  constructor(
    readonly err: SandboxRouterError,
    what: string,
    /** How long the failing call ran. */
    readonly ms = 0,
  ) {
    super(`${what}: ${err.message}`);
    this.name = "BoxFailure";
  }
}

const gone = (box: Box) =>
  new BoxFailure(new SandboxRouterError("not_found", `box ${box.sandboxId} on ${box.provider} is gone`, box.provider), "checking the box");

export interface RunnerDeps {
  router: SandboxRouter;
  store: CheckpointStore;
  /** Every wait goes through this, so tests can drive a fake clock. */
  sleep: (ms: number) => Promise<void>;
  /** Lease owner id of this process. */
  owner: string;
}

export class JobRunner {
  private rec: JobRecord;
  private readonly policy: JobPolicy;
  private sbx?: Sandbox;
  private paths?: BoxPaths;
  /** The box this runner set up itself; its workspace is known to be clean. */
  private preparedHere?: string;
  /** The box this runner placed, when, and how many steps started on it since. */
  private placedHere?: { sandboxId: string; at: number; steps: number };
  /**
   * Room in a new box's life for getting it ready (connecting, restoring the workspace), on top
   * of setup and the step. Grows when a fresh box still came up short, so moves can't loop.
   */
  private prepareSec: number;
  private timer?: NodeJS.Timeout;
  private stopped = false;

  constructor(
    private readonly deps: RunnerDeps,
    /** A job this owner has just claimed. */
    rec: JobRecord,
    private readonly opts: JobRunOptions = {},
  ) {
    this.rec = rec;
    this.policy = jobPolicy(deps.router, rec.spec);
    this.prepareSec = this.policy.deadlineMarginSec;
  }

  private get id(): string {
    return this.rec.id;
  }

  private get spec(): JobSpec {
    return this.rec.spec;
  }

  private get router(): SandboxRouter {
    return this.deps.router;
  }

  private now(): number {
    return this.deps.router.now();
  }

  /**
   * Drives the job until it ends. Returns the final record; also when someone cancelled it
   * meanwhile. Throws ConflictError when another owner took it over: that owner has the box now.
   */
  async drive(): Promise<JobRecord> {
    this.startRenewing();
    try {
      while (!isTerminal(this.rec)) {
        try {
          await this.advance();
        } catch (err) {
          if (!(err instanceof BoxFailure)) throw err;
          await this.boxFailed(err);
        }
      }
      return this.rec;
    } catch (err) {
      if (err instanceof ConflictError) {
        // Someone else owns the job now, or ended it. Stop here and leave the box alone.
        const latest = (await this.router.ledger.read()).jobs[this.id];
        if (latest && isTerminal(latest)) {
          if (latest.state === "cancelled") this.emit({ type: "cancelled" });
          return latest;
        }
      }
      throw err;
    } finally {
      this.stopRenewing();
    }
  }

  private advance(): Promise<void> {
    switch (this.rec.state) {
      case "placing":
        return this.place();
      case "preparing":
        return this.prepare();
      case "running":
        return this.runSteps();
      case "migrating":
        return this.leave();
      default:
        throw new Error(`job ${this.id} is ${this.rec.state}; claim it before driving it`);
    }
  }

  // ------------------------------------------------------------------ writes and the lease

  /** The only way this runner changes the job: transitionJob under the ledger lock, as the lease holder. */
  private async write(ev: JobEvent): Promise<void> {
    await this.writeAndRead(ev, () => undefined);
  }

  /** `write`, returning what `read` finds in the same locked snapshot. */
  private async writeAndRead<T>(ev: JobEvent, read: (d: LedgerData) => T): Promise<T> {
    const { next, found } = await this.router.ledger.update((d) => {
      const cur = d.jobs[this.id];
      if (!cur) throw new SandboxRouterError("not_found", `no job ${this.id}`);
      const rec = transitionJob(cur, ev, this.now(), this.deps.owner);
      d.jobs[this.id] = rec;
      return { next: rec, found: read(d) };
    });
    // The renewal timer writes too; keep whichever record is newer.
    if (next.version > this.rec.version) this.rec = next;
    return found;
  }

  /**
   * Renews the lease under the lock right before work that would harm a box someone else may
   * now use: a kill, or the `rm -rf` of a restore. An owner that stalled past its lease and was
   * taken over gets a ConflictError here, and stops without touching the box.
   */
  private fence(): Promise<void>;
  private fence<T>(read: (d: LedgerData) => T): Promise<T>;
  private fence<T>(read?: (d: LedgerData) => T): Promise<T | undefined> {
    return this.writeAndRead(this.renewal(), (d) => read?.(d));
  }

  /** The lease, renewed from now. */
  private renewal(): JobEvent {
    return { type: "renew", until: iso(this.now() + this.policy.leaseSec * 1000) };
  }

  private startRenewing(): void {
    this.timer = setInterval(() => void this.renew().catch(() => undefined), (this.policy.leaseSec * 1000) / 3);
    this.timer.unref();
  }

  private stopRenewing(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }

  private async renew(): Promise<void> {
    if (this.stopped) return;
    await this.write(this.renewal());
  }

  /** Renews when a third of the lease has gone by. Called after waits, whose clock may be a test's. */
  private async renewIfDue(): Promise<void> {
    if (!("lease" in this.rec)) return;
    if (Date.parse(this.rec.lease.until) - this.now() < (this.policy.leaseSec * 2000) / 3) await this.renew();
  }

  private async wait(ms: number): Promise<void> {
    await this.deps.sleep(ms);
    await this.renewIfDue();
  }

  private emit(ev: RunnerEvent): void {
    try {
      this.opts.onEvent?.(ev);
    } catch {
      // A listener's bug must not stop the job.
    }
  }

  // ------------------------------------------------------------------ placing

  /**
   * placing: get a box from the router. When none can take the job, wait only if some reason
   * lapses before maxWaitSec runs out (a mark, a circuit, a full free tier), and only until then.
   */
  private async place(): Promise<void> {
    await this.reapStrays();
    const deadline = this.now() + this.policy.maxWaitSec * 1000;
    for (;;) {
      let sbx: Sandbox;
      try {
        sbx = await this.router.create(this.request());
      } catch (err) {
        if (!(err instanceof NoProviderAvailableError)) {
          if (err instanceof SandboxRouterError && err.kind === "invalid") return this.fail(err.message);
          throw err;
        }
        const now = this.now();
        const retryAt = err.retryAt;
        if (retryAt === undefined) return this.fail(err.message);
        if (retryAt > deadline || now >= deadline) {
          return this.fail(`${err.message}\nnothing frees up within maxWaitSec (${this.policy.maxWaitSec} s); the first change is at ${iso(retryAt)}`);
        }
        const delayMs = Math.min(WAIT_STEP_MS, Math.max(MIN_WAIT_MS, retryAt - now), deadline - now);
        this.emit({ type: "waiting", reason: err.message, delayMs });
        await this.wait(delayMs);
        continue;
      }
      const made = sbx.route.filter((a) => a.outcome === "created").at(-1);
      const box: Box = { sandboxId: sbx.id, provider: sbx.provider, lane: made?.lane ?? made?.detail, billing: made?.billing, placedAt: iso(this.now()) };
      try {
        await this.write({ type: "placed", box });
      } catch (err) {
        // The job never recorded this box, so no one else can be using it: it's ours to kill.
        await this.kill(sbx.id);
        throw err;
      }
      this.sbx = sbx;
      this.paths = undefined;
      this.placedHere = { sandboxId: box.sandboxId, at: this.now(), steps: 0 };
      this.emit({ type: "placed", provider: box.provider, sandboxId: box.sandboxId, lane: box.lane });
      return;
    }
  }

  /**
   * Live boxes tagged with this job while it has none: one a crashed owner created but never
   * recorded, or an old box whose kill failed. Killed before placing so none outlives the job.
   */
  private async reapStrays(): Promise<void> {
    // Found under the lock, behind a fence: from a plain read, an owner that stalled past its
    // lease would kill the box its successor just placed.
    const strays = await this.fence((d) => {
      const now = this.now();
      return Object.values(d.sandboxes).filter((s) => s.metadata[JOB_TAG] === this.id && s.state !== "creating" && isLive(s, now)).map((s) => s.id);
    });
    for (const id of strays) await this.kill(id);
  }

  /** The router request for this job's next box. */
  private request(): SandboxSpec {
    const sandbox = this.spec.sandbox ?? {};
    const longest = this.longestCommandSec();
    const avoid = new Set(sandbox.avoid ?? []);
    for (const p of this.rec.placements) if (p.endReason && AVOID.has(p.endReason)) avoid.add(p.provider);
    // A fresh box must outlive getting ready, setup, and its longest step with the margin a step
    // needs to start; with less, a provider that can't extend a deadline would send the job to a
    // new box (and a new setup) over and over.
    const setupSec = (this.spec.setup ?? []).reduce((sum, s) => sum + this.stepTimeoutSec(s), 0);
    const needSec = this.prepareSec + setupSec + this.longestStepSec() + this.policy.deadlineMarginSec;
    return {
      ...sandbox,
      timeoutSec: Math.max(sandbox.timeoutSec ?? this.router.config.defaults.timeoutSec, needSec),
      execTimeoutSec: Math.max(sandbox.execTimeoutSec ?? 0, longest),
      memoryMiB: this.rec.memoryMiB ?? sandbox.memoryMiB,
      metadata: { ...sandbox.metadata, [JOB_TAG]: this.id },
      avoid: [...avoid],
    };
  }

  /** Longest command the next box runs: setup, then the steps from where the workspace resumes. */
  private longestCommandSec(): number {
    return Math.max(0, ...(this.spec.setup ?? []).map((s) => this.stepTimeoutSec(s)), this.longestStepSec());
  }

  /** Longest step left from where the workspace resumes. */
  private longestStepSec(): number {
    const from = (this.rec.checkpoint?.step ?? -1) + 1;
    return Math.max(0, ...this.spec.steps.slice(from).map((s) => this.stepTimeoutSec(s)));
  }

  private stepTimeoutSec(step: StepSpec): number {
    return step.timeoutSec ?? this.policy.defaultStepTimeoutSec;
  }

  // ------------------------------------------------------------------ preparing

  /** preparing: setup, then the workspace from the last checkpoint (or the initial files). Idempotent. */
  private async prepare(): Promise<void> {
    const rec = this.rec as Preparing;
    const from = (rec.checkpoint?.step ?? -1) + 1;
    const replay = this.replayProblem(from);
    if (replay) return this.fail(replay);
    // Read first: when the saved workspace is unreadable, setting up the box is wasted work.
    const archive = rec.checkpoint ? await this.archive(rec.checkpoint) : undefined;
    const { sbx, paths } = await this.attach(rec.box);

    const setup = this.spec.setup ?? [];
    if (setup.length) {
      // Setup runs in the workdir by default, before the restore creates it.
      const r = await this.boxCall("creating the workdir", () => sbx.commands.run(`mkdir -p ${shellQuote(paths.workdir)}`));
      if (r.exitCode !== 0) return this.move("prepare-failed", `creating ${paths.workdir} exited ${r.exitCode}: ${tail(r.stderr, 300).trim()}`);
    }
    for (const [i, step] of setup.entries()) {
      const r = await this.boxCall(`setup ${label(i, step)}`, () => sbx.commands.run(step.run, this.execOptions(step, paths)));
      if (r.exitCode !== 0) {
        return this.move("prepare-failed", `setup ${label(i, step)} exited ${r.exitCode}: ${tail(r.stderr || r.stdout, 300).trim()}`);
      }
    }
    // Both start with `rm -rf` of the workdir, which a successor may be using by now.
    await this.fence();
    if (archive) await this.boxCall("restoring the workspace", () => restoreWorkspace(sbx, paths, archive));
    else await this.boxCall("writing the initial files", () => writeInitialFiles(sbx, paths, this.spec.files ?? {}));

    await this.write({ type: "prepared", cursor: from });
    this.preparedHere = rec.box.sandboxId;
    this.emit({ type: "prepared", fromStep: from, restored: Boolean(archive) });
  }

  /** Why continuing from step `from` is unsafe: it would run a step that isn't idempotent again. */
  private replayProblem(from: number): string | undefined {
    for (let i = from; i < this.rec.cursor; i++) {
      const step = this.spec.steps[i]!;
      if (step.idempotent === false) {
        return `continuing from the last checkpoint (step ${from}) would run step ${label(i, step)} again, and it isn't idempotent`;
      }
    }
    return undefined;
  }

  /** Connects to the job's box and finds its paths. Throws a BoxFailure when it's gone. */
  private async attach(box: Box): Promise<{ sbx: Sandbox; paths: BoxPaths }> {
    if (await this.goneReason(box)) throw gone(box);
    let sbx = this.sbx;
    if (sbx?.id !== box.sandboxId) {
      sbx = await this.boxCall("connecting to the box", () => this.router.connect(box.sandboxId));
      this.sbx = sbx;
      this.paths = undefined;
    }
    const on = sbx;
    this.paths ??= await this.boxCall("finding the workdir", () => boxPaths(on, this.spec.workdir ?? "work"));
    return { sbx: on, paths: this.paths };
  }

  /** Why the box can't be used any more, from the ledger: past its deadline, stopped outside the job, or lost. */
  private async goneReason(box: Box): Promise<MigrationReason | undefined> {
    const s = (await this.router.ledger.read()).sandboxes[box.sandboxId];
    const state = s ? effectiveState(s, this.now()) : "failed";
    if (state === "running") return undefined;
    if (state === "expired" || (s?.state === "stopped" && s.reason === "expired")) return "deadline";
    // Paused, or killed by someone else (the job kills only boxes it has left): not the provider's doing.
    if (state === "paused" || (s?.state === "stopped" && s.reason === "killed")) return "stopped";
    return "lost";
  }

  private handle(): { sbx: Sandbox; paths: BoxPaths } {
    if (!this.sbx || !this.paths) throw new Error(`job ${this.id}: no box attached`);
    return { sbx: this.sbx, paths: this.paths };
  }

  // ------------------------------------------------------------------ running

  /** running: at each step boundary the planned checks, then the step. */
  private async runSteps(): Promise<void> {
    const rec = this.rec as Running;
    if (rec.inFlight) return this.takeOverStep(rec.inFlight.step, rec.box);
    await this.attach(rec.box);
    // A takeover of a box this runner didn't prepare: the last owner may have stopped between
    // a retry and its restore, leaving the failed attempt's files behind.
    if (this.preparedHere !== rec.box.sandboxId && this.rec.attempts[String(rec.cursor)]) await this.restoreBeforeStep(rec.cursor);
    while (this.rec.state === "running") {
      const k = this.rec.cursor;
      if (k >= this.spec.steps.length) return this.succeed();
      if (await this.boundary(k)) return;
      await this.runStep(k);
    }
  }

  /**
   * A step recorded in flight by an owner that stopped. Nobody knows how it ended, and a copy
   * may still be running on that box, so it runs again on a new box, from the checkpoint
   * before it, and only if it's idempotent.
   */
  private async takeOverStep(k: number, box: Box): Promise<void> {
    const step = this.spec.steps[k]!;
    if (step.idempotent === false) {
      return this.fail(`step ${label(k, step)} was running when its runner stopped; its outcome is unknown and it isn't idempotent, so it isn't run again`);
    }
    if (this.attemptsUsed(k) >= this.policy.maxStepAttempts) {
      return this.fail(`step ${label(k, step)} didn't finish in ${this.policy.maxStepAttempts} attempts`);
    }
    const gone = await this.goneReason(box);
    if (gone) return this.move(gone, `box ${box.sandboxId} on ${box.provider} is gone`);
    await this.move("orphaned", `its runner stopped during step ${label(k, step)}, which may still be running there`);
  }

  /** The planned checks before step k (docs §3). True when the job left the box or failed. */
  private async boundary(k: number): Promise<boolean> {
    await this.renewIfDue();
    const box = (this.rec as Running).box;
    const step = this.spec.steps[k]!;
    const data = await this.router.ledger.read();
    const now = this.now();
    const s = data.sandboxes[box.sandboxId];
    if (!s || s.state !== "running" || effectiveState(s, now) !== "running") throw gone(box);

    const better = await this.betterPlace(box, step, data, now);
    // These moves are optional: with no migrations left the job stays where it is.
    if (better && this.rec.migrations < this.policy.maxMigrations) {
      await this.plannedLeave(better.reason, better.detail);
      return true;
    }

    const needSec = this.stepTimeoutSec(step) + this.policy.deadlineMarginSec;
    const leftMs = Date.parse(s.expiresAt) - now;
    if (leftMs >= needSec * 1000 || (await this.extend(box, s, needSec))) return false;
    await this.plannedLeave("deadline", `box ${box.sandboxId} has ${Math.max(0, Math.floor(leftMs / 1000))} s left and step ${label(k, step)} needs ${needSec} s`);
    return true;
  }

  /** A reason to leave a box that still works, or undefined to stay. */
  private async betterPlace(box: Box, step: StepSpec, data: LedgerData, now: number): Promise<{ reason: MigrationReason; detail: string } | undefined> {
    // Marks from before the box was placed were known when the router picked it.
    const refused = activeMarks(data, box.provider, now).find(
      (m) => (m.kind === "quota" || m.kind === "auth") && Date.parse(m.at) >= Date.parse(box.placedAt),
    );
    if (refused) return { reason: "provider-refused", detail: `${box.provider}: ${refused.detail ?? refused.kind}` };

    const health = providerHealth(data, box.provider, now, this.router.config.routing.circuitBreaker);
    if (health.circuit === "open") return { reason: "circuit-open", detail: `${box.provider} failed ${health.consecutiveFailures} times in a row` };

    const short = box.billing === "free" && this.freeRunsShort(box, step, data, now);
    const paid = this.policy.rebalance && box.billing === "paid";
    if (!short && !paid) return undefined;
    // Move only when the router would now put the job somewhere else.
    const first = (await this.router.plan(this.request())).ordered[0];
    if (!first || first.provider === box.provider) return undefined;
    if (short) return { reason: "free-credit", detail: `${box.provider}'s free usage won't cover the next step; ${first.provider} is first now` };
    if (first.billing !== "paid") return { reason: "rebalance", detail: `${first.provider} can take it without paying (${first.billing})` };
    return undefined;
  }

  /** The box's free tier is used up, or won't pay for the next step at its full timeout. */
  private freeRunsShort(box: Box, step: StepSpec, data: LedgerData, now: number): boolean {
    const info = this.router.adapter(box.provider).info;
    const cfg = this.router.config.providers[box.provider];
    const free = freeStatus(info, cfg, data, now);
    if (free.state === "exhausted") return true;
    if (free.state !== "available") return false;
    const secs = this.stepTimeoutSec(step);
    const s = data.sandboxes[box.sandboxId];
    const rate = ratePerSecond(effectivePricing(info, cfg), s?.cpu ?? info.pricing.defaultCpu, s?.memoryMiB ?? info.pricing.defaultMemoryMiB);
    return free.remaining < (free.unit === "hours" ? secs / 3600 : secs * rate);
  }

  /** Moves the deadline when the provider can and the box's whole life stays within its caps. */
  private async extend(box: Box, s: LiveSandbox, needSec: number): Promise<boolean> {
    const info = this.router.adapter(box.provider).info;
    if (!info.capabilities.includes("extendTimeout")) return false;
    let capSec = info.maxTimeoutSec ?? Number.POSITIVE_INFINITY;
    if (box.billing === "free" && info.freeTier.maxLifetimeSec !== undefined) capSec = Math.min(capSec, info.freeTier.maxLifetimeSec);
    if ((this.now() - Date.parse(s.createdAt)) / 1000 + needSec > capSec) return false;
    const { sbx } = this.handle();
    try {
      await this.boxCall("extending the box's deadline", () => sbx.setTimeout(needSec));
    } catch (err) {
      // Not extended: a planned move does the job instead, unless the box itself is gone.
      if (err instanceof BoxFailure && err.err.kind !== "not_found" && err.err.kind !== "conflict") return false;
      throw err;
    }
    this.emit({ type: "extended", sandboxId: box.sandboxId, timeoutSec: needSec });
    return true;
  }

  /** Leaves a box that still works, saving the workspace first when the checkpoint is behind. */
  private async plannedLeave(reason: MigrationReason, detail: string): Promise<void> {
    const k = this.rec.cursor;
    if (k > 0 && this.rec.checkpoint?.step !== k - 1) await this.checkpointNow();
    await this.move(reason, detail);
  }

  private async runStep(k: number): Promise<void> {
    const step = this.spec.steps[k]!;
    const { sbx, paths } = this.handle();
    if (this.attemptsUsed(k) >= this.policy.maxStepAttempts) {
      return this.fail(`step ${label(k, step)} didn't finish in ${this.policy.maxStepAttempts} attempts`);
    }
    await this.write({ type: "stepStarted", step: k, at: iso(this.now()) });
    if (this.placedHere?.sandboxId === sbx.id) this.placedHere.steps++;
    this.emit({ type: "stepStarted", step: k, attempt: (this.rec as Running).inFlight?.attempt ?? 1, name: step.name });

    const startedAt = this.now();
    const timeoutMs = this.stepTimeoutSec(step) * 1000;
    let r: ExecResult;
    try {
      // A call that broke off leaves the outcome unknown, and the command may still be running on
      // the box: a retry there would run a second copy beside it, after a restore wiped the
      // workspace under it. So the drive loop moves the step to a new box (or fails it, when it
      // isn't idempotent), as a takeover does.
      r = await this.boxCall(`step ${label(k, step)}`, () => sbx.commands.run(step.run, this.execOptions(step, paths)), { step: k, retryTransient: false });
    } catch (err) {
      // A call that broke off after the step's whole timeout: the step ran out of time.
      if (!(err instanceof BoxFailure && err.err.kind === "transient" && err.ms >= timeoutMs)) throw err;
      r = { exitCode: 124, stdout: "", stderr: err.message };
    }
    // A box destroyed mid-command can still answer with an exit code (`docker exec` says 137,
    // SSH says 255). Blame the step only once the box answers: a dead box throws here and the
    // step re-runs elsewhere.
    if (r.exitCode !== 0) await this.boxCall("checking the box after the step failed", () => sbx.commands.run("true", { timeoutSec: 30 }), { step: k });
    const endedAt = this.now();
    this.emit({ type: "stepFinished", step: k, exitCode: r.exitCode, durationMs: endedAt - startedAt });
    const result: StepResult = {
      step: k,
      exitCode: r.exitCode,
      sandboxId: sbx.id,
      provider: sbx.provider,
      startedAt: iso(startedAt),
      endedAt: iso(endedAt),
      stdoutTail: tail(r.stdout),
      stderrTail: tail(r.stderr),
    };
    if (r.exitCode === 0) return this.stepSucceeded(k, step, result);
    return this.stepExited(k, step, result, endedAt - startedAt);
  }

  private async stepSucceeded(k: number, step: StepSpec, result: StepResult): Promise<void> {
    let checkpoint: CheckpointRef | undefined;
    if (!step.noCheckpoint && this.policy.checkpoint === "every-step") {
      try {
        checkpoint = await this.capture(k);
      } catch (err) {
        if (!(err instanceof BoxFailure)) throw err;
        // The step did succeed: record that first. Then the drive loop leaves the box (the next
        // one rewinds to the last checkpoint and re-runs this step only if it's idempotent), or
        // fails the job when the store itself can't save.
        await this.write({ type: "stepSucceeded", result });
        throw err;
      }
    }
    await this.write({ type: "stepSucceeded", result, checkpoint });
    if (checkpoint) {
      this.emit({ type: "checkpointed", step: k, bytes: checkpoint.bytes });
      await this.prune(checkpoint);
    }
  }

  /** The command exited non-zero: the step's own failure, unless it was killed for memory. */
  private async stepExited(k: number, step: StepSpec, result: StepResult, ms: number): Promise<void> {
    // Exit 137 is a kill; before the step's timeout it's almost always the OOM killer.
    if (result.exitCode === 137 && this.policy.growMemoryOnOom && step.idempotent !== false && ms < this.stepTimeoutSec(step) * 1000) {
      const memory = await this.boxMemoryMiB();
      if (
        memory &&
        memory < this.policy.maxMemoryMiB &&
        this.attemptsUsed(k) < this.policy.maxStepAttempts &&
        this.rec.migrations < this.policy.maxMigrations
      ) {
        return this.move("oom", `step ${label(k, step)} was killed (exit 137) with ${memory} MiB`, Math.min(memory * 2, this.policy.maxMemoryMiB));
      }
    }
    if ((this.rec.attempts[String(k)]?.exitFailures ?? 0) < (step.retries ?? 0)) {
      const reason = `exit ${result.exitCode}`;
      await this.write({ type: "stepRetry", reason, exit: true });
      this.emit({ type: "retrying", step: k, reason, delayMs: 0 });
      await this.restoreBeforeStep(k);
      return;
    }
    return this.fail(`step ${label(k, step)} exited ${result.exitCode}`, result);
  }

  /** Starts of step k that weren't retries of a non-zero exit: infrastructure attempts, the current one included. */
  private attemptsUsed(k: number): number {
    const a = this.rec.attempts[String(k)];
    return a ? a.total - a.exitFailures : 0;
  }

  private async boxMemoryMiB(): Promise<number | undefined> {
    const box = currentBox(this.rec);
    return box && (await this.router.ledger.read()).sandboxes[box.sandboxId]?.memoryMiB;
  }

  private execOptions(step: StepSpec, paths: BoxPaths): ExecOptions {
    return {
      cwd: step.cwd ? posix.resolve(paths.workdir, step.cwd) : paths.workdir,
      env: { ...this.spec.env, ...step.env },
      timeoutSec: this.stepTimeoutSec(step),
      onStdout: this.opts.onStdout,
      onStderr: this.opts.onStderr,
    };
  }

  // ------------------------------------------------------------------ the workspace

  /**
   * Puts the workspace back as it was before step k when that state is stored: the initial
   * files before step 0, else the checkpoint of step k-1. In on-migrate mode (or after a
   * noCheckpoint step) it isn't, and the step runs again on the workspace as it is.
   */
  private async restoreBeforeStep(k: number): Promise<void> {
    const { sbx, paths } = this.handle();
    // Both `rm -rf` the workdir, where a successor may be running the step by now: fence first.
    if (k === 0) {
      await this.fence();
      return this.boxCall("writing the initial files", () => writeInitialFiles(sbx, paths, this.spec.files ?? {}));
    }
    const ckpt = this.rec.checkpoint;
    if (ckpt?.step !== k - 1) return;
    const archive = await this.archive(ckpt);
    await this.fence();
    await this.boxCall("restoring the workspace", () => restoreWorkspace(sbx, paths, archive));
  }

  private async archive(ref: CheckpointRef): Promise<Uint8Array> {
    try {
      return await this.deps.store.get(this.id, ref);
    } catch (err) {
      // Not the box's fault, and no other box can help: the job's saved state is unreadable.
      const why = new SandboxRouterError("invalid", `the checkpoint of step ${ref.step} can't be read: ${(err as Error).message}`);
      throw new BoxFailure(why, "restoring the workspace");
    }
  }

  private async capture(step: number): Promise<CheckpointRef> {
    const { sbx, paths } = this.handle();
    const data = await this.boxCall("checkpointing the workspace", () => captureWorkspace(sbx, paths, { maxBytes: this.policy.maxCheckpointBytes }));
    try {
      return await this.deps.store.put(this.id, step, data);
    } catch (err) {
      // Not the box's fault, and no other box can help: the job can't keep its state (a full disk).
      const why = new SandboxRouterError("invalid", err instanceof Error ? err.message : String(err));
      throw new BoxFailure(why, `couldn't save the workspace after step ${label(step, this.spec.steps[step]!)}`);
    }
  }

  /** Saves the workspace as it is now (it holds every step before the cursor). */
  private async checkpointNow(): Promise<void> {
    const step = this.rec.cursor - 1;
    const ref = await this.capture(step);
    await this.write({ type: "checkpointed", checkpoint: ref });
    this.emit({ type: "checkpointed", step, bytes: ref.bytes });
    await this.prune(ref);
  }

  /** Old archives only cost disk; a failed prune is retried by the next one. */
  private async prune(keep?: CheckpointRef): Promise<void> {
    // Until the job ends, a successor may have recorded a newer archive than `keep` by now.
    if (!isTerminal(this.rec)) await this.fence();
    await this.deps.store.prune(this.id, keep).catch(() => undefined);
  }

  // ------------------------------------------------------------------ failures and moves

  /**
   * A call on the box. Rate limits back off and retry, up to maxWaitSec in all; transient
   * errors retry twice, 1 s then 2 s apart, unless `retryTransient` is false. What still fails
   * becomes a BoxFailure.
   */
  private async boxCall<T>(what: string, fn: () => Promise<T>, o: { step?: number; retryTransient?: boolean } = {}): Promise<T> {
    let transient = 0;
    let limited = 0;
    let waitedMs = 0;
    for (;;) {
      const started = this.now();
      try {
        return await fn();
      } catch (raw) {
        if (raw instanceof BoxFailure) throw raw;
        const err = classify(raw, currentBox(this.rec)?.provider);
        const ms = this.now() - started;
        let delayMs: number | undefined;
        if (err.kind === "rate_limit") {
          const left = this.policy.maxWaitSec * 1000 - waitedMs;
          if (left > 0) delayMs = Math.min(1000 * 2 ** limited++, WAIT_STEP_MS, left);
        } else if (err.kind === "transient" && transient < TRANSIENT_RETRIES && o.retryTransient !== false) {
          delayMs = 1000 * 2 ** transient++;
        }
        if (delayMs === undefined) throw new BoxFailure(err, what, ms);
        this.emit({ type: "retrying", step: o.step ?? this.rec.cursor, reason: `${what}: ${err.message}`, delayMs });
        await this.wait(delayMs);
        waitedMs += delayMs;
      }
    }
  }

  /** A call on the box failed for good: leave the box, or fail when no other box can help. */
  private async boxFailed(f: BoxFailure): Promise<void> {
    const { kind } = f.err;
    if (kind === "conflict") throw f.err;
    if (kind === "invalid" || kind === "unsupported") return this.fail(f.message);
    const rec = this.rec;
    const inFlight = rec.state === "running" ? rec.inFlight : undefined;
    if (inFlight) {
      const step = this.spec.steps[inFlight.step]!;
      // A box that vanished, or a call that broke off, may have run the command.
      if ((kind === "not_found" || kind === "transient") && step.idempotent === false) {
        return this.fail(`step ${label(inFlight.step, step)} isn't idempotent and its outcome is unknown (${f.message}), so it isn't run again`);
      }
      if (this.attemptsUsed(inFlight.step) >= this.policy.maxStepAttempts) {
        return this.fail(`step ${label(inFlight.step, step)} didn't finish in ${this.policy.maxStepAttempts} attempts; last: ${f.message}`);
      }
    }
    const box = currentBox(rec);
    const reason: MigrationReason =
      kind === "not_found"
        ? ((box && (await this.goneReason(box))) ?? "lost")
        : kind === "quota" || kind === "auth"
          ? "provider-refused"
          : rec.state === "preparing"
            ? "prepare-failed"
            : "unhealthy";
    return this.move(reason, f.message);
  }

  /**
   * Leaves the box. Fails instead past maxMigrations, or when the next box would have to
   * replay a step that isn't idempotent.
   */
  private async move(reason: MigrationReason, detail: string, memoryMiB?: number): Promise<void> {
    const replay = this.replayProblem((this.rec.checkpoint?.step ?? -1) + 1);
    if (replay) return this.fail(`${reason} (${detail}); ${replay}`);
    if (this.rec.migrations >= this.policy.maxMigrations) {
      return this.fail(`${reason} (${detail}); the job already moved ${this.rec.migrations} time(s), the most maxMigrations allows`);
    }
    const box = currentBox(this.rec);
    const placed = this.placedHere;
    if (reason === "deadline" && box && placed?.sandboxId === box.sandboxId && placed.steps === 0) {
      // Too short before a single step ran: getting a box ready takes longer than allowed for.
      const tookSec = Math.ceil((this.now() - placed.at) / 1000);
      this.prepareSec = Math.max(this.prepareSec * 2, tookSec + this.policy.deadlineMarginSec);
    }
    const from = box?.provider ?? "";
    await this.write({ type: "migrate", reason, detail: detail.slice(0, 500), memoryMiB });
    this.emit({ type: "migrating", reason, detail, from });
  }

  /** migrating: retire the old box, then place again. */
  private async leave(): Promise<void> {
    const box = (this.rec as Migrating).box;
    if (box) {
      // Killed only by the lease holder: once someone else has the job, its boxes are theirs to handle.
      await this.fence();
      await this.kill(box.sandboxId);
    }
    this.sbx = undefined;
    this.paths = undefined;
    await this.write({ type: "left" });
  }

  private async succeed(): Promise<void> {
    const box = currentBox(this.rec);
    await this.write({ type: "succeed" });
    this.emit({ type: "succeeded" });
    if (box) await this.kill(box.sandboxId);
    await this.prune(this.rec.checkpoint);
  }

  private async fail(error: string, result?: StepResult): Promise<void> {
    const box = currentBox(this.rec);
    await this.write({ type: "fail", error, result });
    this.emit({ type: "failed", error });
    if (box) await this.kill(box.sandboxId);
    // The latest archive stays for `workspace()`; any a crash left unrecorded goes.
    await this.prune(this.rec.checkpoint);
  }

  /** Best effort: a box whose kill fails stops at its deadline, or the sweep reaps it. */
  private async kill(sandboxId: string): Promise<void> {
    await this.router.kill(sandboxId).catch(() => undefined);
  }
}
