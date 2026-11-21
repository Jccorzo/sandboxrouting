// One adapter for every service that speaks E2B's sandbox API: E2B itself, and the clouds
// that host an E2B-compatible endpoint (Novita, Tencent Cloud Agent Sandbox, Volcengine AgentKit).
// All of them go through the stock `e2b` SDK with their own key and endpoint. The services
// differ in what they implement, so each says which optional calls it has.

import { defineProvider, loadSdk } from "./util.js";
import type { ProviderAdapter, ProviderContext, ProviderInfo } from "../core/types.js";

type E2B = typeof import("e2b");
type E2BSandbox = InstanceType<E2B["Sandbox"]>;

/** What the `e2b` SDK takes to reach a service: a key, plus its domain or API URL. */
export interface E2bConnection {
  apiKey?: string;
  /** Sandbox domain: the API is `api.<domain>`, a sandbox `<port>-<id>.<domain>`. */
  domain?: string;
  /** Control-plane URL, for services whose API isn't at `api.<domain>`. */
  apiUrl?: string;
}

export interface E2bCompatibleOptions {
  info: Omit<ProviderInfo, "sdkPackage">;
  connection(ctx: ProviderContext): E2bConnection;
  /** Template when the caller names none. Undefined lets the service pick its default. */
  template?(ctx: ProviderContext): string | undefined;
  /**
   * False when the service lacks `POST /v2/sandboxes/{id}/connect`: a sandbox is then only
   * reachable from the process that created it, and paused ones can't be resumed.
   */
  reconnect?: boolean;
  pause?: boolean;
  setTimeout?: boolean;
  ports?: boolean;
  /** Lists running and paused sandboxes; an object narrows the list by metadata. */
  listAlive?: boolean | ((ctx: ProviderContext) => Record<string, string>);
}

export function e2bCompatible(o: E2bCompatibleOptions): ProviderAdapter {
  const id = o.info.id;
  const cache = new Map<string, E2BSandbox>();
  const sdk = () => loadSdk<E2B>("e2b", id);
  // Unset fields are left out so the SDK's own defaults (and its E2B_* variables) apply.
  const opts = (ctx: ProviderContext) =>
    Object.fromEntries(Object.entries(o.connection(ctx)).filter(([, v]) => v !== undefined && v !== "")) as E2bConnection;
  const reconnect = o.reconnect ?? true;

  async function get(sandboxId: string, ctx: ProviderContext): Promise<E2BSandbox> {
    const hit = cache.get(sandboxId);
    if (hit) return hit;
    if (!reconnect) throw new Error(`${id} cannot reconnect to sandbox ${sandboxId}: only the process that created it can reach it`);
    const { Sandbox } = await sdk();
    const sbx = await Sandbox.connect(sandboxId, opts(ctx));
    cache.set(sandboxId, sbx);
    return sbx;
  }

  const adapter: ProviderAdapter = {
    info: { ...o.info, sdkPackage: "e2b" },

    async create(spec, ctx) {
      const { Sandbox } = await sdk();
      const params = { ...opts(ctx), envs: spec.env, metadata: spec.metadata, timeoutMs: spec.timeoutSec * 1000 };
      const template = spec.nativeTemplate ?? o.template?.(ctx);
      const sbx = template ? await Sandbox.create(template, params) : await Sandbox.create(params);
      cache.set(sbx.sandboxId, sbx);
      return { providerSandboxId: sbx.sandboxId };
    },

    async exec(sandboxId, command, x, ctx) {
      const sbx = await get(sandboxId, ctx);
      try {
        const r = await sbx.commands.run(command, {
          cwd: x.cwd,
          envs: x.env,
          timeoutMs: x.timeoutSec ? x.timeoutSec * 1000 : 0,
          onStdout: x.onStdout,
          onStderr: x.onStderr,
        });
        return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode };
      } catch (err) {
        // A non-zero exit throws CommandExitError, which carries the result.
        const e = err as { exitCode?: number; stdout?: string; stderr?: string };
        if (typeof e.exitCode === "number") return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", exitCode: e.exitCode };
        throw err;
      }
    },

    async readFile(sandboxId, path, ctx) {
      return (await get(sandboxId, ctx)).files.read(path, { format: "bytes" });
    },

    async writeFile(sandboxId, path, data, ctx) {
      await (await get(sandboxId, ctx)).files.write(path, data.slice().buffer as ArrayBuffer);
    },

    async listFiles(sandboxId, path, ctx) {
      const entries = await (await get(sandboxId, ctx)).files.list(path);
      return entries.map((e) => ({ name: e.name, path: e.path, isDir: e.type === "dir", size: e.size }));
    },

    async kill(sandboxId, ctx) {
      const { Sandbox } = await sdk();
      cache.delete(sandboxId);
      // Resolves false when the sandbox is already gone.
      await Sandbox.kill(sandboxId, opts(ctx));
    },
  };

  if (o.ports) {
    adapter.getUrl = async (sandboxId, port, ctx) => `https://${(await get(sandboxId, ctx)).getHost(port)}`;
  }
  if (o.setTimeout) {
    adapter.setTimeout = async (sandboxId, timeoutSec, ctx) => {
      await (await get(sandboxId, ctx)).setTimeout(timeoutSec * 1000);
    };
  }
  if (o.pause && reconnect) {
    adapter.pause = async (sandboxId, ctx) => {
      await (await get(sandboxId, ctx)).pause();
      cache.delete(sandboxId);
    };
    adapter.resume = async (sandboxId, ctx) => {
      cache.delete(sandboxId);
      await get(sandboxId, ctx); // connect() resumes a paused sandbox
    };
  }
  if (o.listAlive) {
    const narrow = typeof o.listAlive === "function" ? o.listAlive : undefined;
    adapter.listAlive = async (ctx) => {
      const { Sandbox } = await sdk();
      const metadata = narrow?.(ctx);
      const pages = Sandbox.list({ ...opts(ctx), query: { state: ["running", "paused"], ...(metadata ? { metadata } : {}) } });
      const ids: string[] = [];
      while (pages.hasNext) for (const s of await pages.nextItems()) ids.push(s.sandboxId);
      return ids;
    };
  }
  return defineProvider(adapter);
}
