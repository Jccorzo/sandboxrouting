// The handle callers hold. Same shape whatever provider is behind it, modelled on the
// SDK shape most providers share: `sandbox.commands.run`, `sandbox.files.*`, `getUrl`,
// `setTimeout`, `kill`. Where an adapter lacks a native call, it falls back to exec.

import type { ExecOptions, ExecResult, FileInfo, ProviderAdapter } from "./types.js";
import type { SandboxRouter, SandboxView } from "./router.js";
import { classify, SandboxRouterError, type RouteAttempt } from "./errors.js";

export const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const UNSUPPORTED = Symbol("unsupported");
const WRITE_CHUNK = 48 * 1024; // base64 bytes per exec call; keeps argv well under limits

export class Sandbox {
  readonly commands: { run: (command: string, opts?: ExecOptions) => Promise<ExecResult> };
  readonly files: {
    read: (path: string) => Promise<string>;
    readBytes: (path: string) => Promise<Uint8Array>;
    write: (path: string, content: string | Uint8Array) => Promise<void>;
    list: (path?: string) => Promise<FileInfo[]>;
  };

  constructor(
    private readonly router: SandboxRouter,
    /** Router id (`sbr_…`): what you pass to `connect`, the CLI, REST and MCP. */
    readonly id: string,
    readonly provider: string,
    readonly providerSandboxId: string,
    /** How the router picked this provider: every provider tried or skipped, and why. */
    readonly route: RouteAttempt[],
  ) {
    this.commands = { run: (c, o) => this.run(c, o) };
    this.files = {
      read: async (p) => new TextDecoder().decode(await this.readBytes(p)),
      readBytes: (p) => this.readBytes(p),
      write: (p, c) => this.write(p, typeof c === "string" ? new TextEncoder().encode(c) : c),
      list: (p = ".") => this.list(p),
    };
  }

  private get adapter(): ProviderAdapter {
    return this.router.adapter(this.provider);
  }

  private get ctx() {
    return this.router.ctxFor(this.adapter);
  }

  /** Runs a provider call; a "not found" means the sandbox is gone, which the ledger records. */
  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (raw) {
      const err = classify(raw, this.provider);
      if (err.kind === "not_found") {
        await this.router.apply(this.id, { type: "stopped", reason: "gone" }).catch(() => undefined);
      } else if (err.kind === "quota" || err.kind === "rate_limit" || err.kind === "auth") {
        await this.router.markFromError(this.provider, err);
      }
      throw err;
    }
  }

  /** Runs a native call; an adapter throwing `unsupported` asks for the exec fallback. */
  private async native<T>(fn: () => Promise<T>): Promise<T | typeof UNSUPPORTED> {
    try {
      return await this.call(fn);
    } catch (err) {
      if (err instanceof SandboxRouterError && err.kind === "unsupported") return UNSUPPORTED;
      throw err;
    }
  }

  async info(): Promise<SandboxView | undefined> {
    return this.router.get(this.id);
  }

  run(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    return this.call(() => this.adapter.exec(this.providerSandboxId, command, opts, this.ctx));
  }

  private async readBytes(path: string): Promise<Uint8Array> {
    const a = this.adapter;
    if (a.readFile) {
      const native = await this.native(() => a.readFile!(this.providerSandboxId, path, this.ctx));
      if (native !== UNSUPPORTED) return native;
    }
    // Check first: in a pipeline the exit status is tr's, which would hide a missing file.
    const q = shellQuote(path);
    const r = await this.run(`[ -f ${q} ] && [ -r ${q} ] || { echo "no such file: ${path.replace(/[`"$\\]/g, "")}" >&2; exit 1; }; base64 < ${q} | tr -d '\\n'`);
    if (r.exitCode !== 0) throw new SandboxRouterError("not_found", `read ${path}: ${r.stderr.trim()}`, this.provider);
    return Buffer.from(r.stdout.trim(), "base64");
  }

  private async write(path: string, data: Uint8Array): Promise<void> {
    const a = this.adapter;
    if (a.writeFile) {
      const native = await this.native(() => a.writeFile!(this.providerSandboxId, path, data, this.ctx));
      if (native !== UNSUPPORTED) return;
    }
    const b64 = Buffer.from(data).toString("base64");
    const q = shellQuote(path);
    const tmp = shellQuote(`${path}.sbr-upload`);
    let r = await this.run(`mkdir -p "$(dirname ${q})" && : > ${tmp}`);
    for (let i = 0; i < b64.length && r.exitCode === 0; i += WRITE_CHUNK) {
      r = await this.run(`printf '%s' ${shellQuote(b64.slice(i, i + WRITE_CHUNK))} >> ${tmp}`);
    }
    if (r.exitCode === 0) r = await this.run(`base64 -d < ${tmp} > ${q} && rm -f ${tmp}`);
    if (r.exitCode !== 0) throw new SandboxRouterError("transient", `write ${path}: ${r.stderr.trim()}`, this.provider);
  }

  private async list(path: string): Promise<FileInfo[]> {
    const a = this.adapter;
    if (a.listFiles) {
      const native = await this.native(() => a.listFiles!(this.providerSandboxId, path, this.ctx));
      if (native !== UNSUPPORTED) return native;
    }
    const r = await this.run(`cd ${shellQuote(path)} && ls -1Ap`);
    if (r.exitCode !== 0) throw new SandboxRouterError("not_found", `list ${path}: ${r.stderr.trim()}`, this.provider);
    const base = path.endsWith("/") ? path : `${path}/`;
    return r.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const isDir = line.endsWith("/");
        const name = isDir ? line.slice(0, -1) : line;
        return { name, path: `${base}${name}`, isDir };
      });
  }

  /** Public URL for a port inside the sandbox. */
  async getUrl(port: number): Promise<string> {
    const a = this.adapter;
    if (!a.getUrl) throw new SandboxRouterError("unsupported", `${this.provider} does not expose ports`, this.provider);
    return this.call(() => a.getUrl!(this.providerSandboxId, port, this.ctx));
  }

  /** Moves the deadline to `timeoutSec` from now. */
  async setTimeout(timeoutSec: number): Promise<void> {
    const a = this.adapter;
    if (!a.setTimeout) throw new SandboxRouterError("unsupported", `${this.provider} cannot change a live sandbox's timeout`, this.provider);
    await this.call(() => a.setTimeout!(this.providerSandboxId, timeoutSec, this.ctx));
    await this.router.apply(this.id, { type: "timeoutSet", timeoutSec });
  }

  async pause(): Promise<void> {
    const a = this.adapter;
    if (!a.pause) throw new SandboxRouterError("unsupported", `${this.provider} cannot pause`, this.provider);
    await this.call(() => a.pause!(this.providerSandboxId, this.ctx));
    await this.router.apply(this.id, { type: "paused" });
  }

  async resume(timeoutSec = this.router.config.defaults.timeoutSec): Promise<void> {
    const a = this.adapter;
    if (!a.resume) throw new SandboxRouterError("unsupported", `${this.provider} cannot resume`, this.provider);
    await this.call(() => a.resume!(this.providerSandboxId, this.ctx));
    await this.router.apply(this.id, { type: "resumed", timeoutSec });
  }

  /** Stops the sandbox. Safe to call twice; a sandbox already gone counts as stopped. */
  async kill(): Promise<void> {
    const view = await this.info();
    if (view && (view.state === "stopped" || view.state === "failed")) return;
    try {
      await this.adapter.kill(this.providerSandboxId, this.ctx);
    } catch (raw) {
      const err = classify(raw, this.provider);
      if (err.kind !== "not_found") throw err;
    }
    await this.router.apply(this.id, { type: "stopped", reason: "killed" });
  }
}
