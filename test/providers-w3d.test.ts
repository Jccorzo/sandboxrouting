// The adapters added in wave 3 on 2026-11-21 (Workpaper, Rayrun, tama, Tangle, Nirvana, agental),
// driven through the router against local servers that speak each provider's wire format: from
// its OpenAPI spec, its API reference, and the requests its official SDK sends. None has been run
// against the real service.
import { describe, expect, it } from "vitest";
import { fakeRun, lifecycle, mock, routerFor, type Reply } from "./restmock.js";
import { sbrName } from "../src/providers/rest-helpers.js";
import { NoProviderAvailableError, type ProviderAdapter, type SandboxRouter } from "../src/index.js";
import { workpaperProvider, workpaperSize } from "../src/providers/workpaper.js";
import { rayrunLabels, rayrunProvider } from "../src/providers/rayrun.js";
import { tamaProvider } from "../src/providers/tama.js";
import { tangleProvider, tangleTemplate } from "../src/providers/tangle.js";
import { nirvanaProvider } from "../src/providers/nirvana.js";
import { EXECD_PORT } from "../src/providers/opensandbox.js";
import { agentalMetadata, agentalProvider, agentalSize } from "../src/providers/agental.js";
import { decode, get, grpcWebFrame, pb, type Fields } from "../src/providers/grpc-web.js";

/** A create refused by the provider fails the plan with the given kind, and leaves that mark. */
async function refused(router: SandboxRouter, provider: string, kind: string) {
  const err = await router.create({ timeoutSec: 60 }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(NoProviderAvailableError);
  expect((err as NoProviderAvailableError).attempts[0]).toMatchObject({ provider, outcome: "failed", kind });
  expect((await router.ledger.read()).marks.some((m) => m.provider === provider && m.kind === kind)).toBe(true);
}

/** Deleting a sandbox the provider no longer has is not an error. */
async function killsGone(adapter: ProviderAdapter, env: (url: string) => Record<string, string>, reply: Reply = { status: 404, json: { error: "not found" } }) {
  const { url, seen } = await mock(() => reply);
  await expect(adapter.kill("gone-1", { env: env(url), options: {} })).resolves.toBeUndefined();
  expect(seen.length).toBeGreaterThan(0);
}

/** The command a mock receives, minus the env-file prefix the adapters add. */
const bare = (cmd: string) => cmd.replace(/^\[ -f \/tmp\/\.sbr-env \] && \. \/tmp\/\.sbr-env; /, "");

describe("sizes and labels", () => {
  it("maps a request to each provider's sizes and accepted labels", () => {
    expect(workpaperSize(2, 4096).templateID).toBe("workpaper-2c4g");
    expect(workpaperSize(3, 1024).templateID).toBe("workpaper-4c8g");
    expect(agentalSize(2, 4096).size).toBe("small");
    expect(agentalSize(1, 1024).size).toBe("tiny");
    expect(agentalSize(64, 1).size).toBe("large");
    expect(agentalMetadata({ "sandboxrouting.id": "a", Bad: "x", ok_key: "y" })).toEqual({ "sandboxrouting.id": "a", ok_key: "y" });
    const many = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, "v"]));
    const labels = rayrunLabels({ ...many, "sandboxrouting.id": "r1", "bad key": "x", empty: "" });
    expect(Object.keys(labels)).toHaveLength(16);
    expect(labels["sandboxrouting.id"]).toBe("r1");
    const t = [
      { templateID: "big", cpuCount: 4, memoryMB: 8192 },
      { templateID: "small", cpuCount: 2, memoryMB: 4096 },
    ];
    expect(tangleTemplate(t, 2, 4096)?.templateID).toBe("small");
    expect(tangleTemplate(t, 16, 4096)?.templateID).toBe("big");
  });

  it("prices 2 vCPU / 4 GiB as each provider's page does", () => {
    const perHour = (a: ProviderAdapter) => (a.info.pricing.vcpuSecondUsd * 2 + a.info.pricing.gibSecondUsd * 4) * 3600;
    expect(perHour(workpaperProvider)).toBeCloseTo(0.01, 6);
    expect(perHour(agentalProvider)).toBeCloseTo(0.027, 6);
    expect(perHour(tamaProvider)).toBeCloseTo(0.045412, 5);
    expect(perHour(tangleProvider)).toBeCloseTo(0.049095, 5);
    expect(perHour(nirvanaProvider)).toBeCloseTo(0.048, 6);
    // ¥0.10 an hour.
    expect(perHour(rayrunProvider)).toBeCloseTo(0.1 / 7.1, 6);
  });
});

describe("workpaper", () => {
  const env = (url: string) => ({ WORKPAPER_API_KEY: "wp_test", WORKPAPER_API_URL: url });

  it("creates a full computer, waits for it to run, keeps env in a file, and moves files", async () => {
    const files = new Map<string, Buffer>();
    let polls = 0;
    let busy = 1;
    const requestIds: string[] = [];
    const { url, seen } = await mock((r) => {
      if (r.headers["x-api-key"] !== "wp_test") return { status: 401, json: { message: "bad key" } };
      if (r.method === "POST" && r.path === "/v1/computers") {
        const b = r.json();
        expect(b).toMatchObject({ mode: "full", templateID: "workpaper-2c4g", metadata: { "sandboxrouting.id": expect.any(String) } });
        expect(b.name).toMatch(/^sbr-[0-9a-f]{16}$/);
        return { json: { sandboxID: "wp1", state: "starting", workpaperManaged: true, cpuCount: 2, memoryMB: 4096 } };
      }
      if (r.method === "GET" && r.path === "/v1/computers/wp1") return { json: { sandboxID: "wp1", state: polls++ < 1 ? "starting" : "running" } };
      if (r.path === "/v1/computers/wp1/files") {
        const p = r.query.get("path")!;
        if (r.method === "PUT") return files.set(p, r.body), { json: {} };
        return files.has(p) ? { raw: files.get(p)! } : { status: 404, json: { message: "no such file" } };
      }
      if (r.method === "POST" && r.path === "/v1/computers/wp1/exec") {
        const b = r.json();
        requestIds.push(b.requestID);
        // One host_busy, retried with the same request id.
        if (busy-- > 0) return { status: 503, json: { message: "busy", reason: "host_busy" } };
        const x = fakeRun(bare(b.command));
        return { json: { exitCode: x.code, stdout: x.stdout, stderr: x.stderr } };
      }
      if (r.method === "DELETE" && r.path === "/v1/computers/wp1") return { json: {} };
      return undefined;
    });
    const { router } = routerFor(workpaperProvider, env(url));
    const sbx = await router.create({ timeoutSec: 120, env: { TOKEN: "s3cret" } });
    expect(String(files.get("/tmp/.sbr-env"))).toBe("export TOKEN='s3cret'\n");
    expect((await sbx.commands.run("echo hi")).stdout).toContain("echo hi");
    expect(new Set(requestIds.slice(0, 2)).size).toBe(1);
    expect((await sbx.commands.run("exit 3")).exitCode).toBe(3);
    await sbx.files.write("/tmp/a.txt", "hello");
    expect(await sbx.files.read("/tmp/a.txt")).toBe("hello");
    await sbx.kill();
    expect(seen).toContain("DELETE /v1/computers/wp1");
  });

  it("adopts the computer a retried create already made, and treats a 404 delete as gone", async () => {
    const { url, seen } = await mock((r) => {
      if (r.method === "POST" && r.path === "/v1/computers") return { status: 409, json: { message: "there's already a computer named that" } };
      if (r.method === "GET" && r.path === "/v1/computers") {
        return { json: [{ sandboxID: "other", state: "running", metadata: { "workpaper.name": "someone-else" } }] };
      }
      return undefined;
    });
    const ctx = { env: env(url), options: { pollMs: 1 } };
    const spec = { cpu: 2, memoryMiB: 4096, timeoutSec: 60, env: {}, metadata: { "sandboxrouting.id": "seed-1" } };
    const name = sbrName(spec);
    const fixed = await mock((r) => {
      if (r.method === "POST" && r.path === "/v1/computers") return { status: 409, json: { message: "exists" } };
      if (r.method === "GET" && r.path === "/v1/computers") return { json: [{ sandboxID: "mine", state: "running", metadata: { "workpaper.name": name } }] };
      return undefined;
    });
    expect((await workpaperProvider.create(spec, { env: env(fixed.url), options: { pollMs: 1 } })).providerSandboxId).toBe("mine");
    // No computer of that name: the 409 stands.
    await expect(workpaperProvider.create(spec, ctx)).rejects.toThrow(/409/);
    expect(seen).toContain("GET /v1/computers");
    await killsGone(workpaperProvider, env);
  });

  it("marks a refused key as auth", async () => {
    const { url } = await mock(() => ({ status: 401, json: { message: "invalid API key" } }));
    await refused(routerFor(workpaperProvider, env(url)).router, "workpaper", "auth");
  });
});

describe("rayrun", () => {
  const env = (url: string) => ({ RAYRUN_TOKEN: "rr_test", RAYRUN_API_URL: url });

  it("creates with an idempotency key and open egress, runs commands, and publishes a port", async () => {
    let state = "Creating";
    const envFile: string[] = [];
    const { url, seen } = await mock((r) => {
      if (r.headers.authorization !== "Bearer rr_test") return { status: 401, json: { error: "unauthenticated" } };
      if (r.method === "POST" && r.path === "/sandboxes") {
        expect(r.headers["idempotency-key"]).toBeTruthy();
        const b = r.json();
        expect(b).toMatchObject({ agent: "ubuntu@1", cpu_cores: 2, memory_mb: 4096, max_lifetime_seconds: 120, egress: { allow_all: true } });
        expect(b.name).toMatch(/^sbr-/);
        expect(b.labels["sandboxrouting.id"]).toBeTruthy();
        return { status: 201, json: { id: "rr1", status: state, cpu_cores: 2, memory_mb: 4096 } };
      }
      if (r.method === "GET" && r.path === "/sandboxes/rr1") {
        state = "Running";
        return { json: { id: "rr1", status: state } };
      }
      if (r.method === "POST" && r.path === "/sandboxes/rr1/exec") {
        const b = r.json();
        expect(b.timeout_seconds).toBeLessThanOrEqual(3600);
        if (/sbr-env/.test(b.command) && /printf/.test(b.command)) return envFile.push(b.command), { json: { exit_code: 0, stdout: "", stderr: "" } };
        if (b.command.includes("sleep 99")) return { json: { exit_code: null, stdout: "", stderr: "", timed_out: true } };
        const x = fakeRun(bare(b.command));
        return { json: { exec_id: "e", exit_code: x.code, stdout: x.stdout, stderr: x.stderr, timed_out: false, truncated: false } };
      }
      if (r.method === "PUT" && r.path === "/sandboxes/rr1/ingress/8080") {
        expect(r.json()).toEqual({ visibility: "public", protocol: "http" });
        return { json: { port: 8080, visibility: "public", protocol: "http", url: "https://8080-rr1.rayrunos.com" } };
      }
      if (r.method === "DELETE" && r.path === "/sandboxes/rr1") return { status: 204, raw: "" };
      return undefined;
    });
    const { router } = routerFor(rayrunProvider, env(url));
    const sbx = await router.create({ timeoutSec: 120, env: { A: "1" } });
    // The file's `export A='1'` line, quoted once more for the shell that writes it.
    expect(envFile[0]).toMatch(/> \/tmp\/\.sbr-env$/);
    expect(envFile[0]).toContain("export A=");
    expect((await sbx.commands.run("echo hi")).stdout).toContain("echo hi");
    expect((await sbx.commands.run("exit 3")).exitCode).toBe(3);
    expect((await sbx.commands.run("sleep 99", { timeoutSec: 2 })).exitCode).toBe(124);
    expect(await rayrunProvider.getUrl!("rr1", 8080, { env: env(url), options: {} })).toBe("https://8080-rr1.rayrunos.com");
    await sbx.kill();
    expect(seen).toContain("DELETE /sandboxes/rr1");
    await killsGone(rayrunProvider, env);
  });

  it("marks a spent balance (403 insufficient_balance) as quota, not a bad key", async () => {
    const { url } = await mock(() => ({ status: 403, json: { error: "insufficient_balance", message: "余额不足" } }));
    await refused(routerFor(rayrunProvider, env(url)).router, "rayrun", "quota");
  });

  it("deletes a sandbox that terminated while starting", async () => {
    const { url, seen } = await mock((r) => {
      if (r.method === "POST" && r.path === "/sandboxes") return { status: 201, json: { id: "rr2", status: "Creating" } };
      if (r.method === "GET" && r.path === "/sandboxes/rr2") return { json: { id: "rr2", status: "Terminated" } };
      if (r.method === "DELETE") return { status: 204, raw: "" };
      return undefined;
    });
    const spec = { cpu: 1, memoryMiB: 1024, timeoutSec: 60, env: {}, metadata: {} };
    await expect(rayrunProvider.create(spec, { env: env(url), options: { pollMs: 1 } })).rejects.toThrow(/Terminated/);
    expect(seen).toContain("DELETE /sandboxes/rr2");
  });
});

describe("tama", () => {
  const env = (url: string) => ({ TAMA_TOKEN: "tama_test", TAMA_API_URL: url });
  /** A gRPC-Web reply: one message frame and an OK trailer. */
  const ok = (fields: number[]): Reply => {
    const trailer = Buffer.from("grpc-status:0\r\ngrpc-message:\r\n");
    const head = Buffer.alloc(5);
    head[0] = 0x80;
    head.writeUInt32BE(trailer.length, 1);
    return { type: "application/grpc-web+proto", raw: Buffer.concat([Buffer.from(grpcWebFrame(fields)), head, trailer]) };
  };
  const fail = (code: number, message: string): Reply => ({ type: "application/grpc-web+proto", headers: { "grpc-status": String(code), "grpc-message": encodeURIComponent(message) }, raw: "" });
  const machine = (id: string, status: number) => [...pb.str(1, id), ...pb.str(2, `name-${id}`), ...pb.uint(3, status), ...pb.msg(4, [...pb.uint(1, 2000), ...pb.uint(2, 4096)])];
  const request = (body: Buffer): Fields => decode(body.subarray(5));

  it("creates a machine over gRPC-Web, waits for READY, runs commands and lists files", async () => {
    let polls = 0;
    const { url, seen } = await mock((r) => {
      if (r.headers.authorization !== "Bearer tama_test") return fail(16, "invalid or missing token");
      expect(r.headers["content-type"]).toBe("application/grpc-web+proto");
      const m = /^\/api\.v1\.ApiService\/(\w+)$/.exec(r.path)?.[1];
      const f = request(r.body);
      if (m === "CreateMachine") {
        const spec = get.msg(f, 1)!;
        expect(get.str(spec, 1)).toMatch(/^sbr-/);
        const res = get.msg(spec, 3)!;
        expect([get.int(res, 1), get.int(res, 2)]).toEqual([2000, 4096]);
        expect(get.int(spec, 7)).toBe(120);
        expect(spec.get(10)?.map((v) => new TextDecoder().decode(v as Uint8Array))).toEqual(["A=1"]);
        expect(get.str(spec, 12)).toBe("auto");
        return ok(pb.msg(1, machine("m1", 1)));
      }
      if (m === "GetMachine") {
        expect(get.str(f, 1)).toBe("m1");
        return ok(pb.msg(1, machine("m1", polls++ < 1 ? 2 : 3)));
      }
      if (m === "Exec") {
        expect(get.str(f, 1)).toBe("m1");
        const x = fakeRun(get.str(f, 2));
        return ok([...pb.str(1, x.stdout), ...pb.str(2, x.stderr), ...pb.uint(3, x.code)]);
      }
      if (m === "ListFiles") return ok([...pb.str(1, "/workspace"), ...pb.msg(2, [...pb.str(1, "a.txt"), ...pb.uint(3, 5)]), ...pb.msg(2, [...pb.str(1, "src"), ...pb.bool(2, true)])]);
      if (m === "ExposePort") return ok(pb.str(1, `https://m1-${get.int(f, 2)}.tama.run`));
      if (m === "DeleteMachine") return ok([]);
      return undefined;
    });
    const { router } = routerFor(tamaProvider, env(url));
    const sbx = await router.create({ timeoutSec: 120, cpu: 2, memoryMiB: 4096, env: { A: "1" } });
    expect(sbx.providerSandboxId).toBe("m1");
    expect((await sbx.commands.run("echo hi")).stdout).toContain("echo hi");
    expect((await sbx.commands.run("exit 3")).exitCode).toBe(3);
    const ctx = { env: env(url), options: {} };
    expect(await tamaProvider.listFiles!("m1", "/workspace", ctx)).toEqual([
      { name: "a.txt", path: "/workspace/a.txt", isDir: false, size: 5 },
      { name: "src", path: "/workspace/src", isDir: true, size: 0 },
    ]);
    expect(await tamaProvider.getUrl!("m1", 3000, ctx)).toBe("https://m1-3000.tama.run");
    await sbx.kill();
    expect(seen).toContain("POST /api.v1.ApiService/DeleteMachine");
  });

  it("deletes a machine that failed to provision, treats NOT_FOUND on delete as gone, and marks a bad token", async () => {
    const { url, seen } = await mock((r) => {
      if (r.path.endsWith("/CreateMachine")) return ok(pb.msg(1, machine("bad", 1)));
      if (r.path.endsWith("/GetMachine")) return ok(pb.msg(1, [...machine("bad", 6), ...pb.str(15, "no capacity")]));
      if (r.path.endsWith("/DeleteMachine")) return ok([]);
      return undefined;
    });
    const spec = { cpu: 1, memoryMiB: 1024, timeoutSec: 60, env: {}, metadata: {} };
    await expect(tamaProvider.create(spec, { env: env(url), options: { pollMs: 1 } })).rejects.toThrow(/failed to provision: no capacity/);
    expect(seen).toContain("POST /api.v1.ApiService/DeleteMachine");
    await killsGone(tamaProvider, env, fail(5, "machine not found"));
    const bad = await mock(() => fail(16, "invalid or missing token"));
    await refused(routerFor(tamaProvider, env(bad.url)).router, "tama", "auth");
  });
});

describe("tangle", () => {
  const env = (url: string) => ({ TANGLE_API_KEY: "sk-tan-test", TANGLE_API_URL: url });

  it("picks a template, creates, runs commands (reading an early answer to the end), and moves files", async () => {
    const files = new Map<string, Buffer>();
    let reads = 0;
    const { url, seen } = await mock((r) => {
      if (r.headers.authorization !== "Bearer sk-tan-test") return { status: 401, json: { error: { code: 401, message: "Missing or invalid API key" } } };
      if (r.method === "GET" && r.path === "/e2b/templates") {
        return { json: [{ templateID: "opencode-big", cpuCount: 4, memoryMB: 8192, public: true }, { templateID: "opencode", cpuCount: 2, memoryMB: 4096, public: true }] };
      }
      if (r.method === "POST" && r.path === "/e2b/sandboxes") {
        expect(r.json()).toMatchObject({ templateID: "opencode", timeout: 120, envVars: { A: "1" }, metadata: { "sandboxrouting.id": expect.any(String) } });
        return { status: 201, json: { sandboxID: "tg1", clientID: "c", envdVersion: "1", templateID: "opencode" } };
      }
      if (r.method === "POST" && r.path === "/e2b/sandboxes/tg1/processes") {
        const b = r.json();
        if (b.cmd === "slow") return { json: { pid: "7", command: "slow", status: "running", exitCode: null, stdout: "", stderr: "" } };
        const x = fakeRun(b.cmd);
        return { json: { pid: "1", command: b.cmd, status: "exited", exitCode: x.code, stdout: x.stdout, stderr: x.stderr } };
      }
      if (r.method === "GET" && r.path === "/e2b/sandboxes/tg1/processes/7") {
        return { json: { pid: "7", status: ++reads < 2 ? "running" : "exited", exitCode: reads < 2 ? null : 0, stdout: "done\n", stderr: "" } };
      }
      if (r.path === "/e2b/sandboxes/tg1/files") {
        const p = r.query.get("path")!;
        if (r.method === "POST") return files.set(p, r.body), { json: { path: p, size: r.body.length } };
        return { raw: files.get(p) ?? "" };
      }
      if (r.path === "/e2b/sandboxes/tg1/files/list") return { json: { entries: [{ name: "a.txt", type: "file", path: "/tmp/a.txt", size: 5 }] } };
      if (r.method === "DELETE" && r.path === "/e2b/sandboxes/tg1") return { status: 204, raw: "" };
      return undefined;
    });
    const { router } = routerFor(tangleProvider, env(url));
    const sbx = await router.create({ timeoutSec: 120, env: { A: "1" } });
    expect((await sbx.commands.run("echo hi")).stdout).toContain("echo hi");
    expect((await sbx.commands.run("exit 3")).exitCode).toBe(3);
    expect(await sbx.commands.run("slow")).toMatchObject({ stdout: "done\n", exitCode: 0 });
    await sbx.files.write("/tmp/a.txt", "hello");
    expect(await sbx.files.read("/tmp/a.txt")).toBe("hello");
    expect(await tangleProvider.listFiles!("tg1", "/tmp", { env: env(url), options: {} })).toEqual([{ name: "a.txt", path: "/tmp/a.txt", isDir: false, size: 5 }]);
    await sbx.kill();
    expect(seen).toContain("DELETE /e2b/sandboxes/tg1");
    await killsGone(tangleProvider, env);
  });

  it("marks no prepaid credit (402) as quota", async () => {
    const { url } = await mock((r) =>
      r.path === "/e2b/templates" ? { json: [{ templateID: "t", cpuCount: 2, memoryMB: 4096, public: true }] } : { status: 402, json: { error: { code: 402, message: "Prepaid credit required" } } },
    );
    await refused(routerFor(tangleProvider, env(url)).router, "tangle", "quota");
  });
});

describe("nirvana", () => {
  const env = (url: string) => ({ NIRVANA_API_KEY: "nv_test", NIRVANA_SANDBOX_CLUSTER_ID: "cluster-1", NIRVANA_API_URL: url });

  it("creates on the cluster named in extensions and runs commands through the signed execd endpoint", async () => {
    let host = "";
    let polls = 0;
    const { url, seen } = await mock((r) => {
      if (r.path.startsWith("/gw/")) {
        if (r.headers["opensandbox-ingress-to"] !== "nv1-44772-tok") return { status: 403, json: {} };
        const at = r.path.replace(/^\/gw/, "");
        if (at === "/ping") return { json: {} };
        if (at === "/command") {
          const x = fakeRun(r.json().command);
          const events = [...(x.stdout ? [{ type: "stdout", text: x.stdout }] : []), x.code === 0 ? { type: "execution_complete" } : { type: "error", error: { ename: "CommandExecError", evalue: String(x.code), exit_code: x.code } }];
          return { type: "text/event-stream", raw: events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") };
        }
        return undefined;
      }
      if (r.headers["open-sandbox-api-key"] !== "nv_test") return { status: 401, json: { code: "UNAUTHORIZED", message: "invalid api key" } };
      if (r.method === "POST" && r.path === "/v1/sandboxes") {
        const b = r.json();
        expect(b).toMatchObject({ image: { uri: "python:3.12-slim" }, extensions: { "nirvana.sandbox_cluster_id": "cluster-1" }, resourceLimits: { cpu: "2", memory: "4096Mi" } });
        expect(b.snapshotId).toBeUndefined();
        return { json: { id: "nv1", status: { state: "Pending" }, extensions: { "nirvana.sandbox_cluster_id": "cluster-1", "nirvana.region": "us-sva-2" } } };
      }
      if (r.method === "GET" && r.path === "/v1/sandboxes/nv1") return { json: { id: "nv1", status: { state: polls++ < 1 ? "Pending" : "Running" } } };
      if (r.path === `/v1/sandboxes/nv1/endpoints/${EXECD_PORT}`) return { json: { endpoint: `${host}/gw`, headers: { "OpenSandbox-Ingress-To": "nv1-44772-tok" } } };
      if (r.method === "DELETE" && r.path === "/v1/sandboxes/nv1") return { status: 204, raw: "" };
      return undefined;
    });
    host = url.replace("http://", "");
    const { router } = routerFor(nirvanaProvider, env(url));
    await lifecycle(router);
    expect(seen).toContain("DELETE /v1/sandboxes/nv1");
    expect(nirvanaProvider.pause).toBeUndefined();
    await killsGone(nirvanaProvider, env, { status: 204, raw: "" });
  });

  it("lists sandboxes page by page without hasNextPage, and marks a bad key as auth", async () => {
    const page = (n: number, count: number) => Array.from({ length: count }, (_, i) => ({ id: `s${n}-${i}`, status: { state: "Running" } }));
    const { url } = await mock((r) => {
      if (r.path !== "/v1/sandboxes" || r.method !== "GET") return { status: 401, json: { code: "UNAUTHORIZED", message: "invalid api key" } };
      const p = Number(r.query.get("page"));
      return { json: { items: page(p, p === 1 ? 100 : 3), pagination: { page: p, pageSize: 100 } } };
    });
    expect(await nirvanaProvider.listAlive!({ env: env(url), options: {} })).toHaveLength(103);
    await refused(routerFor(nirvanaProvider, env(url)).router, "nirvana", "auth");
  });
});

describe("agental", () => {
  const env = (url: string) => ({ AGENTAL_API_KEY: "ag_test", AGENTAL_API_URL: url });

  it("creates with an idempotency key (resending on 202), keeps env in a file, and runs short and long commands", async () => {
    const files = new Map<string, Buffer>();
    let creates = 0;
    let polls = 0;
    const keys: string[] = [];
    const { url, seen } = await mock((r) => {
      if (r.headers.authorization !== "Bearer ag_test") return { status: 401, json: { error: { code: "unauthorized", message: "API key missing or wrong" } } };
      if (r.method === "POST" && r.path === "/v1/sandboxes") {
        keys.push(String(r.headers["idempotency-key"]));
        expect(r.json()).toMatchObject({ size: "small", ttlSeconds: 120, onTimeout: "delete", metadata: { "sandboxrouting.id": expect.any(String) } });
        return creates++ < 1 ? { status: 202, json: { status: "accepted" } } : { status: 201, json: { id: "sbx_1", status: "creating" } };
      }
      if (r.method === "GET" && r.path === "/v1/sandboxes/sbx_1") return { json: { id: "sbx_1", status: polls++ < 1 ? "creating" : "running" } };
      if (r.path === "/v1/sandboxes/sbx_1/files") {
        if (r.method === "PUT") {
          const b = r.json();
          return files.set(b.path, b.base64 !== undefined ? Buffer.from(b.base64, "base64") : Buffer.from(b.text)), { json: { path: b.path, bytes: 1 } };
        }
        expect(r.query.get("encoding")).toBe("base64");
        return { json: { path: r.query.get("path"), encoding: "base64", base64: files.get(r.query.get("path")!)?.toString("base64") ?? "" } };
      }
      if (r.method === "POST" && r.path === "/v1/sandboxes/sbx_1/exec") {
        const b = r.json();
        expect(b.command.slice(0, 2)).toEqual(["sh", "-c"]);
        expect(b.timeoutMs).toBeLessThanOrEqual(90_000);
        const x = fakeRun(bare(b.command[2]));
        return { json: { exitCode: x.code, stdout: x.stdout, stderr: x.stderr, truncated: false } };
      }
      if (r.method === "POST" && r.path === "/v1/sandboxes/sbx_1/commands") {
        expect(r.json().timeoutMs).toBe(300_000);
        return { status: 201, json: { id: "cmd_1", pid: 9, status: "running" } };
      }
      if (r.method === "GET" && r.path === "/v1/sandboxes/sbx_1/commands/cmd_1") return { json: { id: "cmd_1", status: "timed_out", exitCode: null, stdout: "partial\n", stderr: "" } };
      if (r.method === "DELETE" && r.path === "/v1/sandboxes/sbx_1") {
        expect(r.headers["x-agental-confirm-delete"]).toBe("sbx_1");
        expect(r.query.get("pauseJobs")).toBe("true");
        return { status: 204, raw: "" };
      }
      return undefined;
    });
    const { router } = routerFor(agentalProvider, env(url));
    const sbx = await router.create({ timeoutSec: 120, env: { A: "1" } });
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    expect(String(files.get("/tmp/.sbr-env"))).toBe("export A='1'\n");
    expect((await sbx.commands.run("echo hi", { timeoutSec: 30 })).stdout).toContain("echo hi");
    expect((await sbx.commands.run("exit 3", { timeoutSec: 30 })).exitCode).toBe(3);
    expect(await sbx.commands.run("make all", { timeoutSec: 300 })).toMatchObject({ exitCode: 124, stdout: "partial\n" });
    await sbx.files.write("/tmp/a.txt", "hello");
    expect(await sbx.files.read("/tmp/a.txt")).toBe("hello");
    await sbx.kill();
    expect(seen).toContain("DELETE /v1/sandboxes/sbx_1");
    await killsGone(agentalProvider, env);
  });

  it("marks out of credit (402) and a spent burst budget (429) as quota, and too many running (429) as rate_limit", async () => {
    const answer = (status: number, code: string): Promise<{ url: string }> => mock(() => ({ status, json: { error: { code, message: code } } }));
    await refused(routerFor(agentalProvider, env((await answer(402, "out_of_credit")).url)).router, "agental", "quota");
    await refused(routerFor(agentalProvider, env((await answer(429, "burst_budget_reached")).url)).router, "agental", "quota");
    await refused(routerFor(agentalProvider, env((await answer(429, "running_limit_reached")).url)).router, "agental", "rate_limit");
  });

  it("deletes a sandbox that ends in error while starting", async () => {
    const { url, seen } = await mock((r) => {
      if (r.method === "POST" && r.path === "/v1/sandboxes") return { status: 201, json: { id: "sbx_bad", status: "creating" } };
      if (r.method === "GET" && r.path === "/v1/sandboxes/sbx_bad") return { json: { id: "sbx_bad", status: "error", error: "host failed" } };
      if (r.method === "DELETE") return { status: 204, raw: "" };
      return undefined;
    });
    const spec = { cpu: 2, memoryMiB: 4096, timeoutSec: 60, env: {}, metadata: {} };
    await expect(agentalProvider.create(spec, { env: env(url), options: { pollMs: 1 } })).rejects.toThrow(/error: host failed/);
    expect(seen).toContain("DELETE /v1/sandboxes/sbx_bad");
  });
});
