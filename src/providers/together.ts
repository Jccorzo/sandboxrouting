// Together Code Sandbox (formerly the CodeSandbox SDK): Firecracker VMs that boot from a
// snapshot. The new SDK is on Together's custom plans (no self-serve free tier); the legacy
// CodeSandbox Build plan had free credits but that SDK is deprecated.
// SDK: npm `together-sandbox`. API: https://api.bartender.codesandbox.io. CLI: `together-sandbox`.

import { createHash } from "node:crypto";
import { defineProvider, loadSdk } from "./util.js";
import { SandboxRouterError } from "../core/errors.js";
import type { ProviderContext } from "../core/types.js";

type TogetherSdk = typeof import("together-sandbox");
type TClient = InstanceType<TogetherSdk["TogetherSandbox"]>;
type TSandbox = Awaited<ReturnType<TClient["sandboxes"]["connect"]>>;

let client: TClient | undefined;
const cache = new Map<string, TSandbox>();
/** image → snapshot id, so each image is built once per process. */
const imageSnapshots = new Map<string, Promise<string>>();

async function together(ctx: ProviderContext): Promise<TClient> {
  if (client) return client;
  const { TogetherSandbox } = await loadSdk<TogetherSdk>("together-sandbox", "together");
  client = new TogetherSandbox({ apiKey: ctx.env["TOGETHER_API_KEY"], baseUrl: ctx.env["TOGETHER_BASE_URL"] });
  return client;
}

async function get(id: string, ctx: ProviderContext): Promise<TSandbox> {
  const hit = cache.get(id);
  if (hit) return hit;
  const sbx = await (await together(ctx)).sandboxes.connect(id);
  cache.set(id, sbx);
  return sbx;
}

export const togetherProvider = defineProvider({
  info: {
    id: "together",
    name: "Together Code Sandbox",
    homepage: "https://docs.together.ai/docs/together-code-sandbox",
    env: ["TOGETHER_API_KEY"],
    sdkPackage: "together-sandbox",
    capabilities: ["customImage", "fileList", "snapshot"],
    freeTier: {
      tier: { kind: "none" },
      notes: "Available on Together's custom plans; no self-serve free usage for the new SDK.",
      source: "https://docs.together.ai/docs/together-code-sandbox",
      checked: "2026-11-11",
    },
    // $0.01486 per credit; works out to $0.0446/vCPU-h + $0.0149/GiB-h.
    pricing: { vcpuSecondUsd: 0.0446 / 3600, gibSecondUsd: 0.0149 / 3600, defaultCpu: 1, defaultMemoryMiB: 2048, source: "https://docs.together.ai/docs/together-code-sandbox" },
    surfaces: { rest: "https://api.bartender.codesandbox.io", sdk: ["together-sandbox (npm)", "together-sandbox (PyPI)"], cli: "together-sandbox" },
  },

  async create(spec, ctx) {
    const t = await together(ctx);
    let snapshot: { snapshotId?: string; snapshotAlias?: string };
    const alias = spec.nativeTemplate ?? (ctx.options["snapshot"] as string | undefined);
    if (alias) snapshot = { snapshotAlias: alias };
    else {
      const image = spec.image ?? String(ctx.options["image"] ?? "python:3.12-slim");
      let pending = imageSnapshots.get(image);
      if (!pending) {
        const name = `sbr-${createHash("sha256").update(image).digest("hex").slice(0, 12)}`;
        pending = t.snapshots.create({ image, alias: name }).then((r) => r.snapshotId);
        imageSnapshots.set(image, pending);
        pending.catch(() => imageSnapshots.delete(image));
      }
      snapshot = { snapshotId: await pending };
    }
    const sbx = await t.sandboxes.create({
      ...snapshot,
      cpu: spec.cpu,
      memoryBytes: Math.max(1024, spec.memoryMiB) * 1024 * 1024,
      ttl: spec.timeoutSec,
      tags: spec.metadata,
    });
    cache.set(sbx.id, sbx);
    return { providerSandboxId: sbx.id };
  },

  async exec(id, command, o, ctx) {
    const sbx = await get(id, ctx);
    // Output comes back merged into one stream.
    const r = await sbx.execs.exec("sh", ["-c", command], { cwd: o.cwd, env: o.env });
    o.onStdout?.(r.output);
    return { stdout: r.output, stderr: "", exitCode: r.exitCode };
  },

  async readFile(id, path, ctx) {
    return new TextEncoder().encode(await (await get(id, ctx)).files.read(path));
  },

  async writeFile(id, path, data, ctx) {
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(data);
    } catch {
      throw new SandboxRouterError("unsupported", "binary write", "together"); // exec fallback
    }
    await (await get(id, ctx)).files.create(path, text);
  },

  async listFiles(id, path, ctx) {
    const items = await (await get(id, ctx)).directories.list(path);
    return items.map((f) => ({ name: f.name, path: f.path, isDir: f.isDir, size: f.size }));
  },

  async kill(id, ctx) {
    cache.delete(id);
    await (await together(ctx)).sandboxes.terminate(id);
  },

  async listAlive(ctx) {
    const ids: string[] = [];
    let page = await (await together(ctx)).sandboxes.list({ limit: 100 });
    for (;;) {
      ids.push(...page.data.map((s) => s.id));
      if (!page.nextCursor) break;
      page = await (await together(ctx)).sandboxes.list({ limit: 100, cursor: page.nextCursor });
    }
    return ids;
  },
});
