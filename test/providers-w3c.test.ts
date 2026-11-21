// The adapters added on 2026-11-21 in wave 3 (OpenReward, Baseten, Chalk, VoidRun, kosa8, Prime
// Intellect, Sandboxer), driven through the router against local servers that speak each
// provider's wire format: from its OpenAPI spec, its API reference, and the requests its official
// SDK sends. None has been run against the real service.
import { describe, expect, it } from "vitest";
import { fakeRun, lifecycle, mock, routerFor } from "./restmock.js";
import { NoProviderAvailableError, type ProviderAdapter, type SandboxRouter } from "../src/index.js";
import { ratePerSecond } from "../src/core/metering.js";
import { INR_PER_USD } from "../src/providers/currency.js";
import { sandboxerProvider, sandboxerType } from "../src/providers/sandboxer.js";
import { primeintellectProvider } from "../src/providers/primeintellect.js";
import { voidrunProvider, voidrunSize } from "../src/providers/voidrun.js";
import { kosa8Provider, kosa8Size } from "../src/providers/kosa8.js";
import { basetenProvider, basetenSize } from "../src/providers/baseten.js";
import { chalkProvider, chalkResources } from "../src/providers/chalk.js";
import { openrewardProvider, openrewardSize } from "../src/providers/openreward.js";

/** A create refused by the provider fails the plan with the given kind, and leaves that mark. */
async function refused(router: SandboxRouter, provider: string, kind: string) {
  const err = await router.create({ timeoutSec: 60 }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(NoProviderAvailableError);
  expect((err as NoProviderAvailableError).attempts[0]).toMatchObject({ provider, outcome: "failed", kind });
  expect((await router.ledger.read()).marks.some((m) => m.provider === provider && m.kind === kind)).toBe(true);
}

/** Deleting a sandbox the provider no longer has is not an error. */
async function killsGone(adapter: ProviderAdapter, env: (url: string) => Record<string, string>, status: number, method = "DELETE") {
  const { url, seen } = await mock((r) => (r.method === method && !/token|ping/.test(r.path) ? { status, json: { error: "not found" } } : r.path.endsWith("/token") ? { json: { access_token: "t", token: "t", expires_in: 3600, expires_at: new Date(Date.now() + 3_600_000).toISOString() } } : undefined));
  await expect(adapter.kill("gone-1", { env: env(url), options: {} })).resolves.toBeUndefined();
  expect(seen.some((s) => s.startsWith(`${method} `))).toBe(true);
}

/** A Connect server-stream body: one envelope per message, then the end-of-stream envelope. */
function envelopes(messages: unknown[], end: unknown = {}): Buffer {
  const frame = (flags: number, v: unknown) => {
    const json = Buffer.from(JSON.stringify(v));
    const head = Buffer.alloc(5);
    head[0] = flags;
    head.writeUInt32BE(json.length, 1);
    return Buffer.concat([head, json]);
  };
  return Buffer.concat([...messages.map((m) => frame(0, m)), frame(2, end)]);
}
const b64 = (s: string) => Buffer.from(s).toString("base64");

describe("sizes and prices", () => {
  it("maps a request to each provider's sizes", () => {
    expect(sandboxerType(2)).toEqual({ type: "small", cpu: 2, memoryMiB: 4096 });
    expect(sandboxerType(5).type).toBe("large");
    expect(voidrunSize(0.5, 512)).toEqual({ cpu: 1, mem: 1024 });
    expect(voidrunSize(32, 99999)).toEqual({ cpu: 8, mem: 16384 });
    expect(kosa8Size(3).size).toBe("4x8");
    expect(basetenSize(2, 4096)).toEqual({ cpu: 2, memory: 4096 });
    expect(basetenSize(1, 16384)).toEqual({ cpu: 1, memory: 8192 });
    expect(chalkResources(2, 4096)).toEqual({ cpu: "2", memory: "4096Mi" });
    expect(openrewardSize(2, 4096).size).toBe("2:4");
    expect(openrewardSize(1.5, 1024).size).toBe("2:2");
    expect(openrewardSize(2, 12000).size).toBe("4:16");
    expect(openrewardSize(64, 1).size).toBe("16:16");
  });

  it("prices 2 vCPU / 4 GiB as each provider's page does", () => {
    const perHour = (p: ProviderAdapter) => ratePerSecond(p.info.pricing, 2, 4096) * 3600;
    expect(perHour(sandboxerProvider)).toBeCloseTo(0.018, 6);
    expect(perHour(primeintellectProvider)).toBeCloseTo(0.09, 6);
    expect(perHour(basetenProvider)).toBeCloseTo(0.2154, 6);
    expect(perHour(openrewardProvider)).toBeCloseTo(0.1656, 6);
    expect(perHour(chalkProvider)).toBeCloseTo(0.0818, 6);
    expect(perHour(kosa8Provider)).toBeCloseTo(0.15, 6);
    // Rupees at the ECB rate: ₹12.19/h busy.
    expect(voidrunProvider.info.pricing.billing).toBe("active-cpu");
    expect((2 * 0.0010304 + 4 * 0.0003312) * 3600).toBeCloseTo(12.19, 2);
    expect(voidrunProvider.info.pricing.vcpuSecondUsd).toBeCloseTo(0.0010304 / INR_PER_USD, 12);
    expect(INR_PER_USD).toBeCloseTo(92.675, 2);
  });
});

describe("sandboxer", () => {
  const env = (url: string) => ({ SANDBOXER_API_KEY: "sbx_live_test", SANDBOXER_API_URL: url });

  it("creates with an idempotency key and no account secrets, waits for ready, runs commands, moves files, and deletes with the confirm header", async () => {
    const files = new Map<string, string>();
    let polls = 0;
    const { url, seen } = await mock((r) => {
      if (r.headers.authorization !== "Bearer sbx_live_test") return { status: 401, json: { error: "unauthorized" } };
      if (r.method === "POST" && r.path === "/sandboxes") {
        expect(r.headers["idempotency-key"]).toBeTruthy();
        expect(r.json()).toMatchObject({ type: "small", ttlSeconds: 120, noEnv: true });
        return { status: 202, json: { ok: true, status: "provisioning", ttlSeconds: 120, sandbox: { id: "sx1", name: "n", state: "provisioning" } } };
      }
      if (r.method === "GET" && r.path === "/sandboxes/sx1") {
        expect(r.query.get("waitFor")).toBe("ready");
        return { json: { ok: true, sandbox: { id: "sx1", name: "n", state: polls++ < 1 ? "provisioned" : "ready" } } };
      }
      if (r.method === "POST" && r.path === "/sandboxes/sx1/commands") {
        const b = r.json();
        expect(b.timeoutSeconds).toBeLessThanOrEqual(600);
        const x = fakeRun(b.command);
        return { json: { ok: true, success: x.code === 0, exitCode: x.code, stdout: x.stdout, stderr: x.stderr, timedOut: false } };
      }
      if (r.method === "PUT" && r.path === "/sandboxes/sx1/files") return files.set(r.json().path, r.json().content), { json: { ok: true, success: true, path: r.json().path, encoding: "base64", size: 5 } };
      if (r.method === "GET" && r.path === "/sandboxes/sx1/files") return { json: { ok: true, success: true, path: r.query.get("path"), encoding: "base64", size: 5, content: files.get(r.query.get("path")!) } };
      if (r.method === "POST" && r.path === "/sandboxes/sx1/host") return { json: { ok: true, port: r.json().port, url: `https://frazil-${r.json().port}.box.sandboxer.com`, access: "public" } };
      if (r.method === "PATCH" && r.path === "/sandboxes/sx1") return expect(r.json()).toEqual({ ttlSeconds: 900 }), { json: { ok: true, sandbox: { id: "sx1", state: "ready" } } };
      if (r.method === "POST" && (r.path === "/sandboxes/sx1/stop" || r.path === "/sandboxes/sx1/resume")) return { status: 202, json: { ok: true, id: "sx1", status: "accepted" } };
      if (r.method === "DELETE" && r.path === "/sandboxes/sx1") {
        expect(r.headers["x-sandboxer-confirm-delete"]).toBe("sx1");
        return { status: 202, json: { ok: true, operation: { id: "op", kind: "sandbox", targetId: "sx1", status: "pending" } } };
      }
      return undefined;
    });
    const { router } = routerFor(sandboxerProvider, env(url));
    await lifecycle(router, { files: true });
    expect(seen).toContain("DELETE /sandboxes/sx1");
    const sbx = await router.create({ timeoutSec: 120 });
    expect(await sbx.getUrl(3000)).toBe("https://frazil-3000.box.sandboxer.com");
    await sbx.setTimeout(900);
    await sbx.pause();
    await sbx.resume();
    await sbx.kill();
  });

  it("kills a sandbox that failed to start, treats a missing one as gone, reads 402 as quota and 429 as a rate limit", async () => {
    const { url, seen } = await mock((r) => {
      if (r.method === "POST") return { status: 202, json: { ok: true, status: "provisioning", sandbox: { id: "bad", state: "provisioning" } } };
      if (r.method === "GET") return { json: { ok: true, sandbox: { id: "bad", state: "cancelled", error: "no machine" } } };
      if (r.method === "DELETE") return { status: 202, json: { ok: true } };
      return undefined;
    });
    await expect(routerFor(sandboxerProvider, env(url)).router.create({ timeoutSec: 60 })).rejects.toThrow(/cancelled/);
    expect(seen).toContain("DELETE /sandboxes/bad");
    await killsGone(sandboxerProvider, env, 404);
    const broke = await mock(() => ({ status: 402, json: { ok: false, error: { code: "payment_required" } } }));
    await refused(routerFor(sandboxerProvider, env(broke.url)).router, "sandboxer", "quota");
    const busy = await mock(() => ({ status: 429, json: { ok: false, error: { code: "concurrency_limit" } } }));
    await refused(routerFor(sandboxerProvider, env(busy.url)).router, "sandboxer", "rate_limit");
  });

  it("lists live sandboxes across pages and hands paths outside /home/user and /tmp to exec", async () => {
    const { url } = await mock((r) =>
      r.query.get("cursor") ? { json: { ok: true, sandboxes: [{ id: "c", state: "idle" }], pageInfo: { nextCursor: null } } } : { json: { ok: true, sandboxes: [{ id: "a", state: "running" }, { id: "b", state: "error" }], pageInfo: { nextCursor: "p2" } } },
    );
    expect(await sandboxerProvider.listAlive({ env: env(url), options: {} })).toEqual(["a", "c"]);
    await expect(sandboxerProvider.readFile("sx1", "/etc/passwd", { env: env(url), options: {} })).rejects.toMatchObject({ kind: "unsupported" });
  });
});

describe("primeintellect", () => {
  const env = (url: string) => ({ PRIME_API_KEY: "pk_test", PRIME_API_URL: url });

  it("creates with an idempotency key, polls RUNNING, runs commands over the gateway's Connect stream, and moves files through it", async () => {
    const files = new Map<string, Buffer>();
    let polls = 0;
    let auths = 0;
    let gatewayUrl = "";
    let refuseOnce = false;
    const { url, seen } = await mock((r) => {
      const gw = r.path.startsWith("/gw/ns1/job1/");
      if (gw) {
        if (refuseOnce) {
          refuseOnce = false;
          return { status: 401, json: { detail: "expired" } };
        }
        expect(r.headers.authorization).toBe(`Bearer gwtok${auths}`);
      } else if (r.headers.authorization !== "Bearer pk_test") return { status: 401, json: { detail: "bad key" } };
      if (r.method === "POST" && r.path === "/api/v1/sandbox") {
        const b = r.json();
        expect(b).toMatchObject({ docker_image: "python:3.11-slim", cpu_cores: 2, memory_gb: 4, timeout_minutes: 2, labels: ["sandboxrouting"] });
        expect(b.idempotency_key).toBeTruthy();
        expect(b.name).toMatch(/^sbr-/);
        return { status: 201, json: { id: "pi1", status: "PENDING" } };
      }
      if (r.method === "GET" && r.path === "/api/v1/sandbox/pi1") return { json: { id: "pi1", status: polls++ < 1 ? "PROVISIONING" : "RUNNING" } };
      if (r.method === "POST" && r.path === "/api/v1/sandbox/pi1/auth") {
        auths++;
        return { json: { token: `gwtok${auths}`, gateway_url: gatewayUrl, user_ns: "ns1", job_id: "job1", expires_at: new Date(Date.now() + 30 * 60_000).toISOString() } };
      }
      if (r.method === "POST" && r.path === "/gw/ns1/job1/command_session.CommandSession/Start") {
        expect(r.headers["content-type"]).toBe("application/connect+json");
        const len = r.body.readUInt32BE(1);
        const req = JSON.parse(r.body.subarray(5, 5 + len).toString());
        expect(req.command.cmd).toBe("/bin/sh");
        const x = fakeRun(req.command.args[1]);
        return {
          type: "application/connect+json",
          raw: envelopes([{ event: { start: { pid: 7 } } }, { event: { data: { sequence: "1", stdout: b64(x.stdout), ...(x.stderr ? { stderr: b64(x.stderr) } : {}) } } }, { event: { end: x.code ? { exitCode: x.code } : {} } }]),
        };
      }
      if (r.method === "POST" && r.path === "/gw/ns1/job1/upload") {
        expect(r.query.get("sandbox_id")).toBe("pi1");
        const text = r.body.toString("latin1");
        const content = /\r\n\r\n([\s\S]*?)\r\n--/.exec(text)![1]!;
        files.set(r.query.get("path")!, Buffer.from(content, "latin1"));
        return { json: { success: true, path: r.query.get("path") } };
      }
      if (r.method === "GET" && r.path === "/gw/ns1/job1/download") return files.has(r.query.get("path")!) ? { raw: files.get(r.query.get("path")!)! } : { status: 404, json: { detail: "no file" } };
      if (r.method === "POST" && (r.path === "/api/v1/sandbox/pi1/pause" || r.path === "/api/v1/sandbox/pi1/resume")) return { status: 202, json: { id: "pi1", status: "RUNNING" } };
      if (r.method === "DELETE" && r.path === "/api/v1/sandbox/pi1") return { json: { success: true, message: "deleted" } };
      return undefined;
    });
    gatewayUrl = `${url}/gw`;
    const { router } = routerFor(primeintellectProvider, env(url));
    await lifecycle(router, { files: true });
    expect(seen).toContain("DELETE /api/v1/sandbox/pi1");
    const sbx = await router.create({ timeoutSec: 120 });
    // An expired gateway token is refused once, then minted again.
    refuseOnce = true;
    expect((await sbx.commands.run("echo again")).exitCode).toBe(0);
    expect(auths).toBeGreaterThanOrEqual(2);
    await sbx.pause();
    await sbx.resume();
    await sbx.kill();
  });

  it("reports a command past its deadline as 124, kills a sandbox that errors while starting, and reads 402 as spent credit", async () => {
    let gatewayUrl = "";
    const { url, seen } = await mock((r) => {
      if (r.method === "POST" && r.path === "/api/v1/sandbox") return { status: 201, json: { id: "bad", status: "PENDING" } };
      if (r.method === "GET" && r.path === "/api/v1/sandbox/bad") return { json: { id: "bad", status: "ERROR", errorMessage: "image pull failed" } };
      if (r.method === "DELETE") return { json: { success: true } };
      if (r.path === "/api/v1/sandbox/slow/auth") return { json: { token: "t", gateway_url: gatewayUrl, user_ns: "n", job_id: "j", expires_at: new Date(Date.now() + 1_800_000).toISOString() } };
      if (r.path.endsWith("/Start")) return { type: "application/connect+json", raw: envelopes([{ event: { start: { pid: 1 } } }], { error: { code: "deadline_exceeded", message: "timed out" } }) };
      return undefined;
    });
    gatewayUrl = url;
    await expect(routerFor(primeintellectProvider, env(url)).router.create({ timeoutSec: 60 })).rejects.toThrow(/image pull failed/);
    expect(seen).toContain("DELETE /api/v1/sandbox/bad");
    const r = await primeintellectProvider.exec("slow", "sleep 99", { timeoutSec: 1 }, { env: env(url), options: {} });
    expect(r.exitCode).toBe(124);
    await killsGone(primeintellectProvider, env, 404);
    const broke = await mock(() => ({ status: 402, json: { detail: "Insufficient balance" } }));
    await refused(routerFor(primeintellectProvider, env(broke.url)).router, "primeintellect", "quota");
  });

  it("lists active sandboxes by cursor", async () => {
    const { url } = await mock((r) =>
      r.query.get("cursor") ? { json: { sandboxes: [{ id: "c", status: "PAUSED" }], page: 1, per_page: 100, has_next: false, next_cursor: null } } : { json: { sandboxes: [{ id: "a", status: "RUNNING" }, { id: "b", status: "TIMEOUT" }], page: 1, per_page: 100, has_next: true, next_cursor: "n2" } },
    );
    expect(await primeintellectProvider.listAlive({ env: env(url), options: {} })).toEqual(["a", "c"]);
  });
});

describe("voidrun", () => {
  const env = (url: string) => ({ VOIDRUN_API_KEY: "vr_test", VOIDRUN_API_URL: url });

  it("creates with auto-sleep, runs commands, moves and lists files, publishes a port, and leaves the deadline to the router", async () => {
    const files = new Map<string, Buffer>();
    let ports: number[] = [];
    let polls = 0;
    const { url, seen } = await mock((r) => {
      if (r.headers["x-api-key"] !== "vr_test") return { status: 401, json: { error: "unauthorized" } };
      if (r.method === "POST" && r.path === "/sandboxes") {
        expect(r.json()).toMatchObject({ cpu: 2, mem: 4096, autoSleep: true, sync: true });
        expect(r.json().name).toMatch(/^sbr-/);
        return { status: 201, json: { status: "success", data: { id: "v1", name: r.json().name, status: "error_unknown_yet" } } };
      }
      if (r.method === "GET" && r.path === "/sandboxes/v1") return { json: { status: "success", data: { id: "v1", status: polls++ < 1 ? "snapshotted" : "running", cpu: 2, mem: 4096 } } };
      if (r.method === "POST" && r.path === "/sandboxes/v1/exec") {
        const b = r.json();
        expect(b.timeout).toBeLessThanOrEqual(300);
        const x = fakeRun(b.command);
        return { json: { status: "success", data: { stdout: x.stdout, stderr: x.stderr, exitCode: x.code } } };
      }
      if (r.method === "POST" && r.path === "/sandboxes/v1/files/upload") return files.set(r.query.get("path")!, r.body), { json: { status: "success" } };
      if (r.method === "GET" && r.path === "/sandboxes/v1/files/download") return { raw: files.get(r.query.get("path")!) ?? "" };
      if (r.method === "GET" && r.path === "/sandboxes/v1/files") return { json: { status: "success", data: { success: true, files: [{ name: "a.txt", path: "/tmp/a.txt", size: 5, isDir: false }] } } };
      if (r.method === "GET" && r.path === "/sandboxes/v1/public-urls") return { json: { status: "success", data: ports.map((p) => ({ port: p, url: `https://sv1-${p}.sb.void-run.com` })) } };
      if (r.method === "PATCH" && r.path === "/sandboxes/v1/publish-ports") return (ports = r.json().publishPorts), { json: { status: "success" } };
      if (r.method === "POST" && (r.path === "/sandboxes/v1/sleep" || r.path === "/sandboxes/v1/wake")) return { json: { status: "success" } };
      if (r.method === "DELETE" && r.path === "/sandboxes/v1") return { json: { status: "success" } };
      return undefined;
    });
    const { router, clock } = routerFor(voidrunProvider, env(url));
    await lifecycle(router, { files: true });
    const sbx = await router.create({ timeoutSec: 60 });
    expect(await sbx.files.list("/tmp")).toEqual([{ name: "a.txt", path: "/tmp/a.txt", isDir: false, size: 5 }]);
    expect(await sbx.getUrl(8080)).toBe("https://sv1-8080.sb.void-run.com");
    expect(ports).toEqual([8080]);
    await sbx.pause();
    await sbx.resume();
    // No TTL: past the deadline (a resume starts a new one) the sweep deletes it.
    const before = seen.filter((s) => s === "DELETE /sandboxes/v1").length;
    clock.t += 3_600_000;
    expect((await router.sweep()).reaped).toBe(1);
    expect(seen.filter((s) => s === "DELETE /sandboxes/v1").length).toBe(before + 1);
  });

  it("adopts the sandbox a retried create already made, and treats a missing one as gone", async () => {
    let name = "";
    const { url, seen } = await mock((r) => {
      if (r.method === "POST" && r.path === "/sandboxes") return (name = r.json().name), { status: 409, json: { error: "Sandbox already exists" } };
      if (r.method === "GET" && r.path === "/sandboxes") return { json: { status: "success", data: [{ id: "old", name: "other", status: "running" }, { id: "v9", name, status: "running" }], meta: { page: 1, totalPages: 1 } } };
      if (r.method === "GET" && r.path === "/sandboxes/v9") return { json: { status: "success", data: { id: "v9", status: "running" } } };
      return undefined;
    });
    const sbx = await routerFor(voidrunProvider, env(url)).router.create({ timeoutSec: 60 });
    expect(sbx.providerSandboxId).toBe("v9");
    expect(seen).toContain("GET /sandboxes");
    await killsGone(voidrunProvider, env, 404);
    const broke = await mock(() => ({ status: 402, json: { error: "insufficient credits" } }));
    await refused(routerFor(voidrunProvider, env(broke.url)).router, "voidrun", "quota");
  });
});

describe("kosa8", () => {
  const env = (url: string) => ({ KOSA8_API_KEY: "k8c_live_test", KOSA8_API_URL: url });

  it("creates a sized sandbox, polls a cold boot, streams commands as NDJSON, moves files, and opens a public preview", async () => {
    const files = new Map<string, Buffer>();
    let polls = 0;
    const { url, seen } = await mock((r) => {
      if (r.headers.authorization !== "Bearer k8c_live_test") return { status: 401, json: { error: "unauthorized" } };
      if (r.method === "POST" && r.path === "/v1/sandboxes") {
        expect(r.json()).toMatchObject({ size: "2x4", ttl_s: 120 });
        return { status: 202, json: { sandbox: { id: "sbx_1", state: "creating" } } };
      }
      if (r.method === "GET" && r.path === "/v1/sandboxes/sbx_1") return { json: { sandbox: { id: "sbx_1", state: polls++ < 1 ? "creating" : "running" } } };
      if (r.method === "POST" && r.path === "/v1/sandboxes/sbx_1/exec") {
        const b = r.json();
        expect(b.stream).toBe(true);
        expect(b.cmd.slice(0, 2)).toEqual(["sh", "-c"]);
        const x = fakeRun(b.cmd[2]);
        const frames = [{ stream: "stdout", data: "", heartbeat: true }, { stream: "stdout", data: b64(x.stdout) }, ...(x.stderr ? [{ stream: "stderr", data: b64(x.stderr) }] : []), { done: true, exit: x.code }];
        return { type: "application/x-ndjson", raw: frames.map((f) => JSON.stringify(f)).join("\n") + "\n" };
      }
      if (r.method === "PUT" && r.path === "/v1/sandboxes/sbx_1/files") return files.set(r.query.get("path")!, r.body), { json: { file: { path: r.query.get("path") } } };
      if (r.method === "GET" && r.path === "/v1/sandboxes/sbx_1/files") return { raw: files.get(r.query.get("path")!) ?? "" };
      if (r.method === "GET" && r.path === "/v1/sandboxes/sbx_1/files/list") return { json: { path: "/workspace", files: [{ name: "src", path: "/workspace/src", type: "dir" }, { name: "a.txt", path: "/workspace/a.txt", type: "file", size: 5 }] } };
      if (r.method === "POST" && r.path === "/v1/sandboxes/sbx_1/previews") return expect(r.json()).toMatchObject({ port: 3000, public: true }), { status: 201, json: { preview: { port: 3000, public: true, url: "https://abc.preview.kosa8.com/" } } };
      if (r.method === "PATCH" && r.path === "/v1/sandboxes/sbx_1") return expect(r.json()).toEqual({ ttl_s: 600 }), { json: { sandbox: { id: "sbx_1", state: "running" } } };
      if (r.method === "POST" && (r.path === "/v1/sandboxes/sbx_1/sleep" || r.path === "/v1/sandboxes/sbx_1/wake")) return { json: { sandbox: { id: "sbx_1", state: "running" } } };
      if (r.method === "DELETE" && r.path === "/v1/sandboxes/sbx_1") return { json: {} };
      return undefined;
    });
    const { router } = routerFor(kosa8Provider, env(url));
    await lifecycle(router, { files: true });
    expect(seen).toContain("DELETE /v1/sandboxes/sbx_1");
    const sbx = await router.create({ timeoutSec: 120 });
    expect(await sbx.files.list("/workspace")).toEqual([
      { name: "src", path: "/workspace/src", isDir: true, size: undefined },
      { name: "a.txt", path: "/workspace/a.txt", isDir: false, size: 5 },
    ]);
    expect(await sbx.getUrl(3000)).toBe("https://abc.preview.kosa8.com/");
    await sbx.setTimeout(600);
    await sbx.pause();
    await sbx.resume();
    await sbx.kill();
  });

  it("reports a timed-out command as 124, kills one that errors while booting, reads a plan limit as quota and too many active as a rate limit", async () => {
    const { url, seen } = await mock((r) => {
      if (r.method === "POST" && r.path === "/v1/sandboxes") return { status: 202, json: { sandbox: { id: "bad", state: "creating" } } };
      if (r.method === "GET") return { json: { sandbox: { id: "bad", state: "error", last_error: "boot failed" } } };
      if (r.method === "DELETE") return { json: {} };
      if (r.path === "/v1/sandboxes/slow/exec") return { type: "application/x-ndjson", raw: `${JSON.stringify({ done: true, error: "timed out", code: "exec_timeout" })}` };
      return undefined;
    });
    await expect(routerFor(kosa8Provider, env(url)).router.create({ timeoutSec: 60 })).rejects.toThrow(/boot failed/);
    expect(seen).toContain("DELETE /v1/sandboxes/bad");
    expect((await kosa8Provider.exec("slow", "sleep 9", { timeoutSec: 1 }, { env: env(url), options: {} })).exitCode).toBe(124);
    await killsGone(kosa8Provider, env, 404);
    const plan = await mock(() => ({ status: 402, json: { error: "plan_limit", limit_name: "sandbox_hours" } }));
    await refused(routerFor(kosa8Provider, env(plan.url)).router, "kosa8", "quota");
    const busy = await mock(() => ({ status: 429, json: { error: "quota_exceeded", limit: 2 } }));
    await refused(routerFor(kosa8Provider, env(busy.url)).router, "kosa8", "rate_limit");
  });
});

describe("baseten", () => {
  const env = (url: string) => ({ BASETEN_API_KEY: "bt_test", BASETEN_API_URL: url });

  it("mints a sandbox token, creates by name with an expiry, polls DEPLOYED, and runs commands and files on the sandbox's runtime API", async () => {
    const files = new Map<string, Buffer>();
    let polls = 0;
    let tokens = 0;
    let runtimeUrl = "";
    const { url, seen } = await mock((r) => {
      if (r.path === "/v1/token") {
        expect(r.headers.authorization).toBe("Bearer bt_test");
        expect(r.json()).toEqual({ scopes: ["sandboxes"] });
        tokens++;
        return { json: { token: "sbtok", expires_at: new Date(Date.now() + 7_200_000).toISOString() } };
      }
      if (r.headers.authorization !== "Bearer sbtok") return { status: 401, json: { error: "token required" } };
      const name = /^\/v1\/sandboxes\/instances\/([^/]+)/.exec(r.path)?.[1];
      if (r.method === "POST" && r.path === "/v1/sandboxes/instances") {
        const b = r.json();
        expect(b).toMatchObject({ create_if_not_exists: true, cpu: 2, memory: 4096, lifecycle: { expiration_policies: [{ action: "DELETE", type: "TTL_MAX_AGE", value: "120s" }] } });
        return { status: 201, json: { name: b.name, url: `${runtimeUrl}/rt/`, status: "DEPLOYING", cpu: 2, memory: 4096 } };
      }
      if (r.method === "GET" && name && !r.path.endsWith("/previews")) return { json: { name, url: `${runtimeUrl}/rt/`, status: polls++ < 1 ? "DEPLOYING" : "DEPLOYED" } };
      if (r.method === "POST" && r.path === "/rt/process") {
        expect(r.headers.accept).toBe("application/x-ndjson");
        const b = r.json();
        expect(b.waitForCompletion).toBe(true);
        const x = fakeRun(b.command);
        const proc = { command: b.command, exitCode: x.code, status: x.code ? "failed" : "completed", stdout: x.stdout, stderr: x.stderr, logs: "", name: "p", pid: "1", startedAt: "", completedAt: "", workingDir: "/" };
        const lines = [{ type: "keepalive" }, { type: "stdout", data: x.stdout }, { type: "result", data: JSON.stringify(proc) }];
        return { type: "application/x-ndjson", raw: lines.map((l) => JSON.stringify(l)).join("\n") + "\n" };
      }
      if (r.path.startsWith("/rt/filesystem/")) {
        // An absolute path keeps its slash: /rt/filesystem//tmp/a.txt.
        const p = decodeURIComponent(r.path.slice("/rt/filesystem/".length));
        if (r.method === "PUT") {
          const text = r.body.toString("latin1");
          files.set(p, Buffer.from(/\r\n\r\n([\s\S]*?)\r\n--/.exec(text)![1]!, "latin1"));
          return { json: { message: "ok", path: p } };
        }
        if (r.headers.accept === "application/json") return { json: { name: "tmp", path: p, files: [{ name: "a.txt", path: "/tmp/a.txt", size: 5, group: "", owner: "", permissions: "", lastModified: "" }], subdirectories: [{ name: "d", path: "/tmp/d" }] } };
        return files.has(p) ? { raw: files.get(p)! } : { status: 404, json: { error: "not found" } };
      }
      if (r.method === "POST" && r.path.endsWith("/previews")) return expect(r.json()).toMatchObject({ port: 8000, public: true }), { status: 201, json: { name: "public-8000", port: 8000, url: "https://p-8000.us-pdx-1.b10.co", status: "DEPLOYED" } };
      if (r.method === "PATCH" && name) return expect(r.json().lifecycle.expiration_policies[0]).toMatchObject({ action: "DELETE", type: "DATE" }), { json: { name, url: "", status: "DEPLOYED" } };
      if (r.method === "DELETE" && name) return { status: 202, json: { name, url: "", status: "DELETING" } };
      return undefined;
    });
    runtimeUrl = url;
    const { router } = routerFor(basetenProvider, env(url));
    await lifecycle(router, { files: true });
    expect(seen).toContain("POST /rt/process");
    expect(seen.some((s) => s.startsWith("DELETE /v1/sandboxes/instances/sbr-"))).toBe(true);
    const sbx = await router.create({ timeoutSec: 120 });
    expect(await sbx.files.list("/tmp")).toEqual([
      { name: "d", path: "/tmp/d", isDir: true },
      { name: "a.txt", path: "/tmp/a.txt", isDir: false, size: 5 },
    ]);
    expect(await sbx.getUrl(8000)).toBe("https://p-8000.us-pdx-1.b10.co");
    await sbx.setTimeout(600);
    await sbx.kill();
    // One token served every call.
    expect(tokens).toBe(1);
  });

  it("kills a sandbox whose deploy failed, treats a missing one as gone, and reads 429 as a rate limit", async () => {
    const { url, seen } = await mock((r) => {
      if (r.path === "/v1/token") return { json: { token: "t", expires_at: new Date(Date.now() + 7_200_000).toISOString() } };
      if (r.method === "POST") return { status: 201, json: { name: r.json().name, url: "http://x", status: "DEPLOYING" } };
      if (r.method === "GET") return { json: { name: "n", url: "http://x", status: "FAILED" } };
      if (r.method === "DELETE") return { status: 202, json: { status: "DELETING" } };
      return undefined;
    });
    await expect(routerFor(basetenProvider, env(url)).router.create({ timeoutSec: 60 })).rejects.toThrow(/FAILED/);
    expect(seen.some((s) => s.startsWith("DELETE /v1/sandboxes/instances/"))).toBe(true);
    await killsGone(basetenProvider, env, 404);
    const busy = await mock((r) => (r.path === "/v1/token" ? { json: { token: "t", expires_at: new Date(Date.now() + 7_200_000).toISOString() } } : { status: 429, json: { error: "You have reached the maximum number of sandboxes (10)" } }));
    await refused(routerFor(basetenProvider, env(busy.url)).router, "baseten", "rate_limit");
  });
});

describe("chalk", () => {
  const env = (url: string) => ({ CHALK_CLIENT_ID: "client-1", CHALK_CLIENT_SECRET: "secret-1", CHALK_API_SERVER: url });

  it("exchanges credentials for an environment token, creates on the K8S class, polls RUNNING, and runs commands with ExecCommand", async () => {
    let polls = 0;
    const scopes: (string | undefined)[] = [];
    const { url, seen } = await mock((r) => {
      if (r.path === "/v1/oauth/token") {
        const b = r.json();
        expect(b).toMatchObject({ client_id: "client-1", client_secret: "secret-1", grant_type: "client_credentials" });
        scopes.push(b.scope);
        return { json: { access_token: b.scope ? "scoped" : "plain", token_type: "Bearer", expires_in: 3600, api_server: url, primary_environment: "env-1", environment_id_to_name: { "env-1": "prod" } } };
      }
      expect(r.headers.authorization).toBe("Bearer scoped");
      expect(r.headers["x-chalk-env-id"]).toBe("env-1");
      expect(r.headers["connect-protocol-version"]).toBe("1");
      const b = r.json();
      if (r.path === "/chalk.sandbox.v2.SandboxService/CreateSandbox") {
        expect(b.spec).toMatchObject({ entrypoint: ["sleep", "infinity"], lifetime: "120s", resources: { cpu: "2", memory: "4096Mi" }, computeClass: "COMPUTE_CLASS_K8S" });
        return { json: { sandbox: { id: "ch1", status: "SANDBOX_STATUS_PENDING" } } };
      }
      if (r.path === "/chalk.sandbox.v2.SandboxService/GetSandbox") return expect(b).toEqual({ id: "ch1" }), { json: { sandbox: { id: "ch1", status: polls++ < 1 ? "SANDBOX_STATUS_PENDING" : "SANDBOX_STATUS_RUNNING" } } };
      if (r.path === "/chalk.sandbox.v2.SandboxProcessService/ExecCommand") {
        expect(b).toMatchObject({ sandboxId: "ch1", command: "sh" });
        const x = fakeRun(b.args[1]);
        // proto3 JSON leaves out a zero exit code and empty bytes.
        return { json: { stdout: b64(x.stdout), ...(x.stderr ? { stderr: b64(x.stderr) } : {}), ...(x.code ? { exitCode: x.code } : {}) } };
      }
      if (r.path === "/chalk.sandbox.v2.SandboxService/TerminateSandbox") return { json: {} };
      return undefined;
    });
    const { router } = routerFor(chalkProvider, env(url));
    await lifecycle(router);
    expect(seen).toContain("POST /chalk.sandbox.v2.SandboxService/TerminateSandbox");
    expect(scopes).toEqual([undefined, "env:env-1"]);
  });

  it("names the environment by name, kills a sandbox that fails, treats an ended one as gone, and reads resource_exhausted as a rate limit", async () => {
    const token = (r: { json: () => { scope?: string } }, url: string) => ({ json: { access_token: "t", token_type: "Bearer", expires_in: 3600, api_server: url, primary_environment: "env-1", environment_id_to_name: { "env-1": "prod", "env-2": "staging" }, scope: r.json().scope } });
    const { url, seen } = await mock((r) => {
      if (r.path === "/v1/oauth/token") return token(r, url);
      expect(r.headers["x-chalk-env-id"]).toBe("env-2");
      if (r.path.endsWith("/CreateSandbox")) return { json: { sandbox: { id: "bad", status: "SANDBOX_STATUS_PENDING" } } };
      if (r.path.endsWith("/GetSandbox")) return { json: { sandbox: { id: "bad", status: "SANDBOX_STATUS_FAILED", statusMessage: "image not found" } } };
      if (r.path.endsWith("/TerminateSandbox")) return { status: 400, json: { code: "failed_precondition", message: "sandbox already finished" } };
      return undefined;
    });
    const staging = { ...env(url), CHALK_ENVIRONMENT: "Staging" };
    await expect(routerFor(chalkProvider, staging).router.create({ timeoutSec: 60 })).rejects.toThrow(/image not found/);
    expect(seen).toContain("POST /chalk.sandbox.v2.SandboxService/TerminateSandbox");
    await expect(chalkProvider.kill("bad", { env: staging, options: {} })).resolves.toBeUndefined();
    const gone = await mock((r) => (r.path === "/v1/oauth/token" ? token(r, "") : { status: 404, json: { code: "not_found", message: "no sandbox" } }));
    await expect(chalkProvider.kill("x", { env: env(gone.url), options: {} })).resolves.toBeUndefined();
    const busy = await mock((r) => (r.path === "/v1/oauth/token" ? token(r, "") : { status: 429, json: { code: "resource_exhausted", message: "too many sandboxes" } }));
    await refused(routerFor(chalkProvider, env(busy.url)).router, "chalk", "rate_limit");
  });

  it("lists live sandboxes by cursor, with numeric or named statuses", async () => {
    const { url } = await mock((r) => {
      if (r.path === "/v1/oauth/token") return { json: { access_token: "t", expires_in: 3600, primary_environment: "e" } };
      return r.json().cursor
        ? { json: { sandboxes: [{ id: "c", status: 8 }] } }
        : { json: { sandboxes: [{ id: "a", status: "SANDBOX_STATUS_RUNNING" }, { id: "b", status: "SANDBOX_STATUS_TERMINATED" }], nextCursor: "n2" } };
    });
    expect(await chalkProvider.listAlive!({ env: env(url), options: {} })).toEqual(["a", "c"]);
  });
});

describe("openreward", () => {
  const env = (url: string) => ({ OPENREWARD_API_KEY: "or_test", OPENREWARD_ENVIRONMENT: "me/env", OPENREWARD_SESSION_URL: url });
  const events = (...evs: [string, string][]) => ({ type: "text/event-stream", raw: evs.map(([e, d]) => `event: ${e}\ndata: ${d}\n\n`).join("") });

  it("creates a session in the environment, pings before each command, runs commands over the event stream, and deletes the session", async () => {
    const { url, seen } = await mock((r) => {
      if (r.headers["x-api-key"] !== "or_test") return { status: 401, json: { detail: "bad key" } };
      if (r.path === "/create_sandbox") {
        expect(r.json()).toMatchObject({ environment: "me/env", image: "python:3.11-slim", machine_size: "2:4", block_network: false });
        const end = JSON.stringify({ sid: "sid-1" });
        return events(["task_id", "task-1"], ["chunk", end.slice(0, 5)], ["end", end.slice(5)]);
      }
      expect(r.headers["x-session-id"]).toBe("sid-1");
      if (r.path === "/ping") return { json: {} };
      if (r.path === "/run") {
        const b = r.json();
        const x = fakeRun(b.cmd);
        return events(["task_id", "t2"], ["end", JSON.stringify({ return_code: x.code, output: b64(x.stdout + x.stderr) })]);
      }
      if (r.path === "/delete_session") return { json: {} };
      return undefined;
    });
    const { router, clock } = routerFor(openrewardProvider, env(url));
    const sbx = await lifecycle(router);
    expect(sbx.providerSandboxId).toBe("sid-1");
    expect(seen.filter((s) => s === "POST /ping").length).toBe(2);
    expect(seen).toContain("POST /delete_session");
    // No lifetime setting: the sweep deletes it at the deadline.
    await router.create({ timeoutSec: 60 });
    const before = seen.filter((s) => s === "POST /delete_session").length;
    clock.t += 61_000;
    expect((await router.sweep()).reaped).toBe(1);
    expect(seen.filter((s) => s === "POST /delete_session").length).toBe(before + 1);
  });

  it("ends a create that failed after the server started it, treats a gone session as gone, and reads 402 as quota", async () => {
    const { url, seen } = await mock((r) => {
      if (r.path === "/create_sandbox") return events(["task_id", "task-9"], ["error", "image pull failed"]);
      if (r.path === "/delete_session") return expect(r.headers["x-session-id"]).toBe("task-9"), { json: {} };
      return undefined;
    });
    await expect(routerFor(openrewardProvider, env(url)).router.create({ timeoutSec: 60 })).rejects.toThrow(/image pull failed/);
    expect(seen).toContain("POST /delete_session");
    await killsGone(openrewardProvider, env, 410, "POST");
    const broke = await mock(() => ({ status: 402, json: { detail: "Insufficient credits" } }));
    await refused(routerFor(openrewardProvider, env(broke.url)).router, "openreward", "quota");
  });
});
