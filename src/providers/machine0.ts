// machine0: persistent Ubuntu (or NixOS) VMs on DigitalOcean, made for the CLI. Billed per
// minute at the size's rate while RUNNING and also while STOPPED (resources stay reserved);
// only SUSPEND (snapshot, then delete the instance) stops machine billing, leaving image
// storage at $0.078/GB-month. So this adapter's pause is `vm_suspend`, never `vm_stop`: a
// paused box costs storage only, which the router doesn't meter, while a stopped one would
// keep billing the full rate unseen. Resume recreates the VM from its snapshot (minutes, new IP).
// Prepaid wallet, no free tier; at the suspension threshold machines are snapshotted and destroyed.
// Docs: https://docs.machine0.io/introduction/pricing.md, .../platform/vm-management.md,
//   .../mcp/overview.md, .../mcp/machines.md, .../mcp/ssh.md, .../mcp/keys.md, .../introduction/faq.md.
// The only documented programmatic API is the MCP server: https://app.machine0.io/mcp, Streamable
// HTTP, stateless, JSON responses, `x-api-key` header. The adapter calls its tools (vm_create,
// vm_get, ssh_exec, vm_suspend, vm_start, vm_destroy, vm_list, ssh_key_*) as JSON-RPC
// `tools/call` requests. ssh_exec needs VMs created with a managed SSH key: the adapter uses
// `options.sshKeyId` / MACHINE0_SSH_KEY_ID, or finds or makes a managed key named "sandboxrouting".
// No TTL; idle detection (`onIdle: destroy`, 10–2880 min) is set as a backstop and the router
// deletes the VM at its deadline. Commands: ssh_exec, 300 s at most, no stdin, so files use the
// router's exec fallback.

import { SandboxRouterError } from "../core/errors.js";
import { defineProvider, http } from "./util.js";
import { ENV_FILE, envFileBody, inline, pollMs, sbrName, sleep, sse, withEnvFile } from "./rest-helpers.js";
import type { ProviderContext } from "../core/types.js";

const endpoint = (ctx: ProviderContext) => String(ctx.env["MACHINE0_API_URL"] ?? "https://app.machine0.io/mcp");

/** CPU sizes (vCPU, RAM, $/h) from the pricing page. */
const SIZES = [
  { size: "small", cpu: 1, memoryMiB: 1024, usdHour: 0.013 },
  { size: "medium", cpu: 2, memoryMiB: 2048, usdHour: 0.034 },
  { size: "large", cpu: 2, memoryMiB: 4096, usdHour: 0.052 },
  { size: "xl", cpu: 4, memoryMiB: 8192, usdHour: 0.104 },
  { size: "xxl", cpu: 8, memoryMiB: 16384, usdHour: 0.208 },
  { size: "xxxl", cpu: 16, memoryMiB: 65536, usdHour: 0.825 },
  { size: "4xl", cpu: 32, memoryMiB: 131072, usdHour: 1.98 },
];
/** The smallest size with at least the requested vCPUs and memory. */
export function machine0Size(cpu: number, memoryMiB: number) {
  return SIZES.find((s) => s.cpu >= cpu && s.memoryMiB >= memoryMiB) ?? SIZES[SIZES.length - 1]!;
}

const REGIONS = new Set(["nyc3", "sfo3", "lon1", "ams3", "sgp1", "tor1", "nyc2", "atl1", "fra1"]);

/** A tool that ran and reported failure (`isError`). Its text says why. */
class ToolError extends Error {}
const isGone = (err: unknown) => err instanceof ToolError && /not.?found|no such|does not exist|unknown (vm|machine)/i.test(err.message);

let rpcId = 0;
/** Calls one MCP tool and returns its result, parsed from JSON where it is JSON. */
async function tool<T = unknown>(ctx: ProviderContext, name: string, args: Record<string, unknown>, timeoutMs = 120_000): Promise<T> {
  const res = await http(endpoint(ctx), {
    headers: { "x-api-key": String(ctx.env["MACHINE0_API_KEY"]), accept: "application/json, text/event-stream" },
    body: { jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } },
    timeoutMs,
  });
  let msg: { result?: { content?: { type: string; text?: string }[]; structuredContent?: unknown; isError?: boolean }; error?: { code: number; message: string } } | undefined;
  if ((res.headers.get("content-type") ?? "").includes("text/event-stream") && res.body) {
    for await (const ev of sse(res.body as unknown as AsyncIterable<Uint8Array>)) {
      if (ev.event === "message" && ev.data) {
        msg = JSON.parse(ev.data);
        break;
      }
    }
  } else msg = (await res.json()) as typeof msg;
  if (!msg) throw new Error(`machine0 ${name}: empty response`);
  if (msg.error) throw new Error(`machine0 ${name}: ${msg.error.message}`);
  const text = (msg.result?.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
  if (msg.result?.isError) throw new ToolError(`machine0 ${name}: ${text}`);
  if (msg.result?.structuredContent !== undefined) return msg.result.structuredContent as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as T;
  }
}

interface Vm {
  id: string;
  name?: string;
  status?: string;
  statusExplanation?: string;
}
interface SshKey {
  id: string;
  name: string;
}
const vmOf = (r: unknown): Vm => ((r as { vm?: Vm }).vm ?? r) as Vm;
const listOf = <T>(r: unknown, key: string): T[] => (Array.isArray(r) ? r : ((r as Record<string, T[]>)[key] ?? [])) as T[];

/** The managed key VMs are made with, per API key: looked up or created once. */
const managedKeys = new Map<string, Promise<string>>();
function managedKey(ctx: ProviderContext): Promise<string> {
  const given = ctx.options["sshKeyId"] ?? ctx.env["MACHINE0_SSH_KEY_ID"];
  if (given) return Promise.resolve(String(given));
  const cacheKey = `${endpoint(ctx)} ${ctx.env["MACHINE0_API_KEY"]}`;
  let p = managedKeys.get(cacheKey);
  if (!p) {
    p = (async () => {
      const find = async () => listOf<SshKey>(await tool(ctx, "ssh_key_list", {}), "keys").find((k) => k.name === "sandboxrouting")?.id;
      const found = await find();
      if (found) return found;
      try {
        return ((await tool<SshKey | { key: SshKey }>(ctx, "ssh_key_create_managed", { name: "sandboxrouting" })) as { key?: SshKey }).key?.id ?? (await find())!;
      } catch (err) {
        // Another process made it first.
        const again = await find();
        if (again) return again;
        throw err;
      }
    })();
    managedKeys.set(cacheKey, p);
    p.catch(() => managedKeys.delete(cacheKey));
  }
  return p;
}

async function waitRunning(ctx: ProviderContext, id: string): Promise<void> {
  // Provisioning takes 1–3 minutes, longer for large images.
  for (let i = 0; i < 240; i++) {
    const vm = vmOf(await tool(ctx, "vm_get", { id }));
    if (vm.status === "RUNNING") return;
    if (vm.status === "ERRORED" || vm.status === "UNAVAILABLE") throw new Error(`machine0 VM ${id} is ${vm.status}${vm.statusExplanation ? `: ${vm.statusExplanation}` : ""}`);
    await sleep(pollMs(ctx, 5000));
  }
  throw new Error(`machine0 VM ${id} did not start`);
}

export const machine0Provider = defineProvider({
  info: {
    id: "machine0",
    name: "machine0",
    homepage: "https://machine0.io",
    env: ["MACHINE0_API_KEY"],
    capabilities: ["pause"],
    isolation: "vm",
    enforcesTimeout: false,
    maxExecSec: 300,
    freeTier: {
      tier: { kind: "none" },
      notes: "Prepaid wallet (top-ups from $5), no free credit. Stopped VMs bill the full rate; this adapter pauses by suspending, which bills image storage only ($0.078/GB-month).",
      source: "https://docs.machine0.io/introduction/pricing.md",
      checked: "2026-11-21",
    },
    // `large` (2 vCPU / 4 GB) is $0.052/h, split 2:1 vCPU:GiB; every CPU size fits that split.
    pricing: { vcpuSecondUsd: (0.052 * 2) / 3 / 2 / 3600, gibSecondUsd: 0.052 / 3 / 4 / 3600, defaultCpu: 2, defaultMemoryMiB: 4096, source: "https://docs.machine0.io/introduction/pricing.md" },
    surfaces: { mcp: "https://app.machine0.io/mcp", cli: "machine0 (npm @machine0/cli)" },
  },

  async create(spec, ctx) {
    const size = machine0Size(spec.cpu || 2, spec.memoryMiB || 4096);
    const name = sbrName(spec, 12);
    const sshKeyId = await managedKey(ctx);
    const minutes = Math.ceil(spec.timeoutSec / 60);
    let vm: Vm;
    try {
      vm = vmOf(
        await tool(ctx, "vm_create", {
          name,
          size: size.size,
          region: spec.region && REGIONS.has(spec.region) ? spec.region : String(ctx.options["region"] ?? "ams3"),
          imageName: spec.nativeTemplate ?? String(ctx.options["image"] ?? "ubuntu-24-04-loaded"),
          sshKeyId,
          // A backstop if the router never gets to delete it. Idle for the whole lifetime is past the deadline.
          ...(minutes <= 2880 ? { onIdle: "destroy", idleTimeoutMinutes: Math.max(10, minutes) } : {}),
        }),
      );
    } catch (err) {
      // A retried create: the VM named after this router id already exists.
      if (!(err instanceof ToolError && /exist|taken|in use|duplicate/i.test(err.message))) throw err;
      vm = vmOf(await tool(ctx, "vm_get_by_name", { name }));
    }
    try {
      if (vm.status !== "RUNNING") await waitRunning(ctx, vm.id);
      if (Object.keys(spec.env).length) {
        const r = await this.exec(vm.id, `cat > ${ENV_FILE} <<'SBR_ENV'\n${envFileBody(spec.env)}SBR_ENV`, {}, ctx);
        if (r.exitCode !== 0) throw new Error(`machine0 VM ${vm.id}: could not write its environment: ${r.stderr}`);
      }
    } catch (err) {
      await this.kill(vm.id, ctx).catch(() => undefined);
      throw err;
    }
    return { providerSandboxId: vm.id, cpu: size.cpu, memoryMiB: size.memoryMiB };
  },

  async exec(id, command, o, ctx) {
    const timeout = Math.min(300, Math.max(1, Math.ceil(o.timeoutSec ?? 300)));
    const cmd = inline(withEnvFile(command), { cwd: o.cwd, env: o.env });
    if (cmd.length > 65_536) throw new SandboxRouterError("invalid", "machine0 ssh_exec takes commands of at most 65,536 characters", "machine0");
    const r = await tool<{ stdout?: string; stderr?: string; exitCode?: number; exit_code?: number; code?: number }>(ctx, "ssh_exec", { machine_id: id, command: cmd, timeout }, (timeout + 60) * 1000);
    const stdout = r.stdout ?? "";
    const stderr = r.stderr ?? "";
    if (stdout) o.onStdout?.(stdout);
    if (stderr) o.onStderr?.(stderr);
    return { stdout, stderr, exitCode: r.exitCode ?? r.exit_code ?? r.code ?? 1 };
  },

  async pause(id, ctx) {
    // Suspend, not stop: a stopped VM still bills the full rate.
    await tool(ctx, "vm_suspend", { id });
  },

  async resume(id, ctx) {
    await tool(ctx, "vm_start", { id });
    await waitRunning(ctx, id);
  },

  async kill(id, ctx) {
    try {
      await tool(ctx, "vm_destroy", { id });
    } catch (err) {
      if (isGone(err)) return;
      throw err;
    }
  },

  async listAlive(ctx) {
    return listOf<Vm>(await tool(ctx, "vm_list", {}), "vms").map((v) => v.id);
  },
});
