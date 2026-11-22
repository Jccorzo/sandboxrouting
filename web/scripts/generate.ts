// Writes the site's data from the router itself, at build time:
//
//   src/generated/providers.json   every built-in adapter's info, its README rows, and prices
//   src/generated/site.json        counts, strategies, defaults, and the examples the diagrams play:
//                                  real plans, a real failover, the circuit breaker, the sandbox and
//                                  job state machines (each move made by the router's own code)
//   public/data/plans/*.json       the hero grid of plans, one file per cell, fetched on demand
//
// Nothing here is typed in by hand. The examples run the real SandboxRouter against adapters whose
// info is the built-ins' and whose create() is scripted, on an in-memory ledger and a fixed clock.
// The outputs are gitignored and rebuilt before dev, build, lint, typecheck and test, so they
// can't go stale. Run: npm run generate (in web/).

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FootnoteDefinition, Root as MdRoot, RootContent, Table, TableCell } from "mdast";
import { toHtml } from "hast-util-to-html";
import { toHast } from "mdast-util-to-hast";
import { toString } from "mdast-util-to-string";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { visit } from "unist-util-visit";

import { parseConfig, strategyNameFor, type RouterConfig } from "../../src/core/config";
import { SandboxRouterError } from "../../src/core/errors";
import { providerHealth } from "../../src/core/health";
import { transitionJob, newJob, InvalidJobTransitionError } from "../../src/core/jobs/state";
import type { JobEvent, JobRecord } from "../../src/core/jobs/types";
import { MemoryLedger, emptyLedger, type LedgerData } from "../../src/core/ledger";
import { activeMarks, markRefusal } from "../../src/core/marks";
import { expectedRatePerSecond, ratePerSecond } from "../../src/core/metering";
import { SandboxRouter } from "../../src/core/router";
import { builtinStrategies } from "../../src/core/routing/strategies";
import type { Plan } from "../../src/core/routing/types";
import { effectiveState, transition, type SandboxEvent, type SandboxRecord } from "../../src/core/state";
import type { ProviderAdapter, SandboxSpec } from "../../src/core/types";
import { createMcpServer } from "../../src/mcp/server";
import { builtinProviders } from "../../src/providers/index";

import { loadDocs, repoRoot } from "../src/lib/docs";
import {
  REFERENCE_SIZE,
  planFile,
  planKey,
  type Attempt,
  type Category,
  type CircuitPoint,
  type ComparisonDoc,
  type FailoverStep,
  type JobFrame,
  type PlanDoc,
  type PlanGridEntry,
  type ProviderDoc,
  type QuotaPoint,
  type SiteData,
  type TransitionCell,
} from "../src/lib/generated-types";
import { rewriteHref } from "../src/lib/links";
import { COMPARE_IDS, pairSlug } from "../src/lib/compare-set";

const ROOT = repoRoot();
const WEB = path.join(ROOT, "web");
const adapters = builtinProviders();
const byId = new Map(adapters.map((a) => [a.info.id, a]));

// ---------------------------------------------------------------------------------- the clock

const checkedDates = adapters.flatMap((a) => (a.info.freeTier.checked ? [a.info.freeTier.checked] : [])).sort();
const newestChecked = checkedDates.at(-1)!;
const oldestChecked = checkedDates[0]!;
/** Every example is planned at noon UTC on the newest `checked` date, so a build is reproducible. */
const T0 = Date.parse(`${newestChecked}T12:00:00Z`);

// ---------------------------------------------------------------------------- the README rows

type CellNode = TableCell;
const readmeTree = unified().use(remarkParse).use(remarkGfm).parse(readFileSync(path.join(ROOT, "README.md"), "utf8")) as MdRoot;
const docs = loadDocs(ROOT);
const linkCtx = { ...docs.ctx, source: "README.md" };

function inlineHtml(nodes: RootContent[], footnotes?: string[]): string {
  const root: MdRoot = { type: "root", children: structuredClone(nodes) };
  visit(root, "link", (l) => {
    l.url = rewriteHref(l.url, linkCtx);
  });
  // Footnote markers are pulled out of the cell; their text is shown under the row instead.
  visit(root, "footnoteReference", (ref, index, parent) => {
    footnotes?.push(ref.identifier);
    if (parent && index !== undefined) {
      parent.children.splice(index, 1);
      return index;
    }
    return undefined;
  });
  const html = toHtml(toHast(root));
  return html.replace(/^<p>([\s\S]*)<\/p>$/, "$1").trim();
}

const footnoteDefs = new Map<string, string>();
visit(readmeTree, "footnoteDefinition", (def: FootnoteDefinition) => {
  footnoteDefs.set(def.identifier, inlineHtml(def.children as RootContent[]).replace(/<\/?p>/g, " ").replace(/\s+/g, " ").trim());
});

const readmeRows = new Map<string, NonNullable<ProviderDoc["readme"]>>();
const accessRows = new Map<string, NonNullable<ProviderDoc["access"]>>();
{
  let section = "";
  for (const node of readmeTree.children) {
    if (node.type === "heading") section = toString(node);
    if (node.type !== "table") continue;
    const table = node as Table;
    const headers = table.children[0]!.children.map((c) => toString(c));
    for (const row of table.children.slice(1)) {
      const first = row.children[0] as CellNode | undefined;
      const code = first?.children.find((c) => c.type === "inlineCode");
      const id = code && code.type === "inlineCode" ? code.value : undefined;
      if (!id || !byId.has(id)) continue;
      if (section === "Keys and access surfaces") {
        accessRows.set(id, { keysHtml: inlineHtml(row.children[1]!.children as RootContent[]), connectsHtml: inlineHtml(row.children[2]!.children as RootContent[]) });
        continue;
      }
      if (readmeRows.has(id)) continue;
      const notes: string[] = [];
      const cells = row.children.slice(1).map((c, i) => ({
        header: headers[i + 1] ?? "",
        html: inlineHtml(c.children as RootContent[], notes),
        text: toString(c).trim(),
      }));
      readmeRows.set(id, { section, cells, footnotes: [...new Set(notes)].map((n) => footnoteDefs.get(n) ?? "").filter(Boolean) });
    }
  }
}

// ------------------------------------------------------------------------------- providers

function categoryOf(a: ProviderAdapter): Category {
  const { info } = a;
  if (info.offByDefault) return "off";
  if (info.selfHosted) return "self-hosted";
  const kind = info.freeTier.tier.kind;
  if (kind === "monthly-credit" || kind === "monthly-hours") return "monthly";
  if (kind === "one-time-credit") return "one-time";
  return "paid";
}

const money = (usd: number) => (usd >= 100 || Number.isInteger(usd) ? `$${Math.round(usd).toLocaleString("en-US")}` : `$${usd.toFixed(2)}`);

function freeLabel(a: ProviderAdapter): string {
  const t = a.info.freeTier.tier;
  switch (t.kind) {
    case "monthly-credit":
      return `${money(t.usd)} every month`;
    case "monthly-hours":
      return `${t.hours.toLocaleString("en-US")} h every month`;
    case "one-time-credit":
      return `${money(t.usd)} once`;
    case "unlimited":
      return "Unlimited, on your hardware";
    case "none":
      return "No free usage";
  }
}

function adapterFile(id: string): { file: string; summary?: string } {
  const dir = path.join(ROOT, "src", "providers");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".ts")).sort()) {
    const text = readFileSync(path.join(dir, f), "utf8");
    if (!new RegExp(`(\\bid:\\s*|\\bID\\s*=\\s*)"${id}"`).test(text)) continue;
    const lead: string[] = [];
    for (const line of text.split("\n")) {
      if (!line.startsWith("//")) break;
      lead.push(line.replace(/^\/\/\s?/, ""));
    }
    const summary = lead.join(" ").replace(/\s+/g, " ").trim();
    return { file: `src/providers/${f}`, summary: summary || undefined };
  }
  throw new Error(`no adapter file declares id "${id}"`);
}

const providers: ProviderDoc[] = adapters.map((a) => {
  const { info } = a;
  const t = info.freeTier.tier;
  const maxPerSec = ratePerSecond(info.pricing, REFERENCE_SIZE.cpu, REFERENCE_SIZE.memoryMiB);
  const expPerSec = expectedRatePerSecond(info.pricing, REFERENCE_SIZE.cpu, REFERENCE_SIZE.memoryMiB);
  const freeHours =
    t.kind === "monthly-hours" ? t.hours : (t.kind === "monthly-credit" || t.kind === "one-time-credit") && maxPerSec > 0 ? t.usd / (maxPerSec * 3600) : undefined;
  const { file, summary } = adapterFile(info.id);
  return {
    id: info.id,
    name: info.name,
    homepage: info.homepage,
    category: categoryOf(a),
    adapterFile: file,
    adapterSummary: summary,
    env: info.env,
    sdkPackage: info.sdkPackage,
    capabilities: info.capabilities,
    isolation: info.isolation,
    os: info.os ?? "linux",
    maxTimeoutSec: info.maxTimeoutSec,
    maxExecSec: info.maxExecSec,
    selfHosted: Boolean(info.selfHosted),
    offByDefault: info.offByDefault,
    enforcesTimeout: info.enforcesTimeout !== false,
    surfaces: info.surfaces,
    freeTier: {
      kind: t.kind,
      usd: "usd" in t ? t.usd : undefined,
      hours: "hours" in t ? t.hours : undefined,
      concurrency: info.freeTier.concurrency,
      maxLifetimeSec: info.freeTier.maxLifetimeSec,
      requiresCard: info.freeTier.requiresCard,
      notes: info.freeTier.notes,
      source: info.freeTier.source,
      checked: info.freeTier.checked,
    },
    pricing: {
      vcpuSecondUsd: info.pricing.vcpuSecondUsd,
      gibSecondUsd: info.pricing.gibSecondUsd,
      sandboxSecondUsd: info.pricing.sandboxSecondUsd,
      defaultCpu: info.pricing.defaultCpu,
      defaultMemoryMiB: info.pricing.defaultMemoryMiB,
      billing: info.pricing.billing ?? "wall",
      activeCpuFloor: info.pricing.activeCpuFloor,
      source: info.pricing.source,
    },
    pricingUrl: info.pricing.source ?? info.freeTier.source,
    checked: info.freeTier.checked,
    maxUsdPerHour: maxPerSec * 3600,
    expectedUsdPerHour: expPerSec * 3600,
    freeHoursAtReference: freeHours,
    freeLabel: freeLabel(a),
    readme: readmeRows.get(info.id),
    access: accessRows.get(info.id),
  };
});

// ------------------------------------------------------------------------- planning helpers

/** Every key every adapter asks for, plus the extra variables some adapters' isConfigured reads. */
function fullEnv(list: ProviderAdapter[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const a of list) for (const e of a.info.env) env[e] = "set";
  // Some adapters need more than info.env (credentials, a region); set every variable any
  // provider file reads, except the router's own switches (SBR_DOCKER=0 turns Docker off).
  const dir = path.join(ROOT, "src", "providers");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
    for (const m of readFileSync(path.join(dir, f), "utf8").matchAll(/env\[["']([A-Z][A-Z0-9_]+)["']\]/g)) {
      if (!m[1]!.startsWith("SBR_")) env[m[1]!] ??= "set";
    }
  }
  const unconfigured = list.filter((a) => a.isConfigured && !a.isConfigured({ env, options: {} }));
  if (unconfigured.length) throw new Error(`examples: still not configured with every key set: ${unconfigured.map((a) => a.info.id).join(", ")}`);
  return env;
}

const ENV = fullEnv(adapters);

function filterOf(reason: string): number {
  if (/^(disabled in config|off by default)/.test(reason)) return 1;
  if (/^(not in the request's provider list|excluded by the request)/.test(reason)) return 2;
  if (/^self-hosted providers are off/.test(reason)) return 3;
  if (/^not configured/.test(reason)) return 4;
  if (/^(lacks |runs )/.test(reason)) return 5;
  if (/^cannot run an arbitrary image/.test(reason)) return 6;
  if (/^timeout \d+s is over its maximum/.test(reason)) return 7;
  if (/^exec timeout/.test(reason)) return 8;
  if (/^isolation /.test(reason)) return 9;
  if (/^circuit /.test(reason)) return 11;
  if (/^(strategy |left out by strategy)/.test(reason)) return 0;
  if (/^(free |no free tier|timeout over the free|paid )/.test(reason)) return 12;
  return 10;
}

function planDoc(plan: Plan): PlanDoc {
  return {
    strategy: plan.strategy,
    ordered: plan.ordered.map((e) => ({ provider: e.provider, lane: e.lane, billing: e.billing, usdPerHour: e.ratePerSecondUsd * 3600, why: e.why ?? [] })),
    skipped: plan.skipped.map((s) => ({ provider: s.provider, reason: s.reason, filter: filterOf(s.reason) })),
  };
}

const DEFAULTS = parseConfig({});

/** Stub methods on a real adapter's info: create follows `script`, everything else succeeds. */
function scripted(a: ProviderAdapter, script: (call: number) => Error | undefined): ProviderAdapter {
  let calls = 0;
  let n = 0;
  return {
    info: a.info,
    isConfigured: a.isConfigured,
    async create() {
      const err = script(calls++);
      if (err) throw err;
      return { providerSandboxId: `${a.info.id}-${++n}` };
    },
    async exec() {
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    async kill() {},
  };
}

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

// ------------------------------------------------------------------- the hero's example ledger

/**
 * Mid-month on the example clock: two monthly tiers part spent, one refused for quota, one rate
 * limited, one with a bad key, one whose circuit opened. Built with the router's own functions.
 */
function heroLedger(config: RouterConfig): { data: LedgerData; story: string[] } {
  const data = emptyLedger();
  const month = new Date(T0).toISOString().slice(0, 7);
  data.archivedUsd = { modal: { [month]: 18.4 }, freestyle: { [month]: 9.1 } };
  markRefusal(data, { provider: "vercel", kind: "quota", detail: "402 payment required", now: T0 - 3_600_000, resetsAt: Date.parse(`${new Date(T0 + 40 * 86_400_000).toISOString().slice(0, 7)}-01T00:00:00Z`) });
  markRefusal(data, { provider: "e2b", kind: "rate_limit", detail: "429 too many requests", now: T0 - 20_000 });
  markRefusal(data, { provider: "daytona", kind: "auth", detail: "401 invalid api key", now: T0 - 120_000 });
  for (let i = 3; i >= 1; i--) {
    data.health["northflank"] = [...(data.health["northflank"] ?? []), { at: new Date(T0 - i * 15_000).toISOString(), op: "create", ok: false, kind: "transient" }];
  }
  void config;
  return {
    data,
    story: [
      "every provider's key is set",
      "Modal has spent $18.40 of its $30 this month, Freestyle $9.10",
      "Vercel refused with a 402 an hour ago",
      "E2B answered 429 twenty seconds ago",
      "Daytona's key was refused two minutes ago",
      "Northflank failed three creates in a row",
    ],
  };
}

async function routerWith(opts: { data?: LedgerData; config?: unknown; list?: ProviderAdapter[]; now?: () => number }): Promise<{ router: SandboxRouter; ledger: MemoryLedger }> {
  const ledger = new MemoryLedger();
  if (opts.data) {
    const seed = opts.data;
    await ledger.update((d) => Object.assign(d, structuredClone(seed)));
  }
  const router = new SandboxRouter({
    config: parseConfig(opts.config ?? {}),
    ledger,
    env: ENV,
    providers: opts.list ?? adapters,
    now: opts.now ?? (() => T0),
  });
  return { router, ledger };
}

// ---------------------------------------------------------------------------- the hero's grid

const STRATEGIES = builtinStrategies().map((s) => s.name);
const NEEDS = ["ports", "gpu", "customImage", "pause"] as const;
const ISOLATION = ["", "gvisor", "microvm"] as const;

/** The default request's plan, with paid usage on or off. */
function cell(grid: PlanGridEntry[], c: { allowPaid: boolean }): PlanDoc {
  const key = planKey({ strategy: strategyNameFor(DEFAULTS), allowPaid: c.allowPaid, needs: [], minIsolation: "" });
  const hit = grid.find((g) => g.key === key);
  if (!hit) throw new Error(`hero grid has no cell ${key}`);
  return hit.plan;
}

/** The MCP server's tools, as the real server registers them. */
async function mcpTools(): Promise<{ name: string; description: string }[]> {
  const { router } = await routerWith({});
  const server = createMcpServer(router) as unknown as { _registeredTools?: Record<string, { description?: string }> };
  const tools = Object.entries(server._registeredTools ?? {}).map(([name, t]) => ({ name, description: t.description ?? "" }));
  if (!tools.length) throw new Error("mcp: found no registered tools (did the SDK rename _registeredTools?)");
  return tools;
}

async function heroGrid(): Promise<{ grid: PlanGridEntry[]; story: string[]; defaultKey: string }> {
  const { data, story } = heroLedger(DEFAULTS);
  const grid: PlanGridEntry[] = [];
  for (const allowPaid of [false, true]) {
    const { router } = await routerWith({ data, config: { allowPaid } });
    for (const strategy of STRATEGIES) {
      for (let mask = 0; mask < 1 << NEEDS.length; mask++) {
        const needs = NEEDS.filter((_, i) => mask & (1 << i));
        for (const minIsolation of ISOLATION) {
          const spec: SandboxSpec = { strategy, cpu: REFERENCE_SIZE.cpu, memoryMiB: REFERENCE_SIZE.memoryMiB, timeoutSec: 600, needs: [...needs] };
          if (minIsolation) spec.minIsolation = minIsolation;
          const plan = await router.plan(spec);
          grid.push({ key: planKey({ strategy, allowPaid, needs, minIsolation }), plan: planDoc(plan) });
        }
      }
    }
  }
  return { grid, story, defaultKey: planKey({ strategy: strategyNameFor(DEFAULTS), allowPaid: false, needs: [], minIsolation: "" }) };
}

// -------------------------------------------------------------------------- failover, for real

async function failover(): Promise<FailoverStep[]> {
  // Four monthly free tiers, asked in the request's order (lane and priority tie, so the
  // `providers` list decides); the first three refuse in the three ways that leave marks.
  const ids = ["modal", "vercel", "upstash", "freestyle"];
  let clock = T0;
  const behaviour: Record<string, (call: number) => Error | undefined> = {
    modal: () => httpError(402, "402 Payment Required: insufficient credit"),
    vercel: (c) => (c === 0 ? httpError(429, "429 Too Many Requests") : undefined),
    upstash: () => httpError(401, "401 Unauthorized: invalid API key"),
    freestyle: () => undefined,
  };
  const list = ids.map((id) => scripted(byId.get(id)!, behaviour[id]!));
  const { router, ledger } = await routerWith({ list, now: () => clock, config: { routing: { strategy: "free-first" } } });
  const order = (await router.plan({ timeoutSec: 600, providers: ids })).ordered.map((e) => e.provider);
  // The scripted refusals only tell a story if the providers are asked in this order.
  if (order.join() !== ids.join()) throw new Error(`failover example: expected ${ids.join(", ")}, the router planned ${order.join(", ")}`);

  const steps: FailoverStep[] = [];
  const run = async (atSec: number, label: string) => {
    clock = T0 + atSec * 1000;
    let attempts: Attempt[] = [];
    let created: string | undefined;
    let error: string | undefined;
    try {
      const sbx = await router.create({ timeoutSec: 600, providers: ids });
      attempts = sbx.route.map((r) => toAttempt(r, clock));
      created = sbx.provider;
      await sbx.kill();
    } catch (e) {
      const err = e as SandboxRouterError & { attempts?: never[] };
      error = err.message;
      attempts = ((err as unknown as { attempts?: Parameters<typeof toAttempt>[0][] }).attempts ?? []).map((r) => toAttempt(r, clock));
    }
    const data = await ledger.read();
    steps.push({
      atSec,
      label,
      request: `router.create({ providers: [${ids.map((i) => `"${i}"`).join(", ")}] })`,
      attempts: attempts.filter((a) => ids.includes(a.provider)),
      created,
      error,
      marks: ids.flatMap((id) => activeMarks(data, id, clock).map((m) => ({ provider: id, kind: m.kind, untilSec: Math.round((Date.parse(m.until) - T0) / 1000) }))),
      circuits: ids.map((id) => {
        const h = providerHealth(data, id, clock, DEFAULTS.routing.circuitBreaker);
        return { provider: id, circuit: h.circuit, consecutiveFailures: h.consecutiveFailures, openUntilSec: h.openUntil === undefined ? undefined : Math.round((h.openUntil - T0) / 1000) };
      }),
    });
  };
  await run(0, "The first request meets three refusals");
  await run(5, "Five seconds later, the marks route around them");
  await run(75, "After a minute the rate limit has lapsed");
  return steps;
}

function toAttempt(r: { provider: string; outcome: Attempt["outcome"]; detail?: string; kind?: string; lane?: string; billing?: string; until?: number }, now: number): Attempt {
  const out: Attempt = { provider: r.provider, outcome: r.outcome };
  if (r.detail) out.detail = r.detail.replace(/\(until [^)]*\)/, "").trim();
  if (r.kind) out.kind = r.kind;
  if (r.lane) out.lane = r.lane;
  if (r.billing) out.billing = r.billing;
  if (r.until !== undefined && r.until > now) out.untilSec = Math.round((r.until - now) / 1000);
  return out;
}

// --------------------------------------------------------------------- the circuit, for real

async function circuit(): Promise<CircuitPoint[]> {
  let clock = T0;
  // Northflank keeps failing with 503s, then recovers; Modal takes what it drops.
  const failUntil = 4; // the first four creates fail: three to open it, one failed probe
  const list = [scripted(byId.get("northflank")!, (c) => (c < failUntil ? httpError(503, "503 Service Unavailable") : undefined)), scripted(byId.get("modal")!, () => undefined)];
  const { router, ledger } = await routerWith({ list, now: () => clock, config: { routing: { strategy: "free-first" } } });
  const first = (await router.plan({ timeoutSec: 600, providers: ["northflank", "modal"] })).ordered[0]?.provider;
  if (first !== "northflank") throw new Error(`circuit example: northflank should be asked first, got ${first}`);
  const cfg = DEFAULTS.routing.circuitBreaker;
  const points: CircuitPoint[] = [];
  const at = async (sec: number, event: string, create: boolean) => {
    clock = T0 + sec * 1000;
    let label = event;
    if (create) {
      const sbx = await router.create({ timeoutSec: 600, providers: ["northflank", "modal"] });
      const tried = sbx.route.find((r) => r.provider === "northflank");
      label = `${event}: ${tried?.outcome === "created" ? "created on northflank" : tried?.outcome === "failed" ? "northflank failed (503), served by modal" : `northflank skipped, served by ${sbx.provider}`}`;
      await sbx.kill();
    }
    const h = providerHealth(await ledger.read(), "northflank", clock, cfg);
    points.push({ atSec: sec, event: label, circuit: h.circuit, consecutiveFailures: h.consecutiveFailures, openUntilSec: h.openUntil === undefined ? undefined : Math.round((h.openUntil - T0) / 1000) });
  };
  await at(0, "Request 1", true);
  await at(10, "Request 2", true);
  await at(20, "Request 3", true);
  await at(60, "Request 4", true);
  await at(20 + cfg.cooldownSec, "Cooldown over", false);
  await at(20 + cfg.cooldownSec + 5, "Request 5 probes", true);
  const second = 20 + cfg.cooldownSec + 5 + cfg.cooldownSec * 2;
  await at(second, "Doubled cooldown over", false);
  await at(second + 5, "Request 6 probes", true);
  return points;
}

function quota(): QuotaPoint[] {
  const DAY = 86_400_000;
  const data = emptyLedger();
  const out: QuotaPoint[] = [];
  let now = T0;
  for (let refusal = 1; refusal <= 6; refusal++) {
    const until = markRefusal(data, { provider: "e2b", kind: "quota", detail: "402", now });
    out.push({ refusal, atDay: Math.round((now - T0) / DAY), untilDay: Math.round((until - T0) / DAY) });
    now = until; // the half-open probe goes out as soon as the mark lapses, and is refused again
  }
  return out;
}

// --------------------------------------------------------------- the sandbox state machine

function sandboxMatrix(): SiteData["sandbox"] {
  const now = T0;
  const iso = (ms: number) => new Date(ms).toISOString();
  const base = { id: "sbr_example", provider: "modal", cpu: 2, memoryMiB: 4096, createdAt: iso(now - 600_000), metadata: {}, billing: "free" };
  const records: Record<string, SandboxRecord> = {
    creating: { ...base, state: "creating", timeoutSec: 600 },
    running: { ...base, state: "running", providerSandboxId: "sb-1", expiresAt: iso(now + 300_000), segments: [{ start: iso(now - 300_000) }] },
    paused: { ...base, state: "paused", providerSandboxId: "sb-1", segments: [{ start: iso(now - 600_000), end: iso(now - 300_000) }] },
    stopped: { ...base, state: "stopped", providerSandboxId: "sb-1", segments: [{ start: iso(now - 600_000), end: iso(now - 60_000) }], endedAt: iso(now - 60_000), reason: "killed" },
    failed: { ...base, state: "failed", segments: [], endedAt: iso(now - 60_000), error: "503" },
    expired: { ...base, state: "running", providerSandboxId: "sb-1", expiresAt: iso(now - 30_000), segments: [{ start: iso(now - 600_000) }] },
  };
  const events: SandboxEvent[] = [
    { type: "created", providerSandboxId: "sb-1", timeoutSec: 600 },
    { type: "createFailed", error: "503" },
    { type: "paused" },
    { type: "resumed", timeoutSec: 600 },
    { type: "timeoutSet", timeoutSec: 900 },
    { type: "stopped", reason: "killed" },
    { type: "lost", error: "not found before its deadline" },
  ];
  const cells: TransitionCell[] = [];
  for (const [from, rec] of Object.entries(records)) {
    if (effectiveState(rec, now) !== from) throw new Error(`sandbox example: ${from} reads as ${effectiveState(rec, now)}`);
    for (const ev of events) {
      try {
        const next = transition(rec, ev, now);
        const to = effectiveState(next, now);
        const cell: TransitionCell = { from, event: ev.type, to };
        if (next === rec) cell.error = "no change (idempotent)";
        if (next.state === "stopped" && next.reason !== "killed") cell.error = `reason recorded: ${next.reason}`;
        cells.push(cell);
      } catch (e) {
        cells.push({ from, event: ev.type, error: (e as Error).message.replace("sbr_example ", "") });
      }
    }
  }
  return {
    states: ["creating", "running", "paused", "stopped", "failed", "expired"],
    events: events.map((e) => e.type),
    cells,
    derived: "expired is never stored: a running sandbox past its deadline reads as expired (effectiveState).",
  };
}

// ------------------------------------------------------------------- the job state machine

function jobTrace(): SiteData["job"] {
  let now = T0;
  const iso = (ms: number) => new Date(ms).toISOString();
  const owner = "runner-1";
  const lease = () => ({ owner, until: iso(now + 600_000) });
  const steps = ["python main.py > out.txt", "python report.py out.txt", "curl -fsS -X POST https://hooks.example/done"];
  const setup = ["pip install -q requests"];
  let rec: JobRecord = newJob("job_example", {
    sandbox: { image: "python:3.12-slim" },
    setup: setup.map((run) => ({ run })),
    steps: [{ run: steps[0]! }, { run: steps[1]! }, { run: steps[2]!, idempotent: false }],
  }, now);
  const frames: JobFrame[] = [];
  const box = (provider: string, n: number) => ({ sandboxId: `sbr_${provider}_${n}`, provider, lane: "free-recurring", billing: "free", placedAt: iso(now) });
  const result = (step: number) => ({ step, exitCode: 0, sandboxId: (rec as { box?: { sandboxId: string } }).box?.sandboxId ?? "", provider: (rec as { box?: { provider: string } }).box?.provider ?? "", startedAt: iso(now - 4000), endedAt: iso(now), stdoutTail: "", stderrTail: "" });
  const ckpt = (step: number) => ({ key: `job_example/${step}.tgz`, sha256: "0".repeat(64), bytes: 18_432 + step * 2048, step, at: iso(now) });
  const frame = (event: string, detail?: string) => {
    const r = rec as JobRecord & { box?: { provider: string; sandboxId: string }; inFlight?: { step: number } };
    frames.push({
      event,
      state: r.state,
      detail,
      box: r.box && (r.state === "preparing" || r.state === "running" || r.state === "migrating") ? { provider: r.box.provider, sandboxId: r.box.sandboxId } : undefined,
      cursor: r.cursor,
      checkpoint: r.checkpoint?.step,
      inFlight: r.inFlight?.step,
      migrations: r.migrations,
      placements: r.placements.map((p) => ({ provider: p.provider, endReason: p.endReason })),
    });
  };
  const go = (ev: JobEvent, detail?: string) => {
    now += 4000;
    rec = transitionJob(rec, ev, now, owner);
    frame(ev.type, detail);
  };
  frame("submitted", "3 steps");
  go({ type: "claim", lease: lease() }, "runner-1 holds the lease");
  go({ type: "placed", box: box("modal", 1) }, "modal, free every month");
  go({ type: "prepared", cursor: 0 }, "setup ran; initial files written");
  go({ type: "stepStarted", step: 0 }, steps[0]);
  go({ type: "stepSucceeded", result: result(0), checkpoint: ckpt(0) }, "checkpoint of step 0 stored");
  go({ type: "stepStarted", step: 1 }, steps[1]);
  go({ type: "migrate", reason: "lost", detail: "the box vanished before its deadline" }, "box lost mid-step");
  go({ type: "left" }, "old box killed; avoid modal for this job");
  go({ type: "placed", box: box("freestyle", 1) }, "freestyle, the next free candidate");
  go({ type: "prepared", cursor: 1 }, "setup re-ran; checkpoint 0 restored");
  go({ type: "stepStarted", step: 1 }, `${steps[1]} (again: it is idempotent)`);
  go({ type: "stepSucceeded", result: result(1), checkpoint: ckpt(1) }, "checkpoint of step 1 stored");
  go({ type: "stepStarted", step: 2 }, steps[2]);
  go({ type: "stepSucceeded", result: result(2), checkpoint: ckpt(2) }, "checkpoint of step 2 stored");
  go({ type: "succeed" }, "the last checkpoint is the result");

  // A move the table forbids must still throw, or the diagram would be lying about the edges.
  try {
    transitionJob(rec, { type: "left" }, now + 1000, owner);
    throw new Error("job example: a finished job accepted another move");
  } catch (e) {
    if (e instanceof InvalidJobTransitionError || (e as SandboxRouterError).kind === "conflict") {
      /* expected */
    } else throw e;
  }
  return { states: ["queued", "placing", "preparing", "running", "migrating", "succeeded", "failed", "cancelled"], frames, spec: { steps, setup } };
}

// ----------------------------------------------------------------------------- comparisons

async function comparisons(): Promise<ComparisonDoc[]> {
  const out: ComparisonDoc[] = [];
  for (let i = 0; i < COMPARE_IDS.length; i++) {
    for (let j = i + 1; j < COMPARE_IDS.length; j++) {
      const a = COMPARE_IDS[i]!;
      const b = COMPARE_IDS[j]!;
      for (const id of [a, b]) if (!byId.has(id)) throw new Error(`compare-set names "${id}", which is not a built-in provider`);
      const plans: ComparisonDoc["plans"] = [];
      for (const [strategy, allowPaid] of [["free-first", false], ["cheapest", false], ["cheapest", true], ["fastest", false]] as const) {
        const { router } = await routerWith({ config: { allowPaid }, list: [byId.get(a)!, byId.get(b)!] });
        const p = planDoc(await router.plan({ strategy, cpu: REFERENCE_SIZE.cpu, memoryMiB: REFERENCE_SIZE.memoryMiB, timeoutSec: 600 }));
        plans.push({ strategy, allowPaid, ordered: p.ordered, skipped: p.skipped });
      }
      out.push({ slug: pairSlug(a, b), a, b, plans });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------- write

async function writeWhole(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value)}\n`);
  await rename(tmp, file); // whole or not at all: a reader never sees half a file
}

async function main(): Promise<void> {
  const counts = { monthly: 0, "one-time": 0, paid: 0, "self-hosted": 0, off: 0, total: providers.length, cloud: 0 } as SiteData["counts"];
  for (const p of providers) counts[p.category]++;
  counts.cloud = providers.filter((p) => !p.selfHosted).length;
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { version: string };

  const hero = await heroGrid();
  const site: SiteData = {
    asOf: new Date(T0).toISOString(),
    version: pkg.version,
    counts,
    newestChecked,
    oldestChecked,
    referenceSize: { ...REFERENCE_SIZE },
    strategies: builtinStrategies().map((s) => ({ name: s.name, description: s.description })),
    defaults: {
      strategy: strategyNameFor(DEFAULTS),
      activeCpuShare: DEFAULTS.routing.activeCpuShare ?? 0.3,
      circuitBreaker: { ...DEFAULTS.routing.circuitBreaker },
      healthSamples: DEFAULTS.routing.healthSamples,
      jobs: { ...DEFAULTS.jobs },
      allowPaid: DEFAULTS.allowPaid,
      timeoutSec: DEFAULTS.defaults.timeoutSec,
    },
    hero: {
      ledger: hero.story,
      defaultKey: hero.defaultKey,
      controls: { strategies: STRATEGIES, needs: [...NEEDS], isolation: [...ISOLATION] },
      ranked: {
        free: cell(hero.grid, { allowPaid: false }).ordered.length,
        paid: cell(hero.grid, { allowPaid: true }).ordered.length,
      },
    },
    mcpTools: await mcpTools(),
    failover: await failover(),
    circuit: await circuit(),
    quota: quota(),
    sandbox: sandboxMatrix(),
    job: jobTrace(),
    comparisons: await comparisons(),
  };

  const defaultPlan = hero.grid.find((g) => g.key === hero.defaultKey);
  if (!defaultPlan) throw new Error("hero grid has no default cell");
  const generated = path.join(WEB, "src", "generated");
  await writeWhole(path.join(generated, "providers.json"), providers);
  await writeWhole(path.join(generated, "site.json"), site);
  await writeWhole(path.join(generated, "default-plan.json"), defaultPlan);
  // One small file per cell of the grid, fetched when a visitor changes a control.
  const planDir = path.join(WEB, "public", "data", "plans");
  await rm(planDir, { recursive: true, force: true });
  await Promise.all(hero.grid.map((g) => writeWhole(path.join(planDir, `${planFile(g.key)}.json`), g.plan)));
  console.log(
    `generated: ${providers.length} providers (${readmeRows.size} with README rows), ${hero.grid.length} hero plans, ${site.comparisons.length} comparisons, terms checked ${oldestChecked}..${newestChecked}`,
  );
}

if (!existsSync(path.join(ROOT, "src", "providers", "index.ts"))) throw new Error("run from the repository (web/)");
await main();
