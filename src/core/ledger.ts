// The router's local state: which sandboxes it created, their lifecycle and billing
// segments, and marks on providers (quota used up, rate limited, bad key). Shared by the
// SDK, CLI, REST server and MCP server, which may run at the same time, so every
// load-modify-save holds a lock and every write is whole (temp file + rename).

import { mkdir, readFile, rename, rm, stat, writeFile, open } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { validateRecord, type SandboxRecord } from "./state.js";
import type { ErrorKind } from "./errors.js";
import type { JobRecord } from "./jobs/types.js";
import { validateJob } from "./jobs/state.js";

export type MarkKind = "quota" | "rate_limit" | "auth";

/**
 * One infrastructure outcome on a provider: a create that worked (with its latency), a create
 * that failed for a transient reason, or a box lost before its deadline. Health and the
 * circuit breaker are derived from these on read (src/core/health.ts); nothing stores a verdict.
 */
export interface HealthSample {
  at: string;
  op: "create" | "lost";
  ok: boolean;
  /** Create latency, for successful creates. */
  ms?: number;
  kind?: ErrorKind;
}

export interface ProviderMark {
  provider: string;
  kind: MarkKind;
  at: string;
  /** When the mark stops applying. Evaluated on read; nothing has to clear it. */
  until: string;
  detail?: string;
}

export interface LedgerData {
  version: 1;
  sandboxes: Record<string, SandboxRecord>;
  marks: ProviderMark[];
  /**
   * Spend folded out of old finished records by compaction, per provider: all-time USD
   * (for one-time credits) by the month it happened in, e.g. { e2b: { "2026-09": 1.2 } }.
   */
  archivedUsd: Record<string, Record<string, number>>;
  /** Recent infrastructure outcomes per provider, oldest first, capped at `routing.healthSamples`. */
  health: Record<string, HealthSample[]>;
  /** Jobs: steps plus a workdir that can move between boxes. Lifecycle in jobs/state.ts. */
  jobs: Record<string, JobRecord>;
}

export const emptyLedger = (): LedgerData => ({ version: 1, sandboxes: {}, marks: [], archivedUsd: {}, health: {}, jobs: {} });

export interface Ledger {
  read(): Promise<LedgerData>;
  /** Runs `fn` under the lock on fresh data; what it returns is saved if it mutated. */
  update<T>(fn: (data: LedgerData) => T | Promise<T>): Promise<T>;
}

export function defaultHome(env: Record<string, string | undefined> = process.env): string {
  return env["SBR_HOME"] ?? join(homedir(), ".sandboxrouting");
}

/** In-memory ledger, for tests and for embedding without touching disk. */
export class MemoryLedger implements Ledger {
  private data = emptyLedger();
  private queue: Promise<unknown> = Promise.resolve();
  async read(): Promise<LedgerData> {
    return structuredClone(this.data);
  }
  update<T>(fn: (data: LedgerData) => T | Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const draft = structuredClone(this.data);
      const out = await fn(draft);
      this.data = draft;
      return out;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}

const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 15_000;

export class FileLedger implements Ledger {
  readonly path: string;
  private readonly lockPath: string;

  constructor(path = join(defaultHome(), "ledger.json")) {
    this.path = path;
    this.lockPath = `${path}.lock`;
  }

  async read(): Promise<LedgerData> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyLedger();
      throw err;
    }
    const data = JSON.parse(raw) as LedgerData;
    if (data.version !== 1) throw new Error(`${this.path}: unknown ledger version ${String(data.version)}`);
    // Ledgers written before these fields existed read as empty ones; the next write adds them.
    data.archivedUsd ??= {};
    data.health ??= {};
    data.jobs ??= {};
    for (const rec of Object.values(data.sandboxes)) {
      const problem = validateRecord(rec);
      if (problem) throw new Error(`${this.path}: sandbox ${rec.id}: ${problem}`);
    }
    for (const job of Object.values(data.jobs)) {
      const problem = validateJob(job);
      if (problem) throw new Error(`${this.path}: job ${job.id}: ${problem}`);
    }
    return data;
  }

  async update<T>(fn: (data: LedgerData) => T | Promise<T>): Promise<T> {
    await mkdir(dirname(this.path), { recursive: true });
    await this.lock();
    try {
      const data = await this.read();
      const before = JSON.stringify(data);
      const out = await fn(data);
      const after = JSON.stringify(data, null, 2);
      if (JSON.stringify(data) !== before) await this.writeWhole(after);
      return out;
    } finally {
      await rm(this.lockPath, { force: true });
    }
  }

  private async writeWhole(content: string): Promise<void> {
    const tmp = `${this.path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      const fh = await open(tmp, "w", 0o600);
      try {
        await fh.writeFile(content);
        await fh.sync();
      } finally {
        await fh.close();
      }
      await rename(tmp, this.path);
    } catch (err) {
      // Every outcome clears the temp file, not just success.
      await rm(tmp, { force: true }).catch(() => undefined);
      throw err;
    }
  }

  private async lock(): Promise<void> {
    const started = Date.now();
    for (;;) {
      try {
        // O_EXCL create: exactly one process wins.
        await writeFile(this.lockPath, `${process.pid} ${new Date().toISOString()}`, { flag: "wx" });
        return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
      try {
        const st = await stat(this.lockPath);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          // A crashed holder left it behind. Rename-then-remove so two waiters can't both steal it.
          const stolen = `${this.lockPath}.stale.${randomBytes(4).toString("hex")}`;
          await rename(this.lockPath, stolen).then(() => rm(stolen, { force: true }), () => undefined);
          continue;
        }
      } catch {
        continue; // vanished between our create and stat: retry at once
      }
      if (Date.now() - started > LOCK_WAIT_MS) throw new Error(`timed out waiting for ${this.lockPath}`);
      await new Promise((r) => setTimeout(r, 25 + Math.random() * 50));
    }
  }
}

export function newSandboxId(): string {
  return `sbr_${randomBytes(9).toString("base64url")}`;
}

export function newJobId(): string {
  return `job_${randomBytes(9).toString("base64url")}`;
}
