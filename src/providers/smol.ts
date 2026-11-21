// smol cloud (smolmachines.com): persistent microVMs, each with its own guest kernel, booted
// from an OCI image. Free: $100 of credit once, no card; an account without a card runs at
// most 4 machines at once of up to 4 vCPU / 16 GB each. Paid: $0.04 per machine-hour while
// running, plus $0.05 per vCPU-hour of CPU actually used and $0.0162 per GB-hour of memory in
// use (CPU and memory are sampled, not wall clock); exec calls are free. A stopped machine
// bills only its disk.
// REST: https://api.smolmachines.com (Bearer smk_…), OpenAPI at smolmachines.com/openapi.json.
// Docs: https://smolmachines.com/docs/cloud/api-reference, /docs/cloud/lifecycle-storage-networking
// (source: github.com/smol-machines/docs). SDKs: npm `smolvm`, CLI `smol`.
// A machine is created stopped and started here; `ttlSeconds` deletes it that long after
// creation whatever it is doing. Create takes no idempotency key, so the machine is named after
// the router id and a retry that meets the name (409) takes the machine that already has it.
// A balance that runs out answers 402 `payment_required` ("balance exhausted").

import { defineProvider, http, HttpError, httpJson } from "./util.js";
import { pollMs, sbrName, sleep } from "./rest-helpers.js";
import type { ProviderContext } from "../core/types.js";

const base = (ctx: ProviderContext) => String(ctx.env["SMOL_CLOUD_URL"] ?? "https://api.smolmachines.com").replace(/\/+$/, "");
const auth = (ctx: ProviderContext) => ({ authorization: `Bearer ${ctx.env["SMOL_CLOUD_TOKEN"]}` });
const machine = (ctx: ProviderContext, id: string, path = "") => `${base(ctx)}/v1/machines/${encodeURIComponent(id)}${path}`;
/** The file route takes the absolute guest path without its leading slash. */
const file = (ctx: ProviderContext, id: string, path: string) =>
  machine(ctx, id, `/files/${path.replace(/^\/+/, "").split("/").map(encodeURIComponent).join("/")}`);
const gone = (err: unknown) => {
  if (err instanceof HttpError && (err.status === 404 || err.status === 410)) return;
  throw err;
};
/** Label keys smol accepts: 1-63 characters of [a-z0-9._/-], starting and ending alphanumeric. */
const LABEL_KEY = /^[a-z0-9](?:[a-z0-9._/-]{0,61}[a-z0-9])?$/;

interface Machine {
  id: string;
  name?: string | null;
  state: string;
  ready?: boolean;
  error?: string | null;
  resources?: { cpus?: number; memoryMb?: number };
}

export const smolProvider = defineProvider({
  info: {
    id: "smol",
    name: "smol cloud",
    homepage: "https://smolmachines.com",
    env: ["SMOL_CLOUD_TOKEN"],
    capabilities: ["customImage", "pause"],
    isolation: "microvm",
    freeTier: {
      tier: { kind: "one-time-credit", usd: 100 },
      concurrency: 4,
      requiresCard: false,
      notes: "$100 of credit once, kept until spent. Without a card: 4 machines running at once, each up to 4 vCPU / 16 GB / 50 GB disk.",
      source: "https://smolmachines.com/pricing",
      checked: "2026-11-21",
    },
    // The $0.04/h base is wall clock while running and is spread over the default 2 vCPU here
    // ($0.02 per vCPU-hour), since a flat rate would replace the per-vCPU and per-GiB ones.
    // billing: active-cpu (CPU and memory are what's used, sampled; the base is wall clock)
    pricing: { vcpuSecondUsd: (0.05 + 0.04 / 2) / 3600, gibSecondUsd: 0.0162 / 3600, defaultCpu: 2, defaultMemoryMiB: 4096, source: "https://smolmachines.com/pricing" },
    surfaces: { rest: "https://api.smolmachines.com/v1", sdk: ["smolvm (npm)", "smolvm (PyPI)"], cli: "smol" },
  },

  async create(spec, ctx) {
    const name = sbrName(spec);
    const cpus = Math.max(1, Math.ceil(spec.cpu));
    const labels = Object.fromEntries(Object.entries(spec.metadata).filter(([k, v]) => LABEL_KEY.test(k) && v.length <= 256).slice(0, 32));
    let m: Machine;
    try {
      m = await httpJson<Machine>(`${base(ctx)}/v1/machines`, {
        headers: auth(ctx),
        body: {
          name,
          source: { type: "image", reference: spec.image ?? spec.nativeTemplate ?? String(ctx.options["image"] ?? "ubuntu:24.04") },
          resources: { cpus, memoryMb: spec.memoryMiB },
          env: spec.env,
          labels,
          // Outbound access is open unless a policy is set; say so rather than rely on the default.
          network: { mode: "open" },
          ttlSeconds: Math.max(1, Math.ceil(spec.timeoutSec)),
        },
      });
    } catch (err) {
      // A retry of a create whose answer was lost: the machine already has this name.
      if (!(err instanceof HttpError && err.status === 409)) throw err;
      const [found] = await httpJson<Machine[]>(`${base(ctx)}/v1/machines?name=${encodeURIComponent(name)}`, { headers: auth(ctx) });
      if (!found) throw err;
      m = found;
    }
    const id = m.id;
    try {
      // A new machine is stopped. Start it, then wait for the guest agent to answer.
      if (m.state !== "started") m = await httpJson<Machine>(`${machine(ctx, id, "/start")}?waitReady=true`, { method: "POST", headers: auth(ctx), timeoutMs: 300_000 });
      for (let i = 0; i < 300 && !(m.state === "started" && m.ready); i++) {
        if (m.state === "error") throw new Error(`smol machine ${id} failed: ${m.error ?? "error"}`);
        await sleep(pollMs(ctx, 1000));
        m = await httpJson<Machine>(machine(ctx, id), { headers: auth(ctx) });
      }
      if (!(m.state === "started" && m.ready)) throw new Error(`smol machine ${id} did not become ready (${m.state})`);
    } catch (err) {
      await http(machine(ctx, id), { method: "DELETE", headers: auth(ctx) }).catch(() => undefined);
      throw err;
    }
    return { providerSandboxId: id, cpu: m.resources?.cpus ?? cpus, memoryMiB: m.resources?.memoryMb ?? spec.memoryMiB };
  },

  async exec(id, command, o, ctx) {
    const timeoutSeconds = o.timeoutSec ? Math.max(1, Math.ceil(o.timeoutSec)) : undefined;
    const r = await httpJson<{ exitCode: number; stdout?: string; stderr?: string; stdoutB64?: string; stderrB64?: string }>(machine(ctx, id, "/exec"), {
      headers: auth(ctx),
      body: { command: ["sh", "-c", command], cwd: o.cwd, env: o.env, timeoutSeconds },
      timeoutMs: ((timeoutSeconds ?? 3600) + 30) * 1000,
    });
    // The base64 copies are byte-exact and never truncated; the text ones are capped at 1 MiB.
    const text = (b64?: string, plain?: string) => (b64 !== undefined ? Buffer.from(b64, "base64").toString("utf8") : plain ?? "");
    const stdout = text(r.stdoutB64, r.stdout);
    const stderr = text(r.stderrB64, r.stderr);
    if (stdout) o.onStdout?.(stdout);
    if (stderr) o.onStderr?.(stderr);
    return { stdout, stderr, exitCode: r.exitCode };
  },

  async readFile(id, path, ctx) {
    return new Uint8Array(await (await http(file(ctx, id, path), { headers: auth(ctx) })).arrayBuffer());
  },

  async writeFile(id, path, data, ctx) {
    // Creates parent directories; answers 204.
    await http(file(ctx, id, path), { method: "PUT", headers: { ...auth(ctx), "content-type": "application/octet-stream" }, raw: data });
  },

  async pause(id, ctx) {
    // Saves memory and disks, then stops; billed as a stopped machine.
    await http(machine(ctx, id, "/pause"), { method: "POST", headers: auth(ctx) });
  },

  async resume(id, ctx) {
    await http(machine(ctx, id, "/resume"), { method: "POST", headers: auth(ctx) });
  },

  async kill(id, ctx) {
    await http(machine(ctx, id), { method: "DELETE", headers: auth(ctx) }).catch(gone);
  },

  async listAlive(ctx) {
    // Every machine the account holds, stopped and paused ones included.
    const all = await httpJson<Machine[]>(`${base(ctx)}/v1/machines`, { headers: auth(ctx) });
    return all.filter((m) => m.state !== "error" && m.state !== "deleted").map((m) => m.id);
  },
});
