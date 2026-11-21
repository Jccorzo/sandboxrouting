// The adapters added in wave 3 on 2026-11-21 (Cyqle, machine0, Hyperbrowser, Lightcone, offstage
// cloud, Islo), driven against local servers that speak each provider's wire format: from its
// API reference or OpenAPI spec, and the requests its official SDK sends. None has been run
// against the real service. Also the request's `os`, which offstage (macOS) needs.
import { describe, expect, it } from "vitest";
import { deletedAtDeadline, fakeRun, lifecycle, mock, routerFor, type Req } from "./restmock.js";
import { NoProviderAvailableError, SandboxRouter, MemoryLedger, type ProviderAdapter, type SandboxRouter as Router } from "../src/index.js";
import { offstageProvider } from "../src/providers/offstage.js";
import { hyperbrowserProvider } from "../src/providers/hyperbrowser.js";
import { lightconeProvider } from "../src/providers/lightcone.js";
import { cyqleProvider } from "../src/providers/cyqle.js";
import { isloProvider } from "../src/providers/islo.js";
import { machine0Provider, machine0Size } from "../src/providers/machine0.js";
import { ratePerSecond } from "../src/core/metering.js";

/** A create refused by the provider fails the plan with the given kind, and leaves that mark. */
async function refused(router: Router, provider: string, kind: string, spec = {}) {
  const err = await router.create({ timeoutSec: 60, ...spec }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(NoProviderAvailableError);
  expect((err as NoProviderAvailableError).attempts[0]).toMatchObject({ provider, outcome: "failed", kind });
  expect((await router.ledger.read()).marks.some((m) => m.provider === provider && m.kind === kind)).toBe(true);
}

/** Deleting a sandbox the provider no longer has is not an error. */
async function killsGone(adapter: ProviderAdapter, env: (url: string) => Record<string, string>, id: string) {
  const { url, seen } = await mock((r) => (r.method === "DELETE" || r.method === "PUT" ? { status: 404, json: { error: "not found" } } : undefined));
  await expect(adapter.kill(id, { env: env(url), options: {} })).resolves.toBeUndefined();
  expect(seen.length).toBeGreaterThan(0);
}

const perHour = (p: ProviderAdapter, cpu: number, mem: number) => ratePerSecond(p.info.pricing, cpu, mem) * 3600;

describe("terms", () => {
  it("prices each at 2 vCPU / 4 GiB as its page does", () => {
    expect(perHour(hyperbrowserProvider, 2, 4096)).toBeCloseTo(0.15, 9);
    expect(perHour(machine0Provider, 2, 4096)).toBeCloseTo(0.052, 9);
    expect(perHour(machine0Provider, 4, 8192)).toBeCloseTo(0.104, 9);
    expect(perHour(cyqleProvider, 2, 4096)).toBeCloseTo(0.04, 9);
    expect(perHour(lightconeProvider, 2, 4096)).toBeCloseTo(1.14, 9);
    expect(perHour(offstageProvider, 2, 4096)).toBeCloseTo(1.1, 9);
    expect(perHour(isloProvider, 2, 4096)).toBeCloseTo(20 / 744, 9);
    expect(lightconeProvider.info.pricing.billing).toBe("active-cpu");
    expect(offstageProvider.info.os).toBe("macos");
  });

  it("maps machine0 sizes", () => {
    expect(machine0Size(2, 4096).size).toBe("large");
    expect(machine0Size(2, 2048).size).toBe("medium");
    expect(machine0Size(1, 512).size).toBe("small");
    expect(machine0Size(999, 1).size).toBe("4xl");
  });
});

describe("os", () => {
  const offstageEnv = (url: string) => ({ OFFSTAGE_API_KEY: "sk_offstage_t", OFFSTAGE_API_URL: url });
  const lightEnv = (url: string) => ({ TZAFON_API_KEY: "sk_t", LIGHTCONE_BASE_URL: url });

  it("keeps a request that doesn't ask for macOS off the Mac provider, and the other way round", async () => {
    const r = new SandboxRouter({
      providers: [offstageProvider, lightconeProvider],
      ledger: new MemoryLedger(),
      env: { ...offstageEnv("http://127.0.0.1:9"), ...lightEnv("http://127.0.0.1:9") },
      config: { allowPaid: true },
    });
    const linux = await r.plan({ timeoutSec: 60 });
    expect(linux.ordered.map((e) => e.provider)).toEqual(["lightcone"]);
    expect(linux.skipped).toContainEqual(expect.objectContaining({ provider: "offstage", reason: "runs macos, not linux" }));
    const mac = await r.plan({ timeoutSec: 60, os: "macos" });
    expect(mac.ordered.map((e) => e.provider)).toEqual(["offstage"]);
    expect(mac.skipped).toContainEqual(expect.objectContaining({ provider: "lightcone", reason: "runs linux, not macos" }));
    await expect(r.plan({ os: "windows" as never })).rejects.toMatchObject({ kind: "invalid", message: expect.stringMatching(/linux, macos/) });
  });
});

describe("offstage", () => {
  const env = (url: string) => ({ OFFSTAGE_API_KEY: "sk_offstage_t", OFFSTAGE_API_URL: url });

  it("waits for a Mac slot, follows long commands, moves relative files, extends and kills", async () => {
    const files = new Map<string, Buffer>();
    let polls = 0;
    let state = "pending";
    const cmds: Req[] = [];
    const { url, seen } = await mock((r) => {
      if (r.headers.authorization !== "Bearer sk_offstage_t") return { status: 401, json: { error: { code: "unauthorized" } } };
      if (r.method === "POST" && r.path === "/sandboxes") {
        expect(r.headers["idempotency-key"]).toEqual(expect.any(String));
        // The idle timeout is raised to the lifetime, or an idle box would close after 10 min.
        expect(r.json()).toEqual({ session: "headless", timeoutMs: 120_000, idleTimeoutMs: 120_000 });
        return { status: 201, json: { id: "sbx_1", state: "pending" } };
      }
      if (r.method === "GET" && r.path === "/sandboxes/sbx_1") {
        if (state === "pending" && polls++ >= 1) state = "ready";
        return { json: { id: "sbx_1", state } };
      }
      if (r.method === "POST" && r.path === "/sandboxes/sbx_1/commands") {
        cmds.push(r);
        const b = r.json();
        if (b.cmd.includes("slow")) return { status: 202, json: { commandId: "cmd_2", state: "running", startedAt: 1 } };
        const out = fakeRun(b.cmd);
        return { json: { commandId: "cmd_1", state: "finished", exitCode: out.code, timedOut: false, stdout: out.stdout, stderr: out.stderr } };
      }
      if (r.method === "GET" && r.path === "/sandboxes/sbx_1/commands/cmd_2") {
        expect(r.query.get("wait")).toBe("50");
        return { json: { commandId: "cmd_2", state: "finished", exitCode: null, timedOut: true, stdout: "partial", stderr: "" } };
      }
      if (r.path === "/sandboxes/sbx_1/files") {
        const p = r.query.get("path")!;
        if (r.method === "PUT") {
          files.set(p, r.body);
          return { json: { path: p, bytes: r.body.length } };
        }
        return files.has(p) ? { raw: files.get(p)! } : { status: 404, json: { error: { code: "file-not-found" } } };
      }
      if (r.method === "POST" && r.path === "/sandboxes/sbx_1/timeout") return { json: { id: "sbx_1", state: "ready", ...r.json() } };
      if (r.method === "DELETE" && r.path === "/sandboxes/sbx_1") {
        state = "closed";
        return { json: { id: "sbx_1", state: "closed", closeReason: "deleted" } };
      }
      return undefined;
    });
    const { router } = routerFor(offstageProvider, env(url));
    const sbx = await router.create({ timeoutSec: 120, os: "macos", env: { TOKEN: "a b" } });
    expect(sbx.provider).toBe("offstage");
    // Create takes no env: it goes into ~/.zprofile, which every `zsh -lc` reads.
    expect(cmds[0]!.json().cmd).toContain("cat >> ~/.zprofile <<'SBR_ENV'\nexport TOKEN='a b'\n");
    const ok = await sbx.commands.run("echo hi", { cwd: "src", env: { CI: "1" } });
    expect(ok).toMatchObject({ exitCode: 0, stdout: expect.stringContaining("echo hi") });
    expect(cmds[1]!.json()).toMatchObject({ cmd: "echo hi", cwd: "src", envs: { CI: "1" }, timeoutMs: expect.any(Number) });
    expect((await sbx.commands.run("exit 3")).exitCode).toBe(3);
    // An absolute cwd and a lowercase variable name are inlined.
    await sbx.commands.run("pwd", { cwd: "/tmp", env: { lower: "x" } });
    expect(cmds.at(-1)!.json()).toMatchObject({ cmd: "export lower='x'; cd '/tmp' && pwd" });
    expect(cmds.at(-1)!.json().cwd).toBeUndefined();
    // Answered 202, followed until finished; killed at its timeout → 124.
    expect(await sbx.commands.run("slow build")).toMatchObject({ exitCode: 124, stdout: "partial" });
    // Relative paths use the file API; absolute ones the router's exec fallback.
    const ctx = { env: env(url), options: {} };
    await offstageProvider.writeFile("sbx_1", "out/a.txt", new TextEncoder().encode("hello"), ctx);
    expect(new TextDecoder().decode(await offstageProvider.readFile("sbx_1", "out/a.txt", ctx))).toBe("hello");
    await expect(offstageProvider.readFile("sbx_1", "/etc/hosts", ctx)).rejects.toMatchObject({ kind: "unsupported" });
    await offstageProvider.setTimeout!("sbx_1", 600, ctx);
    await sbx.kill();
    expect(seen).toContain("DELETE /sandboxes/sbx_1");
    expect((await sbx.info())!.state).toBe("stopped");
  });

  it("kills a sandbox whose create failed after offstage made it", async () => {
    const { url, seen } = await mock((r) => {
      if (r.method === "POST" && r.path === "/sandboxes") return { status: 201, json: { id: "sbx_9", state: "pending" } };
      if (r.method === "GET" && r.path === "/sandboxes/sbx_9") return { json: { id: "sbx_9", state: "closed", closeReason: "no-capacity" } };
      if (r.method === "DELETE") return { json: { id: "sbx_9", state: "closed" } };
      return undefined;
    });
    const { router } = routerFor(offstageProvider, env(url));
    await expect(router.create({ timeoutSec: 60, os: "macos" })).rejects.toThrow(/no-capacity/);
    expect(seen).toContain("DELETE /sandboxes/sbx_9");
  });

  it("marks no free Mac as a rate limit and spent credit as quota", async () => {
    let status = 409;
    const { url } = await mock(() =>
      status === 409
        ? { status, json: { error: { code: "no-capacity", message: "no slot takes this session" } } }
        : { status, json: { error: { code: "payment-method-required", message: "the available credit cannot cover this work" } } },
    );
    await refused(routerFor(offstageProvider, env(url)).router, "offstage", "rate_limit", { os: "macos" });
    status = 402;
    await refused(routerFor(offstageProvider, env(url)).router, "offstage", "quota", { os: "macos" });
  });

  it("treats a sandbox that is already gone as killed", () => killsGone(offstageProvider, env, "sbx_gone"));
});

describe("hyperbrowser", () => {
  const env = (url: string) => ({ HYPERBROWSER_API_KEY: "hb_t", HYPERBROWSER_API_URL: url });

  it("runs commands and files on the sandbox's runtime, minting its token again when refused", async () => {
    const files = new Map<string, Buffer>();
    let token = "t1";
    let refuseOnce = false;
    let polls = 0;
    const { url, seen } = await mock((r) => {
      const rt = r.path.startsWith("/rt/hb1");
      if (rt) {
        if (refuseOnce) {
          refuseOnce = false;
          return { status: 401, json: { error: "token expired" } };
        }
        if (r.headers.authorization !== `Bearer ${token}`) return { status: 401, json: {} };
      } else if (r.headers["x-api-key"] !== "hb_t") return { status: 401, json: {} };
      const sandbox = (status: string) => ({ id: "hb1", status, vcpus: 2, memMiB: 4096, runtime: { baseUrl: `${url}/rt/hb1` }, token, tokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString() });
      if (r.method === "POST" && r.path === "/sandbox") {
        expect(r.json()).toMatchObject({ imageName: "node", vcpus: 2, memMiB: 2048, timeoutMinutes: 2 });
        return { json: { ...sandbox("provisioning"), runtime: null, token: null } };
      }
      if (r.method === "GET" && r.path === "/sandbox/hb1") return { json: sandbox(polls++ < 1 ? "provisioning" : "active") };
      if (r.method === "POST" && r.path === "/rt/hb1/exec") {
        const out = fakeRun(r.json().command);
        return { json: { result: { stdout: out.stdout, stderr: out.stderr, exitCode: out.code } } };
      }
      if (r.method === "POST" && r.path === "/rt/hb1/files/write") {
        const b = r.json();
        expect(b.encoding).toBe("base64");
        files.set(b.path, Buffer.from(b.data, "base64"));
        return { json: { files: [{ path: b.path, name: "x", type: "file" }] } };
      }
      if (r.method === "POST" && r.path === "/rt/hb1/files/read") {
        const f = files.get(r.json().path);
        return f ? { json: { content: f.toString("base64") } } : { status: 404, json: { error: "not found" } };
      }
      if (r.method === "GET" && r.path === "/rt/hb1/files") return { json: { entries: [{ name: "a.txt", path: "/tmp/a.txt", type: "file", size: 5 }, { name: "d", path: "/tmp/d", type: "dir" }] } };
      if (r.method === "POST" && r.path === "/sandbox/hb1/expose") return { json: { port: r.json().port, auth: false, url: "https://3000-hb1.example" } };
      if (r.method === "PUT" && r.path === "/sandbox/hb1/stop") return { json: { success: true } };
      return undefined;
    });
    const { router } = routerFor(hyperbrowserProvider, env(url));
    const ctx = { env: env(url), options: {} };
    const sbx = await lifecycle(router, { files: true });
    expect(seen).toContain("PUT /sandbox/hb1/stop");
    expect(sbx.providerSandboxId).toBe("hb1");

    // A refused token is minted again from the sandbox, and the call retried once.
    const again = await router.create({ timeoutSec: 120, env: { A: "1" } });
    expect(files.get("/tmp/.sbr-env")?.toString()).toBe("export A='1'\n");
    token = "t2";
    refuseOnce = true;
    expect((await again.commands.run("echo again")).exitCode).toBe(0);
    expect(await hyperbrowserProvider.listFiles!("hb1", "/tmp", ctx)).toEqual([
      { name: "a.txt", path: "/tmp/a.txt", isDir: false, size: 5 },
      { name: "d", path: "/tmp/d", isDir: true, size: undefined },
    ]);
    expect(await hyperbrowserProvider.getUrl!("hb1", 3000, ctx)).toBe("https://3000-hb1.example");
  });

  it("treats a sandbox that is already gone as killed", () => killsGone(hyperbrowserProvider, env, "hb_gone"));

  it("marks a concurrency refusal as a rate limit", async () => {
    const { url } = await mock(() => ({ status: 429, json: { message: "Concurrent session limit reached" } }));
    await refused(routerFor(hyperbrowserProvider, env(url)).router, "hyperbrowser", "rate_limit");
  });
});

describe("lightcone", () => {
  const env = (url: string) => ({ TZAFON_API_KEY: "sk_t", LIGHTCONE_BASE_URL: url });

  it("starts a desktop that ends at its lifetime, runs shell commands, and deletes it", async () => {
    let polls = 0;
    const { url, seen } = await mock((r) => {
      if (r.headers.authorization !== "Bearer sk_t") return { status: 401, json: { title: "Unauthorized", status: 401 } };
      if (r.method === "POST" && r.path === "/computers") {
        expect(r.json()).toEqual({ kind: "desktop", max_lifetime_seconds: 120, inactivity_timeout_seconds: 120 });
        return { json: { id: "lc1", status: "starting" } };
      }
      if (r.method === "GET" && r.path === "/computers/lc1") return { json: { id: "lc1", status: polls++ < 1 ? "starting" : "running" } };
      if (r.method === "POST" && r.path === "/computers/lc1/exec/sync") {
        const b = r.json();
        if (b.command.includes("sleep")) return { json: { exit_code: -1, stdout: "", stderr: "" } };
        const out = fakeRun(b.command);
        return { json: { exit_code: out.code, stdout: out.stdout, stderr: out.stderr } };
      }
      if (r.method === "DELETE" && r.path === "/computers/lc1") return { status: 204, raw: "" };
      return undefined;
    });
    const { router } = routerFor(lightconeProvider, env(url));
    const sbx = await router.create({ timeoutSec: 120 });
    expect((await sbx.commands.run("echo hi")).stdout).toContain("echo hi");
    expect((await sbx.commands.run("exit 3")).exitCode).toBe(3);
    // -1: timed out.
    expect((await sbx.commands.run("sleep 999")).exitCode).toBe(124);
    await sbx.kill();
    expect(seen).toContain("DELETE /computers/lc1");
  });

  it("marks out of credits as quota", async () => {
    const { url } = await mock(() => ({ status: 402, type: "application/problem+json", json: { title: "Payment Required", status: 402, detail: "Your organization is out of credits." } }));
    await refused(routerFor(lightconeProvider, env(url)).router, "lightcone", "quota");
  });

  it("treats a computer that is already gone as killed", () => killsGone(lightconeProvider, env, "lc_gone"));
});

describe("cyqle", () => {
  const env = (url: string) => ({ CYQLE_API_KEY: "cy_t", CYQLE_API_URL: url });

  it("drives the desktop by region, wakes it when it slept, and moves files through exec", async () => {
    const files = new Map<string, Buffer>();
    let polls = 0;
    let status = "INITIATING";
    const { url, seen } = await mock((r) => {
      if (r.headers["x-api-key"] !== "cy_t") return { status: 401, json: { error: "API_KEY_INVALID" } };
      if (r.method === "POST" && r.path === "/sessions") {
        expect(r.json()).toEqual({});
        return { json: { success: true, data: { id: "s1", region: "us", status } } };
      }
      if (r.method === "GET" && r.path === "/sessions/s1") {
        if (status === "INITIATING" && polls++ >= 1) status = "RUNNING";
        return { json: { success: true, data: { id: "s1", region: "us", status } } };
      }
      if (r.method === "PUT" && r.path === "/sessions/s1/resume") {
        status = "RUNNING";
        return { json: { success: true } };
      }
      if (r.method === "POST" && r.path === "/sessions/s1/exec") {
        if (status !== "RUNNING") return { status: 409, json: { error: "SESSION_PAUSED", message: "Session is paused" } };
        const b = r.json();
        const write = /^mkdir -p '([^']*)' && base64 -d > '([^']*)'$/.exec(b.command);
        if (write) {
          files.set(write[2]!, Buffer.from(b.stdin, "base64"));
          return { json: { success: true, data: { stdout: "", stderr: "", exitCode: 0 } } };
        }
        const read = /^base64 -w0 '([^']*)'$/.exec(b.command);
        if (read) return { json: { success: true, data: { stdout: files.get(read[1]!)?.toString("base64") ?? "", stderr: "", exitCode: files.has(read[1]!) ? 0 : 1 } } };
        const out = fakeRun(b.command);
        return { json: { success: true, data: { stdout: out.stdout, stderr: out.stderr, exitCode: out.code } } };
      }
      if (r.method === "PUT" && r.path === "/sessions/s1/pause") {
        status = "PAUSED";
        return { json: { success: true } };
      }
      if (r.method === "DELETE" && r.path === "/sessions/s1") return { json: { success: true, data: { message: "Session ended successfully" } } };
      return undefined;
    });
    const { router } = routerFor(cyqleProvider, env(url));
    const sbx = await router.create({ timeoutSec: 120 });
    expect(sbx.providerSandboxId).toBe("us:s1");
    expect((await sbx.commands.run("echo hi")).stdout).toContain("echo hi");
    expect((await sbx.commands.run("exit 3")).exitCode).toBe(3);
    await sbx.files.write("/tmp/a.txt", "hello");
    expect(await sbx.files.read("/tmp/a.txt")).toBe("hello");
    // The free desktop slept after 15 idle minutes: the next command wakes it and runs.
    status = "PAUSED";
    expect((await sbx.commands.run("echo awake")).stdout).toContain("echo awake");
    expect(seen).toContain("PUT /sessions/s1/resume");
    await sbx.kill();
    expect(seen).toContain("DELETE /sessions/s1");
  });

  it("deletes the desktop at its deadline, since it has no TTL", async () => {
    const { url, seen } = await mock((r) => {
      if (r.method === "POST" && r.path === "/sessions") return { json: { data: { id: "s2", region: "eu", status: "RUNNING" } } };
      if (r.method === "DELETE") return { json: { success: true } };
      return undefined;
    });
    const { router, clock } = routerFor(cyqleProvider, env(url));
    await deletedAtDeadline(router, clock, seen, () => "DELETE /sessions/s2");
  });

  it("marks the daily allowance as quota and a full slot as a rate limit", async () => {
    let code = "DAILY_LIMIT_EXCEEDED";
    const { url } = await mock(() => ({ status: 429, json: { error: code, upgrade: true } }));
    await refused(routerFor(cyqleProvider, env(url)).router, "cyqle", "quota");
    code = "FREE_TIER_SESSION_LIMIT";
    await refused(routerFor(cyqleProvider, env(url)).router, "cyqle", "rate_limit");
  });

  it("treats a desktop that is already gone as killed", () => killsGone(cyqleProvider, env, "eu:gone"));
});

describe("islo", () => {
  const env = (url: string) => ({ ISLO_API_KEY: "ak_t", ISLO_BASE_URL: url, ISLO_COMPUTE_URL: url });

  it("exchanges the key, deletes at the timeout, polls async commands, and adopts a retried create", async () => {
    const files = new Map<string, string>();
    const results = new Map<string, { out: ReturnType<typeof fakeRun>; polls: number }>();
    let polls = 0;
    let exists = false;
    let name = "";
    const { url, seen } = await mock((r) => {
      if (r.method === "POST" && r.path === "/auth/token") {
        expect(r.json()).toEqual({ access_key: "ak_t" });
        return { json: { session_token: "jwt-1", cookie_max_age: 600 } };
      }
      if (r.headers.authorization !== "Bearer jwt-1") return { status: 401, json: { code: "AUTH_REQUIRED", message: "no" } };
      if (r.method === "POST" && r.path === "/sandboxes") {
        const b = r.json();
        expect(b).toMatchObject({ image: "ubuntu:22.04", lifecycle: { delete_after: 120, auto_resume: "never" }, request_id: expect.any(String) });
        name = b.name;
        if (exists) return { status: 409, json: { code: "SANDBOX_ALREADY_EXISTS", message: "exists" } };
        exists = true;
        return { status: 201, json: { id: "sbx_1", name, image: b.image, status: "starting", created_at: "now" } };
      }
      if (r.method === "GET" && r.path === `/sandboxes/${name}`) return { json: { id: "sbx_1", name, image: "x", created_at: "now", status: polls++ < 1 ? "starting" : "running", spec: { vcpus: 2, memory_mb: 4096, disk_gb: 10 } } };
      if (r.method === "POST" && r.path === `/sandboxes/${name}/exec`) {
        const b = r.json();
        expect(b.command.slice(0, 2)).toEqual(["sh", "-c"]);
        expect(b.command[2]).toMatch(/^timeout \d+ sh -c '/);
        const id = `e${results.size}`;
        results.set(id, { out: fakeRun(b.command[2]), polls: 0 });
        return { json: { exec_id: id, sandbox_id: "sbx_1", status: "running" } };
      }
      const ex = new RegExp(`^/sandboxes/${name}/exec/(e\\d+)$`).exec(r.path);
      if (r.method === "GET" && ex) {
        const e = results.get(ex[1]!)!;
        if (e.polls++ < 1) return { json: { exec_id: ex[1], status: "running", stdout: "", stderr: "", truncated: false, exit_code: null } };
        return { json: { exec_id: ex[1], status: "completed", stdout: e.out.stdout, stderr: e.out.stderr, truncated: false, exit_code: e.out.code } };
      }
      if (r.path === `/sandboxes/${name}/files`) {
        const p = r.query.get("path")!;
        if (r.method === "POST") {
          expect(r.headers["content-type"]).toMatch(/^multipart\/form-data/);
          files.set(p, r.body.toString().includes("hello") ? "hello" : "?");
          return { json: { status: "ok" } };
        }
        return files.has(p) ? { raw: files.get(p)! } : { status: 404, json: { code: "FILE_NOT_FOUND", message: "no" } };
      }
      if (r.method === "DELETE" && r.path === `/sandboxes/${name}`) return { status: 204, raw: "" };
      return undefined;
    });
    const { router } = routerFor(isloProvider, env(url));
    const sbx = await lifecycle(router, { files: true });
    expect(sbx.providerSandboxId).toMatch(/^sbr-/);
    expect(seen.filter((s) => s === "POST /auth/token")).toHaveLength(1);
    // The same router id again: Islo says it exists, and the adapter reads it back.
    const ctx = { env: env(url), options: { pollMs: 5 } };
    const spec = { timeoutSec: 120, cpu: 2, memoryMiB: 4096, env: {}, metadata: { "sandboxrouting.id": "fixed" } };
    exists = false;
    const first = await isloProvider.create(spec, ctx);
    const second = await isloProvider.create(spec, ctx);
    expect(second.providerSandboxId).toBe(first.providerSandboxId);
  });

  it("marks spent credit as quota", async () => {
    const { url } = await mock((r) =>
      r.path === "/auth/token" ? { json: { session_token: "jwt", cookie_max_age: 600 } } : { status: 400, json: { code: "BILLING_NOT_ALLOWED", message: "denied" } },
    );
    await refused(routerFor(isloProvider, env(url)).router, "islo", "quota");
  });

  it("treats a sandbox that is already gone as killed", async () => {
    const { url } = await mock((r) => (r.path === "/auth/token" ? { json: { session_token: "jwt", cookie_max_age: 600 } } : { status: 404, json: { code: "SANDBOX_NOT_FOUND", message: "gone" } }));
    await expect(isloProvider.kill("sbr-gone", { env: env(url), options: {} })).resolves.toBeUndefined();
  });
});

describe("machine0", () => {
  const env = (url: string) => ({ MACHINE0_API_KEY: "m0_t", MACHINE0_API_URL: `${url}/mcp` });

  it("calls MCP tools: a managed key, create with an idle backstop, ssh_exec, suspend to pause, destroy", async () => {
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    let keys: { id: string; name: string }[] = [];
    let polls = 0;
    const { url } = await mock((r) => {
      if (r.path !== "/mcp" || r.method !== "POST") return undefined;
      if (r.headers["x-api-key"] !== "m0_t") return { status: 401, json: { error: "unauthorized" } };
      expect(r.headers.accept).toContain("text/event-stream");
      const req = r.json();
      expect(req).toMatchObject({ jsonrpc: "2.0", method: "tools/call" });
      const { name, arguments: args } = req.params;
      calls.push({ name, args });
      const ok = (v: unknown) => ({ json: { jsonrpc: "2.0", id: req.id, result: { content: [{ type: "text", text: JSON.stringify(v) }] } } });
      const fail = (text: string) => ({ json: { jsonrpc: "2.0", id: req.id, result: { isError: true, content: [{ type: "text", text }] } } });
      switch (name) {
        case "ssh_key_list":
          return ok(keys);
        case "ssh_key_create_managed":
          keys = [{ id: "k1", name: args.name }];
          return ok(keys[0]);
        case "vm_create":
          return ok({ id: "vm1", name: args.name, status: "CREATING" });
        case "vm_get":
          // One answer as an event stream, as Streamable HTTP may send.
          if (polls++ === 0) return { type: "text/event-stream", raw: `event: message\ndata: ${JSON.stringify(ok({ id: "vm1", status: "CREATING" }).json)}\n\n` };
          return ok({ id: "vm1", status: "RUNNING" });
        case "ssh_exec": {
          const out = fakeRun(String(args.command));
          return ok({ stdout: out.stdout, stderr: out.stderr, exitCode: out.code });
        }
        case "vm_suspend":
        case "vm_start":
          return ok({ id: "vm1", status: name === "vm_start" ? "RUNNING" : "SUSPENDING" });
        case "vm_destroy":
          return args.id === "vm1" ? ok({ ok: true }) : fail("VM not found");
        default:
          return fail(`unknown tool ${name}`);
      }
    });
    const { router } = routerFor(machine0Provider, env(url));
    const sbx = await router.create({ timeoutSec: 120 });
    expect(calls.find((c) => c.name === "vm_create")!.args).toMatchObject({ size: "large", region: "ams3", imageName: "ubuntu-24-04-loaded", sshKeyId: "k1", onIdle: "destroy", idleTimeoutMinutes: 10 });
    expect((await sbx.commands.run("echo hi")).stdout).toContain("echo hi");
    expect((await sbx.commands.run("exit 3")).exitCode).toBe(3);
    expect(calls.filter((c) => c.name === "ssh_exec").every((c) => (c.args.timeout as number) <= 300)).toBe(true);
    // A stopped machine0 VM still bills the full rate; a suspended one bills storage only.
    await sbx.pause();
    await sbx.resume();
    expect(calls.map((c) => c.name)).toContain("vm_suspend");
    expect(calls.map((c) => c.name)).not.toContain("vm_stop");
    await sbx.kill();
    expect(calls.at(-1)).toMatchObject({ name: "vm_destroy", args: { id: "vm1" } });
    // A VM that is already gone is killed.
    await expect(machine0Provider.kill("vm-gone", { env: env(url), options: {} })).resolves.toBeUndefined();
    // The managed key is found again, not made twice.
    await router.create({ timeoutSec: 120 });
    expect(calls.filter((c) => c.name === "ssh_key_create_managed")).toHaveLength(1);
  });

  it("marks an unauthorized key as auth", async () => {
    const { url } = await mock(() => ({ status: 401, json: { error: "unauthorized" } }));
    await refused(routerFor(machine0Provider, env(url)).router, "machine0", "auth");
  });
});
