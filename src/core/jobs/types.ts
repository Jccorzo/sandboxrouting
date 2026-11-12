// Jobs: ordered steps plus a working directory that can move from box to box. The lifecycle
// is decided in one place (jobs/state.ts); the runner (jobs/runner.ts) drives it; the ledger
// stores it. See docs/routing.md, section 3.

import type { SandboxSpec } from "../types.js";
import type { JobPolicy } from "../config.js";

export interface StepSpec {
  /** Shell command, run with `sh -c` in `cwd` (default: the job's workdir). */
  run: string;
  name?: string;
  /** Working directory. Relative paths are under the workdir. */
  cwd?: string;
  env?: Record<string, string>;
  /** Default: `jobs.defaultStepTimeoutSec`. Also used to decide whether the box has enough life left. */
  timeoutSec?: number;
  /**
   * Whether running it again from the workspace as it was before the step is safe. Default
   * true. When false and the step's outcome is unknown (the box or the runner died mid-step),
   * the job fails instead of running it twice.
   */
  idempotent?: boolean;
  /** Extra attempts when the command itself exits non-zero. Default 0: a non-zero exit fails the job. */
  retries?: number;
  /** Skip the checkpoint after this step (read-only steps such as tests). */
  noCheckpoint?: boolean;
}

export interface JobSpec {
  name?: string;
  /** Where the box goes: the same request as `router.create` (needs, image, providers, strategy…). */
  sandbox?: SandboxSpec;
  /** Directory carried from box to box. Relative paths are under $HOME. Default "work". */
  workdir?: string;
  /** Initial workspace: path relative to the workdir → UTF-8 content. */
  files?: Record<string, string>;
  /** Run on every new box before the workspace is restored. Must be safe to run again. */
  setup?: StepSpec[];
  steps: StepSpec[];
  /** Environment for every step and setup step. */
  env?: Record<string, string>;
  /** Overrides of the config's `jobs` defaults for this job. */
  policy?: Partial<JobPolicy>;
}

export type JobState = "queued" | "placing" | "preparing" | "running" | "migrating" | "succeeded" | "failed" | "cancelled";
/** `orphaned` is never stored: an active job whose lease lapsed reads as orphaned. */
export type EffectiveJobState = JobState | "orphaned";

export const ACTIVE_JOB_STATES: readonly JobState[] = ["placing", "preparing", "running", "migrating"];
export const TERMINAL_JOB_STATES: readonly JobState[] = ["succeeded", "failed", "cancelled"];

/** Who drives the job, and until when. Renewed every `leaseSec / 3`. */
export interface Lease {
  owner: string;
  until: string;
}

/** The box a job is on. */
export interface Box {
  /** Router sandbox id (`sbr_…`). */
  sandboxId: string;
  provider: string;
  /** The strategy's lane when placed (routing `Lane`); for display. */
  lane?: string;
  /** How it is paid for ("free", "self-hosted", "paid"). Decide free-vs-paid from this, not the lane. */
  billing?: string;
  placedAt: string;
}

export type MigrationReason =
  | "lost" // the box vanished before its deadline
  | "stopped" // the box was stopped or paused outside the job: not the provider's fault
  | "provider-refused" // quota or auth refusal from the box's provider
  | "unhealthy" // repeated transient errors on the box
  | "deadline" // the next step would not fit in the box's remaining life
  | "free-credit" // free usage would run out during the next step
  | "circuit-open" // the provider is failing
  | "rebalance" // a free box became available while on a paid one
  | "oom" // the step was killed (exit 137); moving to a bigger box
  | "prepare-failed" // setup or restore failed on the box
  | "orphaned"; // its runner stopped mid-step; a copy may still run there, so the step re-runs elsewhere

export interface Placement extends Box {
  endedAt?: string;
  endReason?: MigrationReason | "finished" | "failed" | "cancelled";
}

export interface StepResult {
  step: number;
  exitCode: number;
  sandboxId: string;
  provider: string;
  startedAt: string;
  endedAt: string;
  /** Last 4 000 characters of each stream. */
  stdoutTail: string;
  stderrTail: string;
}

export interface InFlight {
  step: number;
  /** 1-based attempt number of this step. */
  attempt: number;
  startedAt: string;
  sandboxId: string;
}

export interface StepAttempts {
  /** Times the step was started, on any box. Starts over when a rewind replays it after it succeeded. */
  total: number;
  /** Times it exited non-zero and was retried (bounded by the step's `retries`). */
  exitFailures: number;
}

export interface JobHistoryEntry {
  at: string;
  /** The event type, e.g. "migrate". */
  type: string;
  detail?: string;
}

/** A stored workspace archive (tar.gz of the workdir). */
export interface CheckpointRef {
  key: string;
  sha256: string;
  bytes: number;
  /** The last step whose effects it contains. */
  step: number;
  at: string;
}

interface JobBase {
  id: string;
  spec: JobSpec;
  createdAt: string;
  updatedAt: string;
  /** Bumped by every transition. */
  version: number;
  /** Next step to run; steps before it succeeded (their results are in `results`). */
  cursor: number;
  /** Latest workspace archive. Its `step` is at most `cursor - 1`. Undefined: start from `spec.files`. */
  checkpoint?: CheckpointRef;
  /** Every box the job used, oldest first. The current box (if any) is also the last entry here. */
  placements: Placement[];
  /** Box changes so far. */
  migrations: number;
  /** Keyed by step index. */
  attempts: Record<string, StepAttempts>;
  /** One per succeeded step: results[i] is step i. Length equals `cursor`. */
  results: StepResult[];
  /** Audit log of every transition, newest last, capped at 200. */
  history: JobHistoryEntry[];
  /** Memory for the next box, when it grew after an out-of-memory kill. */
  memoryMiB?: number;
}

export type JobRecord =
  | (JobBase & { state: "queued" })
  | (JobBase & { state: "placing"; lease: Lease })
  | (JobBase & { state: "preparing"; lease: Lease; box: Box })
  | (JobBase & { state: "running"; lease: Lease; box: Box; inFlight?: InFlight })
  | (JobBase & { state: "migrating"; lease: Lease; box?: Box; reason: MigrationReason; detail?: string })
  | (JobBase & { state: "succeeded"; endedAt: string })
  | (JobBase & { state: "failed"; endedAt: string; error: string; result?: StepResult })
  | (JobBase & { state: "cancelled"; endedAt: string });

/** The moves. `transitionJob` in jobs/state.ts is the only function that applies them. */
export type JobEvent =
  /** queued → placing, or take over an orphaned active job (state unchanged, new lease). */
  | { type: "claim"; lease: Lease }
  /** Active → same state with a later `until`. Lease holder only. */
  | { type: "renew"; until: string }
  /** placing → preparing. */
  | { type: "placed"; box: Box }
  /**
   * preparing → running. `cursor` is where the steps continue: the checkpoint's step + 1 (or 0
   * without one). It may be lower than the recorded cursor (a rewind); results past it are dropped
   * and the attempts of the steps it replays start over.
   */
  | { type: "prepared"; cursor: number }
  /** running (nothing in flight, step === cursor) → running with `inFlight`. */
  | { type: "stepStarted"; step: number; at?: string }
  /** running (step in flight) → running, cursor + 1. The checkpoint, if given, is of this step. */
  | { type: "stepSucceeded"; result: StepResult; checkpoint?: CheckpointRef }
  /** running (step in flight) → running, nothing in flight. `exit` counts toward the step's `retries`. */
  | { type: "stepRetry"; reason: string; exit: boolean }
  /** running (nothing in flight) → running with a newer checkpoint (its step is cursor - 1). */
  | { type: "checkpointed"; checkpoint: CheckpointRef }
  /** placing | preparing | running → migrating. Clears anything in flight. */
  | { type: "migrate"; reason: MigrationReason; detail?: string; memoryMiB?: number }
  /** migrating → placing. Closes the box's placement; counts a migration. */
  | { type: "left" }
  /** running (all steps done, nothing in flight) → succeeded. */
  | { type: "succeed" }
  /** Any non-terminal → failed. */
  | { type: "fail"; error: string; result?: StepResult }
  /** Any non-terminal → cancelled. Anyone may cancel. */
  | { type: "cancel" };

/** What a caller sees: the record plus its effective state, never a stored verdict. */
export interface JobView {
  id: string;
  name?: string;
  state: EffectiveJobState;
  cursor: number;
  steps: number;
  provider?: string;
  sandboxId?: string;
  migrations: number;
  placements: Placement[];
  results: StepResult[];
  checkpoint?: CheckpointRef;
  history: JobHistoryEntry[];
  error?: string;
  /** The step that failed the job: its exit code and the tails of its output. */
  result?: StepResult;
  createdAt: string;
  updatedAt: string;
  endedAt?: string;
}

/** Progress the runner reports while it drives a job. */
export type RunnerEvent =
  | { type: "placed"; provider: string; sandboxId: string; lane?: string }
  | { type: "prepared"; fromStep: number; restored: boolean }
  | { type: "stepStarted"; step: number; attempt: number; name?: string }
  | { type: "stepFinished"; step: number; exitCode: number; durationMs: number }
  | { type: "checkpointed"; step: number; bytes: number }
  | { type: "extended"; sandboxId: string; timeoutSec: number }
  | { type: "migrating"; reason: MigrationReason; detail?: string; from: string }
  | { type: "retrying"; step: number; reason: string; delayMs: number }
  | { type: "waiting"; reason: string; delayMs: number }
  | { type: "succeeded" }
  | { type: "failed"; error: string }
  | { type: "cancelled" };

export interface JobRunOptions {
  /**
   * Called once the job is recorded and claimed by this process, before any box exists, with
   * its id. Surfaces use it to answer with the id while the job keeps running.
   */
  onClaimed?: (job: JobView) => void;
  onEvent?: (event: RunnerEvent) => void;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

/** Where workspace archives live. Writes are whole (temp file + rename) and checked by hash. */
export interface CheckpointStore {
  put(jobId: string, step: number, data: Uint8Array): Promise<CheckpointRef>;
  /** The archive's bytes. Throws if it is missing or its SHA-256 differs from the ref. */
  get(jobId: string, ref: CheckpointRef): Promise<Uint8Array>;
  /** Deletes the job's archives except `keep`; all of them when `keep` is undefined. */
  prune(jobId: string, keep?: CheckpointRef): Promise<void>;
}

/** `router.jobs`. */
export interface JobManagerApi {
  /** Records a queued job. Nothing runs until `run`/`resume`. */
  submit(spec: JobSpec): Promise<JobView>;
  /** Submits and drives the job to the end in this process. Resolves with the final view. */
  run(spec: JobSpec, opts?: JobRunOptions): Promise<JobView>;
  /** Claims a queued or orphaned job and drives it. Throws ConflictError while a live runner owns it. */
  resume(id: string, opts?: JobRunOptions): Promise<JobView>;
  get(id: string): Promise<JobView | undefined>;
  list(opts?: { all?: boolean }): Promise<JobView[]>;
  /** Cancels a job that hasn't finished and kills its box (best effort). */
  cancel(id: string): Promise<JobView>;
  /** The latest workspace archive (tar.gz), e.g. the result after the last step. */
  workspace(id: string): Promise<Uint8Array | undefined>;
  /**
   * Converges: kills boxes still alive under finished jobs (and orphans tagged with a job that
   * never recorded them); with `resumeOrphans`, drives orphaned jobs in the background.
   */
  sweep(opts?: { resumeOrphans?: boolean }): Promise<{ reaped: number; resumed: number }>;
}
