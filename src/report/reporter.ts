// The reporter: sends what the ledger records to a sandboxrouting back end (back/), opt-in with
// `report: { url, token }` in config or SBR_REPORT_URL / SBR_REPORT_TOKEN.
//
// It works from state, not from a stream of calls. After every ledger write (and once at
// startup) it reads the ledger and compares each sandbox, job, mark, provider and health sample
// with what it last queued (the outbox's digests). Whatever changed becomes an event with a
// stable id (`<install>:<seq>`), queued in the durable outbox, then delivered. So:
//
// - Nothing is lost to a crash. A write the reporter never saw is still in the ledger, and the
//   next observation (the next write, or the next process's startup) finds it.
// - Retries are idempotent. An event keeps its id until back acknowledges it; back drops a
//   repeat by that id, and never lets an older state of a thing overwrite a newer one.
// - Routing never waits on back. The ledger write returns first; observing is a local file
//   read and write; delivery has a short timeout and backs off, and the backoff is recorded in
//   the outbox so other processes don't each try a back end that is down.
//
// Several quick writes may reach back as one state: back gets every state the reporter saw,
// with the segments that bill it, not every intermediate step.

import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Ledger, LedgerData } from "../core/ledger.js";
import type { RouterConfig } from "../core/config.js";
import type { ProviderAdapter } from "../core/types.js";
import { effectiveFreeTier, effectivePricing } from "../core/metering.js";
import { isConfigured, isEnabled } from "../core/routing/candidates.js";
import { FileOutbox, type DeliveryState, type Outbox, type OutboxData } from "./outbox.js";
import {
  MAX_BATCH_EVENTS,
  digest,
  entityKey,
  healthSampleKey,
  toWireHealthSample,
  toWireJob,
  toWireMark,
  toWireProvider,
  toWireSandbox,
  type IngestResponse,
  type WireEvent,
  type WireProvider,
} from "./wire.js";

/** Payload of an event, before the reporter gives it an id. */
type EventBody = WireEvent extends infer E ? (E extends WireEvent ? Omit<E, "id" | "seq" | "observedAt"> : never) : never;

const SEND_TIMEOUT_MS = 4_000;
/** How long a claim to send a batch lasts; longer than a send can take. */
const LEASE_MS = 30_000;
const BACKOFF_BASE_MS = 2_000;
const BACKOFF_MAX_MS = 10 * 60_000;
/** Batches per delivery round, so one process doesn't hold the outbox forever. */
const ROUNDS = 20;
/** The outbox never holds more than this; thanks to coalescing it takes a very large ledger to reach. */
const MAX_PENDING = 20_000;

export interface ReportSettings {
  url: string;
  token: string;
  metadataKeys: string[];
}

/** The settings config asks for, or undefined when reporting is off (no url, no token, or `enabled: false`). */
export function reportSettings(config: RouterConfig): ReportSettings | undefined {
  const r = config.report;
  if (!r || r.enabled === false || !r.url || !r.token) return undefined;
  return { url: r.url.replace(/\/+$/, ""), token: r.token, metadataKeys: r.metadataKeys ?? [] };
}

export interface ReporterOptions extends ReportSettings {
  ledger: Ledger;
  outbox: Outbox;
  /** Provider snapshots for the providers that matter to this ledger. */
  providers: (data: LedgerData, priorUsd: Record<string, Record<string, number>>) => WireProvider[];
  now?: () => number;
  fetch?: typeof fetch;
  /** How long one send may take. Default 4 s. */
  sendTimeoutMs?: number;
}

export interface ReportStatus {
  installId: string;
  pending: number;
  delivery: DeliveryState;
  delivered: number;
  dropped: number;
  lastDeliveredAt?: number;
  observeError?: string;
}

export class Reporter {
  private readonly now: () => number;
  private readonly fetch: typeof fetch;
  private readonly owner = `${process.pid}:${randomBytes(4).toString("hex")}`;
  private running?: Promise<void>;
  private again = false;
  private retryTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly opts: ReporterOptions) {
    this.now = opts.now ?? Date.now;
    this.fetch = opts.fetch ?? fetch;
  }

  /**
   * Observe the ledger and deliver, in the background. Never throws and never makes the caller
   * wait. Calls while a round runs fold into one more round after it.
   */
  poke(): void {
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = this.round().finally(() => {
      this.running = undefined;
      if (this.again) {
        this.again = false;
        this.poke();
      }
    });
  }

  /** Observe and deliver now, and wait until this process has nothing more in flight. */
  async flush(): Promise<ReportStatus> {
    this.poke();
    while (this.running) await this.running;
    return this.status();
  }

  async status(): Promise<ReportStatus> {
    const d = await this.opts.outbox.read();
    return {
      installId: d.installId,
      pending: d.pending.length,
      delivery: d.delivery,
      delivered: d.delivered,
      dropped: d.dropped,
      ...(d.lastDeliveredAt === undefined ? {} : { lastDeliveredAt: d.lastDeliveredAt }),
      ...(d.observeError === undefined ? {} : { observeError: d.observeError }),
    };
  }

  private async round(): Promise<void> {
    try {
      await this.observe();
    } catch {
      // The outbox itself may be what is failing (its lock, the disk); the next round tries again.
    }
    try {
      await this.deliver();
    } catch {
      // Same: never a reason to disturb routing.
    }
  }

  /** Queues an event for whatever in the ledger changed since it was last queued. */
  async observe(): Promise<void> {
    await this.opts.outbox.update(async (box) => {
      let data: LedgerData;
      try {
        // Read under the outbox lock: of two processes, the later observer sees the later
        // ledger, so sequence numbers follow the ledger's own order.
        data = await this.opts.ledger.read();
      } catch (err) {
        box.observeError = `reading the ledger: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300);
        return;
      }
      delete box.observeError;
      observeInto(box, data, this.now(), this.opts.metadataKeys, this.opts.providers);
    });
  }

  /** Sends pending events in batches until none are left, another process is sending, or back fails. */
  async deliver(): Promise<void> {
    for (let i = 0; i < ROUNDS; i++) {
      const claim = await this.opts.outbox.update((d) => claimBatch(d, this.owner, this.now()));
      if (!claim) return;
      const outcome = await this.send(claim.install, claim.batch);
      const backoffUntil = await this.opts.outbox.update((d) => settle(d, this.owner, claim.failures, outcome, this.now()));
      if (backoffUntil !== undefined) {
        this.scheduleRetry(backoffUntil);
        return;
      }
    }
  }

  private async send(install: string, events: WireEvent[]): Promise<SendOutcome> {
    try {
      const res = await this.fetch(`${this.opts.url}/v1/ingest`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.opts.token}`, "content-type": "application/json" },
        body: JSON.stringify({ install, events }),
        signal: AbortSignal.timeout(this.opts.sendTimeoutMs ?? SEND_TIMEOUT_MS),
      });
      if (res.status !== 200) {
        await res.body?.cancel().catch(() => undefined);
        return { ok: false, error: `back answered ${res.status}${res.status === 401 || res.status === 403 ? " (check report.token)" : ""}` };
      }
      const body = (await res.json()) as Partial<IngestResponse>;
      if (!Array.isArray(body.results)) return { ok: false, error: "back's answer had no results" };
      return { ok: true, results: body.results };
    } catch (err) {
      const e = err as Error;
      return { ok: false, error: `${e.name === "TimeoutError" ? "timed out" : e.message}`.slice(0, 200) };
    }
  }

  /** A timer that doesn't keep the process alive: a long-lived one retries; a short one leaves it to the next start. */
  private scheduleRetry(until: number): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.poke(), Math.max(0, until - this.now()) + 10);
    this.retryTimer.unref?.();
  }
}

type SendOutcome = { ok: true; results: IngestResponse["results"] } | { ok: false; error: string };

/** Takes the next batch to send, unless there is none or another process (or a backoff) holds delivery. */
export function claimBatch(d: OutboxData, owner: string, now: number): { install: string; batch: WireEvent[]; failures: number } | undefined {
  if (!d.pending.length) return undefined;
  const dl = d.delivery;
  if ((dl.state === "sending" || dl.state === "backoff") && dl.until > now) return undefined;
  const batch = d.pending.slice(0, MAX_BATCH_EVENTS);
  d.delivery = { state: "sending", owner, until: now + LEASE_MS, ids: batch.map((e) => e.id), failures: dl.failures };
  return { install: d.installId, batch, failures: dl.failures };
}

/**
 * Records how a send went. Acknowledged events leave the outbox whatever their outcome (applied,
 * a duplicate, stale, or rejected as invalid: resending those can't help). On failure, delivery
 * backs off, longer each time. Returns the backoff's end, if any.
 */
export function settle(d: OutboxData, owner: string, failuresBefore: number, outcome: SendOutcome, now: number): number | undefined {
  const mine = d.delivery.state === "sending" && d.delivery.owner === owner;
  if (outcome.ok) {
    const acked = new Set(outcome.results.map((r) => r.id));
    const before = d.pending.length;
    d.pending = d.pending.filter((e) => !acked.has(e.id));
    const rejected = outcome.results.filter((r) => r.outcome === "rejected").length;
    d.delivered += before - d.pending.length - rejected;
    d.dropped += rejected;
    d.lastDeliveredAt = now;
    if (mine) d.delivery = { state: "idle", failures: 0 };
    return undefined;
  }
  // Someone else claimed after our lease lapsed: their send decides.
  if (!mine) return undefined;
  const failures = failuresBefore + 1;
  const delay = Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_MAX_MS) * (0.5 + Math.random() / 2);
  const until = now + Math.round(delay);
  d.delivery = { state: "backoff", until, failures, error: outcome.error };
  return until;
}

/** Compares the ledger with what was last queued and queues events for the differences. */
export function observeInto(
  box: OutboxData,
  data: LedgerData,
  now: number,
  metadataKeys: readonly string[],
  providers: ReporterOptions["providers"],
): void {
  // What the ledger had already folded away when reporting began is reported once, per provider.
  box.priorUsd ??= structuredClone(data.archivedUsd ?? {});
  const fresh: WireEvent[] = [];
  const queue = (body: EventBody) => {
    box.seq += 1;
    box.observedAt = Math.max(now, box.observedAt);
    fresh.push({ ...body, id: `${box.installId}:${box.seq}`, seq: box.seq, observedAt: new Date(box.observedAt).toISOString() } as WireEvent);
  };
  const present = new Set<string>();
  const changed = (key: string, payload: unknown) => {
    present.add(key);
    const d = digest(payload);
    if (box.seen[key] === d) return false;
    box.seen[key] = d;
    return true;
  };

  for (const rec of Object.values(data.sandboxes)) {
    const sandbox = toWireSandbox(rec, metadataKeys);
    if (changed(`sandbox:${rec.id}`, sandbox)) queue({ type: "sandbox", sandbox });
  }
  for (const rec of Object.values(data.jobs ?? {})) {
    const job = toWireJob(rec);
    if (changed(`job:${rec.id}`, job)) queue({ type: "job", job });
  }
  for (const m of data.marks) {
    const mark = toWireMark(m);
    if (changed(`mark:${m.provider}:${m.kind}`, mark)) queue({ type: "mark", provider: m.provider, kind: m.kind, mark });
  }
  for (const provider of providers(data, box.priorUsd)) {
    if (changed(`provider:${provider.id}`, provider)) queue({ type: "provider", provider });
  }
  for (const key of Object.keys(box.seen)) {
    if (present.has(key)) continue;
    // A mark that went away was cleared (a free create worked, or `sbr reset`): say so. A
    // sandbox or job that went away was compacted out of the ledger: back keeps what it has.
    const mark = /^mark:([^:]+):(quota|rate_limit|auth)$/.exec(key);
    if (mark) queue({ type: "mark", provider: mark[1]!, kind: mark[2] as "quota" | "rate_limit" | "auth", mark: null });
    delete box.seen[key];
  }

  for (const [provider, samples] of Object.entries(data.health ?? {})) {
    const seen = new Set(box.healthSeen[provider] ?? []);
    const keys: string[] = [];
    const counts = new Map<string, number>();
    for (const s of samples) {
      const sample = toWireHealthSample(s);
      const base = healthSampleKey(sample);
      const occurrence = counts.get(base) ?? 0;
      counts.set(base, occurrence + 1);
      const key = healthSampleKey(sample, occurrence);
      keys.push(key);
      if (!seen.has(key)) queue({ type: "health", provider, sample, ...(occurrence ? { occurrence } : {}) });
    }
    box.healthSeen[provider] = keys;
  }
  for (const provider of Object.keys(box.healthSeen)) if (!data.health?.[provider]) delete box.healthSeen[provider];

  if (!fresh.length) return;
  // A newer state of a thing supersedes its older pending one: back would refuse it as stale anyway.
  const superseded = new Set(fresh.filter((e) => e.type !== "health").map(entityKey));
  const kept = box.pending.filter((e) => e.type === "health" || !superseded.has(entityKey(e)));
  box.pending = [...kept, ...fresh];
  if (box.pending.length > MAX_PENDING) {
    const over = box.pending.length - MAX_PENDING;
    box.pending = box.pending.slice(over);
    box.dropped += over;
  }
}

/** Provider snapshots from the router's adapters and config: those this ledger mentions, and those set up here. */
export function providerSnapshots(
  adapters: ProviderAdapter[],
  config: RouterConfig,
  env: Record<string, string | undefined>,
): ReporterOptions["providers"] {
  return (data, priorUsd) => {
    const mentioned = new Set<string>([
      ...Object.values(data.sandboxes).map((r) => r.provider),
      ...data.marks.map((m) => m.provider),
      ...Object.keys(data.health ?? {}),
      ...Object.values(data.jobs ?? {}).flatMap((j) => j.placements.map((p) => p.provider)),
    ]);
    const out: WireProvider[] = [];
    for (const a of adapters) {
      const cfg = config.providers[a.info.id];
      const enabled = isEnabled(a.info, cfg);
      const configured = isConfigured(a, { env, options: cfg?.options ?? {} });
      if (!mentioned.has(a.info.id) && !(enabled && configured)) continue;
      const concurrency = cfg?.concurrency ?? a.info.freeTier.concurrency;
      out.push(
        toWireProvider({
          id: a.info.id,
          name: a.info.name,
          selfHosted: Boolean(a.info.selfHosted),
          enabled,
          configured,
          freeTier: effectiveFreeTier(a.info, cfg),
          ...(cfg?.usedBeforeUsd === undefined ? {} : { usedBeforeUsd: cfg.usedBeforeUsd }),
          pricing: effectivePricing(a.info, cfg),
          ...(concurrency === undefined ? {} : { concurrency }),
          circuitBreaker: config.routing.circuitBreaker,
          healthSamples: config.routing.healthSamples,
          priorUsd: priorUsd[a.info.id] ?? {},
        }),
      );
    }
    return out;
  };
}

/** A ledger that tells the reporter after every write. Reads and writes are the inner ledger's, unchanged. */
export class ReportingLedger implements Ledger {
  constructor(
    readonly inner: Ledger,
    readonly reporter: Reporter,
  ) {}

  read(): Promise<LedgerData> {
    return this.inner.read();
  }

  async update<T>(fn: (data: LedgerData) => T | Promise<T>): Promise<T> {
    const out = await this.inner.update(fn);
    this.reporter.poke();
    return out;
  }
}

export interface ReportingOptions {
  config: RouterConfig;
  env: Record<string, string | undefined>;
  /** `$SBR_HOME`; the outbox lives at `<home>/report/outbox.json`. */
  home: string;
  /** The router's adapters. A function, since the router is made after its ledger. */
  providers: () => ProviderAdapter[];
  now?: () => number;
  outbox?: Outbox;
  fetch?: typeof fetch;
}

/**
 * Wraps `inner` so it reports, when config turns reporting on; returns `inner` itself otherwise.
 * The first observation runs once the current call stack is done, so the router exists by then.
 */
export function reportingLedger(inner: Ledger, opts: ReportingOptions): Ledger {
  const settings = reportSettings(opts.config);
  if (!settings) return inner;
  const reporter = new Reporter({
    ...settings,
    ledger: inner,
    outbox: opts.outbox ?? new FileOutbox(join(opts.home, "report", "outbox.json")),
    providers: (data, prior) => providerSnapshots(opts.providers(), opts.config, opts.env)(data, prior),
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
  // Startup reconciliation: whatever an earlier process wrote and never reported.
  setImmediate(() => reporter.poke());
  return new ReportingLedger(inner, reporter);
}
