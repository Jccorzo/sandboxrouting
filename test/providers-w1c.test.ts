// The REST adapters added on 2026-11-21 (Superserve, EQVPS, Solari, PillDrops, LangSmith, MIOSA),
// driven through the router against local servers that speak each provider's wire format: from
// its OpenAPI spec, its API reference, and the requests its official SDK sends. None has been run
// against the real service.
import { describe, expect, it } from "vitest";
import { fakeRun, lifecycle, mock, routerFor } from "./restmock.js";
import { NoProviderAvailableError, SandboxRouterError, type ProviderAdapter, type SandboxRouter } from "../src/index.js";
import { superserveProvider } from "../src/providers/superserve.js";
import { eqvpsProvider, eqvpsTariff } from "../src/providers/eqvps.js";
import { solariProvider, solariSize } from "../src/providers/solari.js";
import { pilldropsProvider } from "../src/providers/pilldrops.js";
import { langsmithProvider, langsmithSize } from "../src/providers/langsmith.js";
import { miosaProvider, miosaSize } from "../src/providers/miosa.js";

const MiB = 1024 * 1024;

/** A create refused by the provider fails the plan with the given kind, and leaves that mark. */
async function refused(router: SandboxRouter, provider: string, kind: string) {
  const err = await router.create({ timeoutSec: 60 }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(NoProviderAvailableError);
  expect((err as NoProviderAvailableError).attempts[0]).toMatchObject({ provider, outcome: "failed", kind });
  expect((await router.ledger.read()).marks.some((m) => m.provider === provider && m.kind === kind)).toBe(true);
}

/** Deleting a sandbox the provider no longer has is not an error. */
async function killsGone(adapter: ProviderAdapter, env: Record<string, string>, status: number) {
  const { url, seen } = await mock((r) => (r.method === "DELETE" ? { status, json: { error: "not found" } } : undefined));
  await expect(adapter.kill("gone-1", { env: { ...env, ...Object.fromEntries(Object.entries(env).filter(([k]) => /URL$/.test(k)).map(([k]) => [k, url])) }, options: {} })).resolves.toBeUndefined();
  expect(seen.some((s) => s.startsWith("DELETE "))).toBe(true);
}

describe("sizes", () => {
  it("maps a request to each provider's sizes", () => {
    expect(eqvpsTariff(2, 4096).tariff).toBe("plus");
    expect(eqvpsTariff(0.5, 512).tariff).toBe("small");
    expect(eqvpsTariff(64, 1).tariff).toBe("max");
    expect(solariSize(2, 1024)).toEqual({ cpu: 2, memoryMiB: 2048 });
    expect(solariSize(20, 99999)).toEqual({ cpu: 8, memoryMiB: 16384 });
    expect(langsmithSize(2, 4096)).toEqual({ vcpus: 2, memBytes: 4096 * MiB });
    expect(langsmithSize(1, 1024)).toEqual({ vcpus: 1, memBytes: 2048 * MiB });
    // 16 GiB needs at least 3 vCPUs at 6 GiB each.
    expect(langsmithSize(1, 16384)).toEqual({ vcpus: 3, memBytes: 16384 * MiB });
    expect(miosaSize(2, 4096).size).toBe("small");
    expect(miosaSize(3, 1024).size).toBe("medium");
    expect(miosaSize(99, 1).size).toBe("xl");
  });
});

describe("superserve", () => {
  const env = (url: string) => ({ SUPERSERVE_API_KEY: "ss_live_test", SUPERSERVE_BASE_URL: url, SUPERSERVE_SANDBOX_URL: url });

  it("ends the sandbox at its timeout, runs commands on the data plane, and mints a token again when refused", async () => {
    const files = new Map<string, Buffer>();
    let polls = 0;
    let token = "tok-1";
    let refuseOnce = false;
    const { url, seen } = await mock((r) => {
      const dataPlane = r.path === "/exec" || r.path === "/files";
      if (dataPlane) {
        expect(r.headers["x-superserve-sandbox-id"]).toBe("ss1");
        if (refuseOnce) {
          refuseOnce = false;
          return { status: 401, json: { error: { code: "unauthorized" } } };
        }
        if (r.headers["x-access-token"] !== token) return { status: 401, json: {} };
      } else if (r.headers["x-api-key"] !== "ss_live_test") return { status: 401, json: {} };
      if (r.method === "POST" && r.path === "/sandboxes") {
        // timeout_seconds pauses; auto_delete_seconds: 0 deletes on that pause.
        expect(r.json()).toMatchObject({ timeout_seconds: 120, auto_delete_seconds: 0, metadata: { "sandboxrouting.id": expect.any(String) } });
        expect(r.json().name).toMatch(/^sbr-/);
        return { status: 201, json: { id: "ss1", status: "starting", access_token: token, vcpu_count: 2, memory_mib: 4096 } };
      }
      if (r.method === "GET" && r.path === "/sandboxes/ss1") return { json: { id: "ss1", status: polls++ < 1 ? "starting" : "active", created_at: new Date().toISOString() } };
      if (r.method === "POST" && r.path === "/sandboxes/ss1/activate") {
        token = "tok-2";
        return { json: { id: "ss1", status: "active", access_token: token } };
      }
      if (r.method === "POST" && r.path === "/exec") {
        const b = r.json();
        expect(b.timeout_s).toBeGreaterThan(30);
        const x = fakeRun(b.command);
        return { json: { stdout: x.stdout, stderr: x.stderr, exit_code: x.code } };
      }
      if (r.path === "/files" && r.method === "POST") return files.set(r.query.get("path")!, r.body), { json: { path: r.query.get("path"), size: r.body.length } };
      if (r.path === "/files" && r.method === "GET") return files.has(r.query.get("path")!) ? { raw: files.get(r.query.get("path")!)! } : { status: 404, json: {} };
      if (r.method === "GET" && r.path === "/sandboxes/ss1/files") return { json: { entries: [{ name: "a.txt", is_dir: false, size: 5, modified_unix: 0 }] } };
      if (r.method === "POST" && r.path === "/sandboxes/ss1/preview-ports") return expect(r.json()).toEqual({ port: 3000, access: "public" }), { json: { port: 3000, access: "public" } };
      if (r.method === "PATCH" && r.path === "/sandboxes/ss1") return { status: 204, raw: "" };
      if (r.method === "POST" && r.path === "/sandboxes/ss1/pause") return { status: 204, raw: "" };
      if (r.method === "POST" && r.path === "/sandboxes/ss1/resume") return { json: { id: "ss1", status: "active", access_token: token } };
      if (r.method === "DELETE" && r.path === "/sandboxes/ss1") return { status: 204, raw: "" };
      return undefined;
    });
    const { router } = routerFor(superserveProvider, env(url));
    await lifecycle(router, { files: true });
    expect(seen.filter((s) => s === "GET /sandboxes/ss1").length).toBeGreaterThanOrEqual(2);

    const sbx = await router.create({ timeoutSec: 120 });
    expect(await sbx.files.list("/home/user")).toEqual([{ name: "a.txt", path: "/home/user/a.txt", isDir: false, size: 5 }]);
    expect(await sbx.getUrl(3000)).toMatch(/^https:\/\/3000-ss1\./);
    // A rotated token is refused once, then minted again through activate.
    refuseOnce = true;
    expect((await sbx.commands.run("echo again")).exitCode).toBe(0);
    expect(seen).toContain("POST /sandboxes/ss1/activate");
    await sbx.setTimeout(600);
    // Pausing first clears the auto-delete, or the pause would delete it.
    await sbx.pause();
    const patchThenPause = seen.slice(seen.lastIndexOf("PATCH /sandboxes/ss1"));
    expect(patchThenPause[1]).toBe("POST /sandboxes/ss1/pause");
    await sbx.kill();
  });

  it("kills a sandbox that fails while starting, treats a missing one as gone, and reads a 402 as spent credit", async () => {
    const { url, seen } = await mock((r) => {
      if (r.method === "POST" && r.path === "/sandboxes") return { status: 201, json: { id: "bad", status: "starting", access_token: "t" } };
      if (r.method === "GET" && r.path === "/sandboxes/bad") return { json: { id: "bad", status: "failed" } };
      if (r.method === "DELETE") return { status: 204, raw: "" };
      return undefined;
    });
    await expect(routerFor(superserveProvider, env(url)).router.create({ timeoutSec: 60 })).rejects.toThrow(/failed/);
    expect(seen).toContain("DELETE /sandboxes/bad");

    await killsGone(superserveProvider, env("x"), 404);

    const broke = await mock(() => ({ status: 402, json: { error: { code: "trial_exhausted", message: "free trial credit is used up" } } }));
    await refused(routerFor(superserveProvider, env(broke.url)).router, "superserve", "quota");
  });

  it("lists live sandboxes and refuses a list it can't read", async () => {
    const good = await mock(() => ({ json: [{ id: "a", status: "active" }, { id: "b", status: "paused" }, { id: "c", status: "failed" }] }));
    const odd = await mock(() => ({ json: { items: [] } }));
    expect(await superserveProvider.listAlive({ env: env(good.url), options: {} })).toEqual(["a", "b"]);
    await expect(superserveProvider.listAlive({ env: env(odd.url), options: {} })).rejects.toThrow(/unexpected response shape/);
  });
});

describe("eqvps", () => {
  const env = (url: string) => ({ EQVPS_API_KEY: "eq_test", EQVPS_API_URL: url });

  it("creates an ephemeral sandbox, polls it ready, runs short commands in place and long ones as tasks", async () => {
    const files = new Map<string, Buffer>();
    const tasks = new Map<string, { cmd: string; polls: number }>();
    let polls = 0;
    const { url, seen } = await mock((r) => {
      if (r.headers.authorization !== "Bearer eq_test") return { status: 401, json: { error: "unauthorized", message: "bad token" } };
      if (r.method === "POST" && r.path === "/sandboxes") {
        expect(r.json()).toMatchObject({ mode: "ephemeral", tariff: "plus", ttl: 120, idle_timeout: 120 });
        return { status: 201, json: { id: "sb_1", state: "starting", ready: false } };
      }
      if (r.method === "GET" && r.path === "/sandboxes/sb_1") return { json: { id: "sb_1", state: polls++ < 1 ? "starting" : "running", ready: polls > 1 } };
      if (r.method === "POST" && r.path === "/sandboxes/sb_1/exec") {
        const b = r.json();
        if (b.async) {
          tasks.set("tk_000000000001", { cmd: b.command, polls: 0 });
          return { status: 202, json: { task_id: "tk_000000000001", state: "running" } };
        }
        expect(b.timeout).toBeLessThanOrEqual(55);
        const x = fakeRun(b.command);
        return { json: { exit_code: x.code, stdout: x.stdout, stderr: x.stderr, timed_out: false } };
      }
      const task = /^\/sandboxes\/sb_1\/tasks\/(tk_\w+)$/.exec(r.path);
      if (r.method === "GET" && task) {
        const t = tasks.get(task[1]!)!;
        const x = fakeRun(t.cmd);
        // Output arrives in two polls; offsets ask only for what is new.
        if (t.polls++ === 0) return { json: { task_id: task[1], state: "running", done: false, stdout: x.stdout.slice(0, 3), stdout_next_offset: 3, stderr: "", stderr_next_offset: 0 } };
        expect(r.query.get("stdout_offset")).toBe("3");
        return { json: { task_id: task[1], state: "done", done: true, exit_code: x.code, stdout: x.stdout.slice(3), stdout_next_offset: x.stdout.length, stderr: x.stderr, stderr_next_offset: x.stderr.length } };
      }
      if (r.method === "PUT" && r.path === "/sandboxes/sb_1/files") return files.set(r.json().path, Buffer.from(r.json().content_base64, "base64")), { json: { path: r.json().path } };
      if (r.method === "GET" && r.path === "/sandboxes/sb_1/files") return { json: { path: r.query.get("path"), content_base64: files.get(r.query.get("path")!)?.toString("base64") ?? "" } };
      if (r.method === "DELETE" && r.path === "/sandboxes/sb_1") return { json: { id: "sb_1", deleted: true } };
      return undefined;
    });
    const { router } = routerFor(eqvpsProvider, env(url));
    const sbx = await router.create({ timeoutSec: 120 });
    expect(seen.filter((s) => s === "GET /sandboxes/sb_1").length).toBe(2);
    const quick = await sbx.commands.run("echo hi", { timeoutSec: 30 });
    expect(quick).toMatchObject({ exitCode: 0, stdout: "ran: echo hi\n" });
    const long = await sbx.commands.run("echo long");
    expect(long).toMatchObject({ exitCode: 0, stdout: "ran: echo long\n" });
    expect((await sbx.commands.run("exit 3")).exitCode).toBe(3);
    await sbx.files.write("/tmp/a.txt", "hello");
    expect(await sbx.files.read("/tmp/a.txt")).toBe("hello");
    await sbx.kill();
    expect(seen).toContain("DELETE /sandboxes/sb_1");
  });

  it("reads the spending cap as spent credit and an empty balance the same way; a deleted sandbox is gone", async () => {
    const capped = await mock(() => ({ status: 429, json: { error: "budget_exceeded", message: "daily spending cap reached", reason: "daily", limit_usd: 5, spent_usd: 5 } }));
    await refused(routerFor(eqvpsProvider, env(capped.url)).router, "eqvps", "quota");
    const empty = await mock(() => ({ status: 402, json: { error: "insufficient_balance", message: "top up your balance" } }));
    await refused(routerFor(eqvpsProvider, env(empty.url)).router, "eqvps", "quota");
    const busy = await mock(() => ({ status: 429, json: { error: "sandbox_limit", message: "20 sandboxes at once" } }));
    await refused(routerFor(eqvpsProvider, env(busy.url)).router, "eqvps", "rate_limit");
    await killsGone(eqvpsProvider, env("x"), 404);
    await killsGone(eqvpsProvider, env("x"), 410);
  });

  it("hands files over 5 MiB to the exec fallback", async () => {
    const { url } = await mock(() => ({ status: 413, json: { error: "file_too_large", message: "over 5 MB" } }));
    const err = await eqvpsProvider.readFile!("sb_1", "/tmp/big", { env: env(url), options: {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SandboxRouterError);
    expect((err as SandboxRouterError).kind).toBe("unsupported");
  });
});

describe("solari", () => {
  const env = (url: string) => ({ SOLARI_API_KEY: "slr_live_test", SOLARI_BASE_URL: url });

  it("creates with an idempotency key, runs commands through sh -c, and moves files over signed URLs", async () => {
    const files = new Map<string, Buffer>();
    const { url, seen } = await mock((r) => {
      // The signed file URLs carry their own token and no Authorization header.
      if (r.path.startsWith("/files/")) {
        expect(r.headers.authorization).toBeUndefined();
        const path = r.query.get("token")!;
        if (r.method === "PUT") return files.set(path, r.body), { json: { ok: true, path, bytes: r.body.length } };
        return files.has(path) ? { raw: files.get(path)! } : { status: 404, json: { error: "not found" } };
      }
      if (r.headers.authorization !== "Bearer slr_live_test") return { status: 401, json: { error: "Unauthorized" } };
      if (r.method === "POST" && r.path === "/sandboxes") {
        expect(r.headers["idempotency-key"]).toBeTruthy();
        expect(r.json()).toMatchObject({ kind: "sandbox", template: "base", isolation: "dedicated", cpu: 2, memMb: 2048, timeoutMs: 120_000, lifecycle: { onTimeout: "kill" } });
        return { status: 201, json: { sandboxId: "AgOD_x1", kind: "sandbox", controlUrl: "wss://x/control/AgOD_x1", cpu: 2, memMb: 2048 } };
      }
      if (r.method === "POST" && r.path === "/sandboxes/AgOD_x1/exec") {
        const b = r.json();
        expect(b.cmd).toBe("sh");
        expect(b.timeoutMs).toBeLessThanOrEqual(600_000);
        const x = fakeRun(b.args[1]);
        return { json: { exitCode: x.code, stdout: x.stdout, stderr: x.stderr } };
      }
      if (r.method === "GET" && r.path === "/sandboxes/AgOD_x1/files/download-url") return { json: { url: `${url}/files/download?token=${encodeURIComponent(r.query.get("path")!)}` } };
      if (r.method === "GET" && r.path === "/sandboxes/AgOD_x1/files/upload-url") return { json: { url: `${url}/files/upload?token=${encodeURIComponent(r.query.get("path")!)}` } };
      if (r.method === "GET" && r.path === "/sandboxes/AgOD_x1/ports/3000") return { json: { url: "https://abc-3000.preview.getsolari.com/?slr_token=t", token: "t" } };
      if (r.method === "POST" && r.path === "/sandboxes/AgOD_x1/timeout") return expect(r.json()).toEqual({ timeoutMs: 600_000 }), { json: { expiresAt: "2026-11-21T13:00:00Z" } };
      if (r.method === "POST" && r.path === "/sandboxes/AgOD_x1/pause") return { json: { state: "paused" } };
      if (r.method === "POST" && r.path === "/sandboxes/AgOD_x1/resume") return { json: { state: "running", controlUrl: "wss://x" } };
      if (r.method === "DELETE" && r.path === "/sandboxes/AgOD_x1") return { json: { ok: true } };
      return undefined;
    });
    const { router } = routerFor(solariProvider, env(url));
    await lifecycle(router, { files: true });
    const sbx = await router.create({ timeoutSec: 120 });
    expect(await sbx.getUrl(3000)).toContain("abc-3000.preview.getsolari.com");
    await sbx.setTimeout(600);
    await sbx.pause();
    await sbx.resume();
    expect(seen).toContain("POST /sandboxes/AgOD_x1/resume");
    await sbx.kill();
  });

  it("reports a command past its deadline as exit 124, and reads InsufficientCredit as spent credit", async () => {
    const { url } = await mock(() => ({ json: { exitCode: -1, stdout: "", stderr: "", timedOut: true } }));
    expect((await solariProvider.exec("x", "sleep 999", { timeoutSec: 5 }, { env: env(url), options: {} })).exitCode).toBe(124);
    const broke = await mock(() => ({ status: 402, json: { code: "InsufficientCredit", error: "Admission rejected on prepaid balance" } }));
    await refused(routerFor(solariProvider, env(broke.url)).router, "solari", "quota");
    const full = await mock(() => ({ status: 429, json: { code: "ConcurrencyLimitExceeded", error: "Concurrent session limit reached (1)", plan: "free", cap: 1 } }));
    await refused(routerFor(solariProvider, env(full.url)).router, "solari", "rate_limit");
    await killsGone(solariProvider, env("x"), 404);
  });

  it("lists sandboxes page by page, leaving released ones out", async () => {
    const { url } = await mock((r) =>
      r.query.get("cursor")
        ? { json: { sandboxes: [{ sandboxId: "c", state: "paused" }] } }
        : { json: { sandboxes: [{ sandboxId: "a", state: "running" }, { sandboxId: "b", state: "gone" }], nextCursor: "n1" } },
    );
    expect(await solariProvider.listAlive({ env: env(url), options: {} })).toEqual(["a", "c"]);
  });
});

describe("pilldrops", () => {
  const env = (url: string) => ({ PILLDROPS_API_KEY: "pd_test", PILLDROPS_API_URL: url });

  it("creates with env as NAME=VALUE strings, waits for running, and writes raw file bytes", async () => {
    const files = new Map<string, Buffer>();
    let polls = 0;
    const { url, seen } = await mock((r) => {
      if (r.headers.authorization !== "Bearer pd_test") return { status: 401, json: { error: "authentication required", code: "unauthorized" } };
      if (r.method === "POST" && r.path === "/v1/sandboxes") {
        expect(r.headers["idempotency-key"]).toBeTruthy();
        expect(r.json()).toMatchObject({ template: "python-3.11", timeout: 120, vcpu: 2, memory_mb: 2048, env: ["A=1"] });
        return { status: 201, json: { id: "pd1", status: "pending" } };
      }
      if (r.method === "GET" && r.path === "/v1/sandboxes/pd1") return { json: { id: "pd1", status: polls++ < 1 ? "pending" : "running" } };
      if (r.method === "POST" && r.path === "/v1/sandboxes/pd1/exec") {
        const b = r.json();
        expect(b.timeout).toBeLessThanOrEqual(600);
        const x = fakeRun(b.cmd);
        return { json: { stdout: x.stdout, stderr: x.stderr, exit_code: x.code, truncated: false } };
      }
      if (r.path === "/v1/sandboxes/pd1/files" && r.method === "POST") return files.set(r.query.get("path")!, r.body), { json: {} };
      if (r.path === "/v1/sandboxes/pd1/files" && r.method === "GET") return { raw: files.get(r.query.get("path")!) ?? "" };
      if (r.method === "POST" && r.path === "/v1/sandboxes/pd1/timeout") return expect(r.json()).toEqual({ seconds: 600 }), { json: { status: "ok" } };
      if (r.method === "POST" && r.path === "/v1/sandboxes/pd1/pause") return { json: { status: "paused", paused_ms: 10 } };
      if (r.method === "POST" && r.path === "/v1/sandboxes/pd1/resume") return { json: { status: "running", resume_ms: 10 } };
      if (r.method === "DELETE" && r.path === "/v1/sandboxes/pd1") return { json: { status: "destroyed" } };
      return undefined;
    });
    const { router } = routerFor(pilldropsProvider, env(url));
    const sbx = await router.create({ timeoutSec: 120, env: { A: "1" } });
    expect(seen.filter((s) => s === "GET /v1/sandboxes/pd1").length).toBe(2);
    expect((await sbx.commands.run("echo hi")).stdout).toBe("ran: echo hi\n");
    expect((await sbx.commands.run("exit 3")).exitCode).toBe(3);
    await sbx.files.write("/root/a.txt", "hello");
    expect(await sbx.files.read("/root/a.txt")).toBe("hello");
    await sbx.setTimeout(600);
    await sbx.pause();
    await sbx.resume();
    await sbx.kill();
    expect(seen).toContain("DELETE /v1/sandboxes/pd1");
  });

  it("hands a path outside the sandbox home to the exec fallback, and reads a 402 as spent credit", async () => {
    const { url } = await mock(() => ({ status: 400, json: { error: "invalid path: file paths are taken relative to the sandbox home", code: "bad_request" } }));
    const err = await pilldropsProvider.writeFile!("pd1", "/etc/x", new Uint8Array([1]), { env: env(url), options: {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SandboxRouterError);
    expect((err as SandboxRouterError).kind).toBe("unsupported");

    const broke = await mock(() => ({ status: 402, json: { error: "credit exhausted", code: "payment_required" } }));
    await refused(routerFor(pilldropsProvider, env(broke.url)).router, "pilldrops", "quota");
    await killsGone(pilldropsProvider, env("x"), 404);
  });

  it("kills a sandbox that fails to start", async () => {
    const { url, seen } = await mock((r) => {
      if (r.method === "POST" && r.path === "/v1/sandboxes") return { status: 201, json: { id: "pd2", status: "pending" } };
      if (r.method === "GET") return { json: { id: "pd2", status: "failed" } };
      if (r.method === "DELETE") return { json: { status: "destroyed" } };
      return undefined;
    });
    await expect(routerFor(pilldropsProvider, env(url)).router.create({ timeoutSec: 60 })).rejects.toThrow(/failed/);
    expect(seen).toContain("DELETE /v1/sandboxes/pd2");
  });
});

describe("langsmith", () => {
  const env = (url: string) => ({ LANGSMITH_API_KEY: "lsv2_test", LANGSMITH_ENDPOINT: `${url}/api/v1` });

  it("creates by name, polls its status, and runs commands and files on the sandbox's data plane", async () => {
    const files = new Map<string, Buffer>();
    let polls = 0;
    let name = "";
    const { url, seen } = await mock((r) => {
      if (r.headers["x-api-key"] !== "lsv2_test") return { status: 401, json: { detail: { error: "Unauthorized", message: "bad key" } } };
      if (r.method === "POST" && r.path === "/api/v2/sandboxes/boxes") {
        const b = r.json();
        name = b.name;
        expect(name).toMatch(/^sbr-/);
        // TTLs are whole minutes; memory is in bytes.
        expect(b).toMatchObject({ wait_for_ready: false, vcpus: 2, mem_bytes: 4096 * MiB, persistent: false, idle_ttl_seconds: 120, delete_after_stop_seconds: 60 });
        return { status: 201, json: { id: "uuid-1", name, status: "provisioning", dataplane_url: `${url}/dp/${name}` } };
      }
      if (r.method === "GET" && r.path === `/api/v2/sandboxes/boxes/${name}/status`) return { json: { status: polls++ < 1 ? "provisioning" : "ready" } };
      if (r.method === "POST" && r.path === `/dp/${name}/execute`) {
        const b = r.json();
        expect(b.shell).toBe("/bin/bash");
        const x = fakeRun(b.command);
        return { json: { exit_code: x.code, stdout: x.stdout, stderr: x.stderr } };
      }
      if (r.method === "POST" && r.path === `/dp/${name}/upload`) {
        expect(String(r.headers["content-type"])).toMatch(/multipart\/form-data/);
        const raw = r.body.toString("latin1");
        const body = raw.slice(raw.indexOf("\r\n\r\n") + 4, raw.lastIndexOf("\r\n--"));
        return files.set(r.query.get("path")!, Buffer.from(body, "latin1")), { json: {} };
      }
      if (r.method === "GET" && r.path === `/dp/${name}/download`) return { raw: files.get(r.query.get("path")!) ?? "" };
      if (r.method === "PATCH" && r.path === `/api/v2/sandboxes/boxes/${name}`) return expect(r.json()).toEqual({ idle_ttl_seconds: 600 }), { json: { name } };
      if (r.method === "DELETE" && r.path === `/api/v2/sandboxes/boxes/${name}`) return { status: 204, raw: "" };
      return undefined;
    });
    const { router } = routerFor(langsmithProvider, env(url));
    const sbx = await lifecycle(router, { files: true });
    expect(sbx.providerSandboxId).toMatch(/^sbr-/);
    expect(seen.filter((s) => s.endsWith("/status")).length).toBe(2);
    const again = await router.create({ timeoutSec: 120 });
    await again.setTimeout(600);
    await again.kill();
  });

  it("adopts the sandbox a retried create already made, and reports a command past the request deadline as exit 124", async () => {
    const { url, seen } = await mock((r) => {
      if (r.method === "POST" && r.path === "/api/v2/sandboxes/boxes") return { status: 409, json: { detail: { error: "Conflict", message: "Name already exists" } } };
      if (r.method === "GET" && /^\/api\/v2\/sandboxes\/boxes\/sbr-[0-9a-f]+$/.test(r.path)) return { json: { name: r.path.split("/").pop(), status: "ready", dataplane_url: `${url}/dp` } };
      if (r.method === "POST" && r.path === "/dp/execute") return { status: 422, json: { detail: { error: "Timeout", message: "Synchronous execution exceeded the request deadline" } } };
      return undefined;
    });
    const sbx = await routerFor(langsmithProvider, env(url)).router.create({ timeoutSec: 60 });
    expect(seen.filter((s) => s.startsWith("POST /api/v2/sandboxes/boxes")).length).toBe(1);
    expect((await sbx.commands.run("sleep 9999")).exitCode).toBe(124);
  });

  it("reads a 429 as the workspace's sandbox limit, not spent credit, and treats a missing sandbox as gone", async () => {
    const full = await mock(() => ({ status: 429, json: { detail: { error: "QuotaExceeded", message: "Quota exceeded: sandbox count limit reached" } } }));
    await refused(routerFor(langsmithProvider, env(full.url)).router, "langsmith", "rate_limit");
    const gone = await mock((r) => (r.method === "DELETE" ? { status: 404, json: { detail: "Not Found" } } : undefined));
    await expect(langsmithProvider.kill("sbr-gone", { env: env(gone.url), options: {} })).resolves.toBeUndefined();
  });

  it("lists only its own sandboxes, page by page", async () => {
    const { url } = await mock((r) =>
      r.query.get("cursor")
        ? { json: { items: [{ name: "sbr-c", status: "stopped" }], next_cursor: null } }
        : { json: { items: [{ name: "sbr-a", status: "ready" }, { name: "other", status: "ready" }, { name: "sbr-b", status: "failed" }], next_cursor: "n1" } },
    );
    expect(await langsmithProvider.listAlive({ env: env(url), options: {} })).toEqual(["sbr-a", "sbr-c"]);
  });
});

describe("miosa", () => {
  const env = (url: string) => ({ MIOSA_API_KEY: "msk_u_test", MIOSA_API_URL: url });

  it("creates a non-persistent sandbox with the idle stop off, unwraps data envelopes, and exposes ports", async () => {
    let polls = 0;
    const { url, seen } = await mock((r) => {
      if (r.headers.authorization !== "Bearer msk_u_test") return { status: 401, json: { error: { code: "UNAUTHORIZED", message: "invalid token" } } };
      if (r.method === "POST" && r.path === "/sandboxes") {
        expect(r.headers["idempotency-key"]).toBeTruthy();
        expect(r.json()).toMatchObject({ size: "small", persistent: false, timeout_sec: 120, idle_timeout_sec: 0 });
        return { status: 201, json: { data: { id: "mi-1", state: "creating", ready: false } } };
      }
      if (r.method === "GET" && r.path === "/sandboxes/mi-1") return { json: { data: { id: "mi-1", state: polls++ < 1 ? "creating" : "running", ready: polls > 1, cpu_count: 2, memory_mb: 4096 } } };
      if (r.method === "POST" && r.path === "/sandboxes/mi-1/exec") {
        const b = r.json();
        expect(b.timeout).toBeGreaterThan(0);
        const x = fakeRun(b.command);
        return { json: { data: { exit_code: x.code, stdout: x.stdout, stderr: x.stderr, sandbox_id: "mi-1" } } };
      }
      if (r.method === "POST" && r.path === "/sandboxes/mi-1/expose") return { json: { url: `https://${r.json().port}-mi1.sandbox.miosa.app` } };
      if (r.method === "POST" && r.path === "/sandboxes/mi-1/extend") return expect(r.json()).toEqual({ timeout_sec: 600 }), { json: { data: { id: "mi-1" } } };
      if (r.method === "DELETE" && r.path === "/sandboxes/mi-1") return { json: { id: "mi-1", state: "destroyed" } };
      return undefined;
    });
    const { router } = routerFor(miosaProvider, env(url));
    await lifecycle(router);
    expect(seen.filter((s) => s === "GET /sandboxes/mi-1").length).toBe(2);
    const sbx = await router.create({ timeoutSec: 120 });
    expect(await sbx.getUrl(5173)).toBe("https://5173-mi1.sandbox.miosa.app");
    await sbx.setTimeout(600);
    await sbx.kill();
  });

  it("kills a sandbox that errors while starting, treats a missing one as gone, and reads a 401 as a bad key", async () => {
    const { url, seen } = await mock((r) => {
      if (r.method === "POST" && r.path === "/sandboxes") return { status: 201, json: { id: "mi-2", state: "creating" } };
      if (r.method === "GET") return { json: { id: "mi-2", state: "error" } };
      if (r.method === "DELETE") return { json: { id: "mi-2", state: "destroyed" } };
      return undefined;
    });
    await expect(routerFor(miosaProvider, env(url)).router.create({ timeoutSec: 60 })).rejects.toThrow(/error/);
    expect(seen).toContain("DELETE /sandboxes/mi-2");
    await killsGone(miosaProvider, env("x"), 404);
    const bad = await mock(() => ({ status: 401, json: { error: { code: "UNAUTHORIZED", message: "invalid token" } } }));
    await refused(routerFor(miosaProvider, env(bad.url)).router, "miosa", "auth");
  });

  it("lists live sandboxes across pages", async () => {
    const { url } = await mock((r) => {
      const page = Number(r.query.get("page"));
      const rows = page === 1 ? Array.from({ length: 100 }, (_, i) => ({ id: `s${i}`, state: i === 0 ? "destroyed" : "running" })) : [{ id: "last", state: "paused" }];
      return { json: { data: rows, page: { page, page_size: 100, total: 101 } } };
    });
    const ids = await miosaProvider.listAlive({ env: env(url), options: {} });
    expect(ids).toHaveLength(100);
    expect(ids).toContain("last");
    expect(ids).not.toContain("s0");
  });
});
