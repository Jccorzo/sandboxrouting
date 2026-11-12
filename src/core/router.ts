// The router: picks a provider for each new sandbox (free usage first), fails over when a
// provider refuses, records every sandbox's lifecycle in the ledger, and routes later
// calls on a sandbox back to the provider that owns it.

import { join } from "node:path";
import type { ProviderAdapter, ProviderContext, ProviderUsage, ResolvedSpec, SandboxSpec } from "./types.js";
import { parseConfig, type RouterConfig } from "./config.js";
import { defaultHome, FileLedger, MemoryLedger, newSandboxId, type Ledger, type LedgerData, type MarkKind } from "./ledger.js";
import { classify, NoProviderAvailableError, SandboxRouterError, type RouteAttempt } from "./errors.js";
import { effectiveState, isLive, transition, type EffectiveState, type SandboxEvent, type SandboxRecord } from "./state.js";
import {
  availability,
  billableSeconds,
  effectivePricing,
  freeStatus,
  monthKey,
  monthWindow,
  ratePerSecond,
  type Availability,
  type FreeStatus,
} from "./metering.js";
import { isConfigured, plan, type Plan } from "./policy.js";
import { Sandbox } from "./sandbox.js";

export interface RouterOptions {
  config?: RouterConfig | unknown;
  providers?: ProviderAdapter[];
  ledger?: Ledger;
  env?: Record<string, string | undefined>;
  /** Clock, for tests. Server state uses one clock: this one. */
  now?: () => number;
}

export interface ProviderStatus {
  id: string;
  name: string;
  configured: boolean;
  enabled: boolean;
  selfHosted: boolean;
  free: FreeStatus;
  availability: Availability;
  live: number;
  concurrency?: number;
  capabilities: string[];
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

export class SandboxRouter {
  readonly config: RouterConfig;
  readonly ledger: Ledger;
  private readonly adapters = new Map<string, ProviderAdapter>();
  private readonly env: Record<string, string | undefined>;
  readonly now: () => number;
  private usageCache = new Map<string, { at: number; usage: ProviderUsage }>();

  constructor(opts: RouterOptions = {}) {
    this.config = parseConfig(opts.config ?? {});
    this.ledger = opts.ledger ?? new MemoryLedger();
    this.env = opts.env ?? process.env;
    this.now = opts.now ?? Date.now;
    for (const p of opts.providers ?? []) this.register(p);
  }

  /** Adds a provider. Adding one is this call plus an adapter file; nothing else changes. */
  register(adapter: ProviderAdapter): this {
    if (this.adapters.has(adapter.info.id)) throw new Error(`provider "${adapter.info.id}" is already registered`);
    this.adapters.set(adapter.info.id, adapter);
    return this;
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

  // ------------------------------------------------------------------ routing

  resolve(spec: SandboxSpec): ResolvedSpec {
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

  private planWith(data: LedgerData, spec: ResolvedSpec, only?: string): Plan {
    const adapters = only ? [this.adapter(only)] : this.providers();
    const now = this.now();
    // Size-dependent ranking needs a size; use each provider's default when unset.
    const sized = { ...spec, cpu: spec.cpu || 2, memoryMiB: spec.memoryMiB || 2048 };
    return plan({
      adapters,
      config: this.config,
      data,
      spec: sized,
      now,
      ctxFor: (a) => this.ctxFor(a),
      reported: Object.fromEntries([...this.usageCache].map(([k, v]) => [k, v.usage])),
    });
  }

  async create(spec: SandboxSpec = {}): Promise<Sandbox> {
    await this.sweepLocal();
    const resolved = this.resolve(spec);
    const first = this.planWith(await this.ledger.read(), resolved);
    const attempts: RouteAttempt[] = first.skipped.map((s) => ({ provider: s.provider, outcome: "skipped", detail: s.reason }));

    for (const entry of first.ordered) {
      const adapter = this.adapter(entry.provider);
      const id = newSandboxId();
      const forProvider = this.resolveFor(resolved, adapter, id);

      // Reserve under the lock: re-plan this provider on fresh data so two callers can't
      // both take the last free slot or the last of a budget.
      const reserved = await this.ledger.update((data) => {
        const again = this.planWith(data, resolved, entry.provider);
        if (!again.ordered.length) return again.skipped[0]?.reason ?? "no longer eligible";
        const now = this.now();
        data.sandboxes[id] = {
          id,
          provider: entry.provider,
          state: "creating",
          cpu: forProvider.cpu,
          memoryMiB: forProvider.memoryMiB,
          createdAt: new Date(now).toISOString(),
          metadata: forProvider.metadata,
        };
        return true;
      });
      if (reserved !== true) {
        attempts.push({ provider: entry.provider, outcome: "skipped", detail: reserved });
        continue;
      }

      try {
        const created = await adapter.create(forProvider, this.ctxFor(adapter));
        await this.apply(id, {
          type: "created",
          providerSandboxId: created.providerSandboxId,
          timeoutSec: forProvider.timeoutSec,
          cpu: created.cpu,
          memoryMiB: created.memoryMiB,
        });
        attempts.push({ provider: entry.provider, outcome: "created", detail: entry.lane });
        return new Sandbox(this, id, entry.provider, created.providerSandboxId, attempts);
      } catch (raw) {
        const err = classify(raw, entry.provider);
        await this.apply(id, { type: "createFailed", error: err.message });
        await this.markFromError(entry.provider, err);
        attempts.push({ provider: entry.provider, outcome: "failed", kind: err.kind, detail: err.message.slice(0, 300) });
      }
    }
    throw new NoProviderAvailableError(attempts);
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
        enabled: cfg?.enabled !== false,
        selfHosted: Boolean(a.info.selfHosted),
        free: freeStatus(a.info, cfg, data, now, this.usageCache.get(a.info.id)?.usage),
        availability: availability(data, a.info.id, now),
        live: Object.values(data.sandboxes).filter((r) => r.provider === a.info.id && isLive(r, now)).length,
        concurrency: cfg?.concurrency ?? a.info.freeTier.concurrency,
        capabilities: a.info.capabilities,
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

  /** Clears marks on a provider (e.g. after topping up credit or fixing a key). */
  async clearMarks(provider: string, kind?: MarkKind): Promise<void> {
    await this.ledger.update((data) => {
      data.marks = data.marks.filter((m) => m.provider !== provider || (kind !== undefined && m.kind !== kind));
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

  async markFromError(provider: string, err: SandboxRouterError): Promise<void> {
    const now = this.now();
    let kind: MarkKind | undefined;
    let until = now;
    if (err.kind === "quota") {
      kind = "quota";
      const tier = this.config.providers[provider]?.freeTier ?? this.adapter(provider).info.freeTier.tier;
      // Monthly grants come back at the reset; anything else is re-tried after a day.
      until = tier.kind === "monthly-credit" || tier.kind === "monthly-hours" ? monthWindow(now).to : now + DAY;
    } else if (err.kind === "rate_limit") {
      kind = "rate_limit";
      until = now + 60_000;
    } else if (err.kind === "auth") {
      kind = "auth";
      until = now + 10 * 60_000;
    }
    if (!kind) return;
    const mark = { provider, kind, at: new Date(now).toISOString(), until: new Date(until).toISOString(), detail: err.message.slice(0, 200) };
    await this.ledger.update((data) => {
      data.marks = data.marks.filter((m) => Date.parse(m.until) > now && !(m.provider === provider && m.kind === kind));
      data.marks.push(mark);
    });
  }

  /**
   * Reconciles the ledger with reality. Locally: records past their deadline become
   * stopped at the deadline, and creates a crash left half done become failed. With
   * `remote`, asks each provider which sandboxes are alive and closes the rest, and
   * deletes sandboxes past their deadline on providers that don't enforce one.
   */
  async sweep(opts: { remote?: boolean } = {}): Promise<{ stopped: number; failed: number; reaped: number }> {
    const result = await this.sweepLocal();
    if (!opts.remote) return result;
    for (const adapter of this.providers()) {
      if (!adapter.listAlive || !isConfigured(adapter, this.ctxFor(adapter))) continue;
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
          if (rec.provider !== adapter.info.id) continue;
          if ((rec.state === "running" || rec.state === "paused") && !alive.has(rec.providerSandboxId)) {
            data.sandboxes[id] = transition(rec, { type: "stopped", reason: "gone" }, now);
            count++;
          }
        }
        return count;
      });
      result.stopped += n;

      // Providers that don't stop sandboxes at the deadline: delete any the ledger has
      // already closed (a kill at expiry that failed, or a process that died first).
      if (adapter.info.enforcesTimeout === false) {
        const data = await this.ledger.read();
        for (const rec of Object.values(data.sandboxes)) {
          if (rec.provider !== adapter.info.id) continue;
          if ((rec.state === "stopped" || rec.state === "failed") && rec.providerSandboxId && alive.has(rec.providerSandboxId)) {
            await adapter.kill(rec.providerSandboxId, this.ctxFor(adapter)).then(
              () => result.reaped++,
              () => undefined,
            );
          }
        }
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
  const env = opts.env ?? process.env;
  return new SandboxRouter({
    config: opts.config ?? (await loadConfig(env)),
    ledger: opts.ledger ?? new FileLedger(join(defaultHome(env), "ledger.json")),
    env,
    providers: opts.providers ?? builtinProviders(),
    now: opts.now,
  });
}
