// Vers (vers.sh, by HDR): live Linux VMs that can be branched, committed and restored.
// $0.04 per vCPU-hour + $0.01 per GiB-hour, by the second while running; sleeping VMs pay only
// storage ($0.10/GiB-month from 2026-12-01). Prepaid: $5 of credit for a new organization, $50
// more when a card is added. At $0 new computers can't start.
// REST: https://api.vers.sh/api/v1 (Bearer key). There is no published API reference; the
// shapes here come from the official TypeScript SDK generated from Vers's OpenAPI spec,
// github.com/hdresearch/ts-sdk (src/client.ts, src/models.ts: newRootVm, getVmMetadata, execVm,
// readFileVm, writeFileVm, updateVmState, deleteVm, listVms), which the Go CLI
// (github.com/hdresearch/vers-cli) also uses. Docs: docs.vers.sh/llms.txt, docs.vers.sh/quickstart.md,
// docs.vers.sh/cli-reference/overview.md, pricing vers.sh/pricing.
// The newer docs create computers through a durable v2 operation (POST /api/v2/computers with an
// Idempotency-Key, then GET /api/v2/operations/{id}), but v2 exec and file routes aren't
// documented, so this adapter stays on v1: no idempotency key on create, and no TTL, so the
// router deletes a VM at its deadline.

import { defineProvider, http, httpJson, HttpError } from "./util.js";
import { pollMs, sleep } from "./rest-helpers.js";
import type { ProviderContext } from "../core/types.js";

const base = (ctx: ProviderContext) => String(ctx.env["VERS_BASE_URL"] ?? "https://api.vers.sh").replace(/\/+$/, "");
const auth = (ctx: ProviderContext) => ({ authorization: `Bearer ${ctx.env["VERS_API_KEY"]}` });
const vm = (ctx: ProviderContext, id: string, path = "") => `${base(ctx)}/api/v1/vm/${encodeURIComponent(id)}${path}`;
const gone = (err: unknown) => err instanceof HttpError && (err.status === 404 || err.status === 410);

interface Metadata {
  vm_id: string;
  state: string;
  vcpu_count?: number;
  mem_size_mib?: number;
}

export const versProvider = defineProvider({
  info: {
    id: "vers",
    name: "Vers",
    homepage: "https://vers.sh",
    env: ["VERS_API_KEY"],
    capabilities: ["pause", "snapshot"],
    isolation: "vm",
    enforcesTimeout: false,
    freeTier: {
      tier: { kind: "one-time-credit", usd: 5 },
      requiresCard: false,
      notes: "New organizations get $5 of usage credit; adding a card adds $50 more (set freeTier to 55 if you have it). Prepaid; at $0 new computers can't start.",
      source: "https://vers.sh/pricing",
      checked: "2026-11-21",
    },
    pricing: { vcpuSecondUsd: 0.04 / 3600, gibSecondUsd: 0.01 / 3600, defaultCpu: 2, defaultMemoryMiB: 4096, source: "https://vers.sh/pricing" },
    surfaces: {
      rest: "https://api.vers.sh/api/v1",
      sdk: ["github.com/hdresearch/ts-sdk", "github.com/hdresearch/python-sdk", "github.com/hdresearch/go-sdk"],
      cli: "vers",
    },
  },

  async create(spec, ctx) {
    const cpu = Math.max(1, Math.ceil(spec.cpu));
    const memoryMiB = Math.max(512, Math.ceil(spec.memoryMiB));
    const r = await httpJson<{ vm_id: string }>(`${base(ctx)}/api/v1/vm/new_root?wait_boot=true`, {
      headers: auth(ctx),
      body: { vm_config: { vcpu_count: cpu, mem_size_mib: memoryMiB, labels: spec.metadata } },
      timeoutMs: 300_000,
    });
    try {
      let state = "booting";
      for (let i = 0; i < 300; i++) {
        state = (await httpJson<Metadata>(vm(ctx, r.vm_id, "/metadata"), { headers: auth(ctx) })).state;
        if (state === "running") break;
        if (state === "dead") throw new Error(`vers vm ${r.vm_id} is dead`);
        await sleep(pollMs(ctx, 1000));
      }
      if (state !== "running") throw new Error(`vers vm ${r.vm_id} did not boot`);
    } catch (err) {
      // Vers made it: never leave it running (and billing) when the create fails.
      await http(vm(ctx, r.vm_id), { method: "DELETE", headers: auth(ctx) }).catch(() => undefined);
      throw err;
    }
    return { providerSandboxId: r.vm_id, cpu, memoryMiB };
  },

  async exec(id, command, o, ctx) {
    // argv, run as given; `timeout_secs` 0 means none.
    const timeout_secs = o.timeoutSec === undefined ? 0 : Math.max(1, Math.ceil(o.timeoutSec));
    const r = await httpJson<{ exit_code: number; stdout: string; stderr: string }>(vm(ctx, id, "/exec"), {
      headers: auth(ctx),
      body: { command: ["sh", "-c", command], env: o.env, working_dir: o.cwd, timeout_secs },
      timeoutMs: ((o.timeoutSec ?? 3600) + 60) * 1000,
    });
    if (r.stdout) o.onStdout?.(r.stdout);
    if (r.stderr) o.onStderr?.(r.stderr);
    return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", exitCode: r.exit_code };
  },

  async readFile(id, path, ctx) {
    const r = await httpJson<{ content_b64: string }>(`${vm(ctx, id, "/files")}?path=${encodeURIComponent(path)}`, { headers: auth(ctx) });
    return new Uint8Array(Buffer.from(r.content_b64, "base64"));
  },

  async writeFile(id, path, data, ctx) {
    await http(vm(ctx, id, "/files"), {
      method: "PUT",
      headers: auth(ctx),
      body: { path, content_b64: Buffer.from(data).toString("base64"), create_dirs: true },
    });
  },

  async pause(id, ctx) {
    await http(vm(ctx, id, "/state"), { method: "PATCH", headers: auth(ctx), body: { state: "Sleeping" } });
  },

  async resume(id, ctx) {
    await http(vm(ctx, id, "/state"), { method: "PATCH", headers: auth(ctx), body: { state: "Running" } });
  },

  async kill(id, ctx) {
    await http(`${vm(ctx, id)}?skip_wait_boot=true`, { method: "DELETE", headers: auth(ctx) }).catch((err) => {
      if (!gone(err)) throw err;
    });
  },

  async listAlive(ctx) {
    const vms = await httpJson<{ vm_id: string; state: string }[]>(`${base(ctx)}/api/v1/vm`, { headers: auth(ctx) });
    return vms.filter((v) => v.state !== "dead").map((v) => v.vm_id);
  },
});
