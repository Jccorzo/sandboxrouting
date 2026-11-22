// sandboxrouting as an AgentRun MachineHost (AgentRun's packages/computer/src/host.ts; PROVIDERS.md, "The eleven
// members"). One host routes every machine through the router in this process: the router picks a provider (free usage
// first by default), fails over when one refuses (a 402, a 429, an outage), records the sandbox in its ledger, and
// later calls on the machine go back to the provider that holds it.
//
// The host is a dial host (facts.connect "dial"), as Fly Machines' is (AgentRun's src/fly.ts): sandboxrouting's exec
// answers once its command ends, and AgentRun's stdio bridge needs a live two-way process, so the machine dials the
// server instead. create asks the router for a sandbox of the box image (AgentRun's box/Dockerfile, which has
// agentrun-dial), then starts agentrun-dial in it through one exec, with the boot env as that process's alone, as E2B's
// dial launch does (AgentRun's src/e2b.ts DIAL_LAUNCH), and checks with a second exec that it outlived the first.
//
// State: the router's ledger is the one record of every machine. The host keeps nothing of its own: get and list read
// the ledger, the machine's end is the ledger's expiresAt (the deadline label is read from it), and delete and extend
// go through the router, which records each move before or as the provider makes it (src/core/state.ts).
import {
  COMPUTER_LABEL,
  DEADLINE_LABEL,
  HostError,
  MAX_LABEL,
  NAME_LABEL,
  type ComputerErrorCode,
  type ComputerSpec,
  type HostCall,
  type HostFacts,
  type Machine,
  type MachineHost,
  type MachineRequest,
  type Refusal,
} from "./agentrun-computer.js";
import { SANDBOXROUTING } from "./descriptor.js";
import { NoProviderAvailableError, SandboxRouterError, type Capability, type Isolation, type RouteAttempt, type SandboxRouter, type SandboxSpec, type SandboxView } from "./sandboxrouting.js";

/** The routing choices every machine's create asks the router for. Unset: the router's config decides. */
export interface RoutingChoices {
  /** free-first (default), cheapest, balanced, fastest, spread, or one registered on the router. */
  strategy?: string;
  /** Route among these provider ids alone, in this order of preference. */
  providers?: string[];
  /** Never route to these provider ids. */
  exclude?: string[];
  /** The weakest isolation acceptable; providers with weaker or unknown isolation are skipped. */
  minIsolation?: Isolation;
  /** Region hint, passed to providers that take one. */
  region?: string;
  /** Capabilities beyond customImage, which every machine needs for the box image. */
  needs?: Capability[];
}

export interface SandboxRoutingHostOptions {
  /** The router, made once on first use. */
  router: () => Promise<SandboxRouter>;
  routing?: RoutingChoices;
  /** Sandboxes tried for one machine when a sandbox can't host it (no root, no network namespace, ...). Default 3. */
  launchAttempts?: number;
}

/** The label names the host adds on every read: where the machine runs, and how the router got there. */
export const PROVIDER_LABEL = `${COMPUTER_LABEL}.sandboxrouting.provider`;
export const ROUTE_LABEL = `${COMPUTER_LABEL}.sandboxrouting.route`;
/** Where the route is kept, in the ledger record's metadata: written once, after the launch. */
const ROUTE_KEY = "sandboxrouting.route";
/** The router's own metadata namespace (it adds sandboxrouting.id): never a machine's label. */
const ROUTER_PREFIX = "sandboxrouting.";
/** A router id, sbr_ and 12 base64url characters (src/core/ledger.ts newSandboxId). */
const ROUTER_ID = /^sbr_[A-Za-z0-9_-]{1,64}$/;
/** The longest any provider's plan keeps a machine, as AgentRun's E2B states Pro's: the cap a provider option lowers. */
const MAX_LIFETIME_MS = 24 * 60 * 60_000;
const DIAL = "/usr/local/bin/agentrun-dial";
const DIAL_LOG = "/run/agentrun-dial.log";
const DIAL_PID = "/run/agentrun-dial.pid";
/** The exit code of a launch step that found this sandbox can't host a computer: the next provider may. */
const UNFIT = 75;
/** Each launch exec's bound, in seconds. */
const LAUNCH_EXEC_SEC = 60;

const quote = (word: string) => `'${word.replace(/'/g, `'\\''`)}'`;
const words = (error: unknown) => (error instanceof Error ? error.message : String(error));
/** The shell line that makes $p run a command as root: nothing as root, else passwordless sudo, else UNFIT. */
const AS_ROOT = `if [ "$(id -u)" = 0 ]; then p=; elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then p="sudo -n"; else echo "commands run as $(id -un), with no passwordless sudo, and agentrun-dial runs as root" >&2; exit ${UNFIT}; fi`;

/**
 * The launch: checks this sandbox can host a computer (the box image's agentrun-dial is there, root or passwordless
 * sudo, root can make a network namespace, which init's fence needs), closes the session buses in /tmp to the
 * computer's user (AgentRun's hosted/scripts.ts SOCKETS_SCRIPT, SESSION_BUSES), and starts agentrun-dial in a session
 * of its own, so it outlives the exec, with the boot env as its own environment. The env goes in the command, not the
 * exec's env option, which some adapters don't carry; the computer's programs, which start later, never see it.
 */
export function launchCommand(env: Record<string, string>): string {
  for (const name of Object.keys(env)) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new HostError("invalid", `the boot env's name ${JSON.stringify(name)} is not a shell variable name`);
  const assigns = Object.entries(env).map(([name, value]) => `${name}=${quote(value)}`);
  const inner = `echo $$ > ${DIAL_PID}; umask 077; exec >>${DIAL_LOG} 2>&1 </dev/null; exec ${DIAL}`;
  return [
    `[ -x ${DIAL} ] || { echo "${DIAL} is missing: this sandbox did not start from the box image" >&2; exit ${UNFIT}; }`,
    AS_ROOT,
    `$p unshare -n true 2>/dev/null || $p unshare -Urn true 2>/dev/null || { echo "root can make no network namespace here, so init could not fence the computer's programs" >&2; exit ${UNFIT}; }`,
    `$p sh -c 'for s in /tmp/dbus-*; do [ -S "$s" ] && [ ! -L "$s" ] || continue; chmod o-rwx "$s" || exit 1; done' || { echo "closing the session buses in /tmp failed" >&2; exit ${UNFIT}; }`,
    `$p rm -f ${DIAL_PID}`,
    `$p setsid -f env ${assigns.join(" ")} sh -c ${quote(inner)} </dev/null >/dev/null 2>&1 || { echo "setsid could not start agentrun-dial" >&2; exit ${UNFIT}; }`,
  ].join("\n");
}

/**
 * The check, a second exec a second later: agentrun-dial is still running. Gone with nothing in its log, the provider
 * ended what the launch's exec left running (UNFIT); gone with words in its log, agentrun-dial stopped itself, and its
 * log's last lines say why.
 */
export const CHECK_COMMAND = [
  AS_ROOT,
  "sleep 1",
  `pid=$($p cat ${DIAL_PID} 2>/dev/null)`,
  `[ -n "$pid" ] && $p kill -0 "$pid" 2>/dev/null && exit 0`,
  `log=$($p tail -c 600 ${DIAL_LOG} 2>/dev/null)`,
  `[ -n "$log" ] || { echo "agentrun-dial did not outlive the launch's command: this provider ends what a command leaves running" >&2; exit ${UNFIT}; }`,
  `printf '%s\\n' "$log" >&2`,
  "exit 1",
].join("\n");

/** A sandbox that can't host a computer, in words: the router's next provider may. */
class Unfit extends Error {}

/** Every boot env value of some length, out of words that go back to AgentRun (its token, its URLs). */
function redact(text: string, env: Record<string, string>): string {
  let out = text;
  for (const value of Object.values(env)) if (value.length >= 8) out = out.split(value).join("<redacted>");
  return out.trim().slice(-400);
}

/** The route in a few words: each provider the router tried and what came of it, the skipped ones left out. */
function routeWords(route: RouteAttempt[], earlier: string[]): string {
  const tried = route.filter((a) => a.outcome !== "skipped").map((a) => (a.outcome === "created" ? `${a.provider} created${a.billing ? ` (${a.billing})` : ""}` : `${a.provider} ${a.kind ?? a.outcome}`));
  return [...earlier, ...tried].join(" -> ").slice(0, 400);
}

/** The ledger's states as AgentRun's (host.ts Machine.state); undefined for a sandbox that is over. */
function stateOf(view: SandboxView): Machine["state"] | undefined {
  switch (view.state) {
    case "creating":
      return "starting";
    case "running":
      return "running";
    case "paused":
      return "stopped";
    case "expired":
      // Past its deadline: the provider's timer or the router's sweep is ending it.
      return "gone";
    default:
      return undefined;
  }
}

/** A sandbox as AgentRun reads a machine: its labels without the router's own, where it runs, and its end. */
export function machineOf(view: SandboxView): Machine | undefined {
  const state = stateOf(view);
  if (state === undefined) return undefined;
  const labels = Object.fromEntries(Object.entries(view.metadata).filter(([key]) => !key.startsWith(ROUTER_PREFIX)));
  labels[PROVIDER_LABEL] = view.provider;
  const route = view.metadata[ROUTE_KEY];
  if (route !== undefined) labels[ROUTE_LABEL] = route;
  // The ledger's end is the machine's: an extend moves it, and AgentRun reads the end from this label (deadlineOf).
  if (view.expiresAt !== undefined) labels[DEADLINE_LABEL] = view.expiresAt;
  const endsAt = view.expiresAt === undefined ? undefined : new Date(view.expiresAt);
  return {
    id: view.id,
    labels,
    state,
    createdAt: new Date(view.createdAt),
    ...(endsAt ? { endsAt } : {}),
    ...(state === "gone" ? { why: `its deadline ${view.expiresAt ?? ""} passed, so ${view.provider} or the router's sweep ends it` } : {}),
    resources: { cpus: view.cpu, memoryMb: view.memoryMiB },
  };
}

/** The code of an error the router threw, as AgentRun's (ComputerErrorCode). */
export function codeOf(error: unknown): ComputerErrorCode {
  if (error instanceof HostError) return error.code;
  // Every provider was skipped or refused: waiting helps when one's reason lapses (a monthly reset, a cooldown).
  if (error instanceof NoProviderAvailableError) return error.retryAt === undefined ? "refused" : "limit";
  if (error instanceof SandboxRouterError) {
    switch (error.kind) {
      case "not_found":
        return "not_found";
      case "invalid":
        return "invalid";
      case "unsupported":
        return "unsupported";
      case "quota":
      case "rate_limit":
        return "limit";
      case "auth":
        return "denied";
      case "conflict":
        return "refused";
      default:
        return "vendor";
    }
  }
  return "vendor";
}

export class SandboxRoutingHost implements MachineHost {
  readonly descriptor = SANDBOXROUTING;
  readonly facts: HostFacts;
  readonly #router: () => Promise<SandboxRouter>;
  readonly #routing: RoutingChoices;
  readonly #attempts: number;

  constructor(options: SandboxRoutingHostOptions) {
    this.#router = options.router;
    this.#routing = options.routing ?? {};
    this.#attempts = options.launchAttempts ?? 3;
    if (!Number.isInteger(this.#attempts) || this.#attempts < 1) throw new Error(`launchAttempts is a whole number of sandboxes, at least 1, not ${JSON.stringify(options.launchAttempts)}`);
    const strong = this.#routing.minIsolation === "microvm" || this.#routing.minIsolation === "vm";
    this.facts = {
      // agentrun-dial starts init as a child of its own process; nothing else is started through exec.
      daemon: "child",
      // The floor the routing guarantees: a microVM or a VM where minIsolation asks for one. Never gvisor: a request for
      // gVisor may land on a stronger provider, and AgentRun's read-back holds a gvisor claim to a gVisor kernel exactly.
      isolation: strong ? "microvm" : "container",
      // The router ends each sandbox at its deadline: the provider's own timer, or the router's sweep (list runs it)
      // where the provider has none (info.enforcesTimeout false).
      lifetime: "vendor",
      maxLifetimeMs: MAX_LIFETIME_MS,
      // The box image is built for amd64 alone (AgentRun's release.yml box job).
      arch: "amd64",
      // Unknown, provider by provider: init's fence keeps the computer's programs to their own loopback either way, and
      // isolation.vendor-agent checks it.
      vendorAgentPorts: [],
      connect: "dial",
    };
  }

  /** The image is a registry reference the providers pull; the router's metadata names are not a caller's labels. */
  check(spec: Partial<ComputerSpec>): Refusal[] {
    const refusals: Refusal[] = [];
    if (typeof spec.image === "string" && (spec.image.trim() === "" || /\s/.test(spec.image))) refusals.push({ field: "image", message: "an image is an OCI reference the routed provider pulls, such as ghcr.io/parcha-ai/agentrun-box:<tag>" });
    for (const key of Object.keys(spec.labels ?? {})) {
      if (key.startsWith(ROUTER_PREFIX)) refusals.push({ field: "labels", message: `the label ${key} is in sandboxrouting's own namespace (${ROUTER_PREFIX})` });
    }
    if (spec.gpu !== undefined) refusals.push({ field: "gpu", message: "sandboxrouting gives no GPU computers to AgentRun" });
    return refusals;
  }

  /**
   * A sandbox from the router, then agentrun-dial started in it. A sandbox that can't host a computer is deleted and the
   * router asked again without its provider, up to launchAttempts sandboxes; every failure after the router made one
   * deletes it before anything is thrown. A live machine already holding req.name is refused as exists, which AgentRun
   * adopts, as a retry of the request does.
   */
  async create(req: MachineRequest, ctx: HostCall): Promise<{ id: string }> {
    if (req.boot === undefined) throw new HostError("invalid", "a sandboxrouting machine dials the server, and the request has no boot env for it");
    const env = req.boot.env;
    const router = await this.#router();
    const named = (await router.list()).find((view) => view.metadata[NAME_LABEL] === req.name && view.state !== "creating");
    if (named !== undefined) throw new HostError("exists", `${req.name} is already the sandbox ${named.id} on ${named.provider}`);
    const unfit: string[] = [];
    const failures: string[] = [];
    for (let attempt = 0; attempt < this.#attempts; attempt++) {
      let sandbox: Awaited<ReturnType<SandboxRouter["create"]>>;
      try {
        sandbox = await router.create(this.#spec(req, unfit));
      } catch (error) {
        if (failures.length === 0) throw error;
        throw new HostError(codeOf(error), `${words(error)}\nBefore that: ${failures.join("; ")}`);
      }
      try {
        await this.#launch(sandbox, env, ctx);
      } catch (error) {
        const deleted = await sandbox.kill().then(
          () => "deleted",
          (killError) => `not deleted (${words(killError)}); the router's sweep ends it`,
        );
        const why = `${sandbox.provider} (${sandbox.id}): ${redact(words(error), env)}; the sandbox was ${deleted}`;
        if (!(error instanceof Unfit)) throw new HostError(codeOf(error), `starting agentrun-dial on ${why}`);
        unfit.push(sandbox.provider);
        failures.push(why);
        continue;
      }
      await this.#recordRoute(router, sandbox.id, routeWords(sandbox.route, unfit.map((id) => `${id} unfit`)));
      return { id: sandbox.id };
    }
    throw new HostError("refused", `${this.#attempts} sandboxes in a row could not host a computer: ${failures.join("; ")}`);
  }

  /** The machine as the ledger has it now; none for an id the router never made, or a sandbox that is over. */
  async get(id: string, _ctx: HostCall): Promise<Machine | undefined> {
    if (!ROUTER_ID.test(id)) return undefined;
    const view = await (await this.#router()).get(id);
    return view === undefined ? undefined : machineOf(view);
  }

  /**
   * The ledger's live and paused sandboxes carrying every one of these labels. The router's local sweep runs first, so a
   * sandbox past its deadline on a provider with no timer of its own is ended here, at the latest when AgentRun's
   * janitor lists. A sandbox still being created is left out: it has no machine id AgentRun could act on yet.
   */
  async list(labels: Record<string, string>, _ctx: HostCall): Promise<Machine[]> {
    const router = await this.#router();
    await router.sweep().catch(() => undefined);
    const views = await router.list();
    return views
      .filter((view) => view.state !== "creating")
      .flatMap((view) => machineOf(view) ?? [])
      .filter((machine) => Object.entries(labels).every(([key, value]) => machine.labels[key] === value));
  }

  /** The router's kill: recorded before the provider is asked, safe twice, and not found is done. */
  async delete(id: string, _ctx: HostCall): Promise<void> {
    if (!ROUTER_ID.test(id)) return;
    const router = await this.#router();
    if ((await router.get(id)) === undefined) return;
    try {
      await router.kill(id);
    } catch (error) {
      if (error instanceof SandboxRouterError && error.kind === "not_found") return;
      throw error;
    }
  }

  /**
   * Moves the machine's end through the router's setTimeout, which reserves the longer life against free credit or the
   * paid budget before the provider grants it. Never past the max-deadline label, never earlier than the end it has.
   * A provider that can't move a live sandbox's end, or a budget the longer life doesn't fit, is a limit, and nothing
   * moves.
   */
  async extend(id: string, endsAt: Date, _ctx: HostCall): Promise<void> {
    const router = await this.#router();
    const view = ROUTER_ID.test(id) ? await router.get(id) : undefined;
    if (view === undefined || view.state !== "running" || view.expiresAt === undefined) throw new HostError("gone", `${id} is ${view?.state ?? "not a sandbox the router has"}, so its end can't move`);
    const most = Date.parse(view.metadata[MAX_LABEL] ?? "");
    if (Number.isNaN(most)) throw new HostError("refused", `${id}'s label ${MAX_LABEL} reads ${JSON.stringify(view.metadata[MAX_LABEL])}, so the most it may live is unknown; nothing moved`);
    const now = router.now();
    const timeoutSec = Math.min(Math.ceil((endsAt.getTime() - now) / 1000), Math.floor((most - now) / 1000));
    const end = now + timeoutSec * 1000;
    if (timeoutSec <= 0 || end < Date.parse(view.expiresAt)) {
      throw new HostError("limit", `no whole number of seconds moves ${id}'s end from ${view.expiresAt} to ${endsAt.toISOString()} without passing ${new Date(most).toISOString()}, the most it may live; nothing moved`);
    }
    try {
      await (await router.connect(id)).setTimeout(timeoutSec);
    } catch (error) {
      if (error instanceof SandboxRouterError && error.kind === "unsupported") throw new HostError("limit", `${view.provider} can't move a live sandbox's end, so ${id} ends at ${view.expiresAt}; nothing moved`);
      if (error instanceof SandboxRouterError && error.kind === "quota") throw new HostError("limit", `${words(error)}; nothing moved`);
      throw error;
    }
  }

  errorCode(error: unknown): ComputerErrorCode {
    return codeOf(error);
  }

  /** What the router is asked for: the box image, the machine's size and life, its labels as metadata, the routing. */
  #spec(req: MachineRequest, unfit: string[]): SandboxSpec {
    const r = this.#routing;
    const exclude = [...(r.exclude ?? []), ...unfit];
    return {
      image: req.image,
      timeoutSec: Math.max(1, Math.ceil(req.lifetimeMs / 1000)),
      ...(req.cpus === undefined ? {} : { cpu: req.cpus }),
      ...(req.memoryMb === undefined ? {} : { memoryMiB: req.memoryMb }),
      metadata: { ...req.labels },
      needs: [...new Set<Capability>(["customImage", ...(r.needs ?? [])])],
      os: "linux",
      ...(r.strategy ? { strategy: r.strategy } : {}),
      ...(r.providers?.length ? { providers: r.providers.filter((id) => !unfit.includes(id)) } : {}),
      ...(exclude.length ? { exclude } : {}),
      ...(r.minIsolation ? { minIsolation: r.minIsolation } : {}),
      ...(r.region ? { region: r.region } : {}),
    };
  }

  /** The launch exec, then the check exec; Unfit for a sandbox that can't host a computer. */
  async #launch(sandbox: { provider: string; run: SandboxRunner }, env: Record<string, string>, ctx: HostCall): Promise<void> {
    const timeoutSec = Math.max(1, Math.min(LAUNCH_EXEC_SEC, Math.floor(ctx.timeoutMs / 1000)));
    let launched;
    try {
      launched = await sandbox.run(launchCommand(env), { timeoutSec });
    } catch (error) {
      // The provider's exec failed outright: this sandbox can't be launched, another provider's may.
      throw new Unfit(`its exec failed: ${words(error)}`);
    }
    if (launched.exitCode === UNFIT) throw new Unfit(launched.stderr.trim() || `the launch exited ${UNFIT}`);
    if (launched.exitCode !== 0) throw new Unfit(`the launch exited ${launched.exitCode}: ${launched.stderr.trim()}`);
    let checked;
    try {
      checked = await sandbox.run(CHECK_COMMAND, { timeoutSec });
    } catch (error) {
      throw new Unfit(`its exec failed: ${words(error)}`);
    }
    if (checked.exitCode === 0) return;
    if (checked.exitCode === UNFIT) throw new Unfit(checked.stderr.trim());
    throw new Error(`agentrun-dial stopped within a second; its log ends: ${checked.stderr.trim()}`);
  }

  /** The route, kept on the ledger record for every later read. Words for people: a failed write loses only them. */
  async #recordRoute(router: SandboxRouter, id: string, route: string): Promise<void> {
    if (route === "") return;
    await router.ledger
      .update((data) => {
        const record = data.sandboxes[id];
        if (record !== undefined) record.metadata = { ...record.metadata, [ROUTE_KEY]: route };
      })
      .catch(() => undefined);
  }
}

type SandboxRunner = (command: string, opts: { timeoutSec: number }) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
