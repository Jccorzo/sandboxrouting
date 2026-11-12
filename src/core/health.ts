// Provider health, derived on read from the ledger's infrastructure samples (creates that
// worked or failed for a transient reason, boxes lost before their deadline). Success rate,
// latency and the circuit breaker are computed here each time and never stored, so there is
// no "open" flag to forget to clear. See docs/routing.md, "Health and the circuit breaker".

import type { HealthSample, LedgerData } from "./ledger.js";
import type { RoutingConfig } from "./config.js";
import type { ProviderHealth } from "./routing/types.js";

const HOUR = 3_600_000;
/** Samples older than this say nothing about the provider today. */
const MAX_AGE_MS = 7 * 24 * HOUR;
/** With few samples the success rate leans toward PRIOR_RATE, as if it had seen PRIOR_WEIGHT such outcomes. */
const PRIOR_RATE = 0.9;
const PRIOR_WEIGHT = 2;

/**
 * Adds an outcome. The caller holds the ledger lock. Keeps the newest `keep` samples from the
 * last 7 days (measured from this sample), oldest first.
 */
export function recordHealth(data: LedgerData, provider: string, sample: HealthSample, keep: number): void {
  const at = Date.parse(sample.at);
  const samples = (data.health[provider] ?? []).filter((s) => at - Date.parse(s.at) <= MAX_AGE_MS);
  samples.push(sample);
  // Outcomes can arrive out of order (a slow create finishing after a fast one); "newest" is by time.
  samples.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  data.health[provider] = samples.slice(Math.max(0, samples.length - keep));
}

export function providerHealth(
  data: LedgerData,
  provider: string,
  now: number,
  cfg: RoutingConfig["circuitBreaker"],
): ProviderHealth {
  const samples = (data.health[provider] ?? []).filter((s) => now - Date.parse(s.at) <= MAX_AGE_MS);

  let weight = 0;
  let okWeight = 0;
  for (const s of samples) {
    // Half-life of an hour. A sample stamped after `now` counts as brand new, never more.
    const w = 0.5 ** (Math.max(0, now - Date.parse(s.at)) / HOUR);
    weight += w;
    if (s.ok) okWeight += w;
  }

  const latencies = samples
    .flatMap((s) => (s.ok && s.op === "create" && s.ms !== undefined ? [s.ms] : []))
    .sort((a, b) => a - b);

  let consecutiveFailures = 0;
  while (consecutiveFailures < samples.length && !samples[samples.length - 1 - consecutiveFailures]!.ok) consecutiveFailures++;
  const lastFailure = samples.findLast((s) => !s.ok);
  const lastFailureAt = lastFailure ? Date.parse(lastFailure.at) : undefined;

  const health: ProviderHealth = {
    samples: samples.length,
    successRate: (okWeight + PRIOR_RATE * PRIOR_WEIGHT) / (weight + PRIOR_WEIGHT),
    createP50Ms: median(latencies),
    consecutiveFailures,
    lastFailureAt,
    circuit: "closed",
  };
  if (cfg.failures === 0 || consecutiveFailures < cfg.failures || lastFailureAt === undefined) return health;

  // Open for the cooldown, doubling with each failure past the threshold (a failed probe
  // reopens it for longer). After that, half-open: one create may probe it.
  const cooldownMs = Math.min(cfg.maxCooldownSec, cfg.cooldownSec * 2 ** (consecutiveFailures - cfg.failures)) * 1000;
  const openUntil = lastFailureAt + cooldownMs;
  return now < openUntil ? { ...health, circuit: "open", openUntil } : { ...health, circuit: "half-open" };
}

function median(sorted: number[]): number | undefined {
  if (!sorted.length) return undefined;
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1]! + sorted[mid]!) / 2;
}
