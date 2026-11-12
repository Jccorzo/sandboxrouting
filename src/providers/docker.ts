// Local Docker: free and unlimited on your own machine. Uses the `docker` CLI, so it works
// with Docker Desktop, Colima, OrbStack or Podman's docker shim. Isolation is a container,
// not a microVM: fine for your own agents, weaker for untrusted code (use gVisor via
// `options.runtime: "runsc"` if installed).

import { spawn } from "node:child_process";
import { defineProvider, withCwdEnv } from "./util.js";
import { SandboxRouterError } from "../core/errors.js";
import type { ExecResult } from "../core/types.js";

interface RunOpts {
  input?: Buffer;
  timeoutMs?: number;
  onStdout?: (s: string) => void;
  onStderr?: (s: string) => void;
}

function docker(args: string[], opts: RunOpts = {}): Promise<ExecResult & { stdoutBytes: Buffer }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env["SBR_DOCKER_BIN"] ?? "docker", args, { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let stderr = "";
    let timer: NodeJS.Timeout | undefined;
    if (opts.timeoutMs) timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs);
    child.stdout.on("data", (b: Buffer) => {
      out.push(b);
      opts.onStdout?.(b.toString());
    });
    child.stderr.on("data", (b: Buffer) => {
      stderr += b.toString();
      opts.onStderr?.(b.toString());
    });
    child.on("error", (err) =>
      reject(
        (err as NodeJS.ErrnoException).code === "ENOENT"
          ? new SandboxRouterError("auth", "docker is not installed or not on PATH", "docker")
          : err,
      ),
    );
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      const stdoutBytes = Buffer.concat(out);
      resolve({ stdout: stdoutBytes.toString(), stdoutBytes, stderr, exitCode: code ?? 137 });
    });
    child.stdin.end(opts.input);
  });
}

async function must(args: string[], opts: RunOpts = {}) {
  const r = await docker(args, opts);
  if (r.exitCode !== 0) {
    const msg = r.stderr.trim();
    throw new SandboxRouterError(/No such container|is not running/i.test(msg) ? "not_found" : "transient", `docker ${args[0]}: ${msg}`, "docker");
  }
  return r;
}

const LABEL = "sandboxrouting=1";

export const dockerProvider = defineProvider({
  info: {
    id: "docker",
    name: "Local Docker",
    homepage: "https://docs.docker.com/engine/",
    env: [],
    capabilities: ["customImage", "pause", "ports"],
    isolation: "container",
    selfHosted: true,
    freeTier: { tier: { kind: "unlimited" }, notes: "Runs on this machine; costs nothing but your CPU." },
    pricing: { vcpuSecondUsd: 0, gibSecondUsd: 0, defaultCpu: 1, defaultMemoryMiB: 1024 },
    surfaces: { cli: "docker", rest: "Docker Engine API (unix socket)" },
  },

  isConfigured(ctx) {
    return ctx.env["SBR_DOCKER"] !== "0";
  },

  async create(spec, ctx) {
    const image = spec.nativeTemplate ?? spec.image ?? String(ctx.options["image"] ?? "python:3.12-slim");
    const args = ["run", "-d", "--rm", "--init", "--label", LABEL, "--label", `sandboxrouting.id=${spec.metadata["sandboxrouting.id"]}`];
    args.push("--cpus", String(spec.cpu), "--memory", `${spec.memoryMiB}m`);
    if (ctx.options["runtime"]) args.push("--runtime", String(ctx.options["runtime"]));
    if (spec.needs?.includes("ports") || ctx.options["publishAll"]) args.push("-P");
    for (const p of (ctx.options["ports"] as number[] | undefined) ?? []) args.push("-p", `127.0.0.1::${p}`);
    for (const [k, v] of Object.entries(spec.env)) args.push("-e", `${k}=${v}`);
    // The container stops itself at the deadline, like a cloud sandbox would.
    args.push(image, "sh", "-c", `sleep ${spec.timeoutSec}`);
    const r = await must(args, { timeoutMs: 10 * 60_000 });
    return { providerSandboxId: r.stdout.trim().slice(0, 12), cpu: spec.cpu, memoryMiB: spec.memoryMiB };
  },

  async exec(id, command, opts) {
    const args = ["exec", "-i"];
    for (const [k, v] of Object.entries(opts.env ?? {})) args.push("-e", `${k}=${v}`);
    if (opts.cwd) args.push("-w", opts.cwd);
    args.push(id, "sh", "-c", command);
    const r = await docker(args, {
      timeoutMs: opts.timeoutSec ? opts.timeoutSec * 1000 : undefined,
      onStdout: opts.onStdout,
      onStderr: opts.onStderr,
    });
    if (r.exitCode !== 0 && /No such container|is not running/i.test(r.stderr)) {
      throw new SandboxRouterError("not_found", r.stderr.trim(), "docker");
    }
    return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode };
  },

  async readFile(id, path) {
    const r = await must(["exec", id, "cat", path]);
    return new Uint8Array(r.stdoutBytes);
  },

  async writeFile(id, path, data) {
    await must(["exec", "-i", id, "sh", "-c", withCwdEnv(`mkdir -p "$(dirname "$P")" && cat > "$P"`, { env: { P: path } })], {
      input: Buffer.from(data),
    });
  },

  async getUrl(id, port) {
    const r = await must(["port", id, String(port)]);
    const first = r.stdout.trim().split("\n")[0] ?? "";
    if (!first) throw new SandboxRouterError("unsupported", `port ${port} is not published (create with needs: ["ports"])`, "docker");
    return `http://${first.replace("0.0.0.0", "127.0.0.1")}`;
  },

  async pause(id) {
    await must(["pause", id]);
  },

  async resume(id) {
    await must(["unpause", id]);
  },

  async kill(id) {
    await must(["rm", "-f", id]);
  },

  async listAlive() {
    const r = await must(["ps", "-q", "--no-trunc", "--filter", `label=${LABEL}`]);
    return r.stdout.split("\n").filter(Boolean).map((s) => s.slice(0, 12));
  },
});
