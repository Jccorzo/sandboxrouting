// Router configuration: which providers are on, how to rank them, and overrides for
// free-tier terms and prices (they change, and accounts differ).

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { defaultHome } from "./ledger.js";

const freeTierSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({ kind: z.literal("one-time-credit"), usd: z.number().nonnegative() }),
  z.object({ kind: z.literal("monthly-credit"), usd: z.number().nonnegative() }),
  z.object({ kind: z.literal("monthly-hours"), hours: z.number().nonnegative() }),
  z.object({ kind: z.literal("unlimited") }),
]);

const providerConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    /** Lower goes first among providers in the same lane. Default 100. */
    priority: z.number().optional(),
    /** Allow paid usage on this provider (overrides the global setting). */
    allowPaid: z.boolean().optional(),
    /** Free tier override, e.g. a plan with more credit. */
    freeTier: freeTierSchema.optional(),
    concurrency: z.number().int().positive().optional(),
    /** Credit already spent before the router started tracking (one-time credits). */
    usedBeforeUsd: z.number().nonnegative().optional(),
    pricing: z
      .object({
        vcpuSecondUsd: z.number().nonnegative().optional(),
        gibSecondUsd: z.number().nonnegative().optional(),
        sandboxSecondUsd: z.number().nonnegative().optional(),
        /** `active-cpu` when the provider bills only the CPU time used (memory still by wall clock). */
        billing: z.enum(["wall", "active-cpu"]).optional(),
        /** Expected busy share of the vCPUs for `active-cpu` billing, 0..1 (default routing.activeCpuShare). */
        activeCpuShare: z.number().min(0).max(1).optional(),
      })
      .optional(),
    /** Adapter-specific options (e.g. openci `url`, Fly `app`). */
    options: z.record(z.unknown()).optional(),
    /** Isolation override, e.g. `gvisor` for Docker with `runtime: "runsc"`, or your openci workers'. */
    isolation: z.enum(["container", "gvisor", "microvm", "vm"]).optional(),
  })
  .strict();

/** How providers are ranked and when a failing one is benched. See docs/routing.md. */
const routingSchema = z
  .object({
    /** Strategy name: free-first, cheapest, balanced, fastest, spread, or one you registered. */
    strategy: z.string().optional(),
    /**
     * Expected busy share of the vCPUs, 0..1, used to rank providers that bill only active CPU
     * (`pricing.billing: "active-cpu"`). Default 0.3. Reservations still hold wall clock.
     */
    activeCpuShare: z.number().min(0).max(1).optional(),
    /** Weights of the `balanced` strategy's within-lane score. */
    weights: z
      .object({
        freeValue: z.number().nonnegative().default(1),
        health: z.number().nonnegative().default(1),
        speed: z.number().nonnegative().default(0.5),
        coverage: z.number().nonnegative().default(0.5),
        load: z.number().nonnegative().default(0.25),
      })
      .strict()
      .default({}),
    circuitBreaker: z
      .object({
        /** Consecutive infrastructure failures that open a provider's circuit. 0 turns it off. */
        failures: z.number().int().nonnegative().default(3),
        /** How long the circuit stays open after it trips; doubles per further failure. */
        cooldownSec: z.number().positive().default(120),
        maxCooldownSec: z.number().positive().default(1800),
      })
      .strict()
      .default({}),
    /** Infrastructure outcomes kept per provider for health and the circuit breaker. */
    healthSamples: z.number().int().positive().default(50),
  })
  .strict()
  .default({});

/** Defaults for jobs (multi-step work that moves between boxes). Each job can override them. */
export const jobPolicySchema = z
  .object({
    /** `every-step`: checkpoint the workdir after each step. `on-migrate`: only before a planned move. */
    checkpoint: z.enum(["every-step", "on-migrate"]).default("every-step"),
    /** Box changes allowed per job before it fails. */
    maxMigrations: z.number().int().nonnegative().default(5),
    /** Attempts per step for infrastructure failures (box lost, provider refused), on any box. */
    maxStepAttempts: z.number().int().positive().default(3),
    defaultStepTimeoutSec: z.number().int().positive().default(600),
    /** A step starts only if the box has its timeout plus this much life left. */
    deadlineMarginSec: z.number().int().nonnegative().default(60),
    /** How long a runner's claim on a job lasts without renewal. */
    leaseSec: z.number().int().positive().default(60),
    /** How long a job waits for capacity (rate limits, full free tiers) before failing. */
    maxWaitSec: z.number().int().nonnegative().default(300),
    /** Move off a paid box at a step boundary when a free one is available. */
    rebalance: z.boolean().default(false),
    /** On exit 137 (killed, usually out of memory), move to a box with twice the memory. */
    growMemoryOnOom: z.boolean().default(false),
    maxMemoryMiB: z.number().int().positive().default(16384),
    maxCheckpointBytes: z.number().int().positive().default(256 * 1024 * 1024),
  })
  .strict();

export const configSchema = z
  .object({
    /** Legacy name for `routing.strategy` (`free-first` or `cheapest`); `routing.strategy` wins. */
    policy: z.string().optional(),
    routing: routingSchema,
    jobs: jobPolicySchema.default({}),
    /** Allow paid usage once free usage is gone. Off by default: free tiers are enforced. */
    allowPaid: z.boolean().default(false),
    /** Most paid spend (USD) per calendar month across providers, when allowPaid is on. */
    maxPaidUsdPerMonth: z.number().nonnegative().optional(),
    /** Where your own hardware (local Docker, openci) goes: before cloud free tiers, after, or never. */
    selfHosted: z.enum(["first", "after-free", "never"]).default("after-free"),
    defaults: z
      .object({
        timeoutSec: z.number().int().positive().default(300),
        cpu: z.number().positive().optional(),
        memoryMiB: z.number().int().positive().optional(),
      })
      .default({}),
    providers: z.record(providerConfigSchema).default({}),
    /** Bearer token required by `sbr serve`. */
    serverToken: z.string().optional(),
  })
  .strict();

export type RouterConfig = z.infer<typeof configSchema>;
export type ProviderConfig = z.infer<typeof providerConfigSchema>;
export type RoutingConfig = RouterConfig["routing"];
export type JobPolicy = z.infer<typeof jobPolicySchema>;

export const DEFAULT_STRATEGY = "free-first";

/** The one place that decides which strategy a request uses. */
export function strategyNameFor(config: RouterConfig, spec?: { strategy?: string }): string {
  return spec?.strategy ?? config.routing.strategy ?? config.policy ?? DEFAULT_STRATEGY;
}

export function parseConfig(input: unknown): RouterConfig {
  return configSchema.parse(input ?? {});
}

/**
 * Loads config from `$SBR_CONFIG`, else `./sandboxrouting.json`, else `$SBR_HOME/config.json`.
 * Missing files mean defaults. `SBR_ALLOW_PAID=1` turns on paid usage for one invocation.
 */
export async function loadConfig(env: Record<string, string | undefined> = process.env, cwd = process.cwd()): Promise<RouterConfig> {
  const candidates = env["SBR_CONFIG"]
    ? [env["SBR_CONFIG"]]
    : [join(cwd, "sandboxrouting.json"), join(defaultHome(env), "config.json")];
  let raw: unknown = {};
  for (const path of candidates) {
    try {
      raw = JSON.parse(await readFile(path, "utf8"));
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT" && !env["SBR_CONFIG"]) continue;
      throw new Error(`reading ${path}: ${(err as Error).message}`);
    }
  }
  const config = parseConfig(raw);
  if (env["SBR_ALLOW_PAID"] === "1" || env["SBR_ALLOW_PAID"] === "true") config.allowPaid = true;
  if (env["SBR_SERVER_TOKEN"]) config.serverToken = env["SBR_SERVER_TOKEN"];
  return config;
}
