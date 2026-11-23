// The router: picks a provider for each new sandbox (with a switchable strategy, free usage
// first by default), fails over when a provider refuses, records every sandbox's lifecycle and
// every provider's infrastructure outcomes in the ledger, and routes later calls on a sandbox
// back to the provider that owns it. Jobs (router.jobs) build on it to move work between boxes.

import { join } from "node:path";
import { ISOLATION_STRENGTH, SANDBOX_OS, type CreatedSandbox, type ProviderAdapter, type ProviderContext, type ProviderUsage, type ResolvedSpec, type SandboxSpec } from "./types.js";
import { parseConfig, strategyNameFor, type RouterConfig } from "./config.js";
import { defaultHome, FileLedger, MemoryLedger, newSandboxId, type HealthSample, type Ledger, type LedgerData, type MarkKind } from "./ledger.js";
import { classify, NoProviderAvailableError, SandboxRouterError, type RouteAttempt } from "./errors.js";
import { effectiveState, isLive, transition, type EffectiveState, type SandboxEvent, type SandboxRecord } from "./state.js";
import { billableSeconds, effectivePricing, freeStatus, monthKey, monthWindow, ratePerSecond, type FreeStatus } from "./metering.js";
import { availability, freeCreateWorked, markRefusal, refusalKind, type Availability } from "./marks.js";
import { billingProblem, eligibility, isConfigured, isEnabled, plan, type Plan } from "./policy.js";
import { holdProblem } from "./routing/candidates.js";
import type { PolicyInput, ProviderHealth, RoutingStrategy } from "./routing/types.js";
import { StrategyRegistry } from "./routing/registry.js";
import { providerHealth, recordHealth } from "./health.js";
import { Sandbox } from "./sandbox.js";
import type { CheckpointStore } from "./jobs/types.js";
import { FileCheckpointStore, MemoryCheckpointStore } from "./jobs/checkpoint.js";
import { moveSandbox } from "./jobs/move.js";
import { JobManager } from "./jobs/manager.js";

export interface RouterOptions {
  config?: RouterConfig | unknown;
  providers?: ProviderAdapter[];
  ledger?: Ledger;
  env?: Record<string, string | undefined>;
  /** Clock, for tests. Server state uses one clock: this one. */
  now?: () => number;
  /** Strategies to add to the built-ins (free-first, cheapest, balanced, fastest, spread). */
  strategies?: RoutingStrategy[];
  /** Where job checkpoints live. Default: in memory (createRouter uses $SBR_HOME/checkpoints). */
  checkpoints?: CheckpointStore;
  /**
   * At most this many sandboxes live (creating or running) at once, across every provider. A
   * create past it is refused with a quota error, decided in the write that reserves the slot.
   * The hosted router sets it per account. Default: no limit.
   */
  maxLive?: number;
}

export interface ProviderStatus {
  id: string;
  name: string;
  configured: boolean;
  enabled: boolean;
  selfHosted: boolean;
  free: FreeStatus;
  availability: Availability;
  /** Recent infrastructure outcomes and the circuit breaker, derived on read. */
  health: ProviderHealth;
  live: number;
  concurrency?: number;
  capabilities: string[];
  isolation?: string;
  freeTierNotes?: string;
  missingEnv: string[];
}

export interface SandboxView {
  id: string;
  provider: string;
  providerSandboxId?: string;
  state: EffectiveState;
  cpu: number;
  memoryMiB: number;
  createdAt: string;
  expiresAt?: string;
  endedAt?: string;
  costUsd: number;
  metadata: Record<string, string>;
  error?: string;
}

const DAY = 86_400_000;
const until = (t: number | undefined) => (t === undefined ? {} : { until: t });

export class SandboxRouter {
  readonly config: RouterConfig;
  readonly ledger: Ledger;
  readonly checkpoints: CheckpointStore;
  private readonly adapters = new Map<string, ProviderAdapter>();
  private readonly registry: StrategyRegistry;
  private readonly env: Record<string, string | undefined>;
  readonly now: () => number;
  private usageCache = new Map<string, { at: number; usage: ProviderUsage }>();
  private jobManager?: JobManager;
  private readonly maxLive?: number;

  constructor(opts: RouterOptions = {}) {
    this.config = parseConfig(opts.config ?? {});
    this.ledger = opts.ledger ?? new MemoryLedger();
    this.env = opts.env ?? process.env;
    this.now = opts.now ?? Date.now;
    this.checkpoints = opts.checkpoints ?? new MemoryCheckpointStore(this.now);
    if (opts.maxLive !== undefined) this.maxLive = opts.maxLive;
    this.registry = new StrategyRegistry();
    for (const s of opts.strategies ?? []) this.registry.register(s);
    for (const p of opts.providers ?? []) this.register(p);
  }

  /** Adds a provider. Adding one is this call plus an adapter file; nothing else changes. */
  register(adapter: ProviderAdapter): this {
    if (this.adapters.has(adapter.info.id)) throw new Error(`provider "${adapter.info.id}" is already registered`);
    this.adapters.set(adapter.info.id, adapter);
    return this;
  }

  /** Adds a routing strategy; use it with `routing.strategy` in config or `strategy` in a request. */
  registerStrategy(strategy: RoutingStrategy): this {
    this.registry.register(strategy);
    return this;
  }

  /** Every strategy this router knows, built-in and registered. */
  strategies(): RoutingStrategy[] {
    return this.registry.list();
  }

  /** The strategy a request would use (its own `strategy`, else config). Throws if unknown. */
  strategyFor(spec: SandboxSpec = {}): RoutingStrategy {
    return this.registry.get(strategyNameFor(this.config, spec));
  }

  providers(): ProviderAdapter[] {
    return [...this.adapters.values()];
  }

  adapter(id: string): ProviderAdapter {
    const a = this.adapters.get(id);
    if (!a) throw new SandboxRouterError("invalid", `unknown provider "${id}"`);
    return a;
  }

  ctxFor(adapter: ProviderAdapter): ProviderContext {
    return { env: this.env, options: this.config.providers[adapter.info.id]?.options ?? {} };
  }

  /** Jobs: steps plus a workdir that move between boxes when one fails or runs out. */
  get jobs(): JobManager {
    return (this.jobManager ??= new JobManager(this, { store: this.checkpoints }));
  }

  /** Copies a sandbox's workdir to a new box (routed like `create`) and kills the old one. */
  move(id: string, opts: { workdir?: string; spec?: SandboxSpec } = {}): Promise<Sandbox> {
    return moveSandbox(this, id, opts);
  }

  // ------------------------------------------------------------------ routing

  resolve(spec: SandboxSpec): ResolvedSpec {
    if (spec.minIsolation !== undefined && !Object.hasOwn(ISOLATION_STRENGTH, spec.minIsolation)) {
      // Unknown, it would compare as weaker than nothing and match every provider.
      throw new SandboxRouterError("invalid", `minIsolation "${spec.minIsolation}" is not one of ${Object.keys(ISOLATION_STRENGTH).join(", ")}`);
    }
    if (spec.os !== undefined && !SANDBOX_OS.includes(spec.os)) {
      throw new SandboxRouterError("invalid", `os "${spec.os}" is not one of ${SANDBOX_OS.join(", ")}`);
    }
    const d = this.config.defaults;
    return {
      ...spec,
      cpu: spec.cpu ?? d.cpu ?? 0,
      memoryMiB: spec.memoryMiB ?? d.memoryMiB ?? 0,
      timeoutSec: spec.timeoutSec ?? d.timeoutSec,
      env: spec.env ?? {},
      metadata: spec.metadata ?? {},
    };
  }

  /** Per-provider resolution: fills the provider's default size and native template. */
  private resolveFor(spec: ResolvedSpec, adapter: ProviderAdapter, id: string): ResolvedSpec {
    const pricing = adapter.info.pricing;
    return {
      ...spec,
      cpu: spec.cpu || pricing.defaultCpu,
      memoryMiB: spec.memoryMiB || pricing.defaultMemoryMiB,
      nativeTemplate: spec.template?.[adapter.info.id],
      metadata: { ...spec.metadata, "sandboxrouting.id": id },
    };
  }

  /** The ranked plan for a request, without creating anything. */
  async plan(spec: SandboxSpec = {}): Promise<Plan> {
    const data = await this.ledger.read();
    return this.planWith(data, this.resolve(spec));
  }

  private policyInput(data: LedgerData, spec: ResolvedSpec): PolicyInput {
    // Size-dependent ranking needs a size; use a common one when the request leaves it unset.
    const sized = { ...spec, cpu: spec.cpu || 2, memoryMiB: spec.memoryMiB || 2048 };
    return {
      adapters: this.providers(),
      config: this.config,
      data,
      spec: sized,
      requested: { cpu: spec.cpu, memoryMiB: spec.memoryMiB },
      now: this.now(),
      ctxFor: (a) => this.ctxFor(a),
      reported: Object.fromEntries([...this.usageCache].map(([k, v]) => [k, v.usage])),
    };
  }

  private planWith(data: LedgerData, spec: ResolvedSpec): Plan {
    return plan({ ...this.policyInput(data, spec), strategy: this.strategyFor(spec) });
  }

  async create(spec: SandboxSpec = {}): Promise<Sandbox> {
    await this.sweepLocal();
    const resolved = this.resolve(spec);
    const first = this.planWith(await this.ledger.read(), resolved);
    const attempts: RouteAttempt[] = first.skipped.map((s) => ({ provider: s.provider, outcome: "skipped", detail: s.reason, ...until(s.until) }));
    const keep = this.config.routing.healthSamples;

    for (const entry of first.ordered) {
      const adapter = this.adapter(entry.provider);
      const id = newSandboxId();
      const forProvider = this.resolveFor(resolved, adapter, id);

      // Reserve under the lock: re-check this provider on fresh data so two callers can't both
      // take the last free slot or the last of a budget. A request planned as free never
      // quietly becomes paid: it moves on to the next candidate, which may still be free.
      const reserved = await this.ledger.update((data): true | { reason: string; until?: number } => {
        if (this.maxLive !== undefined) {
          const now = this.now();
          const live = Object.values(data.sandboxes).filter((r) => isLive(r, now)).length;
          // Not this provider's refusal, so no mark: nothing changes until a sandbox ends.
          if (live >= this.maxLive) throw new SandboxRouterError("quota", `${live} sandboxes are live, and this account may have at most ${this.maxLive} at once; kill one first`);
        }
        const again = eligibility(this.policyInput(data, resolved), entry.provider);
        if (!again.ok) return again;
        const problem = billingProblem(again.candidate, entry.billing);
        // Lost to a parallel request: capacity that may come back at any time.
        if (problem) return { reason: `planned as ${entry.billing}, but ${problem}`, until: this.now() };
        data.sandboxes[id] = {
          id,
          provider: entry.provider,
          state: "creating",
          cpu: forProvider.cpu,
          memoryMiB: forProvider.memoryMiB,
          createdAt: new Date(this.now()).toISOString(),
          metadata: forProvider.metadata,
          billing: entry.billing,
          timeoutSec: forProvider.timeoutSec,
        };
        return true;
      });
      if (reserved !== true) {
        attempts.push({ provider: entry.provider, outcome: "skipped", detail: reserved.reason, ...until(reserved.until) });
        continue;
      }

      const started = this.now();
      let made: CreatedSandbox;
      try {
        made = await adapter.create(forProvider, this.ctxFor(adapter));
      } catch (raw) {
        const err = classify(raw, entry.provider);
        // One write for the failed record and its sample or mark: a refused probe of a half-open
        // free tier and the mark that renews it land together, so no plan sees the tier half-open
        // with nothing in flight and sends another create into the same refusal.
        const marked = await this.ledger.update((data) => {
          const now = this.now();
          const rec = data.sandboxes[id];
          // A create this slow may already be recorded as lost by the sweep.
          if (rec?.state === "creating") data.sandboxes[id] = transition(rec, { type: "createFailed", error: err.message }, now);
          // Only infrastructure trouble counts toward health; refusals have their own marks.
          if (err.kind === "transient") recordHealth(data, entry.provider, { at: new Date(now).toISOString(), op: "create", ok: false, kind: err.kind }, keep);
          return this.mark(data, entry.provider, err, now);
        });
        // A refusal lapses with its mark; a transient failure may pass at once (the circuit breaker
        // benches a provider that keeps failing); anything else won't change by waiting.
        const retry = marked ?? (err.kind === "transient" ? this.now() : undefined);
        attempts.push({ provider: entry.provider, outcome: "failed", kind: err.kind, detail: err.message.slice(0, 300), ...until(retry) });
        continue;
      }

      // The box exists, and until this write lands nothing else knows its id. Its failure is the
      // ledger's, not the provider's, so it gets its own handling instead of the catch above.
      let problem: string | undefined;
      try {
        problem = await this.ledger.update((data) => {
          const rec = data.sandboxes[id];
          // The sweep records a create as lost after 10 minutes; this one took longer.
          if (rec?.state !== "creating") return `its record was already ${rec?.state ?? "gone"}`;
          const now = this.now();
          data.sandboxes[id] = transition(
            rec,
            { type: "created", providerSandboxId: made.providerSandboxId, timeoutSec: forProvider.timeoutSec, cpu: made.cpu, memoryMiB: made.memoryMiB },
            now,
          );
          recordHealth(data, entry.provider, { at: new Date(now).toISOString(), op: "create", ok: true, ms: Math.max(0, now - started) }, keep);
          // A free create that works is what a half-open free tier was waiting for: it's back.
          if (rec.billing === "free") freeCreateWorked(data, entry.provider, now);
          return undefined;
        });
      } catch (err) {
        problem = `recording it failed: ${err instanceof Error ? err.message : String(err)}`;
      }
      if (problem === undefined) {
        attempts.push({ provider: entry.provider, outcome: "created", detail: entry.lane, lane: entry.lane, billing: entry.billing });
        return new Sandbox(this, id, entry.provider, made.providerSandboxId, attempts);
      }
      const error = `created ${made.providerSandboxId}, but ${problem}`;
      await this.discard(adapter, id, made.providerSandboxId, error);
      // Nothing to wait for: the next candidate, or a retry, may work at once.
      attempts.push({ provider: entry.provider, outcome: "failed", kind: "transient", detail: error.slice(0, 300), until: this.now() });
    }
    throw new NoProviderAvailableError(attempts);
  }

  /**
   * A box the provider made that nobody will use: its record couldn't be written, or the sweep
   * gave up on its create. Its id goes on the record before the kill, so a kill that fails, or a
   * crash in between, leaves the remote sweep something to reap.
   */
  private async discard(adapter: ProviderAdapter, id: string, providerSandboxId: string, error: string): Promise<void> {
    await this.ledger
      .update((data) => {
        const rec = data.sandboxes[id];
        const now = this.now();
        if (rec?.state === "running" || rec?.state === "paused") {
          // The "created" write landed after all; what failed came after it.
          data.sandboxes[id] = transition(rec, { type: "stopped", reason: "killed" }, now);
        } else if (rec?.state === "creating" || (rec?.state === "failed" && rec.providerSandboxId === undefined)) {
          data.sandboxes[id] = transition(rec, { type: "createFailed", error, providerSandboxId }, now);
        }
      })
      .catch(() => undefined); // the ledger may be what is failing; the kill goes ahead anyway
    await adapter.kill(providerSandboxId, this.ctxFor(adapter)).catch(() => undefined);
  }

  /** Reattach to a sandbox by router id, or adopt one by `provider:providerSandboxId`. */
  async connect(id: string): Promise<Sandbox> {
    const rec = (await this.ledger.read()).sandboxes[id];
    if (rec) {
      if (rec.state === "creating") throw new SandboxRouterError("invalid", `${id} is still being created`);
      if (!rec.providerSandboxId) throw new SandboxRouterError("not_found", `${id} never started (${rec.state})`);
      return new Sandbox(this, id, rec.provider, rec.providerSandboxId, []);
    }
    const sep = id.indexOf(":");
    if (sep > 0) {
      const provider = id.slice(0, sep);
      const psid = id.slice(sep + 1);
      const adapter = this.adapter(provider);
      const routerId = newSandboxId();
      // Adopted sandboxes are metered from now with the provider's default size.
      await this.ledger.update((data) => {
        const now = this.now();
        data.sandboxes[routerId] = transition(
          {
            id: routerId,
            provider,
            state: "creating",
            cpu: adapter.info.pricing.defaultCpu,
            memoryMiB: adapter.info.pricing.defaultMemoryMiB,
            createdAt: new Date(now).toISOString(),
            metadata: { adopted: "true" },
          },
          { type: "created", providerSandboxId: psid, timeoutSec: this.config.defaults.timeoutSec },
          now,
        );
      });
      return new Sandbox(this, routerId, provider, psid, []);
    }
    throw new SandboxRouterError("not_found", `no sandbox ${id}`);
  }

  async get(id: string): Promise<SandboxView | undefined> {
    const data = await this.ledger.read();
    const rec = data.sandboxes[id];
    return rec ? this.view(rec, this.now()) : undefined;
  }

  async list(opts: { all?: boolean } = {}): Promise<SandboxView[]> {
    const data = await this.ledger.read();
    const now = this.now();
    return Object.values(data.sandboxes)
      .filter((r) => opts.all || isLive(r, now) || r.state === "paused")
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((r) => this.view(r, now));
  }

  async kill(id: string): Promise<void> {
    const sbx = await this.connect(id);
    await sbx.kill();
  }

  // ------------------------------------------------------------------ status

  async status(opts: { refreshUsage?: boolean } = {}): Promise<ProviderStatus[]> {
    if (opts.refreshUsage) await this.refreshUsage();
    const data = await this.ledger.read();
    const now = this.now();
    return this.providers().map((a) => {
      const cfg = this.config.providers[a.info.id];
      const ctx = this.ctxFor(a);
      return {
        id: a.info.id,
        name: a.info.name,
        configured: isConfigured(a, ctx),
        enabled: isEnabled(a.info, cfg),
        selfHosted: Boolean(a.info.selfHosted),
        free: freeStatus(a.info, cfg, data, now, this.usageCache.get(a.info.id)?.usage),
        availability: availability(data, a.info.id, now),
        health: providerHealth(data, a.info.id, now, this.config.routing.circuitBreaker),
        live: Object.values(data.sandboxes).filter((r) => r.provider === a.info.id && isLive(r, now)).length,
        concurrency: cfg?.concurrency ?? a.info.freeTier.concurrency,
        capabilities: a.info.capabilities,
        isolation: cfg?.isolation ?? a.info.isolation,
        freeTierNotes: a.info.freeTier.notes,
        missingEnv: a.info.env.filter((e) => !ctx.env[e]),
      };
    });
  }

  /** Asks providers that have a usage API how much free credit is left. Cached 5 minutes. */
  async refreshUsage(): Promise<void> {
    const now = this.now();
    await Promise.all(
      this.providers().map(async (a) => {
        if (!a.usage || !isConfigured(a, this.ctxFor(a))) return;
        const cached = this.usageCache.get(a.info.id);
        if (cached && now - cached.at < 300_000) return;
        try {
          this.usageCache.set(a.info.id, { at: now, usage: await a.usage(this.ctxFor(a)) });
        } catch {
          // Usage APIs are advisory; the local ledger still meters.
        }
      }),
    );
  }

  /** Clears marks on a provider (e.g. after topping up credit or fixing a key), and its health history. */
  async clearMarks(provider: string, kind?: MarkKind): Promise<void> {
    await this.ledger.update((data) => {
      data.marks = data.marks.filter((m) => m.provider !== provider || (kind !== undefined && m.kind !== kind));
      if (kind === undefined) delete data.health[provider];
    });
  }

  // ------------------------------------------------------------------ lifecycle bookkeeping

  /** Applies a lifecycle event under the lock. The transition table lives in state.ts. */
  async apply(id: string, ev: SandboxEvent): Promise<SandboxRecord> {
    return this.ledger.update((data) => {
      const rec = data.sandboxes[id];
      if (!rec) throw new SandboxRouterError("not_found", `no sandbox ${id} in the ledger`);
      const next = transition(rec, ev, this.now());
      data.sandboxes[id] = next;
      return next;
    });
  }

  /** Records a kill: a running or paused sandbox becomes stopped ("killed"); any other stays as it is. */
  async recordKill(id: string): Promise<void> {
    await this.ledger.update((data) => {
      const rec = data.sandboxes[id];
      if (rec?.state === "running" || rec?.state === "paused") data.sandboxes[id] = transition(rec, { type: "stopped", reason: "killed" }, this.now());
    });
  }

  /**
   * Moves a running sandbox's deadline to `timeoutSec` from now, in the same write as the check
   * that what it may then spend still fits its free tier or the month's budget (holdProblem).
   * Throws a quota error, changing nothing, when it doesn't. Returns the old deadline, so a
   * provider that then refuses can be given it back (`restoreDeadline`).
   */
  async reserveDeadline(id: string, timeoutSec: number): Promise<number> {
    return this.ledger.update((data) => {
      const rec = data.sandboxes[id];
      const now = this.now();
      if (!rec || rec.state !== "running" || effectiveState(rec, now) !== "running") {
        throw new SandboxRouterError("invalid", `${id} isn't running, so its deadline can't move`);
      }
      const problem = holdProblem({ adapters: this.providers(), config: this.config, data, now }, rec, timeoutSec);
      if (problem) throw new SandboxRouterError("quota", `can't keep ${id} for ${timeoutSec} s: ${problem}`, rec.provider);
      data.sandboxes[id] = transition(rec, { type: "timeoutSet", timeoutSec }, now);
      return Date.parse(rec.expiresAt);
    });
  }

  /** Puts back a deadline `reserveDeadline` moved, when the provider didn't move it. */
  async restoreDeadline(id: string, expiresAt: number): Promise<void> {
    await this.ledger.update((data) => {
      const rec = data.sandboxes[id];
      const now = this.now();
      if (rec?.state !== "running" || effectiveState(rec, now) !== "running") return; // gone or over meanwhile
      data.sandboxes[id] = transition(rec, { type: "timeoutSet", timeoutSec: (expiresAt - now) / 1000 }, now);
    });
  }

  /**
   * Resumes a paused sandbox in the ledger for `timeoutSec`, in the same write as the check that
   * what it may then spend fits (holdProblem). Throws a quota error, changing nothing, when it
   * doesn't. `pauseAgain` undoes it when the provider then fails to resume.
   */
  async reserveResume(id: string, timeoutSec: number): Promise<void> {
    await this.ledger.update((data) => {
      const rec = data.sandboxes[id];
      if (rec?.state !== "paused") throw new SandboxRouterError("invalid", `${id} isn't paused`);
      const now = this.now();
      const problem = holdProblem({ adapters: this.providers(), config: this.config, data, now }, rec, timeoutSec);
      if (problem) throw new SandboxRouterError("quota", `can't resume ${id} for ${timeoutSec} s: ${problem}`, rec.provider);
      data.sandboxes[id] = transition(rec, { type: "resumed", timeoutSec }, now);
    });
  }

  /** Undoes `reserveResume` when the provider didn't resume the sandbox. */
  async pauseAgain(id: string): Promise<void> {
    await this.ledger.update((data) => {
      const rec = data.sandboxes[id];
      const now = this.now();
      if (rec?.state !== "running" || effectiveState(rec, now) !== "running") return;
      data.sandboxes[id] = transition(rec, { type: "paused" }, now);
    });
  }

  /**
   * The provider says the sandbox is gone. Records it as stopped and, when that happened
   * before its deadline (not just the provider enforcing the timeout), as a lost box in the
   * provider's health, in the same write.
   */
  async markGone(id: string): Promise<void> {
    await this.ledger.update((data) => {
      const rec = data.sandboxes[id];
      if (!rec || rec.state === "creating" || rec.state === "stopped" || rec.state === "failed") return;
      const now = this.now();
      if (effectiveState(rec, now) === "running") {
        const sample: HealthSample = { at: new Date(now).toISOString(), op: "lost", ok: false, kind: "not_found" };
        recordHealth(data, rec.provider, sample, this.config.routing.healthSamples);
      }
      data.sandboxes[id] = transition(rec, { type: "stopped", reason: "gone" }, now);
    });
  }

  /** Marks a provider after a refusal; returns when its mark lapses (ms epoch), if the error is a refusal. */
  async markFromError(provider: string, err: SandboxRouterError): Promise<number | undefined> {
    if (refusalKind(err.kind) === undefined) return undefined;
    return this.ledger.update((data) => this.mark(data, provider, err, this.now()));
  }

  /** The mark for a refusal, under the ledger lock. How long it lasts is decided in marks.ts. */
  private mark(data: LedgerData, provider: string, err: SandboxRouterError, now: number): number | undefined {
    const kind = refusalKind(err.kind);
    if (kind === undefined) return undefined;
    const tier = this.config.providers[provider]?.freeTier ?? this.adapter(provider).info.freeTier.tier;
    // A monthly grant comes back at the reset; any other refusal is checked again later each time.
    const monthly = tier.kind === "monthly-credit" || tier.kind === "monthly-hours";
    const resetsAt = kind === "quota" && monthly ? monthWindow(now).to : undefined;
    return markRefusal(data, { provider, kind, detail: err.message.slice(0, 200), now, resetsAt });
  }

  /**
   * Reconciles the ledger with reality. Locally: records past their deadline become
   * stopped at the deadline, and creates a crash left half done become failed. With
   * `remote`, asks each provider which sandboxes are alive, closes the rest, and deletes
   * the alive ones the ledger has already closed.
   */
  async sweep(opts: { remote?: boolean } = {}): Promise<{ stopped: number; failed: number; reaped: number }> {
    const result = await this.sweepLocal();
    if (!opts.remote) return result;
    for (const adapter of this.providers()) {
      if (!adapter.listAlive || !isConfigured(adapter, this.ctxFor(adapter))) continue;
      // A box that started running after this may be missing from the list without being gone.
      const listedAt = this.now();
      let alive: Set<string>;
      try {
        alive = new Set(await adapter.listAlive(this.ctxFor(adapter)));
      } catch {
        continue;
      }
      const n = await this.ledger.update((data) => {
        let count = 0;
        const now = this.now();
        for (const [id, rec] of Object.entries(data.sandboxes)) {
          if (rec.provider !== adapter.info.id || (rec.state !== "running" && rec.state !== "paused")) continue;
          // The first segment opens when the create is recorded.
          if (alive.has(rec.providerSandboxId) || Date.parse(rec.segments[0]?.start ?? rec.createdAt) >= listedAt) continue;
          data.sandboxes[id] = transition(rec, { type: "stopped", reason: "gone" }, now);
          count++;
        }
        return count;
      });
      result.stopped += n;

      // The ledger says these are over, yet the provider still runs them: a kill that failed
      // after recording its stop, a create whose record couldn't be written, a deadline the
      // provider doesn't enforce. A box a newer record holds (an adoption) is left alone.
      const data = await this.ledger.read();
      const held = new Set<string>();
      const doomed = new Set<string>();
      for (const rec of Object.values(data.sandboxes)) {
        if (rec.provider !== adapter.info.id) continue;
        if (rec.state === "running" || rec.state === "paused") held.add(rec.providerSandboxId);
        else if ((rec.state === "stopped" || rec.state === "failed") && rec.providerSandboxId && alive.has(rec.providerSandboxId)) doomed.add(rec.providerSandboxId);
      }
      for (const psid of doomed) {
        if (held.has(psid)) continue;
        await adapter.kill(psid, this.ctxFor(adapter)).then(
          () => result.reaped++,
          () => undefined,
        );
      }
    }
    return result;
  }

  private async sweepLocal(): Promise<{ stopped: number; failed: number; reaped: number }> {
    const now = this.now();
    const data = await this.ledger.read();
    const due = Object.values(data.sandboxes).some(
      (r) => effectiveState(r, now) === "expired" || (r.state === "creating" && now - Date.parse(r.createdAt) > 10 * 60_000),
    );
    if (!due) {
      await this.compactIfDue(data);
      return { stopped: 0, failed: 0, reaped: 0 };
    }
    const toKill: { provider: string; psid: string }[] = [];
    const result = await this.ledger.update((d) => {
      let stopped = 0;
      let failed = 0;
      for (const [id, rec] of Object.entries(d.sandboxes)) {
        if (effectiveState(rec, now) === "expired") {
          d.sandboxes[id] = transition(rec, { type: "stopped", reason: "expired" }, now);
          if (rec.state === "running" && this.adapters.get(rec.provider)?.info.enforcesTimeout === false) {
            toKill.push({ provider: rec.provider, psid: rec.providerSandboxId });
          }
          stopped++;
        } else if (rec.state === "creating" && now - Date.parse(rec.createdAt) > 10 * 60_000) {
          d.sandboxes[id] = transition(rec, { type: "lost", error: "create never finished (process exited?)" }, now);
          failed++;
        }
      }
      return { stopped, failed, reaped: 0 };
    });
    // The provider won't stop these itself. Best effort here; `sweep({ remote })` retries.
    for (const { provider, psid } of toKill) {
      const adapter = this.adapter(provider);
      await adapter.kill(psid, this.ctxFor(adapter)).then(
        () => result.reaped++,
        () => undefined,
      );
    }
    return result;
  }

  /** Folds finished records older than 62 days into per-month totals so the ledger stays small. */
  private async compactIfDue(snapshot: LedgerData): Promise<void> {
    const now = this.now();
    const cutoff = now - 62 * DAY;
    const old = (r: SandboxRecord) => (r.state === "stopped" || r.state === "failed") && Date.parse(r.endedAt) < cutoff;
    if (!Object.values(snapshot.sandboxes).some(old)) return;
    await this.ledger.update((data) => {
      for (const [id, rec] of Object.entries(data.sandboxes)) {
        if (!old(rec) || rec.state === "creating") continue;
        const adapter = this.adapters.get(rec.provider);
        if (adapter) {
          const pricing = effectivePricing(adapter.info, this.config.providers[rec.provider]);
          const usd = billableSeconds(rec, { from: 0, to: Number.POSITIVE_INFINITY }, now) * ratePerSecond(pricing, rec.cpu, rec.memoryMiB);
          const byMonth = (data.archivedUsd[rec.provider] ??= {});
          const key = monthKey(Date.parse(rec.createdAt));
          byMonth[key] = (byMonth[key] ?? 0) + usd;
        }
        delete data.sandboxes[id];
      }
    });
  }

  private view(rec: SandboxRecord, now: number): SandboxView {
    const adapter = this.adapters.get(rec.provider);
    const pricing = adapter ? effectivePricing(adapter.info, this.config.providers[rec.provider]) : undefined;
    const secs = billableSeconds(rec, { from: 0, to: Number.POSITIVE_INFINITY }, now);
    return {
      id: rec.id,
      provider: rec.provider,
      providerSandboxId: rec.state === "creating" ? undefined : rec.providerSandboxId,
      state: effectiveState(rec, now),
      cpu: rec.cpu,
      memoryMiB: rec.memoryMiB,
      createdAt: rec.createdAt,
      expiresAt: rec.state === "running" || rec.state === "paused" ? rec.expiresAt : undefined,
      endedAt: rec.state === "stopped" || rec.state === "failed" ? rec.endedAt : undefined,
      costUsd: pricing ? secs * ratePerSecond(pricing, rec.cpu, rec.memoryMiB) : 0,
      metadata: rec.metadata,
      error: rec.state === "failed" ? rec.error : undefined,
    };
  }
}

/** A router wired from the environment: config file, on-disk ledger, every built-in provider. */
export async function createRouter(opts: Partial<RouterOptions> = {}): Promise<SandboxRouter> {
  const { loadConfig } = await import("./config.js");
  const { builtinProviders } = await import("../providers/index.js");
  const { reportingLedger } = await import("../report/reporter.js");
  const env = opts.env ?? process.env;
  const home = defaultHome(env);
  const config = parseConfig(opts.config ?? (await loadConfig(env)));
  // With `report` configured, every ledger write is also reported to a back end (src/report/).
  // The reporter asks for the router's providers only after this function has returned.
  const ledger = reportingLedger(opts.ledger ?? new FileLedger(join(home, "ledger.json")), {
    config,
    env,
    home,
    providers: () => router.providers(),
    ...(opts.now ? { now: opts.now } : {}),
  });
  const router = new SandboxRouter({
    config,
    ledger,
    env,
    providers: opts.providers ?? builtinProviders(),
    now: opts.now,
    strategies: opts.strategies,
    checkpoints: opts.checkpoints ?? new FileCheckpointStore(join(home, "checkpoints"), opts.now),
  });
  return router;
}
