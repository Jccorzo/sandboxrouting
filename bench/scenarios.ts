// Simulated providers and the scenarios bench/simulate.ts runs. Free tiers, prices, caps and
// capabilities come from the real adapters' `info`, so the simulation follows the terms when
// they change. Only the behaviour is made up here: create latency, failures, outages, and
// credit spent outside the router. The latencies are plausible guesses, not measurements.

import type { ProviderInfo } from "../src/core/types.js";
import { daytonaProvider } from "../src/providers/daytona.js";
import { dockerProvider } from "../src/providers/docker.js";
import { e2bProvider } from "../src/providers/e2b.js";
import { flyProvider } from "../src/providers/fly.js";
import { freestyleProvider } from "../src/providers/freestyle.js";
import { koyebProvider } from "../src/providers/koyeb.js";
import { modalProvider } from "../src/providers/modal.js";
import { northflankProvider } from "../src/providers/northflank.js";
import { runloopProvider } from "../src/providers/runloop.js";
import { upstashProvider } from "../src/providers/upstash.js";
import { vercelProvider } from "../src/providers/vercel.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export interface ProviderModel {
  info: ProviderInfo;
  /** Create latency, log-normal: the median and the spread (sigma of the log). */
  latency: { p50Ms: number; sigma: number };
  /** Share of creates that fail with a 503, each one independently. */
  failRate: number;
  /** Windows in which every create fails with a 503, as ms offsets from the start of the run. */
  outages?: { fromMs: number; toMs: number }[];
  /**
   * What is really left of a credit at the start, in USD, when usage outside the router spent
   * part of it. The router doesn't know; once the provider's own meter passes this, creates get a 402.
   */
  trueCreditUsd?: number;
}

export interface Scenario {
  name: string;
  description: string;
  providers: ProviderModel[];
  /** Router config for the run; the simulator sets `routing.strategy` per run. */
  config: Record<string, unknown>;
  /**
   * Takes down whichever provider the run's strategy ranks first for a plain request at
   * `fromMs` (offset from the start), so every strategy loses its own favourite.
   */
  outageOfTop?: { fromMs: number; durationMs: number };
}

export interface ScenarioOptions {
  days: number;
  /** Add local Docker (unlimited, your hardware). */
  docker: boolean;
}

function model(info: ProviderInfo, p50Ms: number, sigma: number, failRate: number): ProviderModel {
  // No keys in a simulation: every provider counts as configured.
  return { info: { ...info, env: [] }, latency: { p50Ms, sigma }, failRate };
}

/** Ten cloud providers: five monthly free tiers, three one-time credits, two paid only. */
export function baseProviders(o: Pick<ScenarioOptions, "docker">): ProviderModel[] {
  return [
    model(modalProvider.info, 1500, 0.4, 0.01),
    model(northflankProvider.info, 9000, 0.35, 0.02), // schedules a whole service
    model(freestyleProvider.info, 800, 0.4, 0.01),
    model(vercelProvider.info, 2500, 0.4, 0.01),
    model(upstashProvider.info, 1200, 0.4, 0.02), // developer preview
    model(daytonaProvider.info, 700, 0.5, 0.01),
    model(e2bProvider.info, 450, 0.4, 0.01),
    model(runloopProvider.info, 5000, 0.4, 0.01), // full VM
    model(koyebProvider.info, 3000, 0.4, 0.01),
    model(flyProvider.info, 2500, 0.5, 0.01),
    ...(o.docker ? [model(dockerProvider.info, 1000, 0.3, 0.002)] : []),
  ];
}

const withModel = (providers: ProviderModel[], id: string, change: Partial<ProviderModel>) =>
  providers.map((p) => (p.info.id === id ? { ...p, ...change } : p));

/** The provider the flaky scenario breaks: a free tier with room for everything (ports, images, 100 at once). */
export const FLAKY = "modal";
/** The one-time credit spent outside the router: the one most strategies reach for early. */
export const EXTERNAL = "daytona";

export const scenarios: Record<string, (o: ScenarioOptions) => Scenario> = {
  steady: (o) => ({
    name: "steady",
    description: "Healthy providers (1-2% of creates fail), free tiers as published, paid usage off: what no free tier can take goes unserved.",
    providers: baseProviders(o),
    config: {},
  }),

  flaky: (o) => ({
    name: "flaky",
    description: `${FLAKY}, a high-ranked free tier, fails 30% of creates with a 503.`,
    providers: withModel(baseProviders(o), FLAKY, { failRate: 0.3 }),
    config: {},
  }),

  outage: (o) => ({
    name: "outage",
    description: "The provider each strategy ranks first goes down for 6 hours mid-run: every create fails with a 503.",
    providers: baseProviders(o),
    config: {},
    // Mid-run, in the busy part of the day, so it hits real traffic.
    outageOfTop: { fromMs: Math.floor(o.days / 2) * DAY + 12 * HOUR, durationMs: 6 * HOUR },
  }),

  tight: (o) => ({
    name: "tight",
    description: "Small free tiers that run out within days; allowPaid with a $25 monthly budget, enough if spent on the cheapest providers. No Docker.",
    providers: baseProviders({ ...o, docker: false }),
    config: {
      allowPaid: true,
      maxPaidUsdPerMonth: 25,
      providers: {
        modal: { freeTier: { kind: "monthly-credit", usd: 3 } },
        northflank: { freeTier: { kind: "monthly-credit", usd: 1 } },
        freestyle: { freeTier: { kind: "monthly-credit", usd: 1 } },
        vercel: { freeTier: { kind: "monthly-credit", usd: 1 } },
        upstash: { freeTier: { kind: "monthly-hours", hours: 1 } },
        daytona: { freeTier: { kind: "one-time-credit", usd: 4 } },
        e2b: { freeTier: { kind: "one-time-credit", usd: 3 } },
        runloop: { freeTier: { kind: "one-time-credit", usd: 2 } },
      },
    },
  }),

  "external-usage": (o) => ({
    name: "external-usage",
    description: `${EXTERNAL}'s $200 credit was mostly spent outside the router: $1 is really left, so it refuses with 402 long before the router expects.`,
    providers: withModel(baseProviders(o), EXTERNAL, { trueCreditUsd: 1 }),
    config: {},
  }),
};

export const scenarioNames = Object.keys(scenarios);
