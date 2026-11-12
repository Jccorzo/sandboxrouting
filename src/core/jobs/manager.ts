// `router.jobs`: submit, run, resume, inspect, cancel and sweep jobs. Every write goes through
// transitionJob under the ledger lock; the drive loop itself is in runner.ts.

import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import type { SandboxRouter } from "../router.js";
import { ConflictError, SandboxRouterError } from "../errors.js";
import { newJobId } from "../ledger.js";
import { isLive } from "../state.js";
import { checkJobSpec, currentBox, effectiveJobState, isTerminal, newJob, transitionJob } from "./state.js";
import { JOB_TAG, jobPolicy, JobRunner } from "./runner.js";
import type { Box, CheckpointStore, JobManagerApi, JobRecord, JobRunOptions, JobSpec, JobView, Lease } from "./types.js";

export interface JobManagerOptions {
  store: CheckpointStore;
  /** Every wait the runner makes (capacity, backoff) goes through this; tests advance a fake clock. */
  sleep?: (ms: number) => Promise<void>;
  /** This process's lease owner id. Default `host:pid:random`. */
  ownerId?: string;
}

export class JobManager implements JobManagerApi {
  readonly ownerId: string;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Jobs this process is driving. A lease can lapse while a long call runs; this keeps us from claiming our own job twice. */
  private readonly driving = new Set<string>();

  constructor(
    private readonly router: SandboxRouter,
    private readonly opts: JobManagerOptions,
  ) {
    this.ownerId = opts.ownerId ?? `${hostname()}:${process.pid}:${randomBytes(4).toString("hex")}`;
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async submit(spec: JobSpec): Promise<JobView> {
    const job = this.checked(spec);
    const id = newJobId();
    const rec = await this.router.ledger.update((d) => (d.jobs[id] = newJob(id, job, this.router.now())));
    return this.view(rec);
  }

  async run(spec: JobSpec, opts?: JobRunOptions): Promise<JobView> {
    const job = this.checked(spec);
    const id = newJobId();
    // Recorded and claimed in one write: a crash right after leaves an orphan that a resume or
    // the sweep picks up, never a queued job that nobody will start.
    const rec = await this.router.ledger.update((d) => {
      const now = this.router.now();
      return (d.jobs[id] = transitionJob(newJob(id, job, now), { type: "claim", lease: this.lease(job, now) }, now, this.ownerId));
    });
    return this.drive(rec, opts);
  }

  async resume(id: string, opts?: JobRunOptions): Promise<JobView> {
    // The claim's lease check runs inside the write: of two runners, one gets a ConflictError.
    const rec = await this.router.ledger.update((d) => {
      const cur = d.jobs[id];
      if (!cur) throw new SandboxRouterError("not_found", `no job ${id}`);
      // How it ended, also while its drive here is still killing the box and pruning.
      if (isTerminal(cur)) return cur;
      if (this.driving.has(id)) throw new ConflictError(`job ${id} is already being driven by this process`);
      const now = this.router.now();
      return (d.jobs[id] = transitionJob(cur, { type: "claim", lease: this.lease(cur.spec, now) }, now, this.ownerId));
    });
    return isTerminal(rec) ? this.view(rec) : this.drive(rec, opts);
  }

  async get(id: string): Promise<JobView | undefined> {
    const rec = (await this.router.ledger.read()).jobs[id];
    return rec && this.view(rec);
  }

  async list(opts: { all?: boolean } = {}): Promise<JobView[]> {
    const data = await this.router.ledger.read();
    return Object.values(data.jobs)
      .filter((r) => opts.all || !isTerminal(r))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((r) => this.view(r));
  }

  async cancel(id: string): Promise<JobView> {
    const { rec, cancelled, box } = await this.router.ledger.update((d): { rec: JobRecord; cancelled: boolean; box?: Box } => {
      const cur = d.jobs[id];
      if (!cur) throw new SandboxRouterError("not_found", `no job ${id}`);
      // Already over: nothing to cancel, and the view says how it ended.
      if (isTerminal(cur)) return { rec: cur, cancelled: false };
      const next = transitionJob(cur, { type: "cancel" }, this.router.now(), this.ownerId);
      d.jobs[id] = next;
      return { rec: next, cancelled: true, box: currentBox(cur) };
    });
    if (cancelled) {
      // Its runner, here or elsewhere, gets a conflict on its next write and stops.
      if (box) await this.router.kill(box.sandboxId).catch(() => undefined);
      // Keep the latest archive for `workspace()`; one the runner saved but can no longer record goes.
      await this.opts.store.prune(id, rec.checkpoint).catch(() => undefined);
    }
    return this.view(rec);
  }

  async workspace(id: string): Promise<Uint8Array | undefined> {
    // A running job prunes the archive it just replaced; re-read when the one we saw went away.
    for (let tries = 0; ; tries++) {
      const rec = (await this.router.ledger.read()).jobs[id];
      if (!rec) throw new SandboxRouterError("not_found", `no job ${id}`);
      if (!rec.checkpoint) return undefined;
      try {
        return await this.opts.store.get(id, rec.checkpoint);
      } catch (err) {
        const now = (await this.router.ledger.read()).jobs[id]?.checkpoint;
        if (tries >= 2 || now?.key === rec.checkpoint.key) throw err;
      }
    }
  }

  async sweep(opts: { resumeOrphans?: boolean } = {}): Promise<{ reaped: number; resumed: number }> {
    const data = await this.router.ledger.read();
    const now = this.router.now();
    const doomed = new Set<string>();
    for (const job of Object.values(data.jobs)) {
      // Boxes a job left or finished with; their kill was best effort.
      const current = currentBox(job)?.sandboxId;
      for (const p of job.placements) if (p.sandboxId !== current) doomed.add(p.sandboxId);
    }
    for (const s of Object.values(data.sandboxes)) {
      const id = s.metadata[JOB_TAG];
      if (!id) continue;
      const job = data.jobs[id];
      // A placing job's runner may be about to record this box, even one whose lease lapsed
      // (nobody claimed it, so its write would still go through). A takeover reaps those.
      if (job?.state === "placing") continue;
      if (!job?.placements.some((p) => p.sandboxId === s.id)) doomed.add(s.id);
    }

    let reaped = 0;
    for (const id of doomed) {
      const s = data.sandboxes[id];
      if (!s || s.state === "creating" || !isLive(s, now)) continue;
      if (await this.router.kill(id).then(() => true, () => false)) reaped++;
    }

    let resumed = 0;
    if (opts.resumeOrphans) {
      for (const job of Object.values(data.jobs)) {
        if (effectiveJobState(job, now) !== "orphaned" || this.driving.has(job.id)) continue;
        // In the background; a conflict means another process claimed it first.
        void this.resume(job.id).catch(() => undefined);
        resumed++;
      }
    }
    return { reaped, resumed };
  }

  private async drive(rec: JobRecord, opts?: JobRunOptions): Promise<JobView> {
    this.driving.add(rec.id);
    try {
      try {
        opts?.onClaimed?.(this.view(rec));
      } catch {
        // A listener's bug must not stop the job.
      }
      const runner = new JobRunner({ router: this.router, store: this.opts.store, sleep: this.sleep, owner: this.ownerId }, rec, opts);
      return this.view(await runner.drive());
    } finally {
      this.driving.delete(rec.id);
    }
  }

  /** Validates the request (including its policy) and keeps a copy the caller can't change later. */
  private checked(spec: JobSpec): JobSpec {
    const problem = checkJobSpec(spec);
    if (problem) throw new SandboxRouterError("invalid", problem);
    jobPolicy(this.router, spec);
    return structuredClone(spec);
  }

  private lease(spec: JobSpec, now: number): Lease {
    return { owner: this.ownerId, until: new Date(now + jobPolicy(this.router, spec).leaseSec * 1000).toISOString() };
  }

  private view(rec: JobRecord): JobView {
    const box = currentBox(rec);
    return {
      id: rec.id,
      name: rec.spec.name,
      state: effectiveJobState(rec, this.router.now()),
      cursor: rec.cursor,
      steps: rec.spec.steps.length,
      provider: box?.provider,
      sandboxId: box?.sandboxId,
      migrations: rec.migrations,
      placements: rec.placements,
      results: rec.results,
      checkpoint: rec.checkpoint,
      history: rec.history,
      error: rec.state === "failed" ? rec.error : undefined,
      result: rec.state === "failed" ? rec.result : undefined,
      createdAt: rec.createdAt,
      updatedAt: rec.updatedAt,
      endedAt: "endedAt" in rec ? rec.endedAt : undefined,
    };
  }
}
