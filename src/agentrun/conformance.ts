// sandboxrouting for AgentRun's conformance run (AgentRun's src/conformance/<vendor>.ts). Its machines dial the server
// that minted their tokens, so a Core run happens inside that server's own process, behind its public address, as Fly's
// does: AgentRun's packages/serve/scripts/dial-conformance.mjs gives createProvider() its dial and the run a DialKit.
// From a laptop's CLI there is no such server: dialKit() refuses in words, and the provider refuses every create before
// the router is called.
//
// The routing choices come from COMPUTER_SANDBOXROUTING_* names. The providers' own keys are the router's to read, from
// the environment given (sandboxrouting's names: E2B_API_KEY, DAYTONA_API_KEY, ...), since no single name covers them.
import { boxImageRef, type DialKit, type HostedDial, type MachineHost } from "./agentrun-computer.js";
import { create, type SandboxRoutingProvider, type SandboxRoutingProviderOptions } from "./index.js";

/** The environment this module reads, by name, each for the option its comment names. */
export const SANDBOXROUTING_ENV_NAMES = {
  /** strategy: free-first (default), cheapest, balanced, fastest, spread. */
  strategy: "COMPUTER_SANDBOXROUTING_STRATEGY",
  /** providers: the provider ids to route among, comma-separated. */
  providers: "COMPUTER_SANDBOXROUTING_PROVIDERS",
  /** exclude: provider ids never to route to, comma-separated. */
  exclude: "COMPUTER_SANDBOXROUTING_EXCLUDE",
  /** minIsolation: container, gvisor, microvm or vm. */
  minIsolation: "COMPUTER_SANDBOXROUTING_MIN_ISOLATION",
  /** allowPaid: true lets the router pay once free usage is gone. */
  allowPaid: "COMPUTER_SANDBOXROUTING_ALLOW_PAID",
} as const;

/** The names this module reads, under the conformance modules' common name (ConformanceModule.ENV). */
export const ENV = SANDBOXROUTING_ENV_NAMES;

/** The longest lifetime a computer of a run may ask for. */
export const CONFORMANCE_MAX_LIFETIME_MS = 30 * 60_000;

/** The provider's routing options this module reads from env. */
export function settingsFromEnv(env: Record<string, string | undefined> = process.env): SandboxRoutingProviderOptions {
  const read = (name: string) => (env[name] === undefined || env[name] === "" ? undefined : env[name]);
  const strategy = read(ENV.strategy);
  const providers = read(ENV.providers);
  const exclude = read(ENV.exclude);
  const minIsolation = read(ENV.minIsolation) as SandboxRoutingProviderOptions["minIsolation"];
  const allowPaid = read(ENV.allowPaid);
  return {
    ...(strategy ? { strategy } : {}),
    ...(providers ? { providers } : {}),
    ...(exclude ? { exclude } : {}),
    ...(minIsolation ? { minIsolation } : {}),
    ...(allowPaid ? { allowPaid } : {}),
  };
}

export interface SandboxRoutingModuleOptions {
  /** The environment to read; process.env by default. The router reads its config and keys from it too. */
  env?: Record<string, string | undefined>;
  /** The server the machines dial: dial-conformance.mjs gives its own. Without it every create is refused in words. */
  dial?: HostedDial;
  /** The daemon the server serves (its sha256 is what a machine checks). */
  daemonPath?: string;
}

/** The provider the run makes computers with, dialing the server options.dial names. */
export function createProvider({ env = process.env, dial, daemonPath }: SandboxRoutingModuleOptions = {}): SandboxRoutingProvider {
  return create({
    ...settingsFromEnv(env),
    env,
    ...(dial ? { dial } : {}),
    ...(daemonPath === undefined ? {} : { daemonPath }),
    maxLifetimeMs: CONFORMANCE_MAX_LIFETIME_MS,
  });
}

/** The run's image: the box image AgentRun's release publishes, whose agentrun-dial the launch starts. */
export function conformanceImage(): Promise<string> {
  return boxImageRef();
}

/** Refused in words: a machine dials the server that minted its token, and a CLI run has no public server. */
export function dialKit(): DialKit {
  throw new Error("a sandboxrouting machine dials the server that minted its token, and this run has no public server: run its Core with packages/serve/scripts/dial-conformance.mjs --provider sandboxrouting inside a server the internet reaches at AGENTRUN_PUBLIC_URL");
}

/** The host the live sweep lists and deletes through, from the same settings; it makes nothing. */
export function createHost({ env = process.env }: Pick<SandboxRoutingModuleOptions, "env"> = {}): MachineHost {
  return create({ ...settingsFromEnv(env), env }).host;
}

/** Where the sweep lists, in words: the router's ledger on this machine. */
export function sweepScope({ env = process.env }: Pick<SandboxRoutingModuleOptions, "env"> = {}): string {
  return `the sandboxrouting ledger under ${env["SBR_HOME"] ?? "~/.sandboxrouting"}`;
}
