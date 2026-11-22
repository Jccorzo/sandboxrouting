// sandboxrouting as one AgentRun compute connector: `sandboxrouting/agentrun`. Computers on any of sandboxrouting's
// providers that can boot the box image, routed free usage first by default, with failover, on AgentRun's shared
// machine-host adapter (HostedProvider), which owns everything else a computer is: the daemon, the deadline as init
// holds it, the read-back, the probe, the janitor and every refusal's words. Durable runs, cost caps and the run
// timeline stay AgentRun's: this file adds none of them.
//
//   import { create } from "sandboxrouting/agentrun";
//   const provider = create({ strategy: "free-first", dial: { url, tokens, hub } });
//
// In AgentRun's repository this file is src/sandboxrouting.ts, host.ts goes beside it, descriptor.ts is
// src/descriptors/sandboxrouting.ts, conformance.ts is src/conformance/sandboxrouting.ts, and the two seams
// (agentrun-computer.ts, sandboxrouting.ts) become imports.
import { boxImageRef, HostedProvider, type HostedOptions, type HostedTimeouts, ok, type Result } from "./agentrun-computer.js";
import { SandboxRoutingHost, type RoutingChoices } from "./host.js";
import { loadRouterKit, type Capability, type Isolation, type SandboxRouter } from "./sandboxrouting.js";

export { SANDBOXROUTING, SANDBOXROUTING_ENV } from "./descriptor.js";
export { CHECK_COMMAND, codeOf, launchCommand, machineOf, PROVIDER_LABEL, ROUTE_LABEL, SandboxRoutingHost, type RoutingChoices, type SandboxRoutingHostOptions } from "./host.js";

/** A list option as a setting gives it (comma-separated, "" for none) or as code does. */
type List = string | readonly string[];

export interface SandboxRoutingProviderOptions extends Omit<HostedOptions, "kind" | "desktop" | "timeouts"> {
  /**
   * A router to use as it is, its config, ledger and providers its own. Default: one made on first use from the
   * environment, as `sbr` makes it (SBR_CONFIG or ./sandboxrouting.json, the ledger under SBR_HOME, every built-in
   * provider), so its free-tier metering is the one `sbr` and the REST server keep on this machine.
   */
  router?: SandboxRouter;
  /** The environment the router reads its config and its providers' keys from. Default process.env. */
  env?: Record<string, string | undefined>;
  /** free-first (the router's default), cheapest, balanced, fastest, spread. "" or unset: the router's config. */
  strategy?: string;
  /** Route among these provider ids alone, in order of preference. */
  providers?: List;
  /** Never route to these provider ids. */
  exclude?: List;
  /** The weakest isolation a computer may get: container, gvisor, microvm or vm. */
  minIsolation?: Isolation | "";
  /** Region hint for providers that take one. */
  region?: string;
  /** Capabilities every routed provider must have beside customImage (the box image needs it). */
  needs?: readonly Capability[];
  /** Allow paid usage once free usage is gone (true or "true"); overrides the config's allowPaid. */
  allowPaid?: boolean | string;
  /** The most paid spend per calendar month, in USD, across providers; overrides the config's. */
  maxPaidUsdPerMonth?: number | string;
  /** Sandboxes tried for one computer when one can't host it. Default 3. */
  launchAttempts?: number;
  /** The image prepareImage answers. Default the box image AgentRun's release published for the installed package. */
  image?: string;
  timeouts?: Partial<HostedTimeouts>;
}

/**
 * The router asks providers one after another, each create polled until the provider says ready, and the box image is
 * pulled at create; the machine then fetches its daemon and dials, which createMs bounds too.
 */
const TIMEOUTS: Partial<HostedTimeouts> = { createMs: 600_000, goneMs: 120_000 };
const ISOLATIONS: readonly string[] = ["container", "gvisor", "microvm", "vm"];

const listOf = (value: List | undefined, what: string): string[] | undefined => {
  if (value === undefined) return undefined;
  const list = typeof value === "string" ? value.split(",") : [...value];
  if (list.some((one) => typeof one !== "string")) throw new Error(`${what} is a list of provider ids, or one string of them separated by commas`);
  const ids = list.map((one) => one.trim()).filter((one) => one !== "");
  return ids.length > 0 ? ids : undefined;
};

function booleanOf(value: boolean | string | undefined): boolean | undefined {
  if (value === undefined || value === "") return undefined;
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  throw new Error(`allowPaid is true or false, not ${JSON.stringify(value)}`);
}

function usdOf(value: number | string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const usd = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(usd) || usd < 0) throw new Error(`maxPaidUsdPerMonth is an amount of USD, 0 or more, not ${JSON.stringify(value)}`);
  return usd;
}

/** The routing choices from the options, checked: each one's words when it is wrong. */
export function routingOf(options: Pick<SandboxRoutingProviderOptions, "strategy" | "providers" | "exclude" | "minIsolation" | "region" | "needs">): RoutingChoices {
  const { strategy, minIsolation, region, needs } = options;
  if (strategy !== undefined && typeof strategy !== "string") throw new Error("strategy is a strategy's name, such as free-first");
  if (minIsolation !== undefined && minIsolation !== "" && !ISOLATIONS.includes(minIsolation)) throw new Error(`minIsolation is one of ${ISOLATIONS.join(", ")}, not ${JSON.stringify(minIsolation)}`);
  const providers = listOf(options.providers, "providers");
  const exclude = listOf(options.exclude, "exclude");
  return {
    ...(strategy ? { strategy } : {}),
    ...(providers ? { providers } : {}),
    ...(exclude ? { exclude } : {}),
    ...(minIsolation ? { minIsolation } : {}),
    ...(region ? { region } : {}),
    ...(needs?.length ? { needs: [...needs] } : {}),
  };
}

/** The router this provider uses: the one given, else one made once, on first use, from the environment. */
function routerOf(options: SandboxRoutingProviderOptions): () => Promise<SandboxRouter> {
  const allowPaid = booleanOf(options.allowPaid);
  const maxPaidUsdPerMonth = usdOf(options.maxPaidUsdPerMonth);
  const given = options.router;
  if (given !== undefined) {
    if (allowPaid !== undefined || maxPaidUsdPerMonth !== undefined || options.env !== undefined) {
      throw new Error("allowPaid, maxPaidUsdPerMonth and env configure the router this provider makes: with options.router, set them in that router's config");
    }
    return async () => given;
  }
  let made: Promise<SandboxRouter> | undefined;
  return () =>
    (made ??= (async () => {
      const env = options.env ?? process.env;
      const kit = await loadRouterKit();
      const config = await kit.loadConfig(env);
      if (allowPaid !== undefined) config.allowPaid = allowPaid;
      if (maxPaidUsdPerMonth !== undefined) config.maxPaidUsdPerMonth = maxPaidUsdPerMonth;
      return kit.createRouter({ env, config });
    })().catch((error: unknown) => {
      made = undefined; // a config that failed to read is read again on the next call
      throw error;
    }));
}

/**
 * Computers on sandboxrouting's providers, each dialing the server that made it: a server with no public https address
 * (AGENTRUN_PUBLIC_URL, options.dial) refuses a create in words before the router is called. Kind linux alone.
 */
export class SandboxRoutingProvider extends HostedProvider {
  readonly #image: string | undefined;

  constructor(options: SandboxRoutingProviderOptions = {}) {
    const { router: _router, env: _env, strategy: _s, providers: _p, exclude: _e, minIsolation: _m, region: _r, needs: _n, allowPaid: _a, maxPaidUsdPerMonth: _u, launchAttempts, image, timeouts = {}, ...rest } = options;
    if (image !== undefined && (typeof image !== "string" || image.trim() === "")) throw new Error("image is the OCI reference of the box image, such as ghcr.io/parcha-ai/agentrun-box:<tag>");
    const host = new SandboxRoutingHost({ router: routerOf(options), routing: routingOf(options), ...(launchAttempts === undefined ? {} : { launchAttempts }) });
    super(host, { ...rest, timeouts: { ...TIMEOUTS, ...timeouts } });
    this.#image = image;
  }

  /**
   * The provider contract's prepareImage (its descriptor declares it): the box image AgentRun's release publishes, by
   * its public registry tag, which each routed provider pulls at create. No call.
   */
  async prepareImage(): Promise<Result<string>> {
    if (this.#image !== undefined) return ok(this.#image);
    try {
      return ok(await boxImageRef());
    } catch (error) {
      return { ok: false, error: { code: "vendor", message: `reading the box image's tag from @parcha/agentrun-computer failed: ${error instanceof Error ? error.message : String(error)}`, vendor: "sandboxrouting" } };
    }
  }
}

/** The provider from its options alone (AgentRun's ProviderModule.create). */
export function create(options: SandboxRoutingProviderOptions = {}): SandboxRoutingProvider {
  return new SandboxRoutingProvider(options);
}

/** The conformance CLI's module for sandboxrouting. */
export const conformance = () => import("./conformance.js");
