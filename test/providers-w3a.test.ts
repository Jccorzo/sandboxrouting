// The adapters added on 2026-11-21 in wave 3 (Vers, Oblien, Runta, StateSet Sandbox, Sandbox as
// a Service, Sandbox0, Watasu Sandboxes), driven through the router against local servers that
// speak each provider's wire format, from its OpenAPI spec, docs or official SDK. Runta's and
// Watasu's commands go through their SDKs (a WebSocket), mocked here. None has been run against
// the real service.
import { describe, expect, it, vi } from "vitest";
import { fakeRun, lifecycle, mock, routerFor, deletedAtDeadline } from "./restmock.js";
import type { ProviderAdapter } from "../src/index.js";
import { versProvider } from "../src/providers/vers.js";
import { oblienProvider } from "../src/providers/oblien.js";
import { runtaProvider } from "../src/providers/runta.js";
import { statesetProvider, statesetResources } from "../src/providers/stateset.js";
import { saasSandboxProvider, saasSize } from "../src/providers/saas-sandbox.js";
import { sandbox0Provider } from "../src/providers/sandbox0.js";
import { watasuProvider } from "../src/providers/watasu.js";

const ctx = (env: Record<string, string>) => ({ env, options: { pollMs: 1 } });

/** A create the provider refuses fails over with `kind`. */
async function refused(adapter: ProviderAdapter, env: Record<string, string>, kind: string) {
  const { router } = routerFor(adapter, env);
  await expect(router.create({ timeoutSec: 60 })).rejects.toMatchObject({ attempts: [expect.objectContaining({ provider: adapter.info.id, outcome: "failed", kind })] });
}

// The SDK sockets, as each SDK exposes them: commands echo, `exit N` exits N.
const sdk = vi.hoisted(() => {
  const calls: { op: string; args: unknown[] }[] = [];
  const run = (cmd: string) => {
    const m = /exit (\d+)/.exec(cmd);
    return m ? { stdout: "", stderr: "boom\n", code: Number(m[1]) } : { stdout: `ran: ${cmd}\n`, stderr: "", code: 0 };
  };
  class Runta {
    constructor(public config: unknown) {
      calls.push({ op: "runta.new", args: [config] });
    }
    runtimes = {
      get: async (id: string) => ({
        exec: async (command: string[], options: unknown) => {
          calls.push({ op: "runta.exec", args: [id, command, options] });
          const r = run(command.join(" "));
          return { exitCode: r.code, stdout: r.stdout, stderr: r.stderr };
        },
      }),
    };
    async close() {}
  }
  const Sandbox = {
    async connect(id: string, opts: unknown) {
      calls.push({ op: "watasu.connect", args: [id, opts] });
      return {
        commands: {
          async run(cmd: string, opts: unknown) {
            calls.push({ op: "watasu.run", args: [id, cmd, opts] });
            const r = run(cmd);
            if (r.code) throw Object.assign(new Error(`Command exited with code ${r.code}`), { name: "CommandExitError", exitCode: r.code, stdout: r.stdout, stderr: r.stderr });
            return { exitCode: 0, stdout: r.stdout, stderr: r.stderr };
          },
        },
      };
    },
  };
  return { calls, Runta, Sandbox };
});
vi.mock("@runta/runta-sdk", () => ({ Runta: sdk.Runta }));
vi.mock("@watasu/sdk", () => ({ Sandbox: sdk.Sandbox }));

describe("sizes", () => {
  it("maps a request to each provider's sizes", () => {
    expect(saasSize(2, 4096).size).toBe("small");
    expect(saasSize(1, 6000).size).toBe("medium");
    expect(saasSize(16, 1).size).toBe("large");
    expect(statesetResources(2, 4096)).toEqual({ cpus: "2", memory: "4096Mi" });
    expect(statesetResources(0.1, 64)).toEqual({ cpus: "0.25", memory: "128Mi" });
  });
});

describe("vers", () => {
  it("creates a root VM, polls until running, runs commands, moves files and sleeps it", async () => {
    const files = new Map<string, string>();
    let polls = 0;
    let state: string | undefined;
    const { url, seen } = await mock((r) => {
      if (r.headers.authorization !== "Bearer vk_test") return { status: 401, json: { error: "unauthorized" } };
      if (r.method === "POST" && r.path === "/api/v1/vm/new_root") {
        expect(r.query.get("wait_boot")).toBe("true");
        expect(r.json().vm_config).toMatchObject({ vcpu_count: 2, mem_size_mib: 4096 });
        expect(r.json().vm_config.labels["sandboxrouting.id"]).toBeTruthy();
        return { json: { vm_id: "vm-1" } };
      }
      if (r.method === "GET" && r.path === "/api/v1/vm/vm-1/metadata") return { json: { vm_id: "vm-1", state: polls++ < 1 ? "booting" : "running", ip: "10.0.0.2" } };
      if (r.method === "POST" && r.path === "/api/v1/vm/vm-1/exec") {
        const b = r.json();
        expect(b.command.slice(0, 2)).toEqual(["sh", "-c"]);
        const x = fakeRun(b.command[2]);
        return { json: { exit_code: x.code, stdout: x.stdout, stderr: x.stderr } };
      }
      if (r.method === "PUT" && r.path === "/api/v1/vm/vm-1/files") return files.set(r.json().path, r.json().content_b64), { json: {} };
      if (r.method === "GET" && r.path === "/api/v1/vm/vm-1/files") return { json: { content_b64: files.get(r.query.get("path")!) ?? "" } };
      if (r.method === "PATCH" && r.path === "/api/v1/vm/vm-1/state") return (state = r.json().state), { json: {} };
      if (r.method === "DELETE" && r.path === "/api/v1/vm/vm-1") return { json: { vm_id: "vm-1" } };
      if (r.method === "DELETE") return { status: 404, json: { error: "vm not found" } };
      return undefined;
    });
    const env = { VERS_API_KEY: "vk_test", VERS_BASE_URL: url };
    const { router } = routerFor(versProvider, env);
    const sbx = await router.create({ timeoutSec: 120 });
    expect(polls).toBe(2);
    await versProvider.pause!(sbx.providerSandboxId, ctx(env));
    expect(state).toBe("Sleeping");
    await sbx.kill();
    await lifecycle(router, { files: true });
    expect(seen).toContain("DELETE /api/v1/vm/vm-1");
    await expect(versProvider.kill("vm-gone", ctx(env))).resolves.toBeUndefined();
  });

  it("has no TTL, so the sweep deletes a VM at its deadline", async () => {
    const { url, seen } = await mock((r) => {
      if (r.path === "/api/v1/vm/new_root") return { json: { vm_id: "vm-2" } };
      if (r.path === "/api/v1/vm/vm-2/metadata") return { json: { vm_id: "vm-2", state: "running" } };
      if (r.method === "DELETE") return { json: { vm_id: "vm-2" } };
      return undefined;
    });
    const { router, clock } = routerFor(versProvider, { VERS_API_KEY: "k", VERS_BASE_URL: url });
    await deletedAtDeadline(router, clock, seen, (id) => `DELETE /api/v1/vm/${id}`);
  });

  it("deletes a VM that died while booting", async () => {
    const { url, seen } = await mock((r) => {
      if (r.path === "/api/v1/vm/new_root") return { json: { vm_id: "vm-3" } };
      if (r.path === "/api/v1/vm/vm-3/metadata") return { json: { vm_id: "vm-3", state: "dead" } };
      if (r.method === "DELETE") return { json: { vm_id: "vm-3" } };
      return undefined;
    });
    const { router } = routerFor(versProvider, { VERS_API_KEY: "k", VERS_BASE_URL: url });
    await expect(router.create({})).rejects.toThrow(/dead/);
    expect(seen).toContain("DELETE /api/v1/vm/vm-3");
  });

  it("is refused out of credit with a quota mark", async () => {
    const { url } = await mock(() => ({ status: 402, json: { error: "insufficient balance" } }));
    await refused(versProvider, { VERS_API_KEY: "k", VERS_BASE_URL: url }, "quota");
  });
});

describe("oblien", () => {
  it("creates a temporary VM, waits for provisioning, enables its runtime and runs commands through the gateway", async () => {
    let polls = 0;
    let enabled = 0;
    const { url, seen } = await mock((r) => {
      if (r.path.startsWith("/v1/") || r.path.startsWith("/v2/")) {
        if (r.headers["x-client-id"] !== "cid" || r.headers["x-client-secret"] !== "secret") return { status: 401, json: { success: false, code: "MISSING_USER_ID" } };
      }
      if (r.method === "POST" && r.path === "/v1/vms") {
        expect(r.headers["idempotency-key"]).toBeTruthy();
        const b = r.json();
        expect(b).toMatchObject({ mode: "temporary", wait_ready: false, config: { cpus: 2, memory_mb: 4096, ttl: "120s", ttl_action: "remove" } });
        return { status: 202, json: { success: true, vm: { id: "ws_1", resources: { cpus: 2, memory_mb: 4096 } }, ready: false, provisioning: { state: "queued" } } };
      }
      if (r.method === "GET" && r.path === "/v1/vms/ws_1") return { json: { success: true, vm: { id: "ws_1", provisioning: { state: polls++ < 1 ? "running" : "ready" }, info: { status: "running" } } } };
      if (r.method === "POST" && r.path === "/v2/vms/ws_1/runtime-api-access/enable") return enabled++, { json: { success: true, enabled: true, token: "jwt-1", expires_at: new Date(Date.now() + 300_000).toISOString() } };
      if (r.method === "POST" && r.path === "/exec") {
        expect(r.headers.authorization).toBe("Bearer jwt-1");
        const b = r.json();
        expect(b.exec_mode).toBe("shell");
        const x = fakeRun(b.cmd[0]);
        return { json: { id: "t1", status: "exited", exit_code: x.code, stdout: x.stdout, stderr: x.stderr } };
      }
      if (r.method === "GET" && r.path === "/files") return { json: { success: true, entries: [{ name: "a.txt", path: "/tmp/a.txt", type: "file", size: 5 }, { name: "d", path: "/tmp/d", type: "directory" }] } };
      if (r.method === "DELETE" && r.path === "/v1/vms/ws_1") return { json: { success: true, message: "VM deleted" } };
      if (r.method === "DELETE") return { status: 404, json: { success: false, code: "not_found" } };
      return undefined;
    });
    const env = { OBLIEN_CLIENT_ID: "cid", OBLIEN_CLIENT_SECRET: "secret", OBLIEN_API_URL: url, OBLIEN_RUNTIME_URL: url };
    const { router } = routerFor(oblienProvider, env);
    const sbx = await router.create({ timeoutSec: 120 });
    expect(polls).toBe(2);
    expect(enabled).toBe(1);
    expect(await oblienProvider.listFiles!(sbx.providerSandboxId, "/tmp", ctx(env))).toEqual([
      { name: "a.txt", path: "/tmp/a.txt", isDir: false, size: 5 },
      { name: "d", path: "/tmp/d", isDir: true, size: undefined },
    ]);
    await sbx.kill();
    await lifecycle(router);
    expect(seen).toContain("DELETE /v1/vms/ws_1");
    await expect(oblienProvider.kill("ws_gone", ctx(env))).resolves.toBeUndefined();
  });

  it("deletes a VM whose provisioning failed", async () => {
    const { url, seen } = await mock((r) => {
      if (r.method === "POST" && r.path === "/v1/vms") return { status: 202, json: { success: true, vm: { id: "ws_2" }, ready: false, provisioning: { state: "queued" } } };
      if (r.method === "GET") return { json: { success: true, vm: { id: "ws_2", provisioning: { state: "failed", error: "no capacity" } } } };
      if (r.method === "DELETE") return { json: { success: true } };
      return undefined;
    });
    const { router } = routerFor(oblienProvider, { OBLIEN_CLIENT_ID: "c", OBLIEN_CLIENT_SECRET: "s", OBLIEN_API_URL: url });
    await expect(router.create({})).rejects.toThrow(/no capacity/);
    expect(seen).toContain("DELETE /v1/vms/ws_2");
  });

  it("reads its plan's VM limit as a rate limit, not spent credit", async () => {
    const { url } = await mock(() => ({ status: 402, json: { success: false, error: "SANDBOX_LIMIT_REACHED", code: "SANDBOX_LIMIT_REACHED", message: "Maximum VM count for your plan" } }));
    await refused(oblienProvider, { OBLIEN_CLIENT_ID: "c", OBLIEN_CLIENT_SECRET: "s", OBLIEN_API_URL: url }, "rate_limit");
  });
});

describe("runta", () => {
  it("creates over REST, runs commands through the SDK, moves files and deletes with the current revision", async () => {
    const files = new Map<string, Buffer>();
    let polls = 0;
    let revision = 1;
    const { url, seen } = await mock((r) => {
      if (r.headers.authorization !== "Bearer rk_test") return { status: 401, json: { error: { code: "unauthenticated", message: "no" }, request_id: "x" } };
      if (r.method === "POST" && r.path === "/v2/runtimes") {
        expect(r.headers["idempotency-key"]).toBeTruthy();
        expect(r.json()).toMatchObject({ resources: { requests: { vcpus: 2, memory_mib: 4096 } }, auto_shutdown_policy: { mode: "enabled", after_seconds: 120 }, auto_delete_policy: { mode: "enabled" } });
        return { status: 201, json: { data: { id: "rt-1", status: "creating", revision } } };
      }
      if (r.method === "GET" && r.path === "/v2/runtimes/rt-1") return { json: { data: { id: "rt-1", status: polls++ < 1 ? "creating" : "running", revision } } };
      if (r.path === "/v2/runtimes/rt-1/files" && r.method === "PUT") return files.set(r.query.get("path")!, r.body), { status: 204, raw: "" };
      if (r.path === "/v2/runtimes/rt-1/files" && r.method === "GET") return { raw: files.get(r.query.get("path")!) ?? "" };
      if (r.method === "DELETE" && r.path === "/v2/runtimes/rt-1") {
        // The first delete carries a revision someone else just moved past.
        if (Number(r.query.get("expected_revision")) !== revision) return { status: 409, json: { error: { code: "failed_precondition", message: "stale revision" }, request_id: "x" } };
        if (revision === 1) return revision++, { status: 409, json: { error: { code: "failed_precondition", message: "stale revision" }, request_id: "x" } };
        return { status: 202, json: { data: { id: "rt-1", status: "deleting", revision: revision + 1 } } };
      }
      if (r.method === "GET") return { status: 404, json: { error: { code: "not_found", message: "no runtime" }, request_id: "x" } };
      return undefined;
    });
    const env = { RUNTA_API_KEY: "rk_test", RUNTA_API_URL: url };
    sdk.calls.length = 0;
    const { router } = routerFor(runtaProvider, env);
    await lifecycle(router, { files: true });
    // Two reads while it starts, then one before each delete attempt.
    expect(polls).toBe(4);
    expect(sdk.calls.find((c) => c.op === "runta.new")!.args[0]).toEqual({ token: "rk_test", endpoint: url });
    expect(sdk.calls.find((c) => c.op === "runta.exec")!.args.slice(0, 2)).toEqual(["rt-1", ["sh", "-c", "echo hi"]]);
    expect(seen.filter((s) => s === "DELETE /v2/runtimes/rt-1")).toHaveLength(2);
    await expect(runtaProvider.kill("rt-gone", ctx(env))).resolves.toBeUndefined();
  });

  it("deletes a runtime that crashed while starting", async () => {
    const { url, seen } = await mock((r) => {
      if (r.method === "POST") return { status: 201, json: { data: { id: "rt-2", status: "creating", revision: 3 } } };
      if (r.method === "GET") return { json: { data: { id: "rt-2", status: "crashed", revision: 3, error_message: "kernel panic" } } };
      if (r.method === "DELETE") return { status: 204, raw: "" };
      return undefined;
    });
    const { router } = routerFor(runtaProvider, { RUNTA_API_KEY: "k", RUNTA_API_URL: url });
    await expect(router.create({})).rejects.toThrow(/kernel panic/);
    expect(seen).toContain("DELETE /v2/runtimes/rt-2");
  });

  it("moves the shutdown deadline with the current revision", async () => {
    let patched: unknown;
    const { url } = await mock((r) => {
      if (r.method === "GET") return { json: { data: { id: "rt-3", status: "running", revision: 7 } } };
      if (r.method === "PATCH") return expect(r.query.get("expected_revision")).toBe("7"), (patched = r.json()), { json: { data: { id: "rt-3", status: "running", revision: 8 } } };
      return undefined;
    });
    await runtaProvider.setTimeout!("rt-3", 900, ctx({ RUNTA_API_KEY: "k", RUNTA_API_URL: url }));
    expect(patched).toEqual({ auto_shutdown_policy: { mode: "enabled", after_seconds: 900 } });
  });

  it("reads a blocked tenant as spent credit", async () => {
    const { url } = await mock(() => ({ status: 403, json: { error: { code: "tenant_blocked", message: "Organization is blocked" }, request_id: "x" } }));
    await refused(runtaProvider, { RUNTA_API_KEY: "k", RUNTA_API_URL: url }, "quota");
  });
});

describe("stateset", () => {
  it("creates a dedicated sandbox through the queue, runs commands, moves files and stops it", async () => {
    const files = new Map<string, string>();
    let polled = 0;
    const sandbox = (status: string) => ({ sandbox_id: "ss-1", status, allocated_vcpu: 2, allocated_memory_gib: 4, expires_at: new Date(Date.now() + 120_000).toISOString() });
    const { url, seen } = await mock((r) => {
      if (r.headers.authorization !== "ApiKey sk_test") return { status: 401, json: { error: { code: "UNAUTHORIZED" } } };
      if (r.method === "POST" && r.path === "/api/v1/sandbox/create") {
        expect(r.headers["idempotency-key"]).toBeTruthy();
        expect(r.json()).toMatchObject({ cpus: "2", memory: "4096Mi", resource_class: "dedicated", timeout_seconds: 120 });
        return { status: 202, json: { status: "queued", request_id: "rq-1", estimated_wait_seconds: 1 } };
      }
      if (r.method === "GET" && r.path === "/api/v1/requests/rq-1") return { json: polled++ < 1 ? { status: "queued" } : { status: "completed", response: sandbox("running") } };
      if (r.method === "POST" && r.path === "/api/v1/sandbox/ss-1/execute") {
        const b = r.json();
        expect(b.stream).toBe(false);
        const x = fakeRun(b.command);
        return { json: { exit_code: x.code, stdout: x.stdout, stderr: x.stderr } };
      }
      if (r.method === "POST" && r.path === "/api/v1/sandbox/ss-1/files") {
        for (const f of r.json().files) files.set(f.path, f.content);
        return { json: { success: true, files_written: 1 } };
      }
      if (r.method === "GET" && r.path === "/api/v1/sandbox/ss-1/files") return { json: { path: r.query.get("path"), content: files.get(r.query.get("path")!) ?? "", size: 5 } };
      if (r.method === "POST" && r.path === "/api/v1/sandbox/ss-1/stop") return { json: { success: true } };
      if (r.method === "POST" && r.path.endsWith("/stop")) return { status: 404, json: { error: { code: "SANDBOX_NOT_FOUND" } } };
      return undefined;
    });
    const env = { STATESET_API_KEY: "sk_test", STATESET_BASE_URL: url };
    const { router } = routerFor(statesetProvider, env);
    const sbx = await lifecycle(router, { files: true });
    expect(polled).toBe(2);
    expect(sbx.providerSandboxId).toBe("ss-1");
    expect(seen).toContain("POST /api/v1/sandbox/ss-1/stop");
    await expect(statesetProvider.kill("ss-gone", ctx(env))).resolves.toBeUndefined();
  });

  it("extends by what moves the deadline to now + timeout", async () => {
    let added: number | undefined;
    const { url } = await mock((r) => {
      if (r.method === "GET") return { json: { sandbox_id: "ss-2", status: "running", expires_at: new Date(Date.now() + 100_000).toISOString() } };
      if (r.path.endsWith("/extend")) return (added = r.json().additional_seconds), { json: { sandbox_id: "ss-2", status: "running" } };
      return undefined;
    });
    await statesetProvider.setTimeout!("ss-2", 600, ctx({ STATESET_API_KEY: "k", STATESET_BASE_URL: url }));
    expect(added).toBeGreaterThanOrEqual(500);
    expect(added).toBeLessThanOrEqual(501);
  });

  it("reads its concurrency limit as a rate limit, and spent credit as quota", async () => {
    const busy = await mock(() => ({ status: 429, json: { error: { code: "CONCURRENT_LIMIT", message: "Concurrent limit exceeded for plan quota" } } }));
    await refused(statesetProvider, { STATESET_API_KEY: "k", STATESET_BASE_URL: busy.url }, "rate_limit");
    const broke = await mock(() => ({ status: 402, json: { error: { code: "INSUFFICIENT_CREDITS", message: "Add credits" } } }));
    await refused(statesetProvider, { STATESET_API_KEY: "k", STATESET_BASE_URL: broke.url }, "quota");
  });
});

describe("saas-sandbox", () => {
  it("creates a small sandbox, runs commands, moves files, lists a folder and opens a preview URL", async () => {
    const files = new Map<string, string>();
    let polls = 0;
    const { url, seen } = await mock((r) => {
      if (r.headers.authorization !== "Bearer aas_sk_test") return { status: 401, json: { error: { type: "unauthorized", message: "bad key" } } };
      if (r.method === "POST" && r.path === "/sandboxes") {
        expect(r.headers["idempotency-key"]).toBeTruthy();
        expect(r.json()).toMatchObject({ size: "small", timeout_minutes: 2 });
        return { status: 201, json: { object: "sandbox", id: "sbx_1", status: "provisioning" } };
      }
      if (r.method === "GET" && r.path === "/sandboxes/sbx_1") return { json: { object: "sandbox", id: "sbx_1", status: polls++ < 1 ? "provisioning" : "running" } };
      if (r.method === "POST" && r.path === "/sandboxes/sbx_1/exec") {
        const x = fakeRun(r.json().command);
        return { json: { object: "execution", status: "completed", exit_code: x.code, stdout: x.stdout, stderr: x.stderr } };
      }
      if (r.method === "PUT" && r.path === "/sandboxes/sbx_1/files") {
        expect(r.json().encoding).toBe("base64");
        return files.set(r.json().path, r.json().content), { status: 201, json: { object: "file", path: r.json().path } };
      }
      if (r.method === "GET" && r.path === "/sandboxes/sbx_1/files" && r.query.get("list") === "true") {
        return { json: { object: "list", path: r.query.get("path"), entries: [{ name: "a.txt", type: "file", size_bytes: 5 }, { name: "data", type: "dir", size_bytes: null }], truncated: false } };
      }
      if (r.method === "GET" && r.path === "/sandboxes/sbx_1/files") return { json: { object: "file", path: r.query.get("path"), encoding: "base64", content: files.get(r.query.get("path")!) ?? "" } };
      if (r.method === "POST" && r.path === "/sandboxes/sbx_1/ports") return { status: 201, json: { object: "port", port: r.json().port, url: "https://preview.example/tok/" } };
      if (r.method === "DELETE" && r.path === "/sandboxes/sbx_1") return { status: 202, json: { object: "sandbox", id: "sbx_1", status: "deleting", message: "teardown" } };
      if (r.method === "DELETE") return { status: 404, json: { error: { type: "not_found", message: "No sandbox with that id." } } };
      return undefined;
    });
    const env = { AAS_API_KEY: "aas_sk_test", AAS_API_URL: url };
    const { router } = routerFor(saasSandboxProvider, env);
    const sbx = await router.create({ timeoutSec: 120 });
    expect(polls).toBe(2);
    expect(await saasSandboxProvider.listFiles!(sbx.providerSandboxId, "/workspace", ctx(env))).toEqual([
      { name: "a.txt", path: "/workspace/a.txt", isDir: false, size: 5 },
      { name: "data", path: "/workspace/data", isDir: true, size: undefined },
    ]);
    expect(await saasSandboxProvider.getUrl!(sbx.providerSandboxId, 3000, ctx(env))).toBe("https://preview.example/tok/");
    await sbx.kill();
    await lifecycle(router, { files: true });
    expect(seen).toContain("DELETE /sandboxes/sbx_1");
    await expect(saasSandboxProvider.kill("sbx_gone", ctx(env))).resolves.toBeUndefined();
  });

  it("deletes a sandbox that failed to start", async () => {
    const { url, seen } = await mock((r) => {
      if (r.method === "POST") return { status: 201, json: { id: "sbx_2", status: "provisioning" } };
      if (r.method === "GET") return { json: { id: "sbx_2", status: "failed" } };
      if (r.method === "DELETE") return { json: { id: "sbx_2", status: "deleted" } };
      return undefined;
    });
    const { router } = routerFor(saasSandboxProvider, { AAS_API_KEY: "k", AAS_API_URL: url });
    await expect(router.create({})).rejects.toThrow(/failed/);
    expect(seen).toContain("DELETE /sandboxes/sbx_2");
  });

  it("is refused out of credit with a quota mark", async () => {
    const { url } = await mock(() => ({ status: 402, json: { error: { type: "insufficient_balance", message: "Insufficient credit balance" } } }));
    await refused(saasSandboxProvider, { AAS_API_KEY: "k", AAS_API_URL: url }, "quota");
  });
});

describe("sandbox0", () => {
  it("claims from the default template, runs cmd contexts, moves files and deletes", async () => {
    const files = new Map<string, Buffer>();
    let polls = 0;
    const { url, seen } = await mock((r) => {
      if (r.headers.authorization !== "Bearer s0_test") return { status: 401, json: { success: false, error: { code: "unauthorized", message: "no" } } };
      if (r.method === "POST" && r.path === "/api/v1/sandboxes") {
        expect(r.json()).toMatchObject({ template: "default", config: { hard_ttl: 120, resources: { memory: "4096Mi" } } });
        return { status: 201, json: { success: true, data: { sandbox_id: "sb_1", status: "starting", runtime_id: "", template: "default" } } };
      }
      if (r.method === "GET" && r.path === "/api/v1/sandboxes/sb_1/status") return { json: { success: true, data: { sandbox_id: "sb_1", status: polls++ < 1 ? "starting" : "running" } } };
      if (r.method === "POST" && r.path === "/api/v1/sandboxes/sb_1/contexts") {
        const b = r.json();
        expect(b).toMatchObject({ type: "cmd", wait_until_done: true });
        const x = fakeRun(b.cmd.command[2]);
        return { status: 201, json: { success: true, data: { id: "ctx-1", type: "cmd", running: false, paused: false, created_at: "now", stdout: x.stdout, stderr: x.stderr, exit_code: x.code, state: "stopped" } } };
      }
      if (r.method === "POST" && r.path === "/api/v1/sandboxes/sb_1/files") return files.set(r.query.get("path")!, r.body), { json: { success: true, data: { written: true } } };
      if (r.method === "GET" && r.path === "/api/v1/sandboxes/sb_1/files") return { raw: files.get(r.query.get("path")!) ?? "" };
      if (r.method === "DELETE" && r.path === "/api/v1/sandboxes/sb_1") return { status: 202, json: { success: true, data: { message: "terminating" } } };
      if (r.method === "DELETE") return { status: 404, json: { success: false, error: { code: "not_found", message: "sandbox not found" } } };
      return undefined;
    });
    const env = { SANDBOX0_TOKEN: "s0_test", SANDBOX0_BASE_URL: url };
    const { router } = routerFor(sandbox0Provider, env);
    await lifecycle(router, { files: true });
    expect(polls).toBe(2);
    expect(seen).toContain("DELETE /api/v1/sandboxes/sb_1");
    await expect(sandbox0Provider.kill("sb_gone", ctx(env))).resolves.toBeUndefined();
  });

  it("deletes a sandbox that failed while starting", async () => {
    const { url, seen } = await mock((r) => {
      if (r.method === "POST") return { status: 201, json: { success: true, data: { sandbox_id: "sb_2", status: "starting" } } };
      if (r.method === "GET") return { json: { success: true, data: { status: "failed" } } };
      if (r.method === "DELETE") return { status: 202, json: { success: true, data: {} } };
      return undefined;
    });
    const { router } = routerFor(sandbox0Provider, { SANDBOX0_TOKEN: "k", SANDBOX0_BASE_URL: url });
    await expect(router.create({})).rejects.toThrow(/failed/);
    expect(seen).toContain("DELETE /api/v1/sandboxes/sb_2");
  });

  it("reads a team quota 429 as a rate limit, not spent credit", async () => {
    const { url } = await mock(() => ({ status: 429, json: { success: false, error: { code: "quota_exceeded", message: "active_sandboxes quota exceeded" } } }));
    await refused(sandbox0Provider, { SANDBOX0_TOKEN: "k", SANDBOX0_BASE_URL: url }, "rate_limit");
  });
});

describe("watasu", () => {
  it("creates from the base template, runs commands through the SDK with the time left, and destroys", async () => {
    let polls = 0;
    const deadline = new Date(Date.now() + 100_000).toISOString();
    const { url, seen } = await mock((r) => {
      if (r.headers.authorization !== "Bearer wk_test") return { status: 401, json: { error: "unauthorized" } };
      if (r.method === "POST" && r.path === "/sandboxes") {
        expect(r.headers["idempotency-key"]).toBeTruthy();
        expect(r.json()).toMatchObject({ template: "base", timeout: 120, lifecycle: { on_timeout: "kill" } });
        return { json: { sandbox: { id: 123, state: "creating" }, session: { data_plane_url: "https://x", access_token: "t" } } };
      }
      if (r.method === "GET" && r.path === "/sandboxes/123") return { json: { sandbox: { id: 123, state: polls++ < 1 ? "creating" : "ready", end_at: deadline } } };
      if (r.method === "DELETE" && r.path === "/sandboxes/123") return { json: {} };
      if (r.method === "DELETE") return { status: 404, json: { error: "not_found" } };
      return undefined;
    });
    const env = { WATASU_API_KEY: "wk_test", WATASU_API_URL: url };
    sdk.calls.length = 0;
    const { router } = routerFor(watasuProvider, env);
    await lifecycle(router);
    expect(polls).toBeGreaterThanOrEqual(2);
    const connect = sdk.calls.find((c) => c.op === "watasu.connect")!;
    expect(connect.args[0]).toBe("123");
    const opts = connect.args[1] as { apiKey: string; apiUrl: string; timeoutMs: number };
    expect(opts).toMatchObject({ apiKey: "wk_test", apiUrl: url });
    expect(opts.timeoutMs).toBeGreaterThan(90_000);
    expect(opts.timeoutMs).toBeLessThanOrEqual(100_000);
    expect(seen).toContain("DELETE /sandboxes/123");
    await expect(watasuProvider.kill("999", ctx(env))).resolves.toBeUndefined();
  });

  it("reads the team sandbox quota as a rate limit and a missing balance as quota", async () => {
    const full = await mock(() => ({ status: 422, json: { error: "sandbox_quota_exceeded", quota: {} } }));
    await refused(watasuProvider, { WATASU_API_KEY: "k", WATASU_API_URL: full.url }, "rate_limit");
    const broke = await mock(() => ({ status: 402, json: { error: "sandbox_balance_required" } }));
    await refused(watasuProvider, { WATASU_API_KEY: "k", WATASU_API_URL: broke.url }, "quota");
  });
});
