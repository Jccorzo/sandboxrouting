// A deterministic discrete-event simulation of the router, to compare routing strategies on the
// same traffic with numbers instead of intuition. Every request goes through the real router
// (router.create, sandbox.kill): planning, reservation, marks, the circuit breaker and health
// are the code that ships. Only the providers (bench/scenarios.ts) and the traffic are made up.
//
// Time is the router's injected clock and nothing else. Events (arrivals, kills, month ends,
// creates finishing) run in time order and set the clock. A provider's create() sleeps on that
// clock for its sampled latency, so creates overlap like real ones, the router records real
// latencies in its health samples, and time to ready includes failovers. Random draws come from
// seeded PRNGs; a provider's latency and failure for a request depend only on (seed, provider,
// request), so every strategy faces the same luck.
//
//   npm run simulate [-- --scenario flaky --days 30 --seed 1 --json]

import { pathToFileURL } from "node:url";
import { SandboxRouter } from "../src/core/router.js";
import { emptyLedger, MemoryLedger, type Ledger, type LedgerData } from "../src/core/ledger.js";
import { NoProviderAvailableError, type RouteAttempt } from "../src/core/errors.js";
import {
  billableSeconds,
  effectiveFreeTier,
  effectivePricing,
  monthKey,
  monthWindow,
  paidSpendThisMonth,
  ratePerSecond,
  spend,
} from "../src/core/metering.js";
import { isLive, type SandboxRecord } from "../src/core/state.js";
import type { RoutingStrategy } from "../src/core/routing/types.js";
import type { Capability, FreeTier, Pricing, ProviderAdapter, SandboxSpec } from "../src/core/types.js";
import { defineProvider } from "../src/providers/util.js";
import { scenarioNames, scenarios, type ProviderModel, type Scenario } from "./scenarios.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Metadata key that tells a simulated provider which request it is serving. */
const REQUEST = "sim.request";
/** A 402 comes back at once: the provider checks the balance before booting anything. */
const REFUSAL_MS = 200;
/** A provider that is down answers with a gateway timeout, not a quick error. */
const OUTAGE_FAIL_MS = 5_000;
/** The request an `outageOfTop` scenario asks the strategy to rank, to find its favourite. */
const PLAIN_REQUEST: SandboxSpec = { cpu: 2, memoryMiB: 2048, timeoutSec: 600 };

// ------------------------------------------------------------------ options and results

export interface WorkloadOptions {
  /** Requests a day on average, not counting bursts. */
  perDay: number;
  /** Daily swing of the rate: 0.5 means 1.5× the mean at 15:00 UTC and 0.5× at 03:00. */
  dailySwing: number;
  /** Durations are log-normal with this median (seconds) and sigma, clamped to [minSec, maxSec]. */
  medianSec: number;
  sigma: number;
  minSec: number;
  maxSec: number;
  /** Share of requests that need a public port, and that bring their own image. */
  portsShare: number;
  imageShare: number;
  /** Fan-outs: bursts a day, each asking for burstMin..burstMax sandboxes at the same instant. */
  burstsPerDay: number;
  burstMin: number;
  burstMax: number;
}

/** About as much as the monthly free tiers hold: free-first spends them, then reaches for one-time credit. */
export const DEFAULT_WORKLOAD: WorkloadOptions = {
  perDay: 200,
  dailySwing: 0.5,
  medianSec: 240,
  sigma: 1.2,
  minSec: 30,
  maxSec: 7200,
  portsShare: 0.15,
  imageShare: 0.2,
  burstsPerDay: 0.5,
  burstMin: 10,
  burstMax: 30,
};

export interface SimulateOptions {
  /** Scenario names from bench/scenarios.ts, or your own scenarios. Default: all of them. */
  scenarios?: (string | Scenario)[];
  /** Strategy names to run. Default: every strategy the router knows, `strategies` included. */
  only?: string[];
  /** Your own strategies, registered on every run's router next to the built-ins. */
  strategies?: RoutingStrategy[];
  /** Simulated days of arrivals (default 30). Sandboxes still running at the end finish after it. */
  days?: number;
  seed?: number;
  /** Start of the run, ms epoch. Default 2026-11-01: a 30-day month, so the default run ends at the reset. */
  start?: number;
  /** Add local Docker (unlimited, your hardware) to every scenario that allows it. */
  docker?: boolean;
  workload?: Partial<WorkloadOptions>;
  /** Router config merged over each scenario's (one level deep for `routing`). */
  config?: Record<string, unknown>;
  /** Keep every create attempt in the result (for tests and digging into a run). */
  trace?: boolean;
  /** Use the router's MemoryLedger instead of the simulator's (much slower; to check that one). */
  memoryLedger?: boolean;
}

export interface Metrics {
  requests: number;
  served: number;
  /** Requests no provider could take (NoProviderAvailableError). */
  unserved: number;
  /** Failed create attempts the router moved on from; each one costs time to ready. */
  failovers: number;
  /** Failed creates per provider, by error kind (transient, quota, ...). */
  failures: Record<string, Record<string, number>>;
  /** Sandboxes the router billed as paid when it created them. */
  paidSandboxes: number;
  /** What providers bill: spend past the free grants, by the router's own metering. */
  paidUsd: number;
  /** Free usage consumed, at list price, from monthly tiers and from one-time credit. */
  freeMonthlyUsd: number;
  freeOneTimeUsd: number;
  /** Sandbox-hours paid for by free tiers. */
  freeHours: number;
  /** Sandbox-hours on your own hardware. */
  selfHostedHours: number;
  /** Monthly free usage still unused when it reset (hour tiers valued at their default size). */
  expiredUsd: number;
  /** Request to ready sandbox, failovers included, for served requests. */
  readyMeanMs: number;
  readyP95Ms: number;
  /** Share of served sandboxes per provider, 0..1. */
  share: Record<string, number>;
}

/** One call to a simulated provider's create(). */
export interface CreateAttempt {
  provider: string;
  request: number;
  start: number;
  end: number;
  outcome: "ok" | "unavailable" | "refused";
}

/** What happened to one request: the router's route (every provider tried or skipped, and why). */
export interface Outcome {
  request: number;
  at: number;
  /** When the sandbox was ready, and where; unset when no provider could take it. */
  readyAt?: number;
  provider?: string;
  route: RouteAttempt[];
}

export interface Run {
  strategy: string;
  metrics: Metrics;
  /** The provider an `outageOfTop` scenario took down in this run, and when. */
  outage?: { provider: string; from: number; to: number };
  /** With `trace`: every create attempt in the order they finished, and every request's outcome. */
  attempts?: CreateAttempt[];
  outcomes?: Outcome[];
}

export interface Simulation {
  days: number;
  seed: number;
  start: string;
  workload: WorkloadOptions;
  scenarios: { name: string; description: string; requests: number; runs: Run[] }[];
}

interface Resolved {
  days: number;
  seed: number;
  start: number;
  end: number;
  docker: boolean;
  workload: WorkloadOptions;
  config: Record<string, unknown>;
  strategies: RoutingStrategy[];
  trace: boolean;
  memoryLedger: boolean;
}

// ------------------------------------------------------------------ simulate

export async function simulate(options: SimulateOptions = {}): Promise<Simulation> {
  const days = options.days ?? 30;
  if (!(days > 0)) throw new Error(`days must be more than 0, got ${days}`);
  const start = options.start ?? Date.UTC(2026, 10, 1);
  const o: Resolved = {
    days,
    seed: options.seed ?? 1,
    start,
    end: start + days * DAY,
    docker: options.docker ?? false,
    workload: { ...DEFAULT_WORKLOAD, ...options.workload },
    config: options.config ?? {},
    strategies: options.strategies ?? [],
    trace: options.trace ?? false,
    memoryLedger: options.memoryLedger ?? false,
  };
  const known = new SandboxRouter({ env: {}, strategies: o.strategies }).strategies().map((s) => s.name);
  for (const name of options.only ?? []) {
    if (!known.includes(name)) throw new Error(`unknown strategy "${name}" (have: ${known.join(", ")})`);
  }
  const names = options.only ?? known;
  const arrivals = workload(o.workload, o.start, o.days, o.seed);

  const result: Simulation = { days, seed: o.seed, start: new Date(start).toISOString(), workload: o.workload, scenarios: [] };
  for (const wanted of options.scenarios ?? scenarioNames) {
    const scenario = typeof wanted === "string" ? scenarioFor(wanted, o) : wanted;
    const runs: Run[] = [];
    for (const strategy of names) runs.push(await runOne(scenario, strategy, arrivals, o));
    result.scenarios.push({ name: scenario.name, description: scenario.description, requests: arrivals.length, runs });
  }
  return result;
}

function scenarioFor(name: string, o: Resolved): Scenario {
  const build = scenarios[name];
  if (!build) throw new Error(`unknown scenario "${name}" (have: ${scenarioNames.join(", ")})`);
  return build({ days: o.days, docker: o.docker });
}

/** Scenario config, then the caller's, then this run's strategy. */
function configFor(scenario: Scenario, o: Resolved, strategy: string): Record<string, unknown> {
  const routing = { ...(scenario.config["routing"] as object | undefined), ...(o.config["routing"] as object | undefined), strategy };
  return { ...scenario.config, ...o.config, routing };
}

// ------------------------------------------------------------------ one run

async function runOne(scenario: Scenario, strategy: string, arrivals: Arrival[], o: Resolved): Promise<Run> {
  const clock = { t: o.start };
  const queue = new EventQueue();
  const attempts: CreateAttempt[] = [];
  const sim: SimContext = {
    now: () => clock.t,
    sleep: (ms) => new Promise((resolve) => queue.push(clock.t + ms, resolve)),
    seed: o.seed,
    start: o.start,
    attempts,
  };
  // Copies, so an outage picked for this run stays in this run.
  const models = scenario.providers.map((m) => ({ ...m, outages: [...(m.outages ?? [])] }));
  const ledger = o.memoryLedger ? new MemoryLedger() : new SimLedger();
  const router = new SandboxRouter({
    providers: models.map((m) => simProvider(m, sim)),
    config: configFor(scenario, o, strategy),
    ledger,
    env: {},
    now: sim.now,
    strategies: o.strategies,
  });
  const terms: Terms = new Map();
  for (const a of router.providers()) {
    const cfg = router.config.providers[a.info.id];
    terms.set(a.info.id, { tier: effectiveFreeTier(a.info, cfg), pricing: effectivePricing(a.info, cfg) });
  }

  const m: Metrics = {
    requests: arrivals.length,
    served: 0,
    unserved: 0,
    failovers: 0,
    failures: {},
    paidSandboxes: 0,
    paidUsd: 0,
    freeMonthlyUsd: 0,
    freeOneTimeUsd: 0,
    freeHours: 0,
    selfHostedHours: 0,
    expiredUsd: 0,
    readyMeanMs: 0,
    readyP95Ms: 0,
    share: {},
  };
  const ready: number[] = [];
  const servedBy: Record<string, number> = {};
  const countFailures = (route: readonly RouteAttempt[]) => {
    for (const a of route) {
      if (a.outcome !== "failed") continue;
      m.failovers++;
      const byKind = (m.failures[a.provider] ??= {});
      const kind = a.kind ?? "transient";
      byKind[kind] = (byKind[kind] ?? 0) + 1;
    }
  };

  // Work started by events runs concurrently; the first unexpected error stops the run.
  let failure: unknown;
  const pending = new Set<Promise<void>>();
  const track = (work: Promise<void>) => {
    const p: Promise<void> = work.catch((err) => void (failure ??= err)).finally(() => pending.delete(p));
    pending.add(p);
  };

  const outcomes: Outcome[] = [];
  const serve = async (a: Arrival) => {
    try {
      const sbx = await router.create(a.spec);
      countFailures(sbx.route);
      m.served++;
      if (sbx.route.some((x) => x.outcome === "created" && x.billing === "paid")) m.paidSandboxes++;
      servedBy[sbx.provider] = (servedBy[sbx.provider] ?? 0) + 1;
      ready.push(clock.t - a.at);
      if (o.trace) outcomes.push({ request: a.index, at: a.at, readyAt: clock.t, provider: sbx.provider, route: sbx.route });
      // The caller is done at arrival + duration (or at once, if the box came later than that).
      queue.push(Math.max(clock.t, a.at + a.durationMs), () => track(sbx.kill()));
    } catch (err) {
      if (!(err instanceof NoProviderAvailableError)) throw err;
      countFailures(err.attempts);
      m.unserved++;
      if (o.trace) outcomes.push({ request: a.index, at: a.at, route: err.attempts });
    }
  };

  // Monthly free usage left just before a reset is lost: that is what free-first tries to avoid.
  const expire = async (resetAt: number) => {
    for (const s of await router.status()) {
      if (s.free.state !== "available" || s.free.resetsAt !== resetAt) continue;
      const pricing = effectivePricing(router.adapter(s.id).info, router.config.providers[s.id]);
      m.expiredUsd += s.free.unit === "usd" ? s.free.remaining : s.free.remaining * 3600 * ratePerSecond(pricing, pricing.defaultCpu, pricing.defaultMemoryMiB);
    }
  };

  for (const a of arrivals) queue.push(a.at, () => track(serve(a)));
  for (let t = monthWindow(o.start).to; t <= o.end; t = monthWindow(t).to) {
    const resetAt = t;
    queue.push(resetAt - 1, () => track(expire(resetAt)));
  }
  if (ledger instanceof SimLedger) {
    for (let t = o.start + HOUR; t <= o.end; t += HOUR) queue.push(t, () => track(ledger.fold(clock.t, terms)));
  }
  let outage: Run["outage"];
  if (scenario.outageOfTop) {
    const { fromMs, durationMs } = scenario.outageOfTop;
    const takeDownTop = async () => {
      const top = (await router.plan(PLAIN_REQUEST)).ordered[0]?.provider;
      const model = models.find((x) => x.info.id === top);
      if (!top || !model) return;
      model.outages.push({ fromMs, toMs: fromMs + durationMs });
      outage = { provider: top, from: o.start + fromMs, to: o.start + fromMs + durationMs };
    };
    queue.push(o.start + fromMs, () => track(takeDownTop()));
  }

  for (let ev = queue.pop(); ev; ev = queue.pop()) {
    clock.t = Math.max(clock.t, ev.at); // never backwards
    ev.run();
    // No real I/O happens below the router here, so one macrotask turn runs every continuation
    // until each piece of work is waiting on a simulated sleep again (or is done).
    await settle();
    if (failure) throw failure;
  }
  if (pending.size) throw new Error(`simulation stalled: ${pending.size} tasks never finished`);

  // Every served sandbox has been killed by now; a sweep closes any that ran past its deadline.
  await router.sweep();
  const data = ledger instanceof SimLedger ? ledger.everything() : await ledger.read();
  const live = Object.values(data.sandboxes).filter((r) => isLive(r, clock.t) || r.state === "paused");
  if (live.length) throw new Error(`${live.length} sandboxes still live at the end of the run`);
  Object.assign(m, usage(router, data, o.start, clock.t));

  ready.sort((x, y) => x - y);
  m.readyMeanMs = ready.length ? ready.reduce((sum, x) => sum + x, 0) / ready.length : 0;
  m.readyP95Ms = ready.length ? ready[Math.min(ready.length - 1, Math.ceil(0.95 * ready.length) - 1)]! : 0;
  for (const [provider, n] of Object.entries(servedBy)) m.share[provider] = n / m.served;
  return { strategy, metrics: m, ...(outage ? { outage } : {}), ...(o.trace ? { attempts, outcomes } : {}) };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Free and paid usage per provider and month, with the router's own metering (the same
 * functions that decide free status and the paid budget), after every sandbox has stopped.
 */
function usage(router: SandboxRouter, data: LedgerData, from: number, to: number) {
  const out = { paidUsd: 0, freeMonthlyUsd: 0, freeOneTimeUsd: 0, freeHours: 0, selfHostedHours: 0 };
  for (let t = monthWindow(from).from; t < to; t = monthWindow(t).to) {
    const month = monthWindow(t);
    for (const a of router.providers()) {
      const cfg = router.config.providers[a.info.id];
      const tier = effectiveFreeTier(a.info, cfg);
      const used = spend(data, a.info.id, effectivePricing(a.info, cfg), month, to);
      if (tier.kind === "unlimited") {
        out.selfHostedHours += used.sandboxSeconds / 3600;
        continue;
      }
      const paid = paidSpendThisMonth(a.info, cfg, data, month.from);
      out.paidUsd += paid;
      if (tier.kind === "none" || used.usd <= 0) continue;
      const free = used.usd - paid;
      if (tier.kind === "one-time-credit") out.freeOneTimeUsd += free;
      else out.freeMonthlyUsd += free;
      out.freeHours += (used.sandboxSeconds / 3600) * (free / used.usd);
    }
  }
  return out;
}

// ------------------------------------------------------------------ ledger

type Terms = Map<string, { tier: FreeTier; pricing: Pricing }>;

/**
 * The simulator's ledger. MemoryLedger clones the whole ledger on every read and write, and
 * every plan walks every record, so a month of traffic costs quadratic time. This one hands out
 * the live data (the router never keeps a read across an await, and its updates are synchronous)
 * and folds finished records into `archivedUsd`, the router's own compaction, an hour after they
 * were created instead of 62 days. Records of hour-metered tiers stay, since free hours are
 * counted from records. A test checks that the numbers match MemoryLedger's.
 */
class SimLedger implements Ledger {
  private readonly data = emptyLedger();
  private queue: Promise<unknown> = Promise.resolve();
  /** Folded records, whole, and the USD they added to archivedUsd, for the final accounting. */
  private readonly folded: SandboxRecord[] = [];
  private readonly foldedUsd: Record<string, Record<string, number>> = {};

  async read(): Promise<LedgerData> {
    return this.data;
  }

  update<T>(fn: (data: LedgerData) => T | Promise<T>): Promise<T> {
    const run = this.queue.then(() => fn(this.data));
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Moves records that nothing reads one by one any more into per-month USD. */
  fold(now: number, terms: Terms): Promise<void> {
    return this.update((data) => {
      for (const [id, rec] of Object.entries(data.sandboxes)) {
        const t = terms.get(rec.provider);
        if (rec.state !== "stopped" && rec.state !== "failed") continue;
        // Created in the last hour: still counts in `recentCreates`.
        if (!t || t.tier.kind === "monthly-hours" || now - Date.parse(rec.createdAt) < HOUR) continue;
        for (let m = monthWindow(Date.parse(rec.createdAt)).from; m <= Date.parse(rec.endedAt); m = monthWindow(m).to) {
          const usd = billableSeconds(rec, monthWindow(m), now) * ratePerSecond(t.pricing, rec.cpu, rec.memoryMiB);
          if (usd === 0) continue;
          for (const into of [data.archivedUsd, this.foldedUsd]) {
            const byMonth = (into[rec.provider] ??= {});
            byMonth[monthKey(m)] = (byMonth[monthKey(m)] ?? 0) + usd;
          }
        }
        this.folded.push(rec);
        delete data.sandboxes[id];
      }
    });
  }

  /** Every record, folded or not, with only the archived USD the router compacted itself. */
  everything(): LedgerData {
    const archivedUsd: LedgerData["archivedUsd"] = {};
    for (const [provider, byMonth] of Object.entries(this.data.archivedUsd)) {
      for (const [month, amount] of Object.entries(byMonth)) {
        const own = amount - (this.foldedUsd[provider]?.[month] ?? 0);
        if (own !== 0) (archivedUsd[provider] ??= {})[month] = own;
      }
    }
    const sandboxes = { ...Object.fromEntries(this.folded.map((r) => [r.id, r])), ...this.data.sandboxes };
    return { ...this.data, sandboxes, archivedUsd };
  }
}

// ------------------------------------------------------------------ simulated providers

interface SimContext {
  now(): number;
  /** Resolves when the simulated clock reaches now + ms. */
  sleep(ms: number): Promise<void>;
  seed: number;
  start: number;
  attempts: CreateAttempt[];
}

const unavailable = (id: string) => Object.assign(new Error(`${id}: 503 service unavailable`), { status: 503 });
const refused = (id: string) => Object.assign(new Error(`${id}: 402 payment required, the account's credit is used up`), { status: 402 });

/** A real ProviderAdapter whose create() takes simulated time and fails as the model says. */
function simProvider(model: ProviderModel, sim: SimContext): ProviderAdapter {
  const id = model.info.id;
  let made = 0;
  // The provider's own meter, which sees usage the router doesn't (only kept when it matters).
  const boxes = new Map<string, { from: number; to: number; usdPerSecond: number }>();
  const spentUsd = (now: number) => {
    let usd = 0;
    for (const b of boxes.values()) usd += (b.usdPerSecond * Math.max(0, Math.min(b.to, now) - b.from)) / 1000;
    return usd;
  };
  const down = (t: number) => (model.outages ?? []).some((w) => t >= sim.start + w.fromMs && t < sim.start + w.toMs);

  return defineProvider({
    info: model.info,
    async create(spec) {
      const start = sim.now();
      const request = Number(spec.metadata[REQUEST] ?? -1);
      const draw = mulberry32(hash(`${sim.seed}:${id}:${request}`));
      const fails = draw() < model.failRate;
      const latencyMs = Math.round(model.latency.p50Ms * Math.exp(model.latency.sigma * normal(draw)));
      const log = (outcome: CreateAttempt["outcome"]) => sim.attempts.push({ provider: id, request, start, end: sim.now(), outcome });

      if (down(start)) {
        await sim.sleep(OUTAGE_FAIL_MS);
        log("unavailable");
        throw unavailable(id);
      }
      if (model.trueCreditUsd !== undefined && spentUsd(start) >= model.trueCreditUsd) {
        await sim.sleep(REFUSAL_MS);
        log("refused");
        throw refused(id);
      }
      await sim.sleep(latencyMs);
      if (fails) {
        log("unavailable");
        throw unavailable(id);
      }
      const providerSandboxId = `${id}-${++made}`;
      if (model.trueCreditUsd !== undefined) {
        const now = sim.now();
        boxes.set(providerSandboxId, { from: now, to: now + spec.timeoutSec * 1000, usdPerSecond: ratePerSecond(model.info.pricing, spec.cpu, spec.memoryMiB) });
      }
      log("ok");
      return { providerSandboxId };
    },
    async exec() {
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    async kill(providerSandboxId) {
      const box = boxes.get(providerSandboxId);
      if (box) box.to = Math.min(box.to, sim.now());
    },
  });
}

// ------------------------------------------------------------------ workload

export interface Arrival {
  index: number;
  at: number;
  durationMs: number;
  spec: SandboxSpec;
}

const SIZES = [
  { cpu: 1, memoryMiB: 1024, share: 0.3 },
  { cpu: 2, memoryMiB: 2048, share: 0.55 },
  { cpu: 4, memoryMiB: 8192, share: 0.15 },
];
/** Callers ask for a round timeout with headroom over what the work needs. */
const TIMEOUTS_SEC = [300, 600, 1800, 3600, 7200, 10800];

/** The requests of a run: the same for every scenario and strategy with the same options. */
export function workload(o: WorkloadOptions, start: number, days: number, seed: number): Arrival[] {
  const end = start + days * DAY;
  const jobs: { at: number; count: number }[] = [];

  // Single requests: a Poisson process at the peak rate, thinned to follow the daily swing.
  const singles = mulberry32(hash(`${seed}:singles`));
  const peak = (o.perDay / DAY) * (1 + o.dailySwing);
  for (let t = start + exponential(singles, peak); t < end; t += exponential(singles, peak)) {
    const hourOfDay = (t % DAY) / HOUR;
    const rate = 1 + o.dailySwing * Math.cos((2 * Math.PI * (hourOfDay - 15)) / 24);
    if (singles() * (1 + o.dailySwing) < rate) jobs.push({ at: Math.floor(t), count: 1 });
  }
  const bursts = mulberry32(hash(`${seed}:bursts`));
  const burstRate = o.burstsPerDay / DAY;
  for (let t = start + exponential(bursts, burstRate); t < end; t += exponential(bursts, burstRate)) {
    jobs.push({ at: Math.floor(t), count: o.burstMin + Math.floor(bursts() * (o.burstMax - o.burstMin + 1)) });
  }
  jobs.sort((a, b) => a.at - b.at);

  const out: Arrival[] = [];
  jobs.forEach((job, j) => {
    // A burst is one job fanned out: same needs, image and size; each task its own duration.
    const draw = mulberry32(hash(`${seed}:job:${j}`));
    const needs: Capability[] | undefined = draw() < o.portsShare ? ["ports"] : undefined;
    const image = draw() < o.imageShare ? "python:3.12-slim" : undefined;
    const size = pick(draw, SIZES);
    for (let k = 0; k < job.count; k++) {
      const durationSec = Math.min(o.maxSec, Math.max(o.minSec, o.medianSec * Math.exp(o.sigma * normal(draw))));
      const index = out.length;
      const spec: SandboxSpec = {
        cpu: size.cpu,
        memoryMiB: size.memoryMiB,
        timeoutSec: TIMEOUTS_SEC.find((s) => s >= durationSec * 1.2 + 60) ?? TIMEOUTS_SEC[TIMEOUTS_SEC.length - 1]!,
        metadata: { [REQUEST]: String(index) },
      };
      if (needs) spec.needs = needs;
      if (image) spec.image = image;
      out.push({ index, at: job.at, durationMs: Math.round(durationSec * 1000), spec });
    }
  });
  return out;
}

// ------------------------------------------------------------------ randomness

/** mulberry32: small, fast and seeded, so every run is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a, to derive independent seeds from a key. */
function hash(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Standard normal (Box-Muller). 1 - u keeps the log away from 0. */
function normal(rng: () => number): number {
  return Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());
}

/** Time to the next event of a Poisson process with `rate` events per ms. */
function exponential(rng: () => number, rate: number): number {
  return rate > 0 ? -Math.log(1 - rng()) / rate : Number.POSITIVE_INFINITY;
}

function pick<T extends { share: number }>(rng: () => number, items: readonly T[]): T {
  let u = rng();
  for (const item of items) {
    if (u < item.share) return item;
    u -= item.share;
  }
  return items[items.length - 1]!;
}

// ------------------------------------------------------------------ event queue

interface QueuedEvent {
  at: number;
  seq: number;
  run: () => void;
}

/** A binary heap by time; events at the same time run in the order they were queued. */
class EventQueue {
  private items: QueuedEvent[] = [];
  private seq = 0;

  push(at: number, run: () => void): void {
    const items = this.items;
    items.push({ at, seq: this.seq++, run });
    for (let i = items.length - 1; i > 0; ) {
      const parent = (i - 1) >> 1;
      if (!earlier(items[i]!, items[parent]!)) break;
      [items[i], items[parent]] = [items[parent]!, items[i]!];
      i = parent;
    }
  }

  pop(): QueuedEvent | undefined {
    const items = this.items;
    const top = items[0];
    const last = items.pop();
    if (top && last && items.length) {
      items[0] = last;
      for (let i = 0; ; ) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < items.length && earlier(items[l]!, items[m]!)) m = l;
        if (r < items.length && earlier(items[r]!, items[m]!)) m = r;
        if (m === i) break;
        [items[i], items[m]] = [items[m]!, items[i]!];
        i = m;
      }
    }
    return top;
  }
}

const earlier = (a: QueuedEvent, b: QueuedEvent) => a.at < b.at || (a.at === b.at && a.seq < b.seq);

// ------------------------------------------------------------------ output

const usd = (x: number) => x.toFixed(2);
const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

function shares(share: Record<string, number>): string {
  return Object.entries(share)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([p, x]) => `${p} ${x < 0.005 ? "<1" : Math.round(x * 100)}%`)
    .join(", ");
}

/** One table per scenario, strategies as rows. */
export function toMarkdown(sim: Simulation): string {
  const lines: string[] = [];
  for (const s of sim.scenarios) {
    const days = `${sim.days} day${sim.days === 1 ? "" : "s"}`;
    lines.push(`## ${s.name}`, "", `${s.description} ${days} from ${sim.start.slice(0, 10)}, seed ${sim.seed}, ${s.requests} requests.`, "");
    lines.push("| strategy | served | unserved | failovers | paid $ | free monthly $ | free one-time $ | free h | expired $ | ready mean | ready p95 | share of served |");
    lines.push("|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|---|");
    for (const { strategy, metrics: m } of s.runs) {
      lines.push(
        `| ${strategy} | ${m.served} | ${m.unserved} | ${m.failovers} | ${usd(m.paidUsd)} | ${usd(m.freeMonthlyUsd)} | ${usd(m.freeOneTimeUsd)} | ` +
          `${m.freeHours.toFixed(1)} | ${usd(m.expiredUsd)} | ${secs(m.readyMeanMs)} | ${secs(m.readyP95Ms)} | ${shares(m.share)} |`,
      );
    }
    const down = s.runs.flatMap((r) => (r.outage ? [`${r.strategy}: ${r.outage.provider}`] : []));
    const from = s.runs.find((r) => r.outage)?.outage?.from;
    if (from !== undefined) lines.push("", `Down from ${new Date(from).toISOString().slice(0, 16)}Z: ${down.join(", ")}.`);
    lines.push("");
  }
  return lines.join("\n");
}

// ------------------------------------------------------------------ CLI

const USAGE = `npm run simulate [-- options]

  --scenario <names>   comma-separated, from: ${scenarioNames.join(", ")} (default: all)
  --strategy <names>   comma-separated strategies to run (default: all)
  --days <n>           simulated days of arrivals (default 30)
  --seed <n>           PRNG seed (default 1)
  --rate <n>           requests a day before bursts (default ${DEFAULT_WORKLOAD.perDay})
  --docker             add local Docker (unlimited, self-hosted)
  --json               print JSON instead of markdown tables`;

function parseArgs(argv: string[]): { options: SimulateOptions; json: boolean; help: boolean } {
  const options: SimulateOptions = {};
  let json = false;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${flag} needs a value`);
      return v;
    };
    const number = () => {
      const v = value();
      if (!Number.isFinite(Number(v))) throw new Error(`${flag} needs a number, got "${v}"`);
      return Number(v);
    };
    const list = () => value().split(",").map((x) => x.trim()).filter(Boolean);
    if (flag === "--scenario") options.scenarios = [...(options.scenarios ?? []), ...list()];
    else if (flag === "--strategy") options.only = [...(options.only ?? []), ...list()];
    else if (flag === "--days") options.days = number();
    else if (flag === "--seed") options.seed = number();
    else if (flag === "--rate") options.workload = { ...options.workload, perDay: number() };
    else if (flag === "--docker") options.docker = true;
    else if (flag === "--json") json = true;
    else if (flag === "--help" || flag === "-h") help = true;
    else throw new Error(`unknown option ${flag}\n\n${USAGE}`);
  }
  return { options, json, help };
}

async function main(argv: string[]): Promise<void> {
  const { options, json, help } = parseArgs(argv);
  if (help) {
    console.log(USAGE);
    return;
  }
  const sim = await simulate(options);
  console.log(json ? JSON.stringify(sim, null, 2) : toMarkdown(sim));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
