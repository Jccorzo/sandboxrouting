// The AgentRun connector (src/agentrun): sandboxrouting as one AgentRun MachineHost, on fake providers in this process
// (no network, no keys). Covers create -> the launch's two execs -> get/list -> delete, delete twice, failover when the
// first provider refuses (402) and when its sandbox can't host a computer, the chosen provider and route in the labels,
// every made sandbox deleted when create fails after the router made it, extend through the router's setTimeout, the
// deadline as time passes, and AgentRun's own HostedProvider over the host.
import { execFileSync, spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { MemoryLedger, SandboxRouter, builtinProviders, defineProvider, type Capability, type ProviderAdapter, type ResolvedSpec } from "../src/index.js";
import {
  CHECK_COMMAND,
  create,
  launchCommand,
  PROVIDER_LABEL,
  ROUTE_LABEL,
  routingOf,
  SANDBOXROUTING,
  SANDBOXROUTING_ENV,
  SandboxRoutingHost,
  type RoutingChoices,
} from "../src/agentrun/index.js";
import { DEADLINE_LABEL, HostError, MAX_LABEL, NAME_LABEL } from "../src/agentrun/agentrun-computer.js";
import { clock } from "./fake.js";

const START = Date.UTC(2026, 10, 11, 12, 0, 0);
const IMAGE = "ghcr.io/parcha-ai/agentrun-box:0123456789ab";
const NAME = "computer-0123456789ab";
const TOKEN = `art_${"7".repeat(64)}`;
const BOOT = {
  AGENTRUN_ATTACH_URL: "wss://agentrun.example.com/v2/computers/attach",
  AGENTRUN_ATTACH_TOKEN: TOKEN,
  AGENTRUN_INIT_ARGS: "--user 2510:2510 --own-network",
};
const LABELS = {
  "agentrun.computer": "1",
  [NAME_LABEL]: NAME,
  [DEADLINE_LABEL]: new Date(START + 600_000).toISOString(),
  "agentrun.computer.image": IMAGE,
  [MAX_LABEL]: new Date(START + 3_600_000).toISOString(),
  team: "research",
};
const CTX = { timeoutMs: 30_000 };
const request = (over: Record<string, unknown> = {}) => ({
  name: NAME,
  image: IMAGE,
  labels: { ...LABELS },
  lifetimeMs: 600_000,
  backstopAt: new Date(START + 3_900_000).toISOString(),
  egress: true,
  boot: { env: { ...BOOT } },
  ...over,
});

type Answer = { exitCode: number; stdout?: string; stderr?: string } | Error;

interface FakeOptions {
  /** Thrown by create, in order; undefined means make one. */
  createErrors?: (unknown | undefined)[];
  /** The launch exec's answer (the command holding `setsid -f env`). */
  launch?: (command: string) => Answer;
  /** The check exec's answer (the command holding `kill -0`). */
  check?: () => Answer;
  setTimeout?: boolean;
  enforcesTimeout?: boolean;
  capabilities?: Capability[];
}

interface Fake extends ProviderAdapter {
  specs: ResolvedSpec[];
  commands: string[];
  made: string[];
  killed: string[];
  timeouts: number[];
}

const notFound = () => Object.assign(new Error("sandbox not found"), { status: 404 });

/** A provider whose execs answer the launch and the check as told, recording everything it is asked. */
function fake(id: string, o: FakeOptions = {}): Fake {
  const errors = [...(o.createErrors ?? [])];
  const specs: ResolvedSpec[] = [];
  const commands: string[] = [];
  const made: string[] = [];
  const killed: string[] = [];
  const timeouts: number[] = [];
  let n = 0;
  const answer = (a: Answer) => {
    if (a instanceof Error) throw a;
    return { stdout: a.stdout ?? "", stderr: a.stderr ?? "", exitCode: a.exitCode };
  };
  const adapter = defineProvider({
    info: {
      id,
      name: id,
      homepage: "https://example.test",
      env: [],
      capabilities: o.capabilities ?? ["customImage", ...(o.setTimeout ? (["extendTimeout"] as const) : [])],
      enforcesTimeout: o.enforcesTimeout,
      isolation: "microvm",
      freeTier: { tier: { kind: "monthly-hours", hours: 100 } },
      pricing: { vcpuSecondUsd: 0.00001, gibSecondUsd: 0, defaultCpu: 2, defaultMemoryMiB: 4096 },
    },
    async create(spec: ResolvedSpec) {
      specs.push(spec);
      const error = errors.shift();
      if (error) throw error;
      const psid = `${id}-${++n}`;
      made.push(psid);
      return { providerSandboxId: psid };
    },
    async exec(psid: string, command: string) {
      if (killed.includes(psid)) throw notFound();
      commands.push(command);
      if (command.includes("setsid -f env")) return answer(o.launch?.(command) ?? { exitCode: 0 });
      if (command.includes("kill -0")) return answer(o.check?.() ?? { exitCode: 0 });
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    async kill(psid: string) {
      if (killed.includes(psid)) throw notFound();
      killed.push(psid);
    },
    ...(o.setTimeout
      ? {
          async setTimeout(_psid: string, timeoutSec: number) {
            timeouts.push(timeoutSec);
          },
        }
      : {}),
  });
  return Object.assign(adapter, { specs, commands, made, killed, timeouts });
}

function setup(providers: Fake[], routing: RoutingChoices = { providers: providers.map((p) => p.info.id) }, launchAttempts?: number) {
  const c = clock(START);
  const router = new SandboxRouter({ providers, ledger: new MemoryLedger(), env: {}, now: c.now, config: {} });
  const host = new SandboxRoutingHost({ router: async () => router, routing, ...(launchAttempts ? { launchAttempts } : {}) });
  return { router, host, clock: c };
}

async function rejection(promise: Promise<unknown>): Promise<HostError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(Error);
  return error as HostError;
}

describe("create, get, list, delete", () => {
  it("routes the box image to a provider, starts agentrun-dial through the launch and the check, and reads the machine back from the ledger", async () => {
    const alpha = fake("alpha");
    const { host, router } = setup([alpha]);

    const { id } = await host.create(request(), CTX);
    expect(id).toMatch(/^sbr_/);

    // The router was asked for the box image, the machine's life, its labels as metadata; never the boot env.
    const [spec] = alpha.specs;
    expect(spec?.image).toBe(IMAGE);
    expect(spec?.timeoutSec).toBe(600);
    expect(spec?.env).toEqual({});
    expect(spec?.metadata).toMatchObject(LABELS);
    expect(spec?.needs).toContain("customImage");

    // Two execs: the launch with the boot env as agentrun-dial's own, then the check.
    expect(alpha.commands).toHaveLength(2);
    expect(alpha.commands[0]).toContain(`AGENTRUN_ATTACH_TOKEN='${TOKEN}'`);
    expect(alpha.commands[0]).toContain("setsid -f env");
    expect(alpha.commands[1]).toBe(CHECK_COMMAND);

    const machine = await host.get(id, CTX);
    expect(machine?.state).toBe("running");
    expect(machine?.labels).toMatchObject({ ...LABELS, [DEADLINE_LABEL]: new Date(START + 600_000).toISOString(), [PROVIDER_LABEL]: "alpha", [ROUTE_LABEL]: "alpha created (free)" });
    // The router's own metadata is no label of the machine's: AgentRun would read it as one never asked for.
    expect(Object.keys(machine?.labels ?? {}).filter((key) => key.startsWith("sandboxrouting."))).toEqual([]);
    expect(machine?.endsAt?.toISOString()).toBe(new Date(START + 600_000).toISOString());
    expect(machine?.resources).toEqual({ cpus: 2, memoryMb: 4096 });

    expect((await host.list({ "agentrun.computer": "1", [NAME_LABEL]: NAME }, CTX)).map((m) => m.id)).toEqual([id]);
    expect(await host.list({ [NAME_LABEL]: "computer-ffffffffffff" }, CTX)).toEqual([]);

    await host.delete(id, CTX);
    expect(alpha.killed).toEqual(["alpha-1"]);
    expect(await host.get(id, CTX)).toBeUndefined();
    expect(await host.list({ [NAME_LABEL]: NAME }, CTX)).toEqual([]);
    expect((await router.get(id))?.state).toBe("stopped");
  });

  it("deletes twice, and deletes an id it never made, as done", async () => {
    const alpha = fake("alpha");
    const { host } = setup([alpha]);
    const { id } = await host.create(request(), CTX);
    await host.delete(id, CTX);
    await host.delete(id, CTX); // the provider answers 404 now: already gone is done
    await host.delete("sbr_neverMade", CTX);
    // The router's adoption form (provider:id) is no machine of this host's: never connected, never killed.
    await host.delete("alpha:alpha-9", CTX);
    expect(alpha.killed).toEqual(["alpha-1"]);
    expect(await host.get("alpha:alpha-1", CTX)).toBeUndefined();
  });

  it("refuses a second create of a name a live machine holds as exists, which AgentRun adopts", async () => {
    const alpha = fake("alpha");
    const { host } = setup([alpha]);
    await host.create(request(), CTX);
    const error = await rejection(host.create(request(), CTX));
    expect(error).toBeInstanceOf(HostError);
    expect(error.code).toBe("exists");
    expect(alpha.made).toHaveLength(1);
  });
});

describe("failover", () => {
  it("goes to the next provider when the first refuses with a 402, and says so in the machine's labels", async () => {
    const alpha = fake("alpha", { createErrors: [Object.assign(new Error("payment required: free credit used up"), { status: 402 })] });
    const beta = fake("beta");
    const { host } = setup([alpha, beta]);
    const { id } = await host.create(request(), CTX);
    const machine = await host.get(id, CTX);
    expect(machine?.labels[PROVIDER_LABEL]).toBe("beta");
    expect(machine?.labels[ROUTE_LABEL]).toBe("alpha quota -> beta created (free)");
    expect(alpha.made).toEqual([]);
  });

  it("deletes a sandbox that can't host a computer and asks the router again without its provider", async () => {
    const alpha = fake("alpha", { launch: () => ({ exitCode: 75, stderr: "root can make no network namespace here, so init could not fence the computer's programs\n" }) });
    const beta = fake("beta");
    const { host } = setup([alpha, beta]);
    const { id } = await host.create(request(), CTX);
    expect(alpha.killed).toEqual(["alpha-1"]);
    expect(beta.specs[0]?.exclude).toContain("alpha");
    const machine = await host.get(id, CTX);
    expect(machine?.labels[PROVIDER_LABEL]).toBe("beta");
    expect(machine?.labels[ROUTE_LABEL]).toBe("alpha unfit -> beta created (free)");
  });

  it("fails over from a provider that ends what the launch's exec left running", async () => {
    const alpha = fake("alpha", { check: () => ({ exitCode: 75, stderr: "agentrun-dial did not outlive the launch's command" }) });
    const beta = fake("beta");
    const { host } = setup([alpha, beta]);
    const { id } = await host.create(request(), CTX);
    expect(alpha.killed).toEqual(["alpha-1"]);
    expect((await host.get(id, CTX))?.labels[PROVIDER_LABEL]).toBe("beta");
  });

  it("fails over from a provider whose exec fails outright", async () => {
    const alpha = fake("alpha", { launch: () => Object.assign(new Error("exec: 503 upstream unavailable"), { status: 503 }) });
    const beta = fake("beta");
    const { host } = setup([alpha, beta]);
    const { id } = await host.create(request(), CTX);
    expect(alpha.killed).toEqual(["alpha-1"]);
    expect((await host.get(id, CTX))?.labels[PROVIDER_LABEL]).toBe("beta");
  });

  it("stops after launchAttempts sandboxes, every one deleted, each reason in the error", async () => {
    const unfit = { launch: () => ({ exitCode: 75, stderr: "commands run as user, with no passwordless sudo" }) };
    const fakes = [fake("alpha", unfit), fake("beta", unfit), fake("gamma", unfit)];
    const { host, router } = setup(fakes, undefined, 2);
    const error = await rejection(host.create(request(), CTX));
    expect(error.code).toBe("refused");
    expect(error.message).toContain("alpha (sbr_");
    expect(error.message).toContain("beta (sbr_");
    expect(fakes[0]?.killed).toEqual(["alpha-1"]);
    expect(fakes[1]?.killed).toEqual(["beta-1"]);
    expect(fakes[2]?.made).toEqual([]);
    expect(await router.list()).toEqual([]);
  });

  it("names every earlier sandbox when the router then has no provider left", async () => {
    const alpha = fake("alpha", { launch: () => ({ exitCode: 75, stderr: "no box image here" }) });
    const { host } = setup([alpha]);
    const error = await rejection(host.create(request(), CTX));
    expect(error.message).toContain("No sandbox provider could take this request");
    expect(error.message).toContain("no box image here");
    expect(alpha.killed).toEqual(["alpha-1"]);
  });

  it("doesn't fail over when agentrun-dial stops itself, deletes the sandbox, and keeps the token out of the words", async () => {
    const alpha = fake("alpha", { check: () => ({ exitCode: 1, stderr: `agentrun-dial: fetching the daemon with ${TOKEN} failed` }) });
    const beta = fake("beta");
    const { host } = setup([alpha, beta]);
    const error = await rejection(host.create(request(), CTX));
    expect(error).toBeInstanceOf(HostError);
    expect(error.code).toBe("vendor");
    expect(error.message).toContain("agentrun-dial stopped within a second");
    expect(error.message).not.toContain(TOKEN);
    expect(alpha.killed).toEqual(["alpha-1"]);
    expect(beta.made).toEqual([]);
  });

  it("reads the router's refusal as a code AgentRun knows", async () => {
    const alpha = fake("alpha", { createErrors: [Object.assign(new Error("payment required"), { status: 402 })] });
    const { host } = setup([alpha]);
    const error = await rejection(host.create(request(), CTX));
    // The quota mark lapses at the month's reset: waiting helps, so a limit.
    expect(host.errorCode(error)).toBe("limit");
  });
});

describe("time and extend", () => {
  it("moves the end through the router's setTimeout, which the next read shows", async () => {
    const alpha = fake("alpha", { setTimeout: true });
    const { host, clock: c } = setup([alpha]);
    const { id } = await host.create(request(), CTX);
    c.advance(60_000);
    const later = new Date(START + 1_200_000);
    await host.extend(id, later, CTX);
    expect(alpha.timeouts).toEqual([1140]);
    const machine = await host.get(id, CTX);
    expect(machine?.labels[DEADLINE_LABEL]).toBe(later.toISOString());
    expect(machine?.endsAt?.toISOString()).toBe(later.toISOString());
  });

  it("never moves the end past the max-deadline label, and refuses a provider that can't move it, as limit", async () => {
    const alpha = fake("alpha", { setTimeout: true });
    const beta = fake("beta");
    const { host } = setup([alpha, beta]);
    const { id } = await host.create(request(), CTX);
    // Capped at the label: an hour from create.
    await host.extend(id, new Date(START + 7_200_000), CTX);
    expect(alpha.timeouts).toEqual([3600]);

    const other = setup([beta]);
    const made = await other.host.create(request(), CTX);
    const error = await rejection(other.host.extend(made.id, new Date(START + 1_200_000), CTX));
    expect(error.code).toBe("limit");
    expect(error.message).toContain("beta can't move a live sandbox's end");
  });

  it("reads a machine past its deadline as gone, and the list's sweep ends it on a provider with no timer", async () => {
    const alpha = fake("alpha", { enforcesTimeout: false });
    const { host, clock: c } = setup([alpha]);
    const { id } = await host.create(request(), CTX);
    c.advance(601_000);
    expect((await host.get(id, CTX))?.state).toBe("gone");
    expect(await host.list({ [NAME_LABEL]: NAME }, CTX)).toEqual([]);
    expect(alpha.killed).toEqual(["alpha-1"]);
    expect(await host.get(id, CTX)).toBeUndefined();
  });
});

describe("the launch's shell", () => {
  it("is valid sh, quotes every boot env value, and stops at once where the box image's agentrun-dial is missing", () => {
    const tricky = { AGENTRUN_ATTACH_TOKEN: "a'b $(echo pwned) `id` \"q\"", AGENTRUN_INIT_ARGS: "--user 2510:2510" };
    const launch = launchCommand(tricky);
    expect(launch).toContain(`AGENTRUN_ATTACH_TOKEN='a'\\''b $(echo pwned) \`id\` "q"'`);
    execFileSync("sh", ["-n", "-c", launch]);
    execFileSync("sh", ["-n", "-c", CHECK_COMMAND]);
    // This machine has no /usr/local/bin/agentrun-dial: the first line refuses, before any root step.
    const ran = spawnSync("sh", ["-c", launch], { encoding: "utf8" });
    expect(ran.status).toBe(75);
    expect(ran.stderr).toContain("did not start from the box image");
    expect(() => launchCommand({ "BAD NAME": "x" })).toThrow(/not a shell variable name/);
  });
});

describe("check and options", () => {
  it("refuses labels in the router's namespace and GPUs", () => {
    const { host } = setup([fake("alpha")]);
    expect(host.check({ image: IMAGE, labels: { "sandboxrouting.id": "x" } }).map((r) => r.field)).toEqual(["labels"]);
    expect(host.check({ image: "has space" }).map((r) => r.field)).toEqual(["image"]);
    expect(host.check({ image: IMAGE, gpu: { type: "h100", count: 1 } } as never).map((r) => r.field)).toEqual(["gpu"]);
    expect(host.check({ image: IMAGE, labels: { team: "a" } })).toEqual([]);
  });

  it("reads the routing choices from settings' strings and refuses wrong ones", () => {
    expect(routingOf({ strategy: "", providers: "e2b, daytona,", exclude: "", minIsolation: "" })).toEqual({ providers: ["e2b", "daytona"] });
    expect(routingOf({ strategy: "cheapest", exclude: ["modal"], minIsolation: "microvm" })).toEqual({ strategy: "cheapest", exclude: ["modal"], minIsolation: "microvm" });
    expect(() => routingOf({ minIsolation: "strong" as never })).toThrow(/minIsolation is one of/);
    const { router } = setup([fake("alpha")]);
    expect(() => create({ router, allowPaid: "true" })).toThrow(/set them in that router's config/);
    expect(() => create({ allowPaid: "maybe" })).toThrow(/allowPaid is true or false/);
  });

  it("declares microvm only where minIsolation asks for one, and never gvisor", () => {
    const facts = (minIsolation?: RoutingChoices["minIsolation"]) => new SandboxRoutingHost({ router: async () => setup([]).router, routing: minIsolation ? { minIsolation } : {} }).facts;
    expect(facts().isolation).toBe("container");
    expect(facts("gvisor").isolation).toBe("container");
    expect(facts("microvm").isolation).toBe("microvm");
    expect(facts("vm").isolation).toBe("microvm");
    expect(facts()).toMatchObject({ connect: "dial", daemon: "child", lifetime: "vendor", arch: "amd64" });
  });
});

describe("AgentRun's side", () => {
  it("passes every built-in provider's env to the router (descriptor hostEnv)", () => {
    const names = new Set(builtinProviders().flatMap((p) => p.info.env));
    const declared = new Set<string>(SANDBOXROUTING_ENV);
    expect([...names].filter((name) => !declared.has(name))).toEqual([]);
    expect(SANDBOXROUTING.id).toBe("sandboxrouting");
    expect(SANDBOXROUTING.connect).toBe("dial");
  });

  it("runs on AgentRun's HostedProvider, which refuses a create with no public address before the router is asked", async () => {
    const alpha = fake("alpha");
    const { router } = setup([alpha]);
    const provider = create({ router, providers: "alpha" });
    const caps = provider.capabilities();
    expect(caps.kind).toBe("linux");
    expect(caps.network).toEqual(["none", "open", "allow"]);
    const made = await provider.create({ image: IMAGE, lifetimeMs: 600_000, network: "none" }, { requestId: "req-0001" });
    expect(made.ok).toBe(false);
    expect(made.ok ? "" : made.error.code).toBe("refused");
    expect(alpha.specs).toEqual([]);
    const image = await create({ router, image: IMAGE }).prepareImage();
    expect(image).toEqual({ ok: true, value: IMAGE });
  });

  it("names the box image of the installed AgentRun package by default", async () => {
    const { router } = setup([]);
    const image = await create({ router }).prepareImage();
    expect(image.ok ? image.value : image.error.message).toMatch(/^ghcr\.io\/parcha-ai\/agentrun-box:[0-9a-f]{12}$/);
  });
});
