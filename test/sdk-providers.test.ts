// SDK-based adapters driven through the router with their SDK modules replaced by fakes.
// The fakes run commands in a real local shell, so the adapters' quoting, cwd and env
// handling are exercised for real; Lambda MicroVMs talks to the real execd from its template.
import { afterAll, describe, expect, it, vi } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import { SandboxRouter, MemoryLedger, type ProviderAdapter } from "../src/index.js";

/** Runs argv locally like a remote sandbox would. */
function sh(argv: string[], opts: { cwd?: string; env?: Record<string, string> } = {}) {
  const r = spawnSync(argv[0]!, argv.slice(1), { cwd: opts.cwd, env: { ...process.env, ...opts.env }, encoding: "utf8" });
  return { stdout: r.stdout, stderr: r.stderr, exitCode: r.status ?? 1 };
}

const killed: string[] = [];

vi.mock("@tenkicloud/sandbox", () => {
  class Session {
    id = "tk-1";
    cpuCores = 2;
    memoryMb = 4096;
    state = "RUNNING";
    timeoutAt = new Date(Date.now() + 60_000);
    async waitReady() {}
    async exec(cmd: string, o: { args: string[]; cwd?: string; env?: Record<string, string> }) {
      const r = sh([cmd, ...o.args], o);
      return { exitCode: r.exitCode, out: r.stdout, err: r.stderr };
    }
    async close() {
      killed.push(`tenki:${this.id}`);
    }
  }
  const s = new Session();
  return {
    TenkiSandbox: class {
      async create() {
        return s;
      }
      async get() {
        return s;
      }
      async list() {
        return [s];
      }
    },
    stdoutText: (r: { out: string }) => r.out,
    stderrText: (r: { err: string }) => r.err,
  };
});

vi.mock("@depot/sandbox", () => {
  const sbx = {
    sandboxId: "dp-1",
    status: "running",
    resources: { vcpus: 2, memoryMb: 4096 },
    async runCommand(o: { cmd: string; args: string[]; cwd?: string; env?: Record<string, string> }) {
      const r = sh([o.cmd, ...o.args], o);
      return { wait: async () => ({ exitCode: r.exitCode }), stdout: async () => r.stdout, stderr: async () => r.stderr };
    },
    async kill() {
      killed.push("depot:dp-1");
    },
  };
  return {
    createClient: () => ({}),
    Sandbox: { create: async () => sbx, get: async () => sbx, listAll: async function* () {} },
  };
});

vi.mock("@upstash/box", () => {
  const box = {
    id: "ub-1",
    exec: {
      // The box runs the command string through a shell.
      command: async (c: string) => {
        const r = sh(["sh", "-c", c]);
        return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode };
      },
    },
    files: { read: async () => "", write: async () => undefined, list: async () => [] },
    async delete() {
      killed.push("upstash:ub-1");
    },
  };
  return { EphemeralBox: { create: async () => box }, Box: { get: async () => box, list: async () => [] } };
});

vi.mock("@celestoai/sdk", () => {
  const c = {
    id: "cl-1",
    vcpus: 1,
    ramMb: 2048,
    status: "running",
    async run(cmd: string) {
      return sh(["sh", "-c", cmd]);
    },
    async delete() {
      killed.push("celesto:cl-1");
    },
  };
  return { Computer: { create: async () => c, get: async () => c, list: async () => [c] } };
});

vi.mock("@namespacelabs/sdk", () => ({
  fromBearerToken: () => ({}),
  loadDefaults: async () => ({}),
  createComputeClient: () => ({
    compute: {
      createInstance: async () => ({ metadata: { instanceId: "ns-1" } }),
      waitInstanceSync: async () => ({}),
      destroyInstance: async () => {
        killed.push("namespace:ns-1");
      },
      listInstances: async () => ({ instances: [] }),
    },
    command: {
      runCommandSync: async (req: { command: { command: string[]; cwd: string; envVars: { name: string; value: string }[] } }) => {
        const env = Object.fromEntries(req.command.envVars.map((e) => [e.name, e.value]));
        const r = sh(req.command.command, { cwd: req.command.cwd || undefined, env });
        return { stdout: new TextEncoder().encode(r.stdout), stderr: new TextEncoder().encode(r.stderr), exitCode: r.exitCode };
      },
    },
  }),
}));

vi.mock("@boxlite-ai/boxlite", () => {
  const stream = (s: string) => {
    let done = false;
    return { next: async () => (done ? null : ((done = true), s)) };
  };
  const box = {
    async info() {
      return { id: "bl-1", cpus: 1, memoryMib: 1024, state: { running: true } };
    },
    async exec(cmd: string, args: string[], env: [string, string][] | null, _tty: unknown, _user: unknown, _t: unknown, cwd: string | null) {
      const r = sh([cmd, ...args], { cwd: cwd ?? undefined, env: Object.fromEntries(env ?? []) });
      return { stdout: async () => stream(r.stdout), stderr: async () => stream(r.stderr), wait: async () => ({ exitCode: r.exitCode }) };
    },
  };
  return {
    BoxliteRestOptions: class {},
    ApiKeyCredential: class {},
    JsBoxlite: {
      rest: () => ({
        create: async () => box,
        get: async () => box,
        remove: async () => {
          killed.push("boxlite:bl-1");
        },
        listInfo: async () => [],
      }),
    },
  };
});

vi.mock("@boxd-sh/sdk", () => ({
  Boxd: class {
    machines = {
      async create(o: { deleteAfter: number; isolated: boolean; config: { vcpu: number; memory: string } }) {
        // The timer is what ends the machine, so it must always be sent.
        if (!(o.deleteAfter > 0) || !o.isolated || o.config.memory !== `${o.config.vcpu * 4}G`) throw new Error("bad boxd create");
        return { id: "bx-1" };
      },
      async waitUntilReady() {},
      async exec(_id: string, o: { command: string[]; env?: Record<string, string> }) {
        return sh(o.command, { env: o.env });
      },
      async delete(id: string) {
        killed.push(`boxd:${id}`);
      },
    };
  },
}));

vi.mock("@beamcloud/beam-js", () => {
  const instance = {
    sandboxId: "bm-1",
    terminated: false,
    async exec(argv: string[], o: { env?: Record<string, string> }) {
      const r = sh(argv, o);
      return { wait: async () => r.exitCode, stdout: { read: async () => r.stdout }, stderr: { read: async () => r.stderr } };
    },
  };
  return {
    beamOpts: {} as Record<string, string>,
    Image: class {},
    Sandbox: class {
      static async connect() {
        return instance;
      }
      static async terminate(id: string) {
        killed.push(`beam:${id}`);
        return true;
      }
      constructor(public config: { keepWarmSeconds: number }) {}
      async create() {
        // Without it the SDK's default lifetime is 60 seconds.
        if (!(this.config.keepWarmSeconds > 0)) throw new Error("bad beam create");
        return instance;
      }
    },
  };
});

// Lambda MicroVMs: a fake control plane in front of the real execd server.
const execd = await import("../templates/aws-lambda-microvm/execd.mjs");
execd.server.listen(0, "127.0.0.1");
await new Promise((ok) => execd.server.once("listening", ok));
const execdUrl = `http://127.0.0.1:${(execd.server.address() as AddressInfo).port}`;
afterAll(() => execd.server.close());

vi.mock("@aws-sdk/client-lambda-microvms", () => {
  class Cmd {
    constructor(public input: Record<string, unknown>) {}
  }
  const named = (name: string) => ({ [name]: class extends Cmd {} })[name]!;
  const RunMicrovmCommand = named("RunMicrovmCommand");
  const GetMicrovmCommand = named("GetMicrovmCommand");
  const CreateMicrovmAuthTokenCommand = named("CreateMicrovmAuthTokenCommand");
  const TerminateMicrovmCommand = named("TerminateMicrovmCommand");
  return {
    RunMicrovmCommand,
    GetMicrovmCommand,
    CreateMicrovmAuthTokenCommand,
    TerminateMicrovmCommand,
    SuspendMicrovmCommand: named("SuspendMicrovmCommand"),
    ResumeMicrovmCommand: named("ResumeMicrovmCommand"),
    ListMicrovmsCommand: named("ListMicrovmsCommand"),
    LambdaMicrovmsClient: class {
      async send(cmd: Cmd) {
        const kind = cmd.constructor.name;
        if (kind === "RunMicrovmCommand") {
          // Lambda delivers runHookPayload to the image's /run hook.
          await fetch(`${execdUrl}/run`, { method: "POST", body: String(cmd.input["runHookPayload"]) });
          return { microvmId: "mv-1", state: "PENDING", endpoint: execdUrl };
        }
        if (kind === "GetMicrovmCommand") return { microvmId: "mv-1", state: "RUNNING", endpoint: execdUrl };
        if (kind === "CreateMicrovmAuthTokenCommand") return { authToken: { "X-aws-proxy-auth": "jwe-token" } };
        if (kind === "TerminateMicrovmCommand") return void killed.push("lambda-microvm:mv-1");
        return {};
      }
    },
  };
});

const { tenkiProvider, depotProvider, upstashProvider, celestoProvider, namespaceProvider, boxliteProvider, lambdaMicrovmProvider, boxdProvider, beamProvider } = await import("../src/index.js");

function routerFor(p: ProviderAdapter, env: Record<string, string>) {
  return new SandboxRouter({ providers: [p], ledger: new MemoryLedger(), env, config: { allowPaid: true, providers: { [p.info.id]: { options: { pollMs: 1 } } } } });
}

const cases: [string, () => ProviderAdapter, Record<string, string>][] = [
  ["tenki", () => tenkiProvider, { TENKI_API_KEY: "k" }],
  ["depot", () => depotProvider, { DEPOT_TOKEN: "k" }],
  ["upstash", () => upstashProvider, { UPSTASH_BOX_API_KEY: "k" }],
  ["celesto", () => celestoProvider, { CELESTO_API_KEY: "k" }],
  ["namespace", () => namespaceProvider, { NSC_TOKEN: "k" }],
  ["boxlite", () => boxliteProvider, { BOXLITE_API_KEY: "k" }],
  ["lambda-microvm", () => lambdaMicrovmProvider, { LAMBDA_MICROVM_IMAGE: "arn:img" }],
  ["boxd", () => boxdProvider, { BOXD_API_KEY: "k" }],
  ["beam", () => beamProvider, { BEAM_TOKEN: "k", BEAM_WORKSPACE_ID: "ws" }],
];

describe.each(cases)("%s adapter", (id, provider, env) => {
  it("runs commands with quoting, cwd, env and exit codes intact, then kills", async () => {
    const r = routerFor(provider(), env);
    const sbx = await r.create({ timeoutSec: 60 });
    expect(sbx.provider).toBe(id);
    const tmp = execFileSync("mktemp", ["-d"], { encoding: "utf8" }).trim();
    const out = await sbx.commands.run(`echo "it's $X" && pwd && echo oops >&2 && exit 3`, { cwd: tmp, env: { X: "a b" } });
    expect(out.stdout.split("\n")[0]).toBe("it's a b");
    expect(out.stdout).toContain(tmp.split("/").pop()!);
    expect(out.exitCode).toBe(3);
    // Daytona and Together merge streams; these all keep stderr apart.
    expect(out.stderr.trim()).toBe("oops");
    await sbx.kill();
    expect(killed).toContain(`${id}:${sbx.providerSandboxId}`);
  });
});

describe("lambda-microvm through execd", () => {
  it("applies runHookPayload env and moves files through the endpoint", async () => {
    const r = routerFor(lambdaMicrovmProvider, { LAMBDA_MICROVM_IMAGE: "arn:img" });
    const sbx = await r.create({ timeoutSec: 60, env: { FROM_CREATE: "yes" } });
    expect((await sbx.commands.run("echo $FROM_CREATE")).stdout.trim()).toBe("yes");
    const dir = execFileSync("mktemp", ["-d"], { encoding: "utf8" }).trim();
    await sbx.files.write(`${dir}/sub/bin.dat`, new Uint8Array([0, 1, 255]));
    expect([...(await sbx.files.readBytes(`${dir}/sub/bin.dat`))]).toEqual([0, 1, 255]);
    expect((await sbx.files.list(`${dir}/sub`)).map((f) => f.name)).toEqual(["bin.dat"]);
    await sbx.kill();
    expect(killed).toContain("lambda-microvm:mv-1");
  });
});
