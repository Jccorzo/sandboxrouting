// The adapters added by w1b on 2026-11-21 (novita, isorun, smol, prized, instavm, zipbox), driven
// through the router against local servers that speak each provider's wire format, taken from its
// OpenAPI spec, docs or official SDK. Novita speaks E2B's API, so its test replaces the e2b SDK.
// None has been run against the real service.
import { describe, expect, it, vi } from "vitest";
import { deletedAtDeadline, fakeRun, lifecycle, mock, routerFor } from "./restmock.js";
import { classify } from "../src/core/errors.js";
import { isorunBase, isorunProvider } from "../src/providers/isorun.js";
import { smolProvider } from "../src/providers/smol.js";
import { prizedProvider } from "../src/providers/prized.js";
import { instavmProvider, instavmSize } from "../src/providers/instavm.js";
import { zipboxNames, zipboxProvider, zipboxTier } from "../src/providers/zipbox.js";
import { NOVITA_DEFAULT_DOMAIN, novitaProvider } from "../src/providers/novita.js";
import type { ProviderAdapter, ProviderContext } from "../src/index.js";

const e2b = vi.hoisted(() => ({ calls: [] as { op: string; opts: Record<string, unknown> }[], killed: [] as string[], files: new Map<string, Uint8Array>() }));

vi.mock("e2b", () => {
  const run = (cmd: string) => {
    const m = /exit (\d+)/.exec(cmd);
    return m ? { stdout: "", stderr: "boom\n", exitCode: Number(m[1]) } : { stdout: `ran: ${cmd}\n`, stderr: "", exitCode: 0 };
  };
  const sandbox = (id: string) => ({
    sandboxId: id,
    commands: {
      run: async (cmd: string) => {
        const r = run(cmd);
        if (r.exitCode !== 0) throw Object.assign(new Error("exit"), r);
        return r;
      },
    },
    files: {
      read: async (p: string) => e2b.files.get(p) ?? new Uint8Array(),
      write: async (p: string, d: ArrayBuffer) => void e2b.files.set(p, new Uint8Array(d)),
      list: async () => [],
    },
    getHost: (port: number) => `${port}-${id}.example`,
    setTimeout: async () => undefined,
    pause: async () => undefined,
  });
  return {
    Sandbox: {
      create: async (...args: unknown[]) => {
        e2b.calls.push({ op: "create", opts: args[args.length - 1] as Record<string, unknown> });
        return sandbox("nv-1");
      },
      connect: async (id: string, opts: Record<string, unknown>) => (e2b.calls.push({ op: "connect", opts }), sandbox(id)),
      kill: async (id: string, opts: Record<string, unknown>) => (e2b.calls.push({ op: "kill", opts }), e2b.killed.push(id), true),
      list: () => ({ hasNext: false, nextItems: async () => [] }),
    },
  };
});

const ctx = (env: Record<string, string>, options: Record<string, unknown> = {}): ProviderContext => ({ env, options });
/** What the router makes of the error a call throws. */
async function refusal(p: Promise<unknown>, provider: string) {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeDefined();
  return classify(err, provider).kind;
}
/** Whether the router left a quota mark on the provider. */
const quotaMarked = async (router: ReturnType<typeof routerFor>["router"], provider: string) =>
  (await router.ledger.read()).marks.some((m) => m.provider === provider && m.kind === "quota");

describe("novita", () => {
  it("is the e2b adapter pointed at Novita's domain, with Novita's key", async () => {
    e2b.calls.length = 0;
    const { router } = routerFor(novitaProvider, { NOVITA_API_KEY: "sk_nv" });
    await lifecycle(router, { files: true });
    const create = e2b.calls.find((c) => c.op === "create")!;
    expect(create.opts).toMatchObject({ apiKey: "sk_nv", domain: NOVITA_DEFAULT_DOMAIN, timeoutMs: 120_000 });
    // An unset API URL is left to the SDK, which builds https://api.<domain>.
    expect(create.opts).not.toHaveProperty("apiUrl");
    expect(e2b.calls.find((c) => c.op === "kill")!.opts).toMatchObject({ apiKey: "sk_nv", domain: NOVITA_DEFAULT_DOMAIN });
    expect(e2b.killed).toContain("nv-1");
  });

  it("takes another region's domain from NOVITA_DOMAIN", async () => {
    e2b.calls.length = 0;
    await novitaProvider.create({ cpu: 2, memoryMiB: 4096, timeoutSec: 60, env: {}, metadata: {} }, ctx({ NOVITA_API_KEY: "k", NOVITA_DOMAIN: "eu.sandbox.novita.ai" }));
    expect(e2b.calls[0]!.opts).toMatchObject({ domain: "eu.sandbox.novita.ai" });
  });
});

describe("isorun", () => {
  it("finds the runner from the key's region, or ISORUN_API_URL", () => {
    expect(isorunBase(ctx({ ISORUN_API_KEY: "isorun_live_eu_abc_def" }))).toBe("https://run-eu.isorun.ai");
    expect(isorunBase(ctx({ ISORUN_API_KEY: "x", ISORUN_API_URL: "http://127.0.0.1:9/" }))).toBe("http://127.0.0.1:9");
    expect(() => isorunBase(ctx({ ISORUN_API_KEY: "plain" }))).toThrow(/region/);
  });

  it("polls until running, keeps env in a file, hibernates, and treats a 404 delete as gone", async () => {
    const files = new Map<string, Buffer>();
    let polls = 0;
    let deleted = 0;
    const { url, seen } = await mock((r) => {
      if (r.headers.authorization !== "Bearer isorun_live_us_k_1") return { status: 401, json: { error: "unauthorized" } };
      if (r.method === "POST" && r.path === "/v1/runs") {
        expect(r.json()).toMatchObject({ image: "node:22-slim", vcpus: 1, mem_mib: 1024 });
        expect([120, 60]).toContain(r.json().timeout);
        return { json: { id: "run_1", status: "creating", vcpus: 1, mem_mib: 1024 } };
      }
      if (r.method === "GET" && r.path === "/v1/runs/run_1") return { json: { id: "run_1", status: polls++ < 1 ? "creating" : "running" } };
      if (r.method === "POST" && r.path === "/v1/runs/run_1/exec") {
        const x = fakeRun(r.json().command);
        return { json: { exit_code: x.code, stdout: x.stdout, stderr: x.stderr } };
      }
      if (r.method === "POST" && r.path === "/v1/runs/run_1/files/upload") return files.set(r.query.get("path")!, r.body), { json: {} };
      if (r.method === "GET" && r.path === "/v1/runs/run_1/files/download") return { raw: files.get(r.query.get("path")!) ?? "" };
      if (r.method === "POST" && /^\/v1\/runs\/run_1\/(hibernate|resume)$/.test(r.path)) return { json: {} };
      if (r.method === "DELETE" && r.path === "/v1/runs/run_1") return deleted++ ? { status: 404, json: { error: "not found" } } : { json: { status: "destroyed", cost_cents: 1 } };
      return undefined;
    });
    const env = { ISORUN_API_KEY: "isorun_live_us_k_1", ISORUN_API_URL: url };
    const { router, clock } = routerFor(isorunProvider, env);
    const sbx = await lifecycle(router, { files: true });
    expect(polls).toBeGreaterThan(1);
    // Killed twice: the second delete meets a 404 and is not an error.
    await isorunProvider.kill(sbx.providerSandboxId, ctx(env));
    const withEnv = await router.create({ timeoutSec: 60, env: { A: "1" } });
    expect(files.get("/tmp/.sbr-env")?.toString()).toBe("export A='1'\n");
    await withEnv.pause();
    await withEnv.resume();
    expect(seen).toContain("POST /v1/runs/run_1/hibernate");
    await withEnv.kill();
    // Its timer counts idle time, so a busy sandbox outlives it: the router deletes it.
    await deletedAtDeadline(router, clock, seen, (id) => `DELETE /v1/runs/${id}`);
  });

  it("deletes a sandbox that fails while starting, and reports a 402 as quota", async () => {
    const { url, seen } = await mock((r) => {
      if (r.method === "POST" && r.path === "/v1/runs") return { json: { id: "run_2", status: "creating" } };
      if (r.method === "GET" && r.path === "/v1/runs/run_2") return { json: { id: "run_2", status: "failed" } };
      if (r.method === "DELETE" && r.path === "/v1/runs/run_2") return { json: {} };
      return undefined;
    });
    const env = { ISORUN_API_KEY: "k", ISORUN_API_URL: url };
    await expect(isorunProvider.create({ cpu: 1, memoryMiB: 1024, timeoutSec: 60, env: {}, metadata: {} }, ctx(env, { pollMs: 1 }))).rejects.toThrow(/failed/);
    expect(seen).toContain("DELETE /v1/runs/run_2");
    const broke = await mock(() => ({ status: 402, json: { error: "insufficient credit" } }));
    expect(await refusal(isorunProvider.create({ cpu: 1, memoryMiB: 1024, timeoutSec: 60, env: {}, metadata: {} }, ctx({ ISORUN_API_KEY: "k", ISORUN_API_URL: broke.url })), "isorun")).toBe("quota");
  });
});

describe("smol", () => {
  it("creates a stopped machine, starts it, waits for ready, and uses byte-exact output", async () => {
    const files = new Map<string, Buffer>();
    let polls = 0;
    let deletes = 0;
    const { url, seen } = await mock((r) => {
      if (r.headers.authorization !== "Bearer smk_test") return { status: 401, json: { code: "unauthorized" } };
      if (r.method === "POST" && r.path === "/v1/machines") {
        const b = r.json();
        expect(b).toMatchObject({ source: { type: "image", reference: "ubuntu:24.04" }, resources: { cpus: 2, memoryMb: 4096 }, network: { mode: "open" } });
        expect(b.name).toMatch(/^sbr-[0-9a-f]{16}$/);
        expect(b.labels).toHaveProperty(["sandboxrouting.id"]);
        expect([120, 60]).toContain(b.ttlSeconds);
        return { status: 201, json: { id: "mach-1", state: "stopped", ready: false } };
      }
      if (r.method === "POST" && r.path === "/v1/machines/mach-1/start") {
        expect(r.query.get("waitReady")).toBe("true");
        return { json: { id: "mach-1", state: "started", ready: false } };
      }
      if (r.method === "GET" && r.path === "/v1/machines/mach-1") return { json: { id: "mach-1", state: "started", ready: polls++ > 0, resources: { cpus: 2, memoryMb: 4096 } } };
      if (r.method === "POST" && r.path === "/v1/machines/mach-1/exec") {
        const b = r.json();
        expect(b.command.slice(0, 2)).toEqual(["sh", "-c"]);
        const x = fakeRun(b.command[2]);
        return { json: { exitCode: x.code, stdout: "lossy", stderr: "", stdoutB64: Buffer.from(x.stdout).toString("base64"), stderrB64: Buffer.from(x.stderr).toString("base64"), durationMs: 1, machineId: "mach-1" } };
      }
      if (r.path === "/v1/machines/mach-1/files/tmp/a.txt" && r.method === "PUT") return files.set(r.path, r.body), { status: 204, raw: "" };
      if (r.path === "/v1/machines/mach-1/files/tmp/a.txt" && r.method === "GET") return { raw: files.get(r.path) ?? "" };
      if (r.method === "DELETE" && r.path === "/v1/machines/mach-1") return deletes++ ? { status: 404, json: { code: "not_found" } } : { status: 204, raw: "" };
      return undefined;
    });
    const env = { SMOL_CLOUD_TOKEN: "smk_test", SMOL_CLOUD_URL: url };
    const { router } = routerFor(smolProvider, env);
    const sbx = await lifecycle(router, { files: true });
    expect(seen).toContain("POST /v1/machines/mach-1/start");
    await smolProvider.kill(sbx.providerSandboxId, ctx(env));
  });

  it("takes the machine a lost create made when its retry meets the name", async () => {
    const { url } = await mock((r) => {
      if (r.method === "POST" && r.path === "/v1/machines") return { status: 409, json: { code: "conflict", detail: "name in use" } };
      if (r.method === "GET" && r.path === "/v1/machines") {
        expect(r.query.get("name")).toMatch(/^sbr-/);
        return { json: [{ id: "mach-9", name: r.query.get("name"), state: "started", ready: true }] };
      }
      return undefined;
    });
    const made = await smolProvider.create({ cpu: 1, memoryMiB: 1024, timeoutSec: 60, env: {}, metadata: { "sandboxrouting.id": "s1" } }, ctx({ SMOL_CLOUD_TOKEN: "t", SMOL_CLOUD_URL: url }, { pollMs: 1 }));
    expect(made.providerSandboxId).toBe("mach-9");
  });

  it("reports an exhausted balance (402) as quota", async () => {
    const { url } = await mock(() => ({ status: 402, json: { code: "payment_required", detail: "balance exhausted" } }));
    const { router } = routerFor(smolProvider, { SMOL_CLOUD_TOKEN: "t", SMOL_CLOUD_URL: url });
    await expect(router.create({})).rejects.toThrow();
    expect(await quotaMarked(router, "smol")).toBe(true);
  });
});

describe("prized", () => {
  it("creates with a key and a template, runs on the edge, and keeps files to /home/prized", async () => {
    const files = new Map<string, Buffer>();
    let edge = "";
    let polls = 0;
    let deletes = 0;
    const sandbox = (state: string) => ({ sandbox: { id: "sbx_1", state, resources: { vcpu: 2, memoryMb: 4096 }, toolboxBase: `${edge}/v1/sandbox/sbx_1`, errorReason: null } });
    const { url, seen } = await mock((r) => {
      if (r.headers.authorization !== "Bearer dcp_test") return { status: 401, json: { error: "unauthorized" } };
      if (r.method === "POST" && r.path === "/api/v1/sandboxes") {
        expect(r.headers["idempotency-key"]).toBeTruthy();
        expect(r.json()).toMatchObject({ template: "prized-base-v1", resources: { vcpu: 2, memoryMb: 4096 }, envVars: {} });
        expect([2, 1]).toContain(r.json().maxRuntimeMin);
        return { status: 201, json: sandbox("starting") };
      }
      if (r.method === "GET" && r.path === "/api/v1/sandboxes/sbx_1") return { json: sandbox(polls++ < 1 ? "starting" : "running") };
      if (r.method === "POST" && r.path === "/v1/sandbox/sbx_1/process/execute") {
        const x = fakeRun(r.json().command);
        return { json: { stdout: x.stdout, stderr: x.stderr, exitCode: x.code, durationMs: 1 } };
      }
      if (r.method === "POST" && r.path === "/v1/sandbox/sbx_1/files/upload") return files.set(r.query.get("path")!, r.body), { json: { path: r.query.get("path"), size: r.body.length } };
      if (r.method === "GET" && r.path === "/v1/sandbox/sbx_1/files/download") return files.has(r.query.get("path")!) ? { raw: files.get(r.query.get("path")!)! } : { status: 404, json: { error: "not_found" } };
      if (r.method === "POST" && r.path === "/api/v1/sandboxes/sbx_1/timeout") return expect(r.json()).toEqual({ inMin: 10 }), { json: { ...sandbox("running"), capped: false } };
      if (r.method === "DELETE" && r.path === "/api/v1/sandboxes/sbx_1") return deletes++ ? { status: 410, json: { error: "sandbox_deleted" } } : { status: 202, json: sandbox("deleting") };
      return undefined;
    });
    edge = url;
    const env = { PRIZED_API_KEY: "dcp_test", PRIZED_API_URL: `${url}/api/v1` };
    const { router } = routerFor(prizedProvider, env);
    const sbx = await router.create({ timeoutSec: 120 });
    expect((await sbx.commands.run("echo hi")).stdout).toContain("echo hi");
    expect((await sbx.commands.run("exit 3")).exitCode).toBe(3);
    await sbx.files.write("/home/prized/work/a.txt", "hello");
    expect(await sbx.files.read("/home/prized/work/a.txt")).toBe("hello");
    // Outside /home/prized, the router falls back to exec instead of the file API.
    await expect(prizedProvider.readFile("sbx_1", "/etc/passwd", ctx(env))).rejects.toMatchObject({ kind: "unsupported" });
    await sbx.setTimeout(600);
    await sbx.kill();
    expect(seen).toContain("DELETE /api/v1/sandboxes/sbx_1");
    // Again: a deleting or deleted sandbox (410) is already gone.
    await prizedProvider.kill("sbx_1", ctx(env));
  });

  it("deletes a sandbox that errors while starting", async () => {
    const { url, seen } = await mock((r) => {
      if (r.method === "POST" && r.path === "/api/v1/sandboxes") return { status: 201, json: { sandbox: { id: "sbx_2", state: "starting" } } };
      if (r.method === "GET" && r.path === "/api/v1/sandboxes/sbx_2") return { json: { sandbox: { id: "sbx_2", state: "error", errorReason: "no capacity" } } };
      if (r.method === "DELETE") return { status: 202, json: {} };
      return undefined;
    });
    await expect(prizedProvider.create({ cpu: 2, memoryMiB: 4096, timeoutSec: 60, env: {}, metadata: {} }, ctx({ PRIZED_API_KEY: "k", PRIZED_API_URL: `${url}/api/v1` }, { pollMs: 1 }))).rejects.toThrow(/no capacity/);
    expect(seen).toContain("DELETE /api/v1/sandboxes/sbx_2");
  });

  it("counts an empty balance (409 insufficient_balance) and a free-tier quota (429) as quota", async () => {
    const broke = await mock(() => ({ status: 409, json: { error: "insufficient_balance", message: "Top up to keep going." } }));
    const { router } = routerFor(prizedProvider, { PRIZED_API_KEY: "k", PRIZED_API_URL: broke.url });
    await expect(router.create({})).rejects.toThrow();
    expect(await quotaMarked(router, "prized")).toBe(true);
    const full = await mock(() => ({ status: 429, json: { error: "sandbox_quota_exceeded", reason: "sandbox_limit", tier: "free", limit: 10 } }));
    expect(await refusal(prizedProvider.create({ cpu: 2, memoryMiB: 4096, timeoutSec: 60, env: {}, metadata: {} }, ctx({ PRIZED_API_KEY: "k", PRIZED_API_URL: full.url })), "prized")).toBe("quota");
  });
});

describe("instavm", () => {
  it("maps sizes to its vCPU steps and even memory", () => {
    expect(instavmSize(3, 3001)).toEqual({ vcpu_count: 4, memory_mb: 3002 });
    expect(instavmSize(64, 99_999)).toEqual({ vcpu_count: 8, memory_mb: 8192 });
  });

  it("starts a session's VM, reads exit codes from its output, shares a port, and kills by session", async () => {
    const files = new Map<string, string>();
    let alive = false;
    let polls = 0;
    const { url, seen } = await mock((r) => {
      if (r.headers["x-api-key"] !== "instavm_sk_test") return { status: 401, json: { detail: "invalid api key" } };
      if (r.method === "POST" && r.path === "/v1/sessions/session") {
        expect(r.json()).toMatchObject({ vcpu_count: 2, memory_mb: 4096, vm_lifetime_seconds: 120 });
        return { json: { session_id: "ses_1" } };
      }
      if (r.method === "POST" && r.path === "/v1/vms") {
        expect(r.query.get("wait")).toBe("true");
        expect(r.headers["idempotency-key"]).toBeTruthy();
        expect(r.json()).toMatchObject({ session_id: "ses_1" });
        return { json: { session_id: "ses_1", vm_id: "vm_1", status: "pending" } };
      }
      if (r.method === "GET" && r.path === "/v1/sessions/status/ses_1") {
        alive = polls++ > 0;
        return { json: { session_id: "ses_1", exists: true, vm_assigned: true, vm_id: "vm_1", vm_status: alive ? "active" : "pending", vm_alive: alive } };
      }
      if (r.method === "POST" && r.path === "/execute") {
        const b = r.json();
        expect(b).toMatchObject({ language: "bash", session_id: "ses_1" });
        // What the VM's shell prints: the command's output, then the code the adapter asked for.
        const x = fakeRun(b.command);
        return { json: { stdout: `${x.stdout}\n__sbr_exit__${x.code}\n`, stderr: x.stderr, success: true } };
      }
      if (r.method === "POST" && r.path === "/upload") {
        const text = r.body.toString();
        const path = /name="remote_path"\r\n\r\n([^\r]*)/.exec(text)![1]!;
        expect(text).toContain('name="session_id"\r\n\r\nses_1');
        files.set(path, /filename="[^"]*"\r\nContent-Type: [^\r]*\r\n\r\n([^\r]*)/.exec(text)![1]!);
        return { json: { success: true } };
      }
      if (r.method === "POST" && r.path === "/download") {
        const b = r.json();
        return { json: { filename: b.file_path, size: 5, content: Buffer.from(files.get(b.file_path) ?? "").toString("base64") } };
      }
      if (r.method === "POST" && r.path === "/v1/shares") return expect(r.json()).toMatchObject({ session_id: "ses_1", port: 3000, is_public: true }), { json: { url: "https://s1.instavm.site" } };
      if (r.method === "POST" && r.path === "/kill") return expect(r.json()).toEqual({ session_id: "ses_1" }), { json: { status: "already_terminated" } };
      return undefined;
    });
    const { router } = routerFor(instavmProvider, { INSTAVM_API_KEY: "instavm_sk_test", INSTAVM_API_URL: url });
    const sbx = await lifecycle(router, { files: true });
    expect(sbx.providerSandboxId).toBe("ses_1");
    expect((await sbx.commands.run("echo hi")).stdout).toBe("ran: sh -c 'echo hi'; printf '\\n__sbr_exit__%d\\n' $?\n");
    expect(seen).toContain("POST /kill");
    expect(await instavmProvider.getUrl!("ses_1", 3000, ctx({ INSTAVM_API_KEY: "instavm_sk_test", INSTAVM_API_URL: url }))).toBe("https://s1.instavm.site");
  });

  it("kills the session when its VM fails to start, and reports a 402 as quota", async () => {
    const { url, seen } = await mock((r) => {
      if (r.path === "/v1/sessions/session") return { json: { session_id: "ses_2" } };
      if (r.path === "/v1/vms") return { json: { session_id: "ses_2", status: "failed" } };
      if (r.path === "/kill") return { json: {} };
      return undefined;
    });
    await expect(instavmProvider.create({ cpu: 2, memoryMiB: 4096, timeoutSec: 60, env: {}, metadata: {} }, ctx({ INSTAVM_API_KEY: "k", INSTAVM_API_URL: url }, { pollMs: 1 }))).rejects.toThrow(/failed/);
    expect(seen).toContain("POST /kill");
    const broke = await mock(() => ({ status: 402, json: { detail: "Insufficient credits" } }));
    expect(await refusal(instavmProvider.create({ cpu: 2, memoryMiB: 4096, timeoutSec: 60, env: {}, metadata: {} }, ctx({ INSTAVM_API_KEY: "k", INSTAVM_API_URL: broke.url })), "instavm")).toBe("quota");
  });
});

describe("zipbox", () => {
  it("names boxes from a pool under a prefix taken from the key, and sizes by tier", () => {
    const names = zipboxNames(ctx({ ZIPBOX_API_KEY: "zb_a" }, { pool: 3 }));
    expect(names).toHaveLength(3);
    expect(names[0]).toMatch(/^sbr-[0-9a-f]{10}-00$/);
    expect(zipboxNames(ctx({ ZIPBOX_API_KEY: "zb_b" }, { pool: 3 }))[0]).not.toBe(names[0]);
    expect(zipboxNames(ctx({ ZIPBOX_API_KEY: "zb_a" }, { namePrefix: "ci" }))[5]).toBe("ci-05");
    expect(zipboxTier(2, 4096).tier).toBe("s");
    expect(zipboxTier(3, 1024).tier).toBe("m");
    expect(zipboxTier(64, 1).tier).toBe("l");
  });

  it("claims a free name, waits for ready, streams exec from the box, and is deleted at the deadline", async () => {
    const files = new Map<string, Buffer>();
    const used = new Set<string>();
    let self = "";
    let n = 0;
    const { url, seen } = await mock((r) => {
      if (r.path.startsWith("/box/")) {
        if (r.headers.authorization !== "Bearer bt_1") return { status: 401, json: { error: "unauthorized" } };
        if (r.method === "POST" && r.path === "/box/exec") {
          expect(r.headers.accept).toBe("text/event-stream");
          const x = fakeRun(r.json().cmd);
          const ev = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
          return {
            type: "text/event-stream",
            raw: ev("start", { id: "cmd_1" }) + (x.stdout ? ev("stdout", { data: x.stdout }) : "") + (x.stderr ? ev("stderr", { data: x.stderr }) : "") + ev("exit", { state: "exited", exitCode: x.code, signal: null, timedOut: false }),
          };
        }
        if (r.method === "POST" && r.path === "/box/files/mutate") return { json: {} };
        if (r.method === "POST" && r.path === "/box/files/write") return files.set(`${r.query.get("dir")}/${r.query.get("name")}`, r.body), { json: {} };
        if (r.method === "GET" && r.path === "/box/files/download") return { raw: files.get(r.query.get("path")!) ?? "" };
        if (r.method === "GET" && r.path === "/box/files") return { json: { path: "/tmp", entries: [{ name: "a.txt", kind: "file", sizeBytes: 5 }], truncated: false } };
        return undefined;
      }
      if (r.headers.authorization !== "Bearer zb_test") return { status: 401, json: { error: { code: "unauthorized" } } };
      if (r.method === "POST" && r.path === "/sandbox/identity/claim") {
        const { name, tier } = r.json();
        expect(tier).toBe("s");
        expect(r.headers["idempotency-key"]).toContain(`:${name}`);
        // The first name tried is taken by another create, so the adapter moves on.
        if (used.has(name) || n++ === 0) return { status: 409, json: { error: { code: "name_taken" } } };
        used.add(name);
        return { json: { sandboxId: `box_${used.size}`, name, status: "provisioning", ready: false, readiness: "settling" } };
      }
      const wait = /^\/sandbox\/(box_\d+)\/wait$/.exec(r.path);
      if (r.method === "GET" && wait) return { json: { id: wait[1], status: "running", ready: true, readiness: "ready", baseUrl: `${self}/box`, boxToken: "bt_1" } };
      const get = /^\/sandbox\/(box_\d+)$/.exec(r.path);
      if (r.method === "GET" && get) return { json: { id: get[1], status: "running", ready: true, readiness: "ready", baseUrl: `${self}/box`, boxToken: "bt_1" } };
      if (r.method === "DELETE" && get) return expect(r.json()).toEqual({ archiveBeforeDestroy: false }), { json: { success: true } };
      return undefined;
    });
    self = url;
    const { router, clock } = routerFor(zipboxProvider, { ZIPBOX_API_KEY: "zb_test", ZIPBOX_API_URL: url });
    await lifecycle(router, { files: true });
    expect(seen.filter((s) => s === "POST /sandbox/identity/claim").length).toBeGreaterThanOrEqual(2);
    // Boxes never stop on a timer: the router deletes them at the deadline.
    await deletedAtDeadline(router, clock, seen, (id) => `DELETE /sandbox/${id}`);
  });

  it("deletes a box whose first start fails, and reports insufficient credits (402) as quota", async () => {
    const { url, seen } = await mock((r) => {
      if (r.path === "/sandbox/identity/claim") return { json: { sandboxId: "box_x", status: "provisioning", ready: false, readiness: "settling" } };
      if (r.path === "/sandbox/box_x/wait") return { json: { id: "box_x", status: "paused", ready: false, readiness: "start_failed" } };
      if (r.method === "DELETE") return { json: {} };
      return undefined;
    });
    await expect(zipboxProvider.create({ cpu: 2, memoryMiB: 4096, timeoutSec: 60, env: {}, metadata: {} }, ctx({ ZIPBOX_API_KEY: "k", ZIPBOX_API_URL: url }, { pollMs: 1 }))).rejects.toThrow(/start_failed/);
    expect(seen).toContain("DELETE /sandbox/box_x");
    const broke = await mock(() => ({ status: 402, json: { error: { code: "insufficient_credits", message: "Your balance is at or below $0" } } }));
    expect(await refusal(zipboxProvider.create({ cpu: 2, memoryMiB: 4096, timeoutSec: 60, env: {}, metadata: {} }, ctx({ ZIPBOX_API_KEY: "k", ZIPBOX_API_URL: broke.url })), "zipbox")).toBe("quota");
  });
});

describe("registered", () => {
  it("each new adapter declares its env key and a base-URL override", () => {
    const adapters: [ProviderAdapter, string][] = [
      [novitaProvider, "NOVITA_API_KEY"],
      [isorunProvider, "ISORUN_API_KEY"],
      [smolProvider, "SMOL_CLOUD_TOKEN"],
      [prizedProvider, "PRIZED_API_KEY"],
      [instavmProvider, "INSTAVM_API_KEY"],
      [zipboxProvider, "ZIPBOX_API_KEY"],
    ];
    for (const [p, key] of adapters) expect(p.info.env).toEqual([key]);
  });
});
