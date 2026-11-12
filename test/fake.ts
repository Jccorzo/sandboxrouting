import { SandboxRouter, MemoryLedger, defineProvider, type ProviderAdapter, type FreeTier, type Capability } from "../src/index.js";

export interface FakeOpts {
  id: string;
  tier: FreeTier;
  rate?: number; // $/vCPU-second
  concurrency?: number;
  maxLifetimeSec?: number;
  capabilities?: Capability[];
  selfHosted?: boolean;
  env?: string[];
  /** Thrown by create, in order; undefined means succeed. */
  createErrors?: (unknown | undefined)[];
  createDelayMs?: number;
}

export interface Fake extends ProviderAdapter {
  created: string[];
  killed: string[];
  files: Map<string, Uint8Array>;
}

export function fakeProvider(o: FakeOpts): Fake {
  let n = 0;
  const created: string[] = [];
  const killed: string[] = [];
  const files = new Map<string, Uint8Array>();
  const errors = [...(o.createErrors ?? [])];
  const adapter = defineProvider({
    info: {
      id: o.id,
      name: o.id,
      homepage: "https://example.test",
      env: o.env ?? [],
      capabilities: o.capabilities ?? ["fileList"],
      selfHosted: o.selfHosted,
      freeTier: { tier: o.tier, concurrency: o.concurrency, maxLifetimeSec: o.maxLifetimeSec },
      pricing: { vcpuSecondUsd: o.rate ?? 0.00001, gibSecondUsd: 0, defaultCpu: 1, defaultMemoryMiB: 1024 },
    },
    async create() {
      if (o.createDelayMs) await new Promise((r) => setTimeout(r, o.createDelayMs));
      const err = errors.shift();
      if (err) throw err;
      const id = `${o.id}-${++n}`;
      created.push(id);
      return { providerSandboxId: id };
    },
    async exec(id, command) {
      if (killed.includes(id)) throw Object.assign(new Error("sandbox not found"), { status: 404 });
      return { stdout: `${id}: ${command}\n`, stderr: "", exitCode: command.startsWith("exit ") ? Number(command.slice(5)) : 0 };
    },
    async readFile(id, path) {
      const data = files.get(`${id}:${path}`);
      if (!data) throw Object.assign(new Error(`${path} not found`), { status: 404 });
      return data;
    },
    async writeFile(id, path, data) {
      files.set(`${id}:${path}`, data);
    },
    async kill(id) {
      killed.push(id);
    },
  });
  return Object.assign(adapter, { created, killed, files });
}

export function clock(start = Date.UTC(2026, 10, 11, 12, 0, 0)) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    set: (ms: number) => {
      t = ms;
    },
  };
}

export function router(providers: ProviderAdapter[], config: unknown = {}, c = clock()) {
  return { router: new SandboxRouter({ providers, config, ledger: new MemoryLedger(), env: {}, now: c.now }), clock: c };
}
