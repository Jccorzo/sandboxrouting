// A provider whose "sandboxes" are temp directories on this machine. Commands run with the
// real `sh`, HOME set to the sandbox's directory and cwd defaulting to it, so tar, base64 and
// friends behave like they do in a real box. Each sandbox is a separate directory, so a job
// moving from one to another really loses everything outside its checkpoint.
//
// Only for tests: commands run unsandboxed on the host. Use paths under $HOME (the workdir
// default "work" resolves there); absolute paths elsewhere touch the real filesystem.

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { defineProvider, type Capability, type ExecResult, type FreeTier, type ProviderAdapter } from "../src/index.js";

export interface LocalShellOpts {
  id: string;
  tier?: FreeTier;
  rate?: number;
  concurrency?: number;
  maxLifetimeSec?: number;
  maxTimeoutSec?: number;
  capabilities?: Capability[];
  /** Implement readFile/writeFile natively (default true). False exercises the exec fallbacks. */
  nativeFiles?: boolean;
  /** Thrown by create, in order; undefined means succeed. */
  createErrors?: (unknown | undefined)[];
  /**
   * Called before every exec. Return an Error to throw it, an ExecResult to return it instead
   * of running the command, or undefined to run the command normally.
   */
  execHook?: (sandboxId: string, command: string, n: number) => Error | ExecResult | undefined;
}

export interface LocalShell extends ProviderAdapter {
  /** Sandbox id → its directory (HOME). */
  dirs: Map<string, string>;
  created: string[];
  killed: string[];
  /** Makes a sandbox vanish: its directory is deleted and every later call says not found. */
  lose(sandboxId: string): Promise<void>;
  /** Deletes every directory this provider made. */
  cleanup(): Promise<void>;
  execCount: number;
}

const notFound = (id: string) => Object.assign(new Error(`sandbox ${id} not found`), { status: 404 });

function sh(command: string, opts: { cwd: string; env: Record<string, string>; timeoutSec?: number; onStdout?: (s: string) => void; onStderr?: (s: string) => void }): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("sh", ["-c", command], { cwd: opts.cwd, env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", ...opts.env } });
    let stdout = "";
    let stderr = "";
    let timer: NodeJS.Timeout | undefined;
    if (opts.timeoutSec) timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutSec * 1000);
    child.stdout.on("data", (b: Buffer) => {
      stdout += b.toString();
      opts.onStdout?.(b.toString());
    });
    child.stderr.on("data", (b: Buffer) => {
      stderr += b.toString();
      opts.onStderr?.(b.toString());
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? (signal === "SIGKILL" ? 137 : 1) });
    });
  });
}

export function localShellProvider(o: LocalShellOpts): LocalShell {
  const dirs = new Map<string, string>();
  const created: string[] = [];
  const killed: string[] = [];
  const lost = new Set<string>();
  const errors = [...(o.createErrors ?? [])];
  let n = 0;
  const state = { execCount: 0 };

  const dirOf = (id: string): string => {
    const d = dirs.get(id);
    if (!d || lost.has(id) || killed.includes(id)) throw notFound(id);
    return d;
  };
  // Paths are host paths; a relative one is relative to the sandbox's HOME.
  const resolvePath = (id: string, p: string) => (p.startsWith("/") ? p : join(dirOf(id), p));

  const native = o.nativeFiles !== false;
  const adapter = defineProvider({
    info: {
      id: o.id,
      name: `local shell ${o.id}`,
      homepage: "https://example.test",
      env: [],
      capabilities: o.capabilities ?? ["extendTimeout"],
      maxTimeoutSec: o.maxTimeoutSec,
      isolation: "container" as const,
      freeTier: { tier: o.tier ?? { kind: "monthly-credit", usd: 30 }, concurrency: o.concurrency, maxLifetimeSec: o.maxLifetimeSec },
      pricing: { vcpuSecondUsd: o.rate ?? 0.00001, gibSecondUsd: 0, defaultCpu: 1, defaultMemoryMiB: 1024 },
    },
    async create() {
      const err = errors.shift();
      if (err) throw err;
      const id = `${o.id}-${++n}`;
      const dir = await mkdtemp(join(tmpdir(), `sbr-local-${o.id}-`));
      dirs.set(id, dir);
      created.push(id);
      return { providerSandboxId: id };
    },
    async exec(id, command, opts) {
      const home = dirOf(id);
      state.execCount++;
      const hooked = o.execHook?.(id, command, state.execCount);
      if (hooked instanceof Error) throw hooked;
      if (hooked) return hooked;
      return sh(command, {
        cwd: opts.cwd ? resolvePath(id, opts.cwd) : home,
        env: { HOME: home, ...(opts.env ?? {}) },
        timeoutSec: opts.timeoutSec,
        onStdout: opts.onStdout,
        onStderr: opts.onStderr,
      });
    },
    ...(native
      ? {
          async readFile(id: string, path: string) {
            dirOf(id);
            try {
              return new Uint8Array(await readFile(resolvePath(id, path)));
            } catch (err) {
              if ((err as NodeJS.ErrnoException).code === "ENOENT") throw Object.assign(new Error(`${path} not found`), { status: 404 });
              throw err;
            }
          },
          async writeFile(id: string, path: string, data: Uint8Array) {
            const p = resolvePath(id, path);
            await mkdir(dirname(p), { recursive: true });
            await writeFile(p, data);
          },
        }
      : {}),
    async setTimeout(id) {
      dirOf(id);
    },
    async kill(id) {
      if (lost.has(id)) throw notFound(id);
      killed.push(id);
      const d = dirs.get(id);
      if (d) await rm(d, { recursive: true, force: true });
    },
    async listAlive() {
      return [...dirs.keys()].filter((id) => !lost.has(id) && !killed.includes(id));
    },
  });

  const shell = Object.assign(adapter, {
    dirs,
    created,
    killed,
    execCount: 0,
    async lose(id: string) {
      lost.add(id);
      const d = dirs.get(id);
      if (d) await rm(d, { recursive: true, force: true });
    },
    async cleanup() {
      await Promise.all([...dirs.values()].map((d) => rm(d, { recursive: true, force: true })));
    },
  });
  Object.defineProperty(shell, "execCount", { get: () => state.execCount });
  return shell as LocalShell;
}
