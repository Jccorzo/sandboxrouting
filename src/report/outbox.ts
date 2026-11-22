// The reporter's durable state: which install this is, what it last sent about each thing in
// the ledger, the events still to deliver, and where delivery stands. One JSON file, written
// whole (temp file + rename) under an O_EXCL lock, the way the ledger is (src/core/ledger.ts):
// several router processes (SDK, CLI, REST, MCP) share it.
//
// Delivery is an explicit state, decided in reporter.ts and stored here:
//
//   idle ──claim──▶ sending ──2xx──▶ idle
//    ▲                │  └──error──▶ backoff ──its until passes──▶ (claimable, like idle)
//    └────────────────┘ a sending lease that lapsed (its process died) is claimable too

import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import type { WireEvent } from "./wire.js";

export type DeliveryState =
  | { state: "idle"; failures: 0 }
  /** A process is sending `ids` until `until` (ms). A lapsed lease means it died: anyone may claim. */
  | { state: "sending"; owner: string; until: number; ids: string[]; failures: number }
  /** The last send failed; nobody sends before `until` (ms). */
  | { state: "backoff"; until: number; failures: number; error: string };

export interface OutboxData {
  version: 1;
  /** Random, made once; with `seq` it gives every event its stable id. */
  installId: string;
  /** The last sequence number handed out. */
  seq: number;
  /** The last `observedAt` handed out (ms). Never goes back, even if the clock does. */
  observedAt: number;
  /** Per thing in the ledger (`sandbox:<id>`, `job:<id>`, `mark:<p>:<kind>`, `provider:<id>`): digest of what was last queued. */
  seen: Record<string, string>;
  /** Per provider: keys of the health samples already queued (the ledger keeps at most `healthSamples` of them). */
  healthSeen: Record<string, string[]>;
  /**
   * The ledger's folded monthly spend (`archivedUsd`) when reporting began: spend back never saw
   * record by record. Undefined until the first observation.
   */
  priorUsd?: Record<string, Record<string, number>>;
  /** Events not yet acknowledged by back, oldest first. */
  pending: WireEvent[];
  delivery: DeliveryState;
  /** Counters, for `status()`. */
  delivered: number;
  /** Events back refused as invalid (dropped so they can't block the rest), or dropped at the cap. */
  dropped: number;
  lastDeliveredAt?: number;
  /** Why the last observation failed, if it did; cleared by the next one that works. */
  observeError?: string;
}

export const newOutbox = (): OutboxData => ({
  version: 1,
  installId: `ins_${randomBytes(12).toString("base64url")}`,
  seq: 0,
  observedAt: 0,
  seen: {},
  healthSeen: {},
  pending: [],
  delivery: { state: "idle", failures: 0 },
  delivered: 0,
  dropped: 0,
});

export interface Outbox {
  read(): Promise<OutboxData>;
  /** Runs `fn` under the lock on fresh data and saves what it leaves, whole. */
  update<T>(fn: (data: OutboxData) => T | Promise<T>): Promise<T>;
}

export class MemoryOutbox implements Outbox {
  private data = newOutbox();
  private queue: Promise<unknown> = Promise.resolve();
  async read(): Promise<OutboxData> {
    return structuredClone(this.data);
  }
  update<T>(fn: (data: OutboxData) => T | Promise<T>): Promise<T> {
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

export class FileOutbox implements Outbox {
  private readonly lockPath: string;

  constructor(readonly path: string) {
    this.lockPath = `${path}.lock`;
  }

  async read(): Promise<OutboxData> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return newOutbox();
      throw err;
    }
    const data = parse(raw);
    if (data) return data;
    // Unreadable (a disk problem, a hand edit): set it aside and start over rather than stop
    // reporting for good. A new install id keeps the new events' ids from clashing with old ones.
    await rename(this.path, `${this.path}.corrupt-${Date.now()}`).catch(() => undefined);
    return newOutbox();
  }

  async update<T>(fn: (data: OutboxData) => T | Promise<T>): Promise<T> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await this.lock();
    try {
      const data = await this.read();
      const before = JSON.stringify(data);
      const out = await fn(data);
      const after = JSON.stringify(data);
      if (after !== before) await this.writeWhole(after);
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
      await rm(tmp, { force: true }).catch(() => undefined);
      throw err;
    }
  }

  private async lock(): Promise<void> {
    const started = Date.now();
    for (;;) {
      try {
        await writeFile(this.lockPath, `${process.pid} ${new Date().toISOString()}`, { flag: "wx" });
        return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
      try {
        const st = await stat(this.lockPath);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          const stolen = `${this.lockPath}.stale.${randomBytes(4).toString("hex")}`;
          await rename(this.lockPath, stolen).then(() => rm(stolen, { force: true }), () => undefined);
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() - started > LOCK_WAIT_MS) throw new Error(`timed out waiting for ${this.lockPath}`);
      await new Promise((r) => setTimeout(r, 25 + Math.random() * 50));
    }
  }
}

function parse(raw: string): OutboxData | undefined {
  try {
    const d = JSON.parse(raw) as Partial<OutboxData>;
    if (d.version !== 1 || typeof d.installId !== "string" || !Array.isArray(d.pending) || typeof d.seq !== "number") return undefined;
    return {
      ...newOutbox(),
      ...d,
      seen: d.seen ?? {},
      healthSeen: d.healthSeen ?? {},
      delivery: d.delivery ?? { state: "idle", failures: 0 },
    } as OutboxData;
  } catch {
    return undefined;
  }
}
