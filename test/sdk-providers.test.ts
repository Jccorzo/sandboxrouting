// The adapters that still load an SDK (BoxLite, boxd, Beam: optional peers), driven through the
// router with their SDK modules replaced by fakes. The fakes run commands in a real local shell,
// so the adapters' quoting, cwd and env handling are exercised for real. The adapters rewritten
// over fetch are tested against HTTP mocks in test/fetch-*.test.ts.
import { describe, expect, it, vi } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { SandboxRouter, MemoryLedger, type ProviderAdapter } from "../src/index.js";

/** Runs argv locally like a remote sandbox would. */
function sh(argv: string[], opts: { cwd?: string; env?: Record<string, string> } = {}) {
  const r = spawnSync(argv[0]!, argv.slice(1), { cwd: opts.cwd, env: { ...process.env, ...opts.env }, encoding: "utf8" });
  return { stdout: r.stdout, stderr: r.stderr, exitCode: r.status ?? 1 };
}

const killed: string[] = [];

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

const { boxliteProvider, boxdProvider, beamProvider } = await import("../src/index.js");

function routerFor(p: ProviderAdapter, env: Record<string, string>) {
  return new SandboxRouter({ providers: [p], ledger: new MemoryLedger(), env, config: { allowPaid: true, providers: { [p.info.id]: { options: { pollMs: 1 } } } } });
}

const cases: [string, () => ProviderAdapter, Record<string, string>][] = [
  ["boxlite", () => boxliteProvider, { BOXLITE_API_KEY: "k" }],
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
