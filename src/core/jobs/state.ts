// The job lifecycle. This file is the one place that decides which moves are allowed and who
// may make them; the ledger stores the result and everything else reads it through
// `effectiveJobState`.
//
//   queued ─claim─▶ placing ─placed─▶ preparing ─prepared─▶ running ─succeed─▶ succeeded
//                     ▲                   │                  │   (stepStarted, stepSucceeded,
//                     │                migrate            migrate  stepRetry, checkpointed)
//                     └──left── migrating ◀──────────────────┘
//   any non-terminal ─fail─▶ failed            any non-terminal ─cancel─▶ cancelled
//
// Ownership is a lease. Every move except claim and cancel must come from the lease holder;
// the check runs here, inside the ledger update, so a runner that lost its lease can't write.

import { ConflictError } from "../errors.js";
import {
  ACTIVE_JOB_STATES,
  TERMINAL_JOB_STATES,
  type Box,
  type EffectiveJobState,
  type JobEvent,
  type JobRecord,
  type JobSpec,
  type Lease,
  type Placement,
  type StepSpec,
} from "./types.js";

export class InvalidJobTransitionError extends Error {
  constructor(from: string, event: JobEvent["type"], why?: string) {
    super(`job cannot go through "${event}" while ${from}${why ? `: ${why}` : ""}`);
    this.name = "InvalidJobTransitionError";
  }
}

type Active = Extract<JobRecord, { lease: Lease }>;

const HISTORY_CAP = 200;
const iso = (ms: number) => new Date(ms).toISOString();
const ms = (s: string) => Date.parse(s);

/** A new queued job. */
export function newJob(id: string, spec: JobSpec, now: number): JobRecord {
  const at = iso(now);
  return {
    id,
    spec,
    state: "queued",
    createdAt: at,
    updatedAt: at,
    version: 1,
    cursor: 0,
    placements: [],
    migrations: 0,
    attempts: {},
    results: [],
    history: [{ at, type: "submitted", detail: `${spec.steps.length} step${spec.steps.length === 1 ? "" : "s"}` }],
  };
}

export function isActive(rec: JobRecord): rec is Active {
  return ACTIVE_JOB_STATES.includes(rec.state);
}

export function isTerminal(rec: JobRecord): boolean {
  return TERMINAL_JOB_STATES.includes(rec.state);
}

const lapsed = (rec: Active, now: number) => ms(rec.lease.until) <= now;

/** `orphaned` when an active job's lease has lapsed; otherwise the stored state. */
export function effectiveJobState(rec: JobRecord, now: number): EffectiveJobState {
  if (isActive(rec) && lapsed(rec, now)) return "orphaned";
  return rec.state;
}

/** The box the job is on now, if any. */
export function currentBox(rec: JobRecord): Box | undefined {
  if (rec.state === "preparing" || rec.state === "running" || rec.state === "migrating") return rec.box;
  return undefined;
}

/**
 * The only function that moves a job. Pure: returns the new record (version + 1, history
 * entry appended). `actor` is the caller's lease owner id: every event except `claim`,
 * `cancel` (and `fail` on a queued or orphaned job) must come from the current lease holder,
 * else it throws ConflictError. Moves the table does not allow throw InvalidJobTransitionError.
 */
export function transitionJob(rec: JobRecord, ev: JobEvent, now: number, actor?: string): JobRecord {
  authorize(rec, ev, now, actor);
  const next = move(rec, ev, now);
  next.version = rec.version + 1;
  next.updatedAt = iso(now);
  // Renewals happen every few seconds; logging them would push real decisions out of the cap.
  if (ev.type !== "renew") next.history = [...rec.history, { at: iso(now), type: ev.type, detail: describe(rec, ev) }].slice(-HISTORY_CAP);
  return next;
}

function authorize(rec: JobRecord, ev: JobEvent, now: number, actor: string | undefined): void {
  if (ev.type === "claim" || ev.type === "cancel") return;
  if (ev.type === "fail" && (rec.state === "queued" || (isActive(rec) && lapsed(rec, now)))) return;
  if (isTerminal(rec)) throw new ConflictError(`job ${rec.id} is already ${rec.state}`);
  if (!isActive(rec)) return; // queued: `move` refuses everything but claim, cancel and fail
  if (rec.lease.owner !== actor) {
    throw new ConflictError(`job ${rec.id} is owned by ${rec.lease.owner}${lapsed(rec, now) ? " (lease lapsed; claim it first)" : ""}`);
  }
}

function move(rec: JobRecord, ev: JobEvent, now: number): JobRecord {
  const invalid = (why?: string) => new InvalidJobTransitionError(rec.state, ev.type, why);
  const steps = rec.spec.steps.length;

  switch (ev.type) {
    case "claim": {
      if (ms(ev.lease.until) <= now) throw invalid("the new lease is already over");
      if (rec.state === "queued") return { ...rec, state: "placing", lease: ev.lease };
      if (isActive(rec)) {
        if (!lapsed(rec, now)) throw new ConflictError(`job ${rec.id} is owned by ${rec.lease.owner} until ${rec.lease.until}`);
        // Takeover: same state, same box; the new owner resumes from what is recorded.
        return { ...rec, lease: ev.lease };
      }
      throw invalid();
    }
    case "renew":
      if (!isActive(rec)) throw invalid();
      if (ms(ev.until) <= now) throw invalid("a lease can only be renewed into the future");
      return { ...rec, lease: { ...rec.lease, until: ev.until } };

    case "placed":
      if (rec.state !== "placing") throw invalid();
      return {
        ...rec,
        state: "preparing",
        box: ev.box,
        placements: [...rec.placements, { ...ev.box }],
      };

    case "prepared": {
      if (rec.state !== "preparing") throw invalid();
      const from = (rec.checkpoint?.step ?? -1) + 1;
      if (ev.cursor !== from) throw invalid(`steps continue after the checkpoint, at ${from}, not ${ev.cursor}`);
      if (ev.cursor > rec.cursor) throw invalid(`cannot skip ahead from step ${rec.cursor} to ${ev.cursor}`);
      // A rewind replays steps that had succeeded, so their attempts start over: replays must not
      // use up maxStepAttempts. The step that was running when the box went keeps its count.
      const attempts = { ...rec.attempts };
      for (let i = ev.cursor; i < rec.cursor; i++) delete attempts[String(i)];
      return { ...rec, state: "running", cursor: ev.cursor, results: rec.results.slice(0, ev.cursor), attempts, inFlight: undefined };
    }

    case "stepStarted": {
      if (rec.state !== "running" || rec.inFlight) throw invalid(rec.state === "running" ? `step ${rec.inFlight!.step} is in flight` : undefined);
      if (ev.step !== rec.cursor) throw invalid(`the next step is ${rec.cursor}, not ${ev.step}`);
      if (ev.step >= steps) throw invalid("every step already ran");
      const key = String(ev.step);
      const prior = rec.attempts[key] ?? { total: 0, exitFailures: 0 };
      const attempt = prior.total + 1;
      return {
        ...rec,
        attempts: { ...rec.attempts, [key]: { ...prior, total: attempt } },
        inFlight: { step: ev.step, attempt, startedAt: ev.at ?? iso(now), sandboxId: rec.box.sandboxId },
      };
    }

    case "stepSucceeded": {
      if (rec.state !== "running" || !rec.inFlight) throw invalid("no step is in flight");
      if (ev.result.step !== rec.inFlight.step) throw invalid(`step ${rec.inFlight.step} is in flight, not ${ev.result.step}`);
      if (ev.checkpoint && ev.checkpoint.step !== ev.result.step) throw invalid("the checkpoint must be of the step that succeeded");
      return {
        ...rec,
        cursor: rec.cursor + 1,
        results: [...rec.results, ev.result],
        checkpoint: ev.checkpoint ?? rec.checkpoint,
        inFlight: undefined,
      };
    }

    case "stepRetry": {
      if (rec.state !== "running" || !rec.inFlight) throw invalid("no step is in flight");
      const key = String(rec.inFlight.step);
      const prior = rec.attempts[key] ?? { total: 1, exitFailures: 0 };
      return {
        ...rec,
        attempts: ev.exit ? { ...rec.attempts, [key]: { ...prior, exitFailures: prior.exitFailures + 1 } } : rec.attempts,
        inFlight: undefined,
      };
    }

    case "checkpointed":
      if (rec.state !== "running" || rec.inFlight) throw invalid(rec.state === "running" ? "a step is in flight" : undefined);
      // Before the first step the workspace is `spec.files`, which the spec already keeps.
      if (rec.cursor === 0) throw invalid("no step has run yet, so there is nothing to checkpoint");
      if (ev.checkpoint.step !== rec.cursor - 1) throw invalid(`a checkpoint now holds step ${rec.cursor - 1}, not ${ev.checkpoint.step}`);
      return { ...rec, checkpoint: ev.checkpoint };

    case "migrate":
      if (rec.state !== "preparing" && rec.state !== "running") throw invalid();
      return {
        ...base(rec),
        state: "migrating",
        lease: rec.lease,
        box: rec.box,
        reason: ev.reason,
        detail: ev.detail,
        memoryMiB: ev.memoryMiB ?? rec.memoryMiB,
      };

    case "left":
      if (rec.state !== "migrating") throw invalid();
      return {
        ...base(rec),
        state: "placing",
        lease: rec.lease,
        placements: rec.box ? close(rec.placements, rec.box.sandboxId, rec.reason, now) : rec.placements,
        migrations: rec.migrations + 1,
      };

    case "succeed":
      if (rec.state !== "running" || rec.inFlight) throw invalid(rec.state === "running" ? "a step is in flight" : undefined);
      if (rec.cursor !== steps) throw invalid(`${steps - rec.cursor} step(s) left`);
      return { ...base(rec), state: "succeeded", endedAt: iso(now), placements: close(rec.placements, rec.box.sandboxId, "finished", now) };

    case "fail": {
      if (isTerminal(rec)) throw invalid();
      const box = currentBox(rec);
      return {
        ...base(rec),
        state: "failed",
        endedAt: iso(now),
        error: ev.error,
        result: ev.result,
        placements: box ? close(rec.placements, box.sandboxId, "failed", now) : rec.placements,
      };
    }

    case "cancel": {
      if (isTerminal(rec)) throw invalid();
      const box = currentBox(rec);
      return {
        ...base(rec),
        state: "cancelled",
        endedAt: iso(now),
        placements: box ? close(rec.placements, box.sandboxId, "cancelled", now) : rec.placements,
      };
    }
  }
}

/** The fields every state shares, without the state-specific ones (lease, box, inFlight…). */
function base(rec: JobRecord) {
  return {
    id: rec.id,
    spec: rec.spec,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
    version: rec.version,
    cursor: rec.cursor,
    checkpoint: rec.checkpoint,
    placements: rec.placements,
    migrations: rec.migrations,
    attempts: rec.attempts,
    results: rec.results,
    history: rec.history,
    memoryMiB: rec.memoryMiB,
  };
}

function close(placements: Placement[], sandboxId: string, reason: NonNullable<Placement["endReason"]>, now: number): Placement[] {
  return placements.map((p) => (p.sandboxId === sandboxId && !p.endedAt ? { ...p, endedAt: iso(now), endReason: reason } : p));
}

function describe(rec: JobRecord, ev: JobEvent): string | undefined {
  switch (ev.type) {
    case "claim":
      return isActive(rec) ? `${ev.lease.owner} took over from ${rec.lease.owner} (lease lapsed at ${rec.lease.until})` : ev.lease.owner;
    case "placed":
      return `${ev.box.provider} ${ev.box.sandboxId}${ev.box.lane ? ` (${ev.box.lane})` : ""}`;
    case "prepared":
      return ev.cursor < rec.cursor ? `rewound from step ${rec.cursor} to ${ev.cursor}` : `from step ${ev.cursor}`;
    case "stepStarted":
      return `step ${ev.step}`;
    case "stepSucceeded":
      return `step ${ev.result.step}${ev.checkpoint ? `, checkpoint ${ev.checkpoint.bytes} bytes` : ""}`;
    case "stepRetry":
      return ev.reason;
    case "checkpointed":
      return `step ${ev.checkpoint.step}, ${ev.checkpoint.bytes} bytes`;
    case "migrate":
      return `${ev.reason}${ev.detail ? `: ${ev.detail}` : ""}${ev.memoryMiB ? ` (memory ${ev.memoryMiB} MiB)` : ""}`;
    case "fail":
      return ev.error.slice(0, 300);
    default:
      return undefined;
  }
}

/** Invariants the types cannot express, checked when a ledger is loaded. */
export function validateJob(rec: JobRecord): string | undefined {
  if (!rec.spec || !Array.isArray(rec.spec.steps)) return "spec.steps is missing";
  const steps = rec.spec.steps.length;
  if (!Number.isInteger(rec.cursor) || rec.cursor < 0 || rec.cursor > steps) return `cursor ${rec.cursor} is outside 0..${steps}`;
  if (rec.results.length !== rec.cursor) return `${rec.results.length} results for cursor ${rec.cursor}`;
  if (rec.results.some((r, i) => r.step !== i)) return "results are out of order";
  if (rec.checkpoint && (rec.checkpoint.step < 0 || rec.checkpoint.step > rec.cursor - 1)) {
    return `checkpoint of step ${rec.checkpoint.step} is ahead of cursor ${rec.cursor}`;
  }
  const open = rec.placements.filter((p) => !p.endedAt);
  if (isActive(rec) && (!rec.lease?.owner || Number.isNaN(ms(rec.lease.until)))) return `${rec.state} job needs a lease`;
  const box = currentBox(rec);
  if ((rec.state === "preparing" || rec.state === "running") && !box) return `${rec.state} job needs a box`;
  if (box) {
    if (open.length !== 1 || open[0]!.sandboxId !== box.sandboxId) return "the current box must be the one open placement";
  } else if (open.length) {
    return `${rec.state} job cannot have an open placement`;
  }
  if (rec.state === "running" && rec.inFlight && rec.inFlight.step !== rec.cursor) return `step ${rec.inFlight.step} in flight at cursor ${rec.cursor}`;
  return undefined;
}

/** Checks a job request before it is recorded. One definition for the SDK, CLI, REST and MCP. */
export function checkJobSpec(spec: unknown): string | undefined {
  if (!spec || typeof spec !== "object") return "a job needs a spec object";
  const s = spec as Partial<JobSpec>;
  if (!Array.isArray(s.steps)) return "steps must be a list";
  if (!s.steps.length) return "a job needs at least one step";
  if (s.sandbox !== undefined && (typeof s.sandbox !== "object" || s.sandbox === null || Array.isArray(s.sandbox))) {
    return "sandbox must be a request object, e.g. { \"providers\": [\"e2b\"] }";
  }
  const stepProblem = (list: StepSpec[], what: string): string | undefined => {
    for (const [i, step] of list.entries()) {
      if (!step || typeof step.run !== "string" || !step.run.trim()) return `${what}[${i}].run must be a command`;
      if (step.timeoutSec !== undefined && !(Number.isFinite(step.timeoutSec) && step.timeoutSec > 0)) return `${what}[${i}].timeoutSec must be positive`;
      if (step.retries !== undefined && !(Number.isInteger(step.retries) && step.retries >= 0)) return `${what}[${i}].retries must be a whole number`;
    }
    return undefined;
  };
  const steps = stepProblem(s.steps, "steps");
  if (steps) return steps;
  if (s.setup !== undefined) {
    if (!Array.isArray(s.setup)) return "setup must be a list";
    const setup = stepProblem(s.setup, "setup");
    if (setup) return setup;
  }
  if (s.workdir !== undefined && (typeof s.workdir !== "string" || !s.workdir.trim())) return "workdir must be a path";
  if (s.files !== undefined) {
    if (typeof s.files !== "object" || s.files === null) return "files must map paths to contents";
    for (const [path, content] of Object.entries(s.files)) if (typeof content !== "string") return `files["${path}"] must be a string`;
  }
  return undefined;
}
