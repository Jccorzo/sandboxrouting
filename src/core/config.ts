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
      })
      .optional(),
    /** Adapter-specific options (e.g. openci `url`, Fly `app`). */
    options: z.record(z.unknown()).optional(),
  })
  .strict();

export const configSchema = z
  .object({
    /** `free-first` burns free usage before anything else; `cheapest` ranks by price only. */
    policy: z.enum(["free-first", "cheapest"]).default("free-first"),
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
