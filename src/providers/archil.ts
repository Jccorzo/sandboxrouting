// Archil Sandboxes (archil.com): persistent Firecracker microVMs whose root filesystem is an Archil
// disk. Free plan, no card: 1 vCPU-hour + 2 GiB-hours of sandbox compute a month (one hour at the
// default 1 vCPU / 2 GiB, $0.095), hard caps, 5 concurrent, sessions of at most 30 minutes, a
// managed egress allowlist. Developer/Team: $0.055 per vCPU-hour + $0.020 per GiB-hour, allocated,
// sampled each minute; paused and stopped sandboxes pay only disk storage.
// REST: https://control.green.us-east-1.aws.prod.archil.com (one host per region, Bearer key-…),
// OpenAPI at docs.archil.com/api-reference/openapi.yaml; docs docs.archil.com/llms.txt,
// /compute/sandboxes/introduction.md, /administration/billing.md, /reference/limits.md.
// Lifecycle goes over REST. Commands don't: they ride a WebSocket (POST /connections hands out its
// endpoint and a token, sent as the `archil.token.<token>` subprotocol) carrying protobuf frames,
// spoken here with websocket.ts and grpc-web.ts's protobuf fields. The frames and flow control are
// the official SDK's (npm `disk` 1.14.0, MIT; schemas in @archildata/api-types process_pb, MIT),
// which needs Node 22.19 for its global WebSocket; this needs none. Files use the router's exec fallback, as the
// SDK's own file calls do. A sandbox is deleted only once stopped, so kill stops it first.
// `max_ttl_seconds` pauses rather than deletes (memory kept, disk billed), so the router deletes
// at the deadline (enforcesTimeout: false). Responses are `{success, data}` / `{success, error, code}`.

import { defineProvider, http, httpJson, HttpError } from "./util.js";
import { pollMs, sbrName, sleep } from "./rest-helpers.js";
import { decode, pb, type Fields } from "./grpc-web.js";
import { WebSocketClient } from "./websocket.js";
import type { ProviderContext } from "../core/types.js";

const REGIONS: Record<string, string> = {
  "aws-us-east-1": "https://control.green.us-east-1.aws.prod.archil.com",
  "aws-us-west-2": "https://control.green.us-west-2.aws.prod.archil.com",
  "aws-eu-west-1": "https://control.green.eu-west-1.aws.prod.archil.com",
  "gcp-us-central1": "https://control.blue.us-central1.gcp.prod.archil.com",
};
const region = (ctx: ProviderContext) => String(ctx.env["ARCHIL_REGION"] ?? "aws-us-east-1");
const base = (ctx: ProviderContext) => {
  const url = ctx.env["ARCHIL_API_URL"] ?? REGIONS[region(ctx)];
  if (!url) throw new Error(`archil: unknown region ${region(ctx)} (one of ${Object.keys(REGIONS).join(", ")})`);
  return String(url).replace(/\/+$/, "");
};
const auth = (ctx: ProviderContext) => ({ authorization: `Bearer ${ctx.env["ARCHIL_API_KEY"]}` });
const box = (ctx: ProviderContext, id: string, path = "") => `${base(ctx)}/api/sandboxes/${encodeURIComponent(id)}${path}`;
const gone = (err: unknown) => err instanceof HttpError && (err.status === 404 || err.status === 410);
const conflict = (err: unknown) => err instanceof HttpError && err.status === 409;

interface Sandbox {
  sandbox_id: string;
  name: string;
  status: string;
  vcpu_count?: number;
  mem_size_mib?: number;
  exit_reason?: string;
}
const one = async (ctx: ProviderContext, id: string) => (await httpJson<{ data: Sandbox }>(box(ctx, id), { headers: auth(ctx) })).data;
const INACTIVE = ["stopped", "exited", "failed"];

// The process protocol (archil.process.v2, @archildata/api-types process_pb), field numbers:
// ClientFrame { channel_id = 1; start = 2; window_update = 9; detach = 8 }
// Start { command = 1; cwd = 2; env = 4 (map); timeout_seconds = 5 }
// ServerFrame { channel_id = 1; started = 2; stdout = 4; stderr = 5; window_update = 6; exit = 7; error = 8; detached = 11; drain = 12 }
// Output { offset = 1; data = 2 }  Exit { status = 1; exit_code = 2; exit_reason = 3 }  Error { code = 1; message = 2 }
const PROTOCOL = "archil.connect.v2";
const TOKEN_PROTOCOL = "archil.token.";
/** Output the runtime may send before the client hands credit back, and the per-chunk cost floor. */
const INITIAL_WINDOW = 262_144;
const MIN_DATA_COST = 256;
const EXIT_STATUS: Record<number, string> = { 1: "completed", 2: "failed", 3: "cancelled", 4: "timed_out" };
const CHANNEL = 1;

const field = (f: Fields, no: number) => f.get(no)?.[0];
const text = (v: bigint | Uint8Array | undefined) => (v instanceof Uint8Array ? new TextDecoder().decode(v) : "");

/** Runs one command over the process socket, as the SDK's sandbox.exec does: start, read until exit. */
async function execProcess(ctx: ProviderContext, id: string, command: string, o: { cwd?: string; env?: Record<string, string>; timeoutSeconds?: number }) {
  // The SDK opens the socket up to four times, asking for a fresh endpoint and token each time.
  let ws: WebSocketClient | undefined;
  for (let attempt = 0; !ws; attempt++) {
    const ep = (await httpJson<{ data: { endpoint: string; token: string } }>(box(ctx, id, "/connections"), { method: "POST", headers: auth(ctx) })).data;
    try {
      ws = await WebSocketClient.connect(ep.endpoint, { protocols: [PROTOCOL, `${TOKEN_PROTOCOL}${ep.token}`], maxMessageBytes: 1024 * 1024 });
    } catch (err) {
      if (attempt >= 3 || (err instanceof HttpError && err.status < 500 && err.status !== 429)) throw err;
      await sleep(Math.random() * Math.min(pollMs(ctx, 5000), 500 * 2 ** attempt));
    }
  }
  if (ws.protocol !== PROTOCOL) {
    await ws.close();
    throw new Error(`archil: the sandbox runtime does not support the ${PROTOCOL} process protocol`);
  }
  const send = (body: number[]) => ws.send(new Uint8Array([...pb.uint(1, CHANNEL), ...body]));
  const out = { stdout: [] as Uint8Array[], stderr: [] as Uint8Array[] };
  let credit = INITIAL_WINDOW;
  let consumed = 0;
  try {
    send(pb.msg(2, [...pb.str(1, command), ...pb.str(2, o.cwd), ...pb.map(4, o.env), ...pb.uint(5, o.timeoutSeconds)]));
    for await (const m of ws.messages()) {
      const f = decode(m.data);
      if (Number(field(f, 1) ?? 0n) !== CHANNEL) continue; // channel 0 carries only `drain`
      const stream = f.has(4) ? "stdout" : f.has(5) ? "stderr" : undefined;
      if (stream) {
        const data = field(decode(field(f, stream === "stdout" ? 4 : 5) as Uint8Array), 2);
        const bytes = data instanceof Uint8Array ? data : new Uint8Array();
        const cost = Math.max(bytes.length, MIN_DATA_COST);
        if (cost > credit) throw new Error("archil: process output exceeded its flow-control window");
        credit -= cost;
        out[stream].push(bytes);
        // Hand the credit back once half the window is used, as the SDK does.
        consumed += cost;
        if (consumed >= INITIAL_WINDOW / 2) {
          credit += consumed;
          send(pb.msg(9, pb.uint(1, consumed)));
          consumed = 0;
        }
      } else if (f.has(7)) {
        const exit = decode(field(f, 7) as Uint8Array);
        const status = EXIT_STATUS[Number(field(exit, 1) ?? 0n)];
        if (!status) throw new Error(`archil: unknown process exit status ${field(exit, 1)}`);
        const code = field(exit, 2);
        const join = (parts: Uint8Array[]) => Buffer.concat(parts).toString("utf8");
        return { status, exitCode: typeof code === "bigint" ? Number(BigInt.asIntN(32, code)) : undefined, stdout: join(out.stdout), stderr: join(out.stderr) };
      } else if (f.has(8)) {
        const e = decode(field(f, 8) as Uint8Array);
        throw new Error(`archil: ${text(field(e, 1))}: ${text(field(e, 2))}`);
      }
    }
    throw new Error("archil: process connection closed before exit");
  } finally {
    if (ws.state === "open") send(pb.msg(8, []));
    await ws.close().catch(() => undefined);
  }
}

export const archilProvider = defineProvider({
  info: {
    id: "archil",
    name: "Archil Sandboxes",
    homepage: "https://archil.com",
    env: ["ARCHIL_API_KEY"],
    capabilities: ["ports", "pause", "customImage", "snapshot", "extendTimeout"],
    isolation: "microvm",
    enforcesTimeout: false,
    maxTimeoutSec: 86_400,
    freeTier: {
      // 1 vCPU-hour ($0.055) + 2 GiB-hours ($0.04).
      tier: { kind: "monthly-credit", usd: 0.095 },
      concurrency: 5,
      maxLifetimeSec: 1800,
      requiresCard: false,
      notes: "Free plan: 1 vCPU-hour and 2 GiB-hours of sandbox compute a month (one hour at 1 vCPU / 2 GiB), hard caps with no overage, 5 concurrent, sessions of at most 30 minutes, outbound traffic limited to a managed allowlist. Developer has a $10 monthly minimum.",
      source: "https://docs.archil.com/administration/billing.md",
      checked: "2026-11-21",
    },
    // 2 vCPU / 4 GiB is $0.19/h.
    pricing: { vcpuSecondUsd: 0.055 / 3600, gibSecondUsd: 0.02 / 3600, defaultCpu: 1, defaultMemoryMiB: 2048, source: "https://docs.archil.com/administration/billing.md" },
    surfaces: { rest: "https://control.green.us-east-1.aws.prod.archil.com/api", sdk: ["disk (npm)", "archil (PyPI)"], cli: "disk" },
  },

  async create(spec, ctx) {
    const vcpu_count = Math.min(32, Math.max(1, Math.ceil(spec.cpu)));
    const mem_size_mib = Math.min(65_536, Math.max(256, Math.ceil(spec.memoryMiB)));
    const name = sbrName(spec);
    const native = spec.nativeTemplate;
    let made: Sandbox;
    try {
      made = (
        await httpJson<{ data: Sandbox }>(`${base(ctx)}/api/sandboxes?wait=true`, {
          headers: auth(ctx),
          body: {
            name,
            vcpu_count,
            mem_size_mib,
            // A built image's 64-hex id, or any public OCI reference.
            ...(native && /^[0-9a-f]{64}$/.test(native) ? { image_id: native } : native || spec.image ? { base_image: native ?? spec.image } : {}),
            env: spec.env,
            max_ttl_seconds: Math.min(86_400, Math.max(60, Math.ceil(spec.timeoutSec))),
            // No idle pause: a command between router calls would find it paused.
            idle_ttl_seconds: 0,
          },
          timeoutMs: 300_000,
        })
      ).data;
    } catch (err) {
      // Names are unique per account and come from the router id: a retried create finds its sandbox.
      if (!(err instanceof HttpError && err.status === 409 && /name/.test(err.message))) throw err;
      const list = await httpJson<{ data: { sandboxes: Sandbox[] } }>(`${base(ctx)}/api/sandboxes`, { headers: auth(ctx) });
      const found = list.data.sandboxes.find((s) => s.name === name);
      if (!found) throw err;
      made = found;
    }
    const id = made.sandbox_id;
    try {
      let cur = made;
      for (let i = 0; i < 600 && cur.status !== "running"; i++) {
        if (cur.status !== "pending") throw new Error(`archil sandbox ${id} is ${cur.status}${cur.exit_reason ? `: ${cur.exit_reason}` : ""}`);
        await sleep(pollMs(ctx, 1000));
        cur = await one(ctx, id);
      }
      if (cur.status !== "running") throw new Error(`archil sandbox ${id} did not start`);
      return { providerSandboxId: id, cpu: cur.vcpu_count ?? vcpu_count, memoryMiB: cur.mem_size_mib ?? mem_size_mib };
    } catch (err) {
      await this.kill(id, ctx).catch(() => undefined);
      throw err;
    }
  },

  async exec(id, command, o, ctx) {
    // The sandbox must exist (404 otherwise), as the SDK's sandboxes.get checks first.
    await one(ctx, id);
    const r = await execProcess(ctx, id, command, {
      ...(o.cwd ? { cwd: o.cwd } : {}),
      ...(o.env && Object.keys(o.env).length ? { env: o.env } : {}),
      ...(o.timeoutSec ? { timeoutSeconds: Math.ceil(o.timeoutSec) } : {}),
    });
    if (r.stdout) o.onStdout?.(r.stdout);
    if (r.stderr) o.onStderr?.(r.stderr);
    return { stdout: r.stdout, stderr: r.stderr, exitCode: r.status === "timed_out" ? 124 : r.exitCode ?? -1 };
  },

  async getUrl(id, port, ctx) {
    const r = await httpJson<{ data: { hostname: string } }>(box(ctx, id, `/ports/${port}`), { method: "PUT", headers: auth(ctx) });
    return `https://${r.data.hostname}`;
  },

  async setTimeout(id, timeoutSec, ctx) {
    // From now, capped at 24 hours after the current session started.
    await http(box(ctx, id, "/timeout"), { headers: auth(ctx), body: { timeout: Math.min(86_400, Math.max(60, Math.ceil(timeoutSec))) } });
  },

  async pause(id, ctx) {
    await http(box(ctx, id, "/pause"), { method: "POST", headers: auth(ctx), timeoutMs: 180_000 });
  },

  async resume(id, ctx) {
    await http(`${box(ctx, id, "/resume")}?wait=true`, { method: "POST", headers: auth(ctx), timeoutMs: 180_000 });
  },

  async kill(id, ctx) {
    // Only a stopped, exited or failed sandbox can be deleted: stop it, wait, then delete.
    try {
      await http(box(ctx, id, "/stop"), { method: "POST", headers: auth(ctx), timeoutMs: 180_000 });
    } catch (err) {
      if (gone(err)) return;
      if (!conflict(err)) throw err; // 409: a pause in progress; wait for it like a stop
    }
    for (let i = 0; i < 300; i++) {
      let cur: Sandbox;
      try {
        cur = await one(ctx, id);
      } catch (err) {
        if (gone(err)) return;
        throw err;
      }
      if (cur.status === "deleted") return;
      if (cur.status === "paused") await http(box(ctx, id, "/stop"), { method: "POST", headers: auth(ctx) }).catch(() => undefined);
      if (INACTIVE.includes(cur.status)) {
        try {
          await http(box(ctx, id), { method: "DELETE", headers: auth(ctx) });
          return;
        } catch (err) {
          if (gone(err)) return;
          if (!conflict(err)) throw err;
        }
      }
      await sleep(pollMs(ctx, 1000));
    }
    throw new Error(`archil sandbox ${id} did not stop to be deleted`);
  },

  async listAlive(ctx) {
    const r = await httpJson<{ data: { sandboxes: Sandbox[] } }>(`${base(ctx)}/api/sandboxes`, { headers: auth(ctx) });
    return r.data.sandboxes.filter((s) => s.status !== "deleted" && s.status !== "deleting").map((s) => s.sandbox_id);
  },
});
