// The adapters added on 2026-11-21 in wave 3 (Keln, Mandala Computer, Platinum, Inngest, Archil,
// OpenPond, GMI Agentbox), driven through the router against local servers that speak each
// provider's wire format, from its OpenAPI spec, API reference or official SDK source. None has
// been run against the real service.
import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { fakeRun, lifecycle, mock, routerFor } from "./restmock.js";
import type { ProviderAdapter } from "../src/index.js";
import { kelnProvider, kelnSize } from "../src/providers/keln.js";
import { mandalaProvider } from "../src/providers/mandala.js";
import { platinumProvider } from "../src/providers/platinum.js";
import { inngestApiKey, inngestProvider, inngestSize } from "../src/providers/inngest.js";
import { archilProvider } from "../src/providers/archil.js";
import { openpondProvider, openpondTier } from "../src/providers/openpond.js";
import { gmiProvider } from "../src/providers/gmi.js";

const ctx = (env: Record<string, string>) => ({ env, options: { pollMs: 1 } });
const b64 = (s: string) => Buffer.from(s).toString("base64");

/** A create the provider refuses fails over with `kind`. */
async function refused(adapter: ProviderAdapter, env: Record<string, string>, kind: string) {
  const { router } = routerFor(adapter, env);
  await expect(router.create({ timeoutSec: 60 })).rejects.toMatchObject({ attempts: [expect.objectContaining({ provider: adapter.info.id, outcome: "failed", kind })] });
}

// The `disk` SDK speaks Archil's WebSocket process protocol; the mock runs commands like fakeRun.
const archilSdk = vi.hoisted(() => ({ opts: [] as unknown[], execs: [] as { id: string; command: string; opts: unknown }[] }));
vi.mock("disk", () => ({
  Archil: class {
    constructor(opts: unknown) {
      archilSdk.opts.push(opts);
    }
    sandboxes = {
      get: async (id: string) => ({
        exec: async (command: string, opts: unknown) => {
          archilSdk.execs.push({ id, command, opts });
          const x = /exit (\d+)/.exec(command);
          return x ? { status: "failed", exitCode: Number(x[1]), stdout: "", stderr: "boom\n" } : { status: "completed", exitCode: 0, stdout: `ran: ${command}\n`, stderr: "" };
        },
      }),
    };
  },
}));

describe("sizes", () => {
  it("maps a request to each provider's sizes", () => {
    expect(kelnSize(2, 4096)).toEqual({ cpu: 2, memory_mb: 4096 });
    expect(kelnSize(1, 512)).toEqual({ cpu: 1, memory_mb: 1024 });
    expect(kelnSize(8, 65_536)).toEqual({ cpu: 4, memory_mb: 16_384 });
    expect(kelnSize(4, 1024)).toEqual({ cpu: 4, memory_mb: 4096 });
    expect(inngestSize(2, 4096)).toEqual({ vcpu: 2, memoryMb: 4096 });
    expect(inngestSize(3, 1024)).toEqual({ vcpu: 4, memoryMb: 4096 });
    expect(inngestSize(1, 9000)).toEqual({ vcpu: 1, memoryMb: 4096 });
    expect(openpondTier(2, 4096)).toEqual({ cpu: 2, memoryGb: 4, diskGb: 20 });
    expect(openpondTier(0.5, 512)).toEqual({ cpu: 0.5, memoryGb: 1, diskGb: 8 });
    expect(openpondTier(16, 1)).toEqual({ cpu: 4, memoryGb: 8, diskGb: 40 });
  });

  it("prices 2 vCPU / 4 GiB as each provider's page does", () => {
    const perHour = (a: ProviderAdapter) => (a.info.pricing.vcpuSecondUsd * 2 + a.info.pricing.gibSecondUsd * 4) * 3600;
    expect(perHour(kelnProvider)).toBeCloseTo(0.1656, 4);
    expect(perHour(mandalaProvider)).toBeCloseTo(0.12, 6);
    expect(perHour(platinumProvider)).toBeCloseTo(0.108, 6);
    expect(perHour(inngestProvider)).toBeCloseTo(0.1224, 6);
    expect(perHour(archilProvider)).toBeCloseTo(0.19, 6);
    expect(perHour(openpondProvider)).toBeCloseTo(0.2376, 6);
    expect(perHour(gmiProvider)).toBeCloseTo(0.17, 6);
  });
});

/** A server-sent event stream as Keln sends it. */
const sseBody = (events: [string, unknown][]) => events.map(([event, data], i) => `id: ${i + 1}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(": ping\n\n");

describe("keln", () => {
  const key = "sk-keln-test";
  it("creates with an idempotency key, polls a starting sandbox, streams commands, moves files and opens a port", async () => {
    const files = new Map<string, Buffer>();
    let polls = 0;
    let ports: { port: number; public: boolean; url: string }[] = [{ port: 3000, public: false, url: "https://3000-x.keln.run" }];
    const { url, seen } = await mock((r) => {
      if (r.headers.authorization !== `Bearer ${key}`) return { status: 401, json: { error: { type: "authentication_error", code: "invalid_api_key", message: "no" } } };
      if (r.method === "POST" && r.path === "/v1/sandboxes") {
        expect(r.headers["idempotency-key"]).toBeTruthy();
        const b = r.json();
        expect(b).toMatchObject({ cpu: 2, memory_mb: 4096, timeout_s: 120 });
        expect(b.metadata["sandboxrouting.id"]).toBeTruthy();
        return { status: 202, json: { id: "sbx_k1", object: "sandbox", state: "starting" } };
      }
      if (r.method === "GET" && r.path === "/v1/sandboxes/sbx_k1") return { json: { id: "sbx_k1", state: polls++ < 1 ? "starting" : "running", ports } };
      if (r.method === "POST" && r.path === "/v1/sandboxes/sbx_k1/commands") {
        expect(r.headers.accept).toBe("text/event-stream");
        const x = fakeRun(r.json().command);
        const events: [string, unknown][] = [["started", { command_id: "cmd_1", pid: 41 }]];
        if (x.stdout) events.push(["stdout", { data: b64(x.stdout), ts: 1 }]);
        if (x.stderr) events.push(["stderr", { data: b64(x.stderr), ts: 1 }]);
        events.push(["exit", { exit_code: x.code, signal: null, oom_killed: false }]);
        return { raw: sseBody(events), type: "text/event-stream", headers: { "keln-command-id": "cmd_1" } };
      }
      if (r.path === "/v1/sandboxes/sbx_k1/files" && r.method === "PUT") return files.set(r.query.get("path")!, r.body), { json: { object: "file", path: r.query.get("path"), size: r.body.length } };
      if (r.path === "/v1/sandboxes/sbx_k1/files" && r.method === "GET") return { raw: files.get(r.query.get("path")!) ?? "" };
      if (r.path === "/v1/sandboxes/sbx_k1/files/list") {
        return { json: { object: "list", path: r.query.get("path"), data: [...files.keys()].map((p) => ({ name: p.split("/").pop(), path: p, type: "file", size: files.get(p)!.length })) } };
      }
      if (r.method === "PATCH" && r.path === "/v1/sandboxes/sbx_k1") {
        ports = r.json().ports.map((p: { port: number; public: boolean }) => ({ ...p, url: `https://${p.port}-k1.keln.run` }));
        return { json: { id: "sbx_k1", state: "running", ports } };
      }
      if (r.method === "DELETE" && r.path === "/v1/sandboxes/sbx_k1") return { json: { id: "sbx_k1", state: "stopped", end_reason: "deleted" } };
      return undefined;
    });
    const env = { KELN_API_KEY: key, KELN_SANDBOX_URL: url };
    const { router } = routerFor(kelnProvider, env);
    const sbx = await lifecycle(router, { files: true });
    expect(polls).toBe(2);
    expect(await kelnProvider.listFiles!(sbx.providerSandboxId, "/tmp", ctx(env))).toEqual([{ name: "a.txt", path: "/tmp/a.txt", isDir: false, size: 5 }]);
    expect(await kelnProvider.getUrl!("sbx_k1", 8080, ctx(env))).toBe("https://8080-k1.keln.run");
    // The port already open is kept: the list is replaced as a whole.
    expect(ports.map((p) => [p.port, p.public])).toEqual([
      [3000, false],
      [8080, true],
    ]);
    expect(seen).toContain("DELETE /v1/sandboxes/sbx_k1");
  });

  it("reattaches a dropped command stream after the last event it saw", async () => {
    let lastEventId: string | undefined;
    const { url } = await mock((r) => {
      if (r.method === "POST" && r.path === "/v1/sandboxes/sbx_k2/commands") {
        return { raw: sseBody([["started", { command_id: "cmd_9", pid: 1 }], ["stdout", { data: b64("part one\n"), ts: 1 }]]), type: "text/event-stream", headers: { "keln-command-id": "cmd_9" } };
      }
      if (r.method === "GET" && r.path === "/v1/sandboxes/sbx_k2/commands/cmd_9/events") {
        lastEventId = r.headers["last-event-id"] as string;
        return { raw: `id: 3\nevent: stdout\ndata: ${JSON.stringify({ data: b64("part two\n") })}\n\nid: 4\nevent: exit\ndata: {"exit_code":0,"signal":null}\n\n`, type: "text/event-stream" };
      }
      return undefined;
    });
    const r = await kelnProvider.exec("sbx_k2", "make", {}, ctx({ KELN_API_KEY: key, KELN_SANDBOX_URL: url }));
    expect(lastEventId).toBe("2");
    expect(r).toEqual({ stdout: "part one\npart two\n", stderr: "", exitCode: 0 });
  });

  it("deletes a sandbox that stopped while starting, and treats a 404 on delete as already gone", async () => {
    const { url, seen } = await mock((r) => {
      if (r.method === "POST" && r.path === "/v1/sandboxes") return { status: 202, json: { id: "sbx_bad", state: "starting" } };
      if (r.method === "GET" && r.path === "/v1/sandboxes/sbx_bad") return { json: { id: "sbx_bad", state: "stopped", end_reason: "failed" } };
      if (r.method === "DELETE" && r.path === "/v1/sandboxes/sbx_bad") return { json: { id: "sbx_bad", state: "stopped" } };
      if (r.method === "DELETE") return { status: 404, json: { error: { type: "not_found_error", code: "sandbox_not_found", message: "No such sandbox" } } };
      return undefined;
    });
    const env = { KELN_API_KEY: key, KELN_SANDBOX_URL: url };
    await expect(routerFor(kelnProvider, env).router.create({})).rejects.toThrow(/failed/);
    expect(seen).toContain("DELETE /v1/sandboxes/sbx_bad");
    await expect(kelnProvider.kill("sbx_never", ctx(env))).resolves.toBeUndefined();
  });

  it("marks quota for a spent balance and for the day's sandbox time", async () => {
    const poor = await mock(() => ({ status: 402, json: { error: { type: "payment_required_error", code: "insufficient_balance", message: "The balance does not cover the first 5 minutes" } } }));
    await refused(kelnProvider, { KELN_API_KEY: key, KELN_SANDBOX_URL: poor.url }, "quota");
    const daily = await mock(() => ({ status: 429, json: { error: { type: "rate_limit_error", code: "daily_limit", message: "The workspace has used its sandbox time for the day." } } }));
    await refused(kelnProvider, { KELN_API_KEY: key, KELN_SANDBOX_URL: daily.url }, "quota");
    const busy = await mock(() => ({ status: 429, json: { error: { type: "rate_limit_error", code: "concurrency_limit", message: "The workspace has its limit of running sandboxes." } } }));
    await refused(kelnProvider, { KELN_API_KEY: key, KELN_SANDBOX_URL: busy.url }, "rate_limit");
  });
});

describe("mandala", () => {
  const key = "mk_test";
  it("creates a computer, waits for it to run, keeps env in a file, polls background commands and moves files", async () => {
    const files = new Map<string, Buffer>();
    const runs = new Map<number, { cmd: string; reads: number }>();
    let polls = 0;
    const { url, seen } = await mock((r) => {
      if (r.headers.authorization !== `Bearer ${key}`) return { status: 401, json: { error: "Unauthorized", reason: "invalid" } };
      if (r.method === "POST" && r.path === "/computers") {
        expect(r.headers["idempotency-key"]).toBeTruthy();
        const b = r.json();
        expect(b).toMatchObject({ cpu: 2, ram_mb: 4096, template: "coding" });
        expect(b.name).toMatch(/^sbr-[0-9a-f]{16}$/);
        // Ten minutes is the shortest end time it takes.
        expect(b.ends_in_hours).toBe(0.17);
        return { status: 201, json: { id: "vm-a1b2c3d4e5f6", status: "building", cpu: 2, ram_mb: 4096 } };
      }
      if (r.method === "GET" && r.path === "/computers/vm-a1b2c3d4e5f6") return { json: { id: "vm-a1b2c3d4e5f6", status: polls++ < 1 ? "building" : "running", cpu: 2, ram_mb: 4096 } };
      if (r.method === "POST" && r.path === "/computers/vm-a1b2c3d4e5f6/exec") {
        const b = r.json();
        expect(b.background).toBe(true);
        const pid = runs.size + 100;
        runs.set(pid, { cmd: b.command, reads: 0 });
        return { status: 202, json: { execution_id: "exec_x", pid, running: true, exited: false, stdout_b64: "", stderr_b64: "" } };
      }
      const m = /^\/computers\/vm-a1b2c3d4e5f6\/exec\/(\d+)$/.exec(r.path);
      if (m && r.method === "GET") {
        const run = runs.get(Number(m[1]))!;
        // The first read finds it still running; reads consume output.
        if (run.reads++ === 0) return { json: { pid: Number(m[1]), running: true, exited: false, stdout_b64: "", stderr_b64: "" } };
        const x = fakeRun(run.cmd);
        return { json: { pid: Number(m[1]), running: false, exited: true, exit_code: x.code, stdout_b64: b64(x.stdout), stderr_b64: b64(x.stderr) } };
      }
      if (r.path === "/computers/vm-a1b2c3d4e5f6/files" && r.method === "PUT") return files.set(r.query.get("path")!, r.body), { json: { path: r.query.get("path"), bytes: r.body.length } };
      if (r.path === "/computers/vm-a1b2c3d4e5f6/files" && r.method === "GET") return { raw: files.get(r.query.get("path")!) ?? "" };
      if (r.path === "/computers/vm-a1b2c3d4e5f6/files/list") return { json: { path: r.query.get("path"), entries: [{ name: "a.txt", type: "file", size_bytes: 5 }, { name: "d", type: "directory" }], truncated: false } };
      if (r.method === "DELETE" && r.path === "/computers/vm-a1b2c3d4e5f6") return { json: { ok: true, snapshots_deleted: 0 } };
      return undefined;
    });
    const env = { MANDALA_API_KEY: key, MANDALA_API_URL: url };
    const { router } = routerFor(mandalaProvider, env);
    const sbx = await router.create({ timeoutSec: 120, env: { TOKEN: "s3cret" }, template: { mandala: "coding" } });
    expect(files.get("/tmp/.sbr-env")?.toString()).toBe("export TOKEN='s3cret'\n");
    const ok = await sbx.commands.run("echo hi");
    expect(ok).toMatchObject({ exitCode: 0 });
    expect(ok.stdout).toContain("echo hi");
    expect([...runs.values()][0]!.cmd).toContain(". /tmp/.sbr-env");
    expect((await sbx.commands.run("exit 3")).exitCode).toBe(3);
    await sbx.files.write("/tmp/b.txt", "hello");
    expect(await sbx.files.read("/tmp/b.txt")).toBe("hello");
    expect(await mandalaProvider.listFiles!(sbx.providerSandboxId, "/tmp", ctx(env))).toEqual([
      { name: "a.txt", path: "/tmp/a.txt", isDir: false, size: 5 },
      { name: "d", path: "/tmp/d", isDir: true, size: undefined },
    ]);
    await sbx.kill();
    expect(seen).toContain("DELETE /computers/vm-a1b2c3d4e5f6");
  });

  it("deletes a computer that was built but would not boot, and treats a 404 on delete as already gone", async () => {
    const { url, seen } = await mock((r) => {
      if (r.method === "POST" && r.path === "/computers") return { status: 201, json: { computer: { id: "vm-000000000bad", status: "stopped" }, start_error: "host out of disk", operation_id: "op_1" } };
      if (r.method === "DELETE" && r.path === "/computers/vm-000000000bad") return { json: { ok: true } };
      if (r.method === "DELETE") return { status: 404, json: { error: "computer not found" } };
      return undefined;
    });
    const env = { MANDALA_API_KEY: key, MANDALA_API_URL: url };
    await expect(routerFor(mandalaProvider, env).router.create({})).rejects.toThrow(/host out of disk/);
    expect(seen).toContain("DELETE /computers/vm-000000000bad");
    await expect(mandalaProvider.kill("vm-never", ctx(env))).resolves.toBeUndefined();
  });

  it("stops a command past its timeout", async () => {
    const { url, seen } = await mock((r) => {
      if (r.method === "POST") return { status: 202, json: { pid: 7, running: true, exited: false } };
      if (r.method === "GET") return { json: { pid: 7, running: true, exited: false, stdout_b64: b64("tick\n") } };
      if (r.method === "DELETE") return { json: { pid: 7, killed: true } };
      return undefined;
    });
    const r = await mandalaProvider.exec("vm-x", "sleep 99", { timeoutSec: 0.05 }, ctx({ MANDALA_API_KEY: key, MANDALA_API_URL: url }));
    expect(r.exitCode).toBe(124);
    expect(seen).toContain("DELETE /computers/vm-x/exec/7");
  });

  it("marks quota when the balance can't cover a start", async () => {
    const { url } = await mock(() => ({ status: 402, json: { error: "Add credits to start this computer.", code: "INSUFFICIENT_BALANCE", required_micros: 250000 } }));
    await refused(mandalaProvider, { MANDALA_API_KEY: key, MANDALA_API_URL: url }, "quota");
  });
});

describe("platinum", () => {
  const key = "pt_test";
  it("creates and waits for running, runs commands as managed processes, moves files and exposes a port", async () => {
    const files = new Map<string, Buffer>();
    const procs = new Map<string, ReturnType<typeof fakeRun> & { body: Record<string, unknown> }>();
    let polls = 0;
    const { url, seen } = await mock((r) => {
      if (r.headers.authorization !== `Bearer ${key}`) return { status: 401, json: { error: "unauthorized" } };
      if (r.method === "POST" && r.path === "/v1/sandboxes") {
        expect(r.query.get("wait_for_state")).toBe("running");
        const b = r.json();
        expect(b).toMatchObject({ cpu: 2, ram_mb: 4096, auto_stop_minutes: 2, backup_interval_min: 0 });
        expect(b.name).toMatch(/^sbr-/);
        return { status: 202, json: { id: "sbx_01P", state: "provisioning", wait_timed_out: true } };
      }
      if (r.method === "GET" && r.path === "/v1/sandboxes/sbx_01P") return { json: { id: "sbx_01P", state: polls++ < 1 ? "provisioning" : "running" } };
      if (r.method === "POST" && r.path === "/v1/sandboxes/sbx_01P/processes") {
        const b = r.json();
        const handle = `p_${procs.size}`;
        procs.set(handle, { ...fakeRun(b.cmd), body: b });
        return { status: 201, json: { handle, pid: 10 } };
      }
      const m = /^\/v1\/sandboxes\/sbx_01P\/processes\/(p_\d+)(\/logs)?$/.exec(r.path);
      if (m && !m[2]) return { json: { handle: m[1], pid: 10, cmd: ["sh"], running: false, exit_code: procs.get(m[1]!)!.code } };
      if (m && m[2]) {
        const p = procs.get(m[1]!)!;
        const at = Number(r.query.get("stdout_offset"));
        expect(r.query.get("encoding")).toBe("base64");
        // All the output on the first read, nothing after.
        return at === 0
          ? { json: { stdout: b64(p.stdout), stderr: b64(p.stderr), stdout_offset: p.stdout.length, stderr_offset: p.stderr.length, stdout_dropped: 0, stderr_dropped: 0, running: false, drained: true, exit_code: p.code } }
          : { json: { stdout: "", stderr: "", stdout_offset: at, stderr_offset: Number(r.query.get("stderr_offset")), stdout_dropped: 0, stderr_dropped: 0, running: false, drained: true, exit_code: p.code } };
      }
      if (r.path === "/v1/sandboxes/sbx_01P/files" && r.method === "PUT") return files.set(r.query.get("path")!, r.body), { json: { ok: true, size: r.body.length, mode: "0644" } };
      if (r.path === "/v1/sandboxes/sbx_01P/files" && r.method === "GET") return { raw: files.get(r.query.get("path")!) ?? "" };
      if (r.path === "/v1/sandboxes/sbx_01P/files/list") return { json: { ok: true, entries: [{ name: "a.txt", size: 5, mode: 420, is_dir: false }] } };
      if (r.path === "/v1/sandboxes/sbx_01P/expose") return { json: { port: r.json().port, url: "https://8000-sbx01p.preview.platinum.dev", public: true, protocol: "http" } };
      if (r.method === "DELETE" && r.path === "/v1/sandboxes/sbx_01P") return { json: { id: "sbx_01P", state: "deleting" } };
      return undefined;
    });
    const env = { PT_TOKEN: key, PT_API_URL: url };
    const { router } = routerFor(platinumProvider, env);
    const sbx = await lifecycle(router, { files: true });
    expect(polls).toBe(2);
    await platinumProvider.exec(sbx.providerSandboxId, "make", { cwd: "/work", env: { A: "1" }, timeoutSec: 30 }, ctx(env));
    expect([...procs.values()].at(-1)!.body).toEqual({ cmd: "make", cwd: "/work", env: { A: "1" }, timeout_ms: 30_000 });
    expect(await platinumProvider.listFiles!(sbx.providerSandboxId, "/tmp/", ctx(env))).toEqual([{ name: "a.txt", path: "/tmp/a.txt", isDir: false, size: 5 }]);
    expect(await platinumProvider.getUrl!(sbx.providerSandboxId, 8000, ctx(env))).toBe("https://8000-sbx01p.preview.platinum.dev");
    expect(seen).toContain("DELETE /v1/sandboxes/sbx_01P");
  });

  it("reads a timed-out process as exit 124", async () => {
    const { url } = await mock((r) => {
      if (r.method === "POST") return { status: 201, json: { handle: "p_t", pid: 1 } };
      if (r.path.endsWith("/logs")) return { json: { stdout: "", stderr: "", stdout_offset: 0, stderr_offset: 0, stdout_dropped: 0, stderr_dropped: 0, running: false, drained: true, exit_code: -1, timed_out: true } };
      return { json: { handle: "p_t", pid: 1, cmd: [], running: false, exit_code: -1, timed_out: true } };
    });
    expect((await platinumProvider.exec("sbx_t", "sleep 99", { timeoutSec: 1 }, ctx({ PT_TOKEN: key, PT_API_URL: url }))).exitCode).toBe(124);
  });

  it("deletes a sandbox whose start failed, and treats a 404 on delete as already gone", async () => {
    const { url, seen } = await mock((r) => {
      if (r.method === "POST" && r.path === "/v1/sandboxes") return { status: 201, json: { id: "sbx_bad", state: "failed-start" } };
      if (r.method === "DELETE" && r.path === "/v1/sandboxes/sbx_bad") return { json: { id: "sbx_bad", state: "deleted" } };
      if (r.method === "DELETE") return { status: 404, json: { error: "not found" } };
      return undefined;
    });
    const env = { PT_TOKEN: key, PT_API_URL: url };
    await expect(routerFor(platinumProvider, env).router.create({})).rejects.toThrow(/failed-start/);
    expect(seen).toContain("DELETE /v1/sandboxes/sbx_bad");
    await expect(platinumProvider.kill("sbx_never", ctx(env))).resolves.toBeUndefined();
  });

  it("marks quota when the credits run out", async () => {
    const { url } = await mock(() => ({ status: 402, json: { error: "insufficient_credits" } }));
    await refused(platinumProvider, { PT_TOKEN: key, PT_API_URL: url }, "quota");
  });
});

describe("inngest", () => {
  const signingKey = "signkey-prod-0a1b2c3d4e5f";
  it("hashes the signing key as the SDK does", () => {
    const want = `signkey-prod-${createHash("sha256").update(Buffer.from("0a1b2c3d4e5f", "hex")).digest("hex")}`;
    expect(inngestApiKey(signingKey)).toBe(want);
    expect(inngestApiKey("0a0b")).toBe(createHash("sha256").update(Buffer.from([10, 11])).digest("hex"));
  });

  it("creates by name, waits for RUNNING, runs commands with base64 output and moves files", async () => {
    const files = new Map<string, Buffer>();
    let polls = 0;
    const id = "0b5d9a54-8a0e-4f3f-9e0c-0d6f0f0f0f0f";
    const { url, seen } = await mock((r) => {
      if (r.headers.authorization !== `Bearer ${inngestApiKey(signingKey)}`) return { status: 401, json: { errors: [{ code: "unauthorized", message: "no" }] } };
      expect(r.headers["x-inngest-env"]).toBe("branch-1");
      if (r.method === "POST" && r.path === "/v2/sandboxes") {
        const b = r.json();
        expect(b).toEqual({ name: expect.stringMatching(/^sbr-/), vcpu: 2, memoryMb: 4096 });
        return { status: 202, json: { data: { id, name: b.name, status: "STARTING" } } };
      }
      if (r.method === "GET" && r.path === `/v2/sandboxes/${id}`) return { json: { data: { id, status: polls++ < 1 ? "STARTING" : "RUNNING" } } };
      if (r.method === "POST" && r.path === `/v2/sandboxes/${id}/exec`) {
        const b = r.json();
        expect(b.command.slice(0, 2)).toEqual(["/bin/sh", "-c"]);
        expect(b.timeout).toMatch(/^\d+ms$/);
        const x = fakeRun(b.command[2]);
        return { json: { data: { stdout: b64(x.stdout), stderr: b64(x.stderr), encoding: "base64", exitCode: x.code } } };
      }
      if (r.path === `/v2/sandboxes/${id}/files` && r.method === "PUT") return files.set(r.query.get("path")!, r.body), { json: { data: { path: r.query.get("path"), bytesWritten: r.body.length } } };
      if (r.path === `/v2/sandboxes/${id}/files` && r.method === "GET") return { raw: files.get(r.query.get("path")!) ?? "" };
      if (r.method === "DELETE" && r.path === `/v2/sandboxes/${id}`) return { status: 202, json: { data: { id, status: "TERMINATING" } } };
      return undefined;
    });
    const env = { INNGEST_SIGNING_KEY: signingKey, INNGEST_API_BASE_URL: url, INNGEST_ENV: "branch-1" };
    const { router } = routerFor(inngestProvider, env);
    await lifecycle(router, { files: true });
    expect(polls).toBe(2);
    expect(seen).toContain(`DELETE /v2/sandboxes/${id}`);
  });

  it("reads the observation timeout as exit 124, deletes a FAILED sandbox, and treats a 404 on delete as gone", async () => {
    const { url, seen } = await mock((r) => {
      if (r.method === "POST" && r.path === "/v2/sandboxes") return { status: 202, json: { data: { id: "s-bad", status: "STARTING" } } };
      if (r.method === "GET" && r.path === "/v2/sandboxes/s-bad") return { json: { data: { id: "s-bad", status: "FAILED", error: "image missing" } } };
      if (r.method === "DELETE" && r.path === "/v2/sandboxes/s-bad") return { status: 204, raw: "" };
      if (r.method === "POST" && r.path.endsWith("/exec")) return { status: 504, json: { errors: [{ code: "sandbox_exec_timed_out", message: "command did not finish" }] } };
      if (r.method === "DELETE") return { status: 404, json: { errors: [{ code: "sandbox_not_found", message: "gone" }] } };
      return undefined;
    });
    const env = { INNGEST_SIGNING_KEY: signingKey, INNGEST_API_BASE_URL: url };
    await expect(routerFor(inngestProvider, env).router.create({})).rejects.toThrow(/image missing/);
    expect(seen).toContain("DELETE /v2/sandboxes/s-bad");
    expect((await inngestProvider.exec("s-x", "sleep 999", { timeoutSec: 1 }, ctx(env))).exitCode).toBe(124);
    await expect(inngestProvider.kill("s-never", ctx(env))).resolves.toBeUndefined();
  });

  it("fails over as auth when the plan has no sandboxes", async () => {
    const { url } = await mock(() => ({ status: 403, json: { errors: [{ code: "access_denied", message: "Sandboxes are not included in this plan" }] } }));
    await refused(inngestProvider, { INNGEST_SIGNING_KEY: signingKey, INNGEST_API_BASE_URL: url }, "auth");
  });
});

describe("archil", () => {
  const key = "key-test";
  it("creates over REST, runs commands through the SDK, and stops before deleting", async () => {
    archilSdk.execs.length = 0;
    let state = "pending";
    const { url, seen } = await mock((r) => {
      if (r.headers.authorization !== `Bearer ${key}`) return { status: 401, raw: "Must provide an Authorization header", type: "text/plain" };
      if (r.method === "POST" && r.path === "/api/sandboxes") {
        expect(r.query.get("wait")).toBe("true");
        const b = r.json();
        expect(b).toMatchObject({ vcpu_count: 1, mem_size_mib: 2048, max_ttl_seconds: 120, idle_ttl_seconds: 0, base_image: "python:3.13" });
        expect(b.name).toMatch(/^sbr-[0-9a-f]{16}$/);
        return { status: 202, json: { success: true, data: { sandbox_id: "019d-1", name: b.name, status: "pending" } } };
      }
      if (r.method === "GET" && r.path === "/api/sandboxes/019d-1") {
        if (state === "pending") state = "running";
        else if (state === "stopping") state = "stopped";
        return { json: { success: true, data: { sandbox_id: "019d-1", name: "x", status: state, vcpu_count: 1, mem_size_mib: 2048 } } };
      }
      if (r.method === "POST" && r.path === "/api/sandboxes/019d-1/stop") return (state = "stopping"), { status: 202, json: { success: true, data: { sandbox_id: "019d-1", status: "stopping" } } };
      if (r.method === "DELETE" && r.path === "/api/sandboxes/019d-1") {
        if (state !== "stopped") return { status: 409, json: { success: false, error: "The sandbox must be stopped", code: "conflict" } };
        return (state = "deleted"), { status: 204, raw: "" };
      }
      if (r.method === "PUT" && r.path === "/api/sandboxes/019d-1/ports/8080") return { status: 201, json: { success: true, data: { port: 8080, hostname: "8080-abc.sbx.archil.com" } } };
      return undefined;
    });
    const env = { ARCHIL_API_KEY: key, ARCHIL_API_URL: url };
    const { router } = routerFor(archilProvider, env);
    const sbx = await router.create({ timeoutSec: 120, image: "python:3.13" });
    expect(await archilProvider.getUrl!(sbx.providerSandboxId, 8080, ctx(env))).toBe("https://8080-abc.sbx.archil.com");
    const ok = await sbx.commands.run("echo hi", { cwd: "/work" });
    expect(ok).toMatchObject({ exitCode: 0, stdout: "ran: echo hi\n" });
    expect((await sbx.commands.run("exit 3")).exitCode).toBe(3);
    expect(archilSdk.execs[0]).toMatchObject({ id: "019d-1", command: "echo hi", opts: { cwd: "/work" } });
    expect(archilSdk.opts.at(-1)).toEqual({ apiKey: key, region: "aws-us-east-1", baseUrl: url });
    await sbx.kill();
    expect(seen.filter((s) => s.startsWith("POST /api/sandboxes/019d-1/stop"))).toHaveLength(1);
    expect(seen).toContain("DELETE /api/sandboxes/019d-1");
    expect(state).toBe("deleted");
  });

  it("adopts the sandbox its earlier try made when the name is taken, and kill is idempotent", async () => {
    const { url } = await mock((r) => {
      if (r.method === "POST" && r.path === "/api/sandboxes") return { status: 409, json: { success: false, error: "A sandbox with this name already exists", code: "sandbox_name_conflict" } };
      if (r.method === "GET" && r.path === "/api/sandboxes") return { json: { success: true, data: { sandboxes: [{ sandbox_id: "other", name: "sbr-0", status: "running" }, { sandbox_id: "mine", name: NAME, status: "running" }] } } };
      if (r.path.startsWith("/api/sandboxes/gone")) return { status: 404, json: { success: false, error: "Not found", code: "not_found" } };
      return undefined;
    });
    const env = { ARCHIL_API_KEY: key, ARCHIL_API_URL: url };
    const spec = { cpu: 1, memoryMiB: 2048, timeoutSec: 60, env: {}, metadata: { "sandboxrouting.id": "fixed-id" } };
    const NAME = `sbr-${createHash("sha256").update("fixed-id").digest("hex").slice(0, 16)}`;
    expect(await archilProvider.create(spec, ctx(env))).toMatchObject({ providerSandboxId: "mine" });
    await expect(archilProvider.kill("gone", ctx(env))).resolves.toBeUndefined();
  });

  it("refuses an unknown region", async () => {
    await expect(archilProvider.listAlive!(ctx({ ARCHIL_API_KEY: key, ARCHIL_REGION: "mars-1" }))).rejects.toThrow(/unknown region/);
  });
});

describe("openpond", () => {
  const key = "opk_test";
  it("creates within a budget, waits for running, inlines cwd and env, and opens a public preview", async () => {
    let polls = 0;
    const execs: Record<string, unknown>[] = [];
    const { url, seen } = await mock((r) => {
      if (r.headers.authorization !== `ApiKey ${key}` || r.headers["openpond-api-key"] !== key) return { status: 401, json: { error: "unauthorized" } };
      if (r.method === "POST" && r.path === "/v1/sandboxes") {
        const b = r.json();
        expect(b.resources).toEqual({ cpu: 2, memoryGb: 4, diskGb: 20 });
        // 2 vCPU / 4 GiB for 120 s with a quarter to spare: $0.0099, rounded to cents.
        expect(b.budget).toEqual({ maxUsd: "0.01" });
        expect(b.quotas).toMatchObject({ maxSpendUsd: "0.01", maxDurationSeconds: 120 });
        expect(b.env).toEqual([{ name: "A", value: "1" }]);
        return { json: { sandbox: { id: "sbx_op", state: "creating" } } };
      }
      if (r.method === "GET" && r.path === "/v1/sandboxes/sbx_op") return { json: { sandbox: { id: "sbx_op", state: polls++ < 1 ? "creating" : "running" } } };
      if (r.method === "POST" && r.path === "/v1/sandboxes/sbx_op/exec") {
        const b = r.json();
        execs.push(b);
        const x = fakeRun(b.command);
        return { json: { sandbox: {}, command: { id: "c", command: b.command, status: x.code ? "failed" : "succeeded", output: x.stdout + x.stderr, exitCode: x.code } } };
      }
      if (r.method === "POST" && r.path === "/v1/sandboxes/sbx_op/ports") return { json: { preview: { port: r.json().port, url: "https://p-1.preview.openpond.ai", access: r.json().access } } };
      if (r.method === "DELETE" && r.path === "/v1/sandboxes/sbx_op") return { json: { sandbox: { id: "sbx_op", state: "deleted" } } };
      return undefined;
    });
    const env = { OPENPOND_API_KEY: key, OPENPOND_API_URL: url };
    const { router } = routerFor(openpondProvider, env);
    const sbx = await router.create({ timeoutSec: 120, env: { A: "1" } });
    expect(polls).toBe(2);
    const ok = await sbx.commands.run("pwd", { cwd: "/work", env: { B: "2" } });
    expect(ok.exitCode).toBe(0);
    expect(execs[0]!.command).toBe("export B='2'; cd '/work' && pwd");
    const bad = await sbx.commands.run("exit 3");
    expect(bad).toMatchObject({ exitCode: 3, stdout: "boom\n", stderr: "" });
    expect(await openpondProvider.getUrl!("sbx_op", 3000, ctx(env))).toBe("https://p-1.preview.openpond.ai");
    await sbx.kill();
    expect(seen).toContain("DELETE /v1/sandboxes/sbx_op");
  });

  it("deletes a sandbox in error, and treats a 404 on delete as already gone", async () => {
    const { url, seen } = await mock((r) => {
      if (r.method === "POST" && r.path === "/v1/sandboxes") return { json: { sandbox: { id: "sbx_err", state: "error" } } };
      if (r.method === "DELETE" && r.path === "/v1/sandboxes/sbx_err") return { json: { sandbox: { id: "sbx_err", state: "deleted" } } };
      if (r.method === "DELETE") return { status: 404, json: { error: "sandbox_not_found" } };
      return undefined;
    });
    const env = { OPENPOND_API_KEY: key, OPENPOND_API_URL: url };
    await expect(routerFor(openpondProvider, env).router.create({})).rejects.toThrow(/error/);
    expect(seen).toContain("DELETE /v1/sandboxes/sbx_err");
    await expect(openpondProvider.kill("sbx_never", ctx(env))).resolves.toBeUndefined();
  });

  it("marks quota when the budget can't be reserved", async () => {
    const { url } = await mock(() => ({ status: 402, json: { error: "insufficient_balance", message: "Add funds to reserve this budget" } }));
    await refused(openpondProvider, { OPENPOND_API_KEY: key, OPENPOND_API_URL: url }, "quota");
  });
});

describe("gmi", () => {
  const key = "gmi_test";
  /** The control plane and one sandbox's data plane, on two local servers. */
  async function planes(opts: { state?: (polls: number) => Record<string, unknown> } = {}) {
    const files = new Map<string, Buffer>();
    const execs = new Map<string, ReturnType<typeof fakeRun>>();
    let polls = 0;
    let token = "tok-1";
    const dataPlane = await mock((r) => {
      if (r.headers["x-access-token"] !== token) return { status: 401, json: { code: "Auth.Unauthorized", message: "bad token" } };
      if (r.method === "POST" && r.path === "/executions") {
        expect(r.query.get("wait")).toBe("true");
        const b = r.json();
        expect(b.action).toBe("exec");
        const eid = `0000000${execs.size}-0000-4000-8000-000000000000`;
        execs.set(eid, fakeRun(b.parameters.command));
        return { status: 202, json: { request_id: "req-1", execution_id: eid, sandbox_id: "ikey", status: "running" } };
      }
      const m = /^\/executions\/(.+)$/.exec(r.path);
      if (m && r.method === "GET") {
        const x = execs.get(m[1]!)!;
        return { json: { execution_id: m[1], status: x.code ? "failed" : "succeeded", exit_code: x.code, stdout: x.stdout, stderr: x.stderr, stdout_truncated: false, stderr_truncated: false } };
      }
      if (r.path === "/files" && r.method === "POST") {
        expect(r.headers["content-type"]).toMatch(/^multipart\/form-data; boundary=/);
        const body = r.body.toString("latin1");
        const start = body.indexOf("\r\n\r\n") + 4;
        const end = body.indexOf("\r\n--", start);
        files.set(r.query.get("path")!, Buffer.from(body.slice(start, end), "latin1"));
        return { json: [{ path: r.query.get("path"), name: "a.txt", type: "file" }] };
      }
      if (r.path === "/files" && r.method === "GET") return { raw: files.get(r.query.get("path")!) ?? "" };
      return undefined;
    });
    const control = await mock((r) => {
      if (r.headers.authorization !== `Bearer ${key}`) return { status: 401, json: { code: "Auth.Unauthorized", message: "Authentication required" } };
      if (r.method === "POST" && r.path === "/sandboxes") {
        expect(r.headers["idempotency-key"]).toBeTruthy();
        const b = r.json();
        expect(b).toMatchObject({ template_id: "tpl-agent", timeout: 120 });
        return { status: 201, json: { request_id: "req", data: { id: "11111111-2222-4333-8444-555555555555", sandbox_key: "ikey", domain: "sbx.gmi.test", sandbox_access_token: token, template_id: "tpl-agent" } } };
      }
      if (r.method === "GET" && r.path === "/sandboxes/11111111-2222-4333-8444-555555555555") {
        const extra = opts.state?.(polls) ?? {};
        return { json: { request_id: "req", data: { id: "11111111-2222-4333-8444-555555555555", state: polls++ < 1 ? "provisioning" : "running", resources: { vcpu: 2, memory_mb: 4096, disk_mb: 20480 }, ...extra } } };
      }
      if (r.method === "POST" && /^\/sandboxes\/[^/]+\/connect$/.test(r.path)) return { json: { request_id: "req", data: { sandbox_key: "ikey", domain: "sbx.gmi.test", sandbox_access_token: token } } };
      if (r.method === "DELETE" && r.path === "/sandboxes/11111111-2222-4333-8444-555555555555") return { json: { request_id: "req", data: { id: "x", state: "deleted" } } };
      if (r.method === "DELETE") return { status: 404, json: { code: "Resource.NotFound", message: "The requested resource was not found" } };
      return undefined;
    });
    const env = { GMI_SANDBOX_API_KEY: key, GMI_SANDBOX_TEMPLATE: "tpl-agent", GMI_SANDBOX_API_URL: control.url, GMI_SANDBOX_DATA_URL: dataPlane.url };
    return { env, files, control, dataPlane, rotate: (t: string) => (token = t), polls: () => polls };
  }

  it("creates from the template, polls executions on the data plane, moves files, and builds port URLs", async () => {
    const p = await planes();
    const { router } = routerFor(gmiProvider, p.env);
    const sbx = await router.create({ timeoutSec: 120 });
    expect(p.polls()).toBe(2);
    expect(sbx.providerSandboxId).toBe("11111111-2222-4333-8444-555555555555");
    const ok = await sbx.commands.run("echo hi");
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout).toContain("echo hi");
    expect((await sbx.commands.run("exit 3")).exitCode).toBe(3);
    await sbx.files.write("/tmp/a.txt", "hello");
    expect(await sbx.files.read("/tmp/a.txt")).toBe("hello");
    expect(await gmiProvider.getUrl!(sbx.providerSandboxId, 8000, ctx(p.env))).toBe("https://8000-ikey.sbx.gmi.test");
    // Create handed over the data-plane token; connect wasn't needed.
    expect(p.control.seen.filter((s) => s.endsWith("/connect"))).toHaveLength(0);
    await sbx.kill();
    expect(p.control.seen).toContain("DELETE /sandboxes/11111111-2222-4333-8444-555555555555");
  });

  it("connects for a sandbox it didn't create here, and again when the token is re-signed", async () => {
    const p = await planes();
    const env = p.env;
    const r = await gmiProvider.exec("99999999-0000-4000-8000-000000000000", "echo a", {}, ctx(env));
    expect(r.exitCode).toBe(0);
    p.rotate("tok-2");
    expect((await gmiProvider.exec("99999999-0000-4000-8000-000000000000", "echo b", {}, ctx(env))).exitCode).toBe(0);
    expect(p.control.seen.filter((s) => s.endsWith("/connect"))).toHaveLength(2);
    await expect(gmiProvider.kill("not-there", ctx(env))).resolves.toBeUndefined();
  });

  it("reads a billing deletion while starting as quota, and deletes the sandbox", async () => {
    const p = await planes({ state: () => ({ state: "deleting", deletion: { code: "Sandbox.BillingInsufficientBalance", initiator: "billing", message: "Insufficient balance" } }) });
    const { router } = routerFor(gmiProvider, p.env);
    await expect(router.create({ timeoutSec: 120 })).rejects.toMatchObject({ attempts: [expect.objectContaining({ provider: "gmi", kind: "quota" })] });
    expect(p.control.seen).toContain("DELETE /sandboxes/11111111-2222-4333-8444-555555555555");
  });

  it("reads a 429 live quota as a rate limit", async () => {
    const { url } = await mock(() => ({ status: 429, json: { code: "Resource.QuotaExceeded", message: "instances quota exhausted" } }));
    await refused(gmiProvider, { GMI_SANDBOX_API_KEY: key, GMI_SANDBOX_TEMPLATE: "t", GMI_SANDBOX_API_URL: url }, "rate_limit");
  });
});
