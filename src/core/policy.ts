// Plans a request in three steps: the hard filters build the candidates (routing/candidates.ts),
// a strategy orders them (routing/strategies.ts, or your own), and a last pass makes sure no
// strategy routed around allowPaid, the budget or a free tier's caps. Pure: it takes the ledger
// snapshot and returns the order plus the reason every other provider was left out, so
// `sbr route` can explain it.

import { strategyNameFor } from "./config.js";
import { billingProblem, buildCandidates } from "./routing/candidates.js";
import { StrategyRegistry } from "./routing/registry.js";
import type { Plan, PlanEntry, PolicyInput, RoutingStrategy } from "./routing/types.js";

export { billingOf, billingProblem, eligibility, isConfigured, isEnabled } from "./routing/candidates.js";
export type { Lane, Plan, PlanEntry, PolicyInput } from "./routing/types.js";

const builtins = new StrategyRegistry();

/** Without `strategy`, uses the built-in that `strategyNameFor` names (an unknown name throws). */
export function plan(input: PolicyInput & { strategy?: RoutingStrategy }): Plan {
  const strategy = input.strategy ?? builtins.get(strategyNameFor(input.config, input.spec));
  const { candidates, skipped } = buildCandidates(input);
  // A strategy can't rewrite the billing facts checked below (they are top-level fields).
  for (const c of candidates) Object.freeze(c);
  const result = strategy.rank(candidates, { spec: input.spec, config: input.config, now: input.now, data: input.data });

  const byProvider = new Map(candidates.map((c) => [c.provider, c]));
  const seen = new Set<string>();
  const ordered: PlanEntry[] = [];
  const dropped: Plan["skipped"] = [];
  for (const entry of result.ordered) {
    const c = byProvider.get(entry.provider);
    // Only candidates, once each: a strategy can't bring back a provider the filters skipped.
    if (!c || seen.has(entry.provider)) continue;
    seen.add(entry.provider);
    const problem = billingProblem(c, entry.billing);
    if (problem) dropped.push({ provider: entry.provider, reason: `strategy ${strategy.name} billed it as ${entry.billing}: ${problem}` });
    else ordered.push(entry);
  }

  // Every candidate not in the order is skipped exactly once, with the first reason given for it.
  const kept = new Set(ordered.map((e) => e.provider));
  const all = [...skipped];
  const add = (provider: string, reason: string) => {
    if (byProvider.has(provider) && !kept.has(provider) && !all.some((s) => s.provider === provider)) all.push({ provider, reason });
  };
  for (const s of [...dropped, ...(result.skipped ?? [])]) add(s.provider, s.reason);
  for (const c of candidates) add(c.provider, `left out by strategy ${strategy.name}`);
  return { strategy: strategy.name, ordered, skipped: all };
}
