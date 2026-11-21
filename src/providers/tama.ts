// tama (tama.computer): Linux VMs ("machines") with or without a GPU, billed by the second
// while running; stopping snapshots the machine and bills nothing. CPU machines start at
// 1 vCPU / 1024 MiB and take any size above that.
// Docs (checked 2026-11-21): https://tama.computer/llms.txt (SDKs, CLI, rules),
// https://tama.computer/typescript-sdk.txt, https://api.tama.computer/v1/offers (prices, JSON).
// The API is gRPC-Web only: service api.v1.ApiService at https://gateway.tama.computer,
// `Authorization: Bearer <TAMA_TOKEN>`. Messages and field numbers are taken from the file
// descriptor in the official SDK, npm `@tama-computer/sdk` 0.1.2 (api/v1/api.proto), which
// uses Connect's gRPC-Web transport:
//   CreateMachine {spec: MachineSpec{1 name, 2 image, 3 resources{1 cpu_millicores, 2 memory_mb},
//                  6 labels, 7 ttl_seconds, 9 template, 10 env ("K=V"), 12 capacity}} → {machine}
//   GetMachine {1 machine} → {1 machine: Machine{1 id, 2 name, 3 status, 4 resources, 15 status_detail}}
//   ListMachines {1 include_stopped} → {1 machines}
//   StopMachine {1 machine, 2 skip_snapshot}; StartMachine {1 machine}; DeleteMachine {1 machine}
//   Exec {1 machine, 2 command (a shell line), 3 cwd} → {1 stdout, 2 stderr, 3 exit_code}
//   ListFiles {1 machine, 2 path} → {1 path, 2 entries{1 name, 2 directory, 3 size}}
//   ExposePort {1 machine, 2 port} → {1 url}
// MachineStatus: 1 PROVISIONING, 2 BOOTING, 3 READY, 4 SNAPSHOTTING, 5 STOPPED, 6 FAILED.
// `ttl_seconds` is an idle timeout that stops (not deletes) the machine, so the router deletes
// it at its deadline (enforcesTimeout: false). Exec has no server-side time limit; a command's
// timeout is enforced with coreutils `timeout` in the machine.

import { HttpError, defineProvider } from "./util.js";
import { inline, pollMs, sbrName, shq, sleep } from "./rest-helpers.js";
import { get, grpcWebCall, pb, type Fields } from "./grpc-web.js";
import type { ProviderContext } from "../core/types.js";

const ID = "tama";
const READY = 3;
const STOPPED = 5;
const FAILED = 6;

const base = (ctx: ProviderContext) => String(ctx.env["TAMA_API_URL"] ?? "https://gateway.tama.computer").replace(/\/+$/, "");
const call = (ctx: ProviderContext, method: string, fields: number[], timeoutMs?: number) =>
  grpcWebCall(`${base(ctx)}/api.v1.ApiService/${method}`, { authorization: `Bearer ${ctx.env["TAMA_TOKEN"]}`, "x-tama-client": "sandboxrouting" }, fields, timeoutMs);

interface Machine {
  id: string;
  name: string;
  status: number;
  detail: string;
  cpu: number;
  memoryMiB: number;
}
function machine(f: Fields | undefined): Machine {
  if (!f) throw new Error("tama: the response carried no machine");
  const res = get.msg(f, 4);
  return {
    id: get.str(f, 1),
    name: get.str(f, 2),
    status: get.int(f, 3),
    detail: get.str(f, 15),
    cpu: res ? get.int(res, 1) / 1000 : 0,
    memoryMiB: res ? get.int(res, 2) : 0,
  };
}
const getMachine = async (ctx: ProviderContext, ref: string) => machine(get.msg(await call(ctx, "GetMachine", pb.str(1, ref)), 1));

/** Polls until the machine is READY; FAILED, or STOPPED on the way up, throws. */
async function waitReady(ctx: ProviderContext, ref: string, first?: Machine): Promise<Machine> {
  let m = first ?? (await getMachine(ctx, ref));
  for (let i = 0; i < 450; i++) {
    if (m.status === READY) return m;
    if (m.status === FAILED) throw new Error(`tama machine ${m.name || ref} failed to provision${m.detail ? `: ${m.detail}` : ""}`);
    if (m.status === STOPPED && i > 0) throw new Error(`tama machine ${m.name || ref} stopped before becoming ready`);
    await sleep(pollMs(ctx, 2000));
    m = await getMachine(ctx, ref);
  }
  throw new Error(`tama machine ${m.name || ref} did not become ready`);
}

export const tamaProvider = defineProvider({
  info: {
    id: ID,
    name: "tama",
    homepage: "https://tama.computer",
    env: ["TAMA_TOKEN"],
    capabilities: ["customImage", "ports", "pause", "fileList", "gpu", "snapshot"],
    isolation: "vm",
    enforcesTimeout: false,
    freeTier: {
      tier: { kind: "none" },
      notes: "No free credit: prepaid credit bought through checkout. A stopped machine is billed nothing.",
      source: "https://tama.computer/llms.txt",
      checked: "2026-11-21",
    },
    // CPU machines, from /v1/offers: 11660 micro-USD per vCPU-hour, 5523 per GB-hour.
    pricing: { vcpuSecondUsd: 0.01166 / 3600, gibSecondUsd: 0.005523 / 3600, defaultCpu: 1, defaultMemoryMiB: 1024, source: "https://api.tama.computer/v1/offers" },
    surfaces: { rest: "gRPC-Web gateway.tama.computer (api.v1.ApiService)", sdk: ["@tama-computer/sdk (npm)", "tama-sdk (PyPI)"], cli: "tama" },
  },

  async create(spec, ctx) {
    const name = sbrName(spec);
    const image = spec.nativeTemplate ? undefined : spec.image;
    const specFields = [
      ...pb.str(1, name),
      ...pb.str(2, image),
      // 1 vCPU and 1024 MiB are the service's floors.
      ...pb.msg(3, [...pb.uint(1, Math.max(1, spec.cpu) * 1000), ...pb.uint(2, Math.max(1024, Math.round(spec.memoryMiB)))]),
      ...pb.map(6, spec.metadata),
      // Idle seconds before it snapshots and stops; 60 is the least it takes.
      ...pb.uint(7, Math.max(60, Math.ceil(spec.timeoutSec))),
      ...pb.str(9, spec.nativeTemplate),
      ...pb.strs(10, Object.entries(spec.env).map(([k, v]) => `${k}=${v}`)),
      ...pb.str(12, "auto"),
    ];
    let m: Machine;
    try {
      m = machine(get.msg(await call(ctx, "CreateMachine", pb.msg(1, specFields), 120_000), 1));
    } catch (err) {
      // The name comes from the router id, so a retried create finds the first one's machine.
      if (!(err instanceof HttpError && err.status === 409 && /exist/i.test(err.message))) throw err;
      m = await getMachine(ctx, name);
    }
    try {
      m = await waitReady(ctx, m.id || name, m);
    } catch (err) {
      await call(ctx, "DeleteMachine", pb.str(1, m.id || name)).catch(() => undefined);
      throw err;
    }
    return { providerSandboxId: m.id, cpu: m.cpu || undefined, memoryMiB: m.memoryMiB || undefined };
  },

  async exec(id, command, o, ctx) {
    let line = inline(command, { env: o.env });
    if (o.timeoutSec) line = `timeout ${Math.ceil(o.timeoutSec)} sh -c ${shq(line)}`;
    const r = await call(ctx, "Exec", [...pb.str(1, id), ...pb.str(2, line), ...pb.str(3, o.cwd)], ((o.timeoutSec ?? 3600) + 30) * 1000);
    const out = { stdout: get.str(r, 1), stderr: get.str(r, 2), exitCode: get.int(r, 3) };
    if (out.stdout) o.onStdout?.(out.stdout);
    if (out.stderr) o.onStderr?.(out.stderr);
    return out;
  },

  async listFiles(id, path, ctx) {
    const r = await call(ctx, "ListFiles", [...pb.str(1, id), ...pb.str(2, path)]);
    const dir = get.str(r, 1) || path;
    const prefix = dir.endsWith("/") ? dir : `${dir}/`;
    return get.msgs(r, 2).map((e) => ({ name: get.str(e, 1), path: `${prefix}${get.str(e, 1)}`, isDir: get.bool(e, 2), size: get.int(e, 3) }));
  },

  async getUrl(id, port, ctx) {
    return get.str(await call(ctx, "ExposePort", [...pb.str(1, id), ...pb.uint(2, port)]), 1);
  },

  async pause(id, ctx) {
    // Snapshots the machine on the way down; long, so no short deadline.
    await call(ctx, "StopMachine", pb.str(1, id), 900_000);
  },

  async resume(id, ctx) {
    await call(ctx, "StartMachine", pb.str(1, id));
    await waitReady(ctx, id);
  },

  async kill(id, ctx) {
    try {
      await call(ctx, "DeleteMachine", pb.str(1, id), 300_000);
    } catch (err) {
      if (!(err instanceof HttpError && (err.status === 404 || err.status === 410))) throw err;
    }
  },

  async listAlive(ctx) {
    const r = await call(ctx, "ListMachines", pb.bool(1, true));
    return get
      .msgs(r, 1)
      .map(machine)
      .filter((m) => m.status !== FAILED)
      .map((m) => m.id);
  },
});
