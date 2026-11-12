// Morph Cloud: VMs booted from snapshots (memory included), with branching. Its official pages
// disagree on free usage (Developer plan "300 MCU starting credit" vs Free "0 starting
// MCUs"), so it is treated as having none; set `providers.morph.freeTier` if your account
// has the credit. SDK: npm `morphcloud`. CLI: `morphcloud`.

import { defineProvider, loadSdk } from "./util.js";
import type { ProviderContext } from "../core/types.js";

type MorphSdk = typeof import("morphcloud");
type MClient = InstanceType<MorphSdk["MorphCloudClient"]>;

let client: MClient | undefined;
/** size key → snapshot id; Morph dedupes by digest too, this saves the round trip. */
const snapshots = new Map<string, Promise<string>>();

async function morph(ctx: ProviderContext): Promise<MClient> {
  if (client) return client;
  const { MorphCloudClient } = await loadSdk<MorphSdk>("morphcloud", "morph");
  client = new MorphCloudClient({ apiKey: ctx.env["MORPH_API_KEY"], baseUrl: ctx.env["MORPH_BASE_URL"] });
  return client;
}
const instance = async (id: string, ctx: ProviderContext) => (await morph(ctx)).instances.get({ instanceId: id });

export const morphProvider = defineProvider({
  info: {
    id: "morph",
    name: "Morph Cloud",
    homepage: "https://cloud.morph.so",
    env: ["MORPH_API_KEY"],
    sdkPackage: "morphcloud",
    capabilities: ["ports", "pause", "snapshot", "extendTimeout"],
    isolation: "vm",
    freeTier: {
      tier: { kind: "none" },
      concurrency: 8,
      notes: "Official pages conflict (300 MCU starting credit vs 0); override freeTier if your account has it.",
      source: "https://cloud.morph.so/docs/documentation/setup/plans",
      checked: "2026-11-11",
    },
    // $0.05 per MCU; an MCU is 1 vCPU-hour or 4 GB-hours, billed as the larger of the two.
    pricing: { vcpuSecondUsd: 0.05 / 3600, gibSecondUsd: 0, defaultCpu: 1, defaultMemoryMiB: 4096, source: "https://cloud.morph.so/docs/documentation/setup/plans" },
    surfaces: { rest: "https://cloud.morph.so/api", sdk: ["morphcloud (npm)", "morphcloud (PyPI)"], cli: "morphcloud" },
  },

  async create(spec, ctx) {
    const m = await morph(ctx);
    let snapshotId = spec.nativeTemplate;
    if (!snapshotId) {
      const vcpus = Math.max(1, Math.round(spec.cpu));
      const memory = Math.max(1024, spec.memoryMiB);
      const imageId = String(ctx.options["imageId"] ?? "morphvm-minimal");
      const key = `${imageId}:${vcpus}:${memory}`;
      let pending = snapshots.get(key);
      if (!pending) {
        pending = m.snapshots
          .create({ imageId, vcpus, memory, diskSize: Number(ctx.options["diskSizeMiB"] ?? 8192), digest: `sbr-${key}` })
          .then((s) => s.id);
        snapshots.set(key, pending);
        pending.catch(() => snapshots.delete(key));
      }
      snapshotId = await pending;
    }
    const inst = await m.instances.start({ snapshotId, metadata: spec.metadata, ttlSeconds: spec.timeoutSec, ttlAction: "stop" });
    return { providerSandboxId: inst.id, cpu: inst.spec.vcpus, memoryMiB: inst.spec.memory };
  },

  async exec(id, command, o, ctx) {
    const inst = await instance(id, ctx);
    const env = Object.entries(o.env ?? {}).map(([k, v]) => `export ${k}='${v.replace(/'/g, `'\\''`)}'; `).join("");
    const cd = o.cwd ? `cd '${o.cwd.replace(/'/g, `'\\''`)}' && ` : "";
    const r = await inst.exec(["sh", "-c", `${env}${cd}${command}`], { timeout: o.timeoutSec, onStdout: o.onStdout, onStderr: o.onStderr });
    return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exit_code };
  },

  async getUrl(id, port, ctx) {
    return (await (await instance(id, ctx)).exposeHttpService(`p${port}`, port)).url;
  },

  async setTimeout(id, timeoutSec, ctx) {
    await (await instance(id, ctx)).setTTL(timeoutSec, "stop");
  },

  async pause(id, ctx) {
    await (await instance(id, ctx)).pause();
  },

  async resume(id, ctx) {
    await (await instance(id, ctx)).resume();
  },

  async kill(id, ctx) {
    await (await morph(ctx)).instances.stop({ instanceId: id });
  },

  async listAlive(ctx) {
    const all = await (await morph(ctx)).instances.list({ metadata: {} });
    return all.filter((i) => String(i.status).toLowerCase() !== "stopped").map((i) => i.id);
  },
});
