// The REST adapters added on 2026-11-12, driven through the router against local servers that
// speak each provider's wire format: from its OpenAPI spec where it publishes one, else from
// its docs or the requests its official SDK sends. None has been run against the real service.
import { describe, expect, it } from "vitest";
import { deletedAtDeadline, fakeRun, lifecycle, mock, routerFor } from "./restmock.js";
import { SandboxRouterError } from "../src/index.js";
import { insideRoots, sse } from "../src/providers/rest-helpers.js";
import { naniteProvider } from "../src/providers/nanite.js";
import { renderPlan, renderProvider } from "../src/providers/render.js";
import { quaveProvider } from "../src/providers/quave.js";
import { boxcomputeProvider, boxcomputeSize } from "../src/providers/boxcompute.js";
import { buddyProvider, buddyResources } from "../src/providers/buddy.js";
import { mosaicProvider, mosaicShape } from "../src/providers/mosaic.js";
import { nodusProvider } from "../src/providers/nodus.js";
import { cathedralProvider, cathedralTemplate } from "../src/providers/cathedral.js";
import { tensorlakeProvider } from "../src/providers/tensorlake.js";
import { promigenceProvider, promigenceTier } from "../src/providers/promigence.js";
import { doryProvider, dorySize } from "../src/providers/dory.js";
import { zodeProvider, zodeShape } from "../src/providers/zode.js";
import { maritimeProvider } from "../src/providers/maritime.js";
import { munitoProvider } from "../src/providers/munito.js";
import { lizardProvider, lizardSize } from "../src/providers/lizard.js";

const b64 = (s: string) => Buffer.from(s).toString("base64");
/** The lifetimes the shared helpers ask for: `lifecycle` 120 s, `deletedAtDeadline` 60 s. */
const LIFETIMES = [120, 60];
const soon = () => new Date(Date.now() + 3_600_000).toISOString();
/** An exec result as a `text/event-stream` body. */
const events = (frames: [string | undefined, unknown][]) => ({
  type: "text/event-stream",
  raw: frames.map(([event, data]) => `${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`).join(""),
});

describe("shared helpers", () => {
  it("parses event streams split across chunks", async () => {
    async function* chunks() {
      yield Buffer.from('event: output\ndata: {"a"');
      yield Buffer.from(':1}\n\ndata: plain\r\n\r\nevent: exit\ndata: {}\n\n');
    }
    const got = [];
    for await (const ev of sse(chunks())) got.push(ev);
    expect(got).toEqual([
      { event: "output", data: '{"a":1}' },
      { event: "message", data: "plain" },
      { event: "exit", data: "{}" },
    ]);
  });

  it("asks for the exec fallback when a path is outside a file API's roots", () => {
    expect(() => insideRoots("x", "/workspace/a", ["/workspace"])).not.toThrow();
    expect(() => insideRoots("x", "/workspace", ["/workspace"])).not.toThrow();
    for (const path of ["/tmp/a", "/workspaces/a"]) {
      const err = (() => {
        try {
          insideRoots("x", path, ["/workspace"]);
        } catch (e) {
          return e;
        }
      })();
      expect(err).toBeInstanceOf(SandboxRouterError);
      expect((err as SandboxRouterError).kind).toBe("unsupported");
    }
  });

  it("maps a request to each provider's sizes", () => {
    expect(renderPlan(1, 2048).plan).toBe("1c-2g");
    expect(renderPlan(2, 2048).plan).toBe("2c-4g");
    expect(renderPlan(1, 6000).plan).toBe("4c-8g");
    expect(renderPlan(64, 1).plan).toBe("8c-16g");
    expect(boxcomputeSize(0.5, 1024).size).toBe("small");
    expect(boxcomputeSize(2, 4096).size).toBe("xl");
    expect(buddyResources(2, 4096).resources).toBe("2x4");
    expect(buddyResources(1, 8192).resources).toBe("4x8");
    expect(buddyResources(99, 1).resources).toBe("12x24");
    expect(mosaicShape(3, 1024)).toEqual({ vcpu: 4, memory_mb: 8192 });
    expect(cathedralTemplate(1, 1024).template).toBe("sealed-2x4");
    expect(cathedralTemplate(2, 8192).template).toBe("sealed-4x8");
    expect(promigenceTier(2, 4096).tier).toBe("small");
    expect(promigenceTier(8, 16384).tier).toBe("large-16");
    expect(dorySize(3, 1024).size).toBe("ac-4");
    expect(zodeShape(1, 1024)).toEqual({ vcpus: 2, ram_mb: 4096 });
    expect(lizardSize(1, 2048).size).toBe("mini");
    expect(lizardSize(2, 4097).size).toBe("medium");
  });
});

describe("nanite", () => {
  it("addresses sandboxes by name, decodes framed exec, and is deleted at the deadline", async () => {
    const files = new Map<string, Buffer>();
    const { url, seen } = await mock((r) => {
      if (r.headers.authorization !== "Bearer sk_test") return { status: 401, json: {} };
      const m = /^\/v1\/sandboxes\/(sbr-[0-9a-f]+)(\/.*)?$/.exec(r.path);
      if (r.method === "POST" && r.path === "/v1/sandboxes") {
        expect(r.json().name).toMatch(/^sbr-[0-9a-f]{16}$/);
        return { status: 201, json: { id: "sbx-1", name: r.json().name, status: "running" } };
      }
      if (!m) return undefined;
      if (r.method === "POST" && m[2] === "/exec") {
        const x = fakeRun(r.query.getAll("cmd")[2]!);
        return { raw: Buffer.from([...(x.stdout ? [1, ...Buffer.from(x.stdout)] : [2, ...Buffer.from(x.stderr)]), 3, x.code]) };
      }
      if (r.method === "PUT" && m[2] === "/fs/write") return files.set(r.query.get("path")!, r.body), { json: { path: r.query.get("path"), size: r.body.length } };
      if (r.method === "GET" && m[2] === "/fs/read") return { raw: files.get(r.query.get("path")!) ?? "" };
      if (r.method === "DELETE" && !m[2]) return { status: 204 };
      return undefined;
    });
    const { router, clock } = routerFor(naniteProvider, { NANITE_API_KEY: "sk_test", NANITE_API_URL: url });
    const sbx = await lifecycle(router, { files: true });
    expect(seen).toContain(`DELETE /v1/sandboxes/${sbx.providerSandboxId}`);
    await deletedAtDeadline(router, clock, seen, (id) => `DELETE /v1/sandboxes/${id}`);
  });
});

describe("render", () => {
  it("mints a connect token for each exec and file transfer, then calls the data plane with it", async () => {
    const files = new Map<string, Buffer>();
    let self = "";
    let polls = 0;
    const grant = (path: string, method: string) => ({ status: 201, json: { executionId: "ex", token: "ct_1", uri: `${self}${path}`, method, expiresAt: soon() } });
    const { url, seen } = await mock((r) => {
      if (r.path.startsWith("/dp/")) {
        if (r.headers.authorization !== "Bearer ct_1") return { status: 401, json: {} };
        if (r.path === "/dp/runs/stream") {
          expect(r.headers.accept).toBe("text/event-stream");
          const x = fakeRun(r.json().command);
          return events([["output", { stream: x.stdout ? "stdout" : "stderr", data: x.stdout || x.stderr }], ["exit", { exit_code: x.code }]]);
        }
        if (r.method === "PUT") return files.set(r.query.get("path")!, r.body), { status: 204 };
        return { raw: files.get(r.query.get("path")!) ?? "" };
      }
      if (r.headers.authorization !== "Bearer rnd_test") return { status: 401, json: {} };
      if (r.method === "POST" && r.path === "/sandboxes") {
        expect(r.json()).toMatchObject({ ownerId: "tea-1", plan: "1c-2g", timeoutSeconds: 120, idleTimeoutSeconds: 0 });
        return { status: 201, json: { id: "sbx-1", status: "creating" } };
      }
      if (r.method === "GET" && r.path === "/sandboxes/sbx-1") return { json: { id: "sbx-1", status: polls++ < 1 ? "creating" : "running" } };
      if (r.method === "POST" && r.path.endsWith("/token")) expect(r.query.get("ownerId")).toBe("tea-1");
      if (r.method === "POST" && r.path === "/sandboxes/sbx-1/runs/stream/token") return grant("/dp/runs/stream", "POST");
      if (r.method === "POST" && r.path === "/sandboxes/sbx-1/files/upload/token") return grant(`/dp/files?path=${encodeURIComponent(r.query.get("path")!)}`, "PUT");
      if (r.method === "POST" && r.path === "/sandboxes/sbx-1/files/download/token") return grant(`/dp/files?path=${encodeURIComponent(r.query.get("path")!)}`, "GET");
      if (r.method === "POST" && r.path === "/sandboxes/sbx-1/terminate") return { status: 204 };
      return undefined;
    });
    self = url;
    const { router } = routerFor(renderProvider, { RENDER_API_KEY: "rnd_test", RENDER_WORKSPACE_ID: "tea-1", RENDER_API_URL: url });
    await lifecycle(router, { files: true });
    expect(seen).toContain("POST /sandboxes/sbx-1/terminate");
  });

  it("terminates a sandbox that errors while starting", async () => {
    const { url, seen } = await mock((r) => {
      if (r.method === "POST" && r.path === "/sandboxes") return { status: 201, json: { id: "sbx-2", status: "creating" } };
      if (r.method === "GET") return { json: { id: "sbx-2", status: "errored" } };
      if (r.path === "/sandboxes/sbx-2/terminate") return { status: 204 };
      return undefined;
    });
    const { router } = routerFor(renderProvider, { RENDER_API_KEY: "k", RENDER_WORKSPACE_ID: "tea-1", RENDER_API_URL: url });
    await expect(router.create({})).rejects.toThrow(/errored/);
    expect(seen).toContain("POST /sandboxes/sbx-2/terminate");
  });
});

describe("quave", () => {
  it("sends the bare token, retries an exec refused while starting, and decodes base64 output", async () => {
    const files = new Map<string, Buffer>();
    let self = "";
    let refusals = 1;
    let sessions = 0;
    const { url, seen } = await mock((r) => {
      if (r.path.startsWith("/gw/")) {
        if (r.headers.authorization !== "Bearer gw_1") return { status: 401, json: {} };
        if (r.method === "PUT" && r.path === "/gw/v1/files/write") return files.set(r.query.get("path")!, r.body), { json: {} };
        if (r.method === "GET" && r.path === "/gw/v1/files/read") return { raw: files.get(r.query.get("path")!) ?? "" };
        return undefined;
      }
      // No "Bearer" prefix on the main API.
      if (r.headers.authorization !== "qtok") return { status: 401, json: {} };
      if (r.method === "POST" && r.path === "/sandbox/create") {
        const b = r.json();
        expect(b).toMatchObject({ accountId: "acc", appId: "app", templateId: "tpl", workloadProfile: "CODE_INTERPRETER_TURN", ownerKind: "EXTERNAL_SESSION" });
        expect(b.idempotencyKey).toBeTruthy();
        return { status: 201, json: { success: true, wasCreated: true, sandbox: { sandboxId: "qs_1", status: "STARTING" } } };
      }
      if (r.method === "GET" && r.path === "/sandbox") return { json: { sandbox: { sandboxId: "qs_1", status: "READY" } } };
      if (r.method === "POST" && r.path === "/sandbox/execute") {
        if (refusals-- > 0) return { status: 409, json: { data: { retryable: true, retryAfterSeconds: 1 } } };
        const b = r.json();
        expect(b.command.slice(0, 2)).toEqual(["sh", "-c"]);
        const x = fakeRun(b.command[2]);
        // Empty streams are left out of the response.
        return { json: { success: true, result: { exitCode: x.code, ...(x.stdout ? { stdout: b64(x.stdout) } : {}), ...(x.stderr ? { stderr: b64(x.stderr) } : {}) } } };
      }
      if (r.method === "POST" && r.path === "/sandbox/session") return sessions++, { json: { endpoint: `${self}/gw`, token: "gw_1", expiresAt: soon() } };
      if (r.method === "POST" && r.path === "/sandbox/terminate") return { json: { success: true } };
      return undefined;
    });
    self = url;
    const env = { QUAVEONE_USER_TOKEN: "qtok", QUAVEONE_ACCOUNT_ID: "acc", QUAVEONE_APP_ID: "app", QUAVEONE_SANDBOX_TEMPLATE_ID: "tpl", QUAVEONE_API_URL: url };
    const { router, clock } = routerFor(quaveProvider, env);
    const sbx = await router.create({ timeoutSec: 120 });
    expect((await sbx.commands.run("echo hi")).stdout).toContain("echo hi");
    expect((await sbx.commands.run("exit 3")).exitCode).toBe(3);
    // The gateway only reaches /workspace; one session serves both calls.
    await sbx.files.write("/workspace/a.txt", "hello");
    expect(await sbx.files.read("/workspace/a.txt")).toBe("hello");
    expect(sessions).toBe(1);
    await sbx.kill();
    await deletedAtDeadline(router, clock, seen, () => "POST /sandbox/terminate");
  });
});

describe("boxcompute", () => {
  it("finds or makes a workspace, waits for the VM, and reports a command timeout as exit 124", async () => {
    const files = new Map<string, Buffer>();
    let polls = 0;
    const { url, seen } = await mock((r) => {
      if (r.headers.authorization !== "Bearer bc_live_test") return { status: 401, json: {} };
      if (r.method === "GET" && r.path === "/workspaces") return { json: { workspaces: [] } };
      if (r.method === "POST" && r.path === "/workspaces") {
        expect(r.headers["idempotency-key"]).toBeTruthy();
        return { status: 201, json: { workspace: { id: "ws_1" } } };
      }
      if (r.method === "POST" && r.path === "/sandboxes") {
        expect(r.headers["idempotency-key"]).toBeTruthy();
        expect(r.json()).toMatchObject({ workspaceId: "ws_1", size: "small" });
        return { status: 202, json: { sandbox: { id: "sbx_1", state: "pending" } } };
      }
      if (r.method === "GET" && r.path === "/sandboxes/sbx_1") return { json: { sandbox: { id: "sbx_1", state: polls++ < 1 ? "pending" : "running" } } };
      if (r.method === "POST" && r.path === "/sandboxes/sbx_1/execute") {
        const b = r.json();
        if (b.argv[2].includes("sleep")) return { status: 408, json: { code: "TIMEOUT", error: "timed out" } };
        // `cwd` must be under /workspace; another directory is entered by the shell.
        if (b.argv[2].includes("pwd")) return { json: { result: { stdout: `${b.cwd ?? ""}|${b.argv[2]}`, stderr: "", exitCode: 0 } } };
        const x = fakeRun(b.argv[2]);
        return { json: { result: { stdout: x.stdout, stderr: x.stderr, exitCode: x.code, timedOut: false } } };
      }
      if (r.path === "/sandboxes/sbx_1/files/content" && r.method === "PUT") return files.set(r.query.get("path")!, r.body), { status: 204 };
      if (r.path === "/sandboxes/sbx_1/files/content" && r.method === "GET") return { raw: files.get(r.query.get("path")!) ?? "", headers: { "x-boxcompute-eof": "true" } };
      if (r.method === "DELETE" && r.path === "/sandboxes/sbx_1") return { status: 204 };
      return undefined;
    });
    const { router, clock } = routerFor(boxcomputeProvider, { BOXCOMPUTE_API_KEY: "bc_live_test", BOXCOMPUTE_API_URL: url });
    const sbx = await router.create({ timeoutSec: 120 });
    expect((await sbx.commands.run("echo hi")).stdout).toContain("echo hi");
    expect((await sbx.commands.run("exit 3")).exitCode).toBe(3);
    expect((await sbx.commands.run("sleep 999")).exitCode).toBe(124);
    expect((await sbx.commands.run("pwd", { cwd: "/workspace/app" })).stdout).toBe("/workspace/app|pwd");
    expect((await sbx.commands.run("pwd", { cwd: "/srv" })).stdout).toBe("|cd '/srv' && pwd");
    await sbx.files.write("/workspace/a.txt", "hello");
    expect(await sbx.files.read("/workspace/a.txt")).toBe("hello");
    await sbx.kill();
    await deletedAtDeadline(router, clock, seen, (id) => `DELETE /sandboxes/${id}`);
  });
});

describe("buddy", () => {
  it("runs commands as polled execs with stderr kept apart, and uploads files as form data", async () => {
    const files = new Map<string, Buffer>();
    const execs = new Map<string, ReturnType<typeof fakeRun>>();
    const stderrFiles = new Map<string, string>();
    let polls = 0;
    const { url, seen } = await mock((r) => {
      if (r.headers.authorization !== "Bearer bud_test") return { status: 401, json: {} };
      const root = "/workspaces/acme/sandboxes";
      if (r.method === "POST" && r.path === root) {
        expect(r.query.get("project_name")).toBe("proj");
        const b = r.json();
        expect(b).toMatchObject({ os: "ubuntu:24.04", resources: "2x4" });
        // Its timeout only stops the sandbox, so none is set: the router deletes it.
        expect(b.timeout).toBeUndefined();
        return { status: 201, json: { id: "sb1", status: "STARTING", setup_status: "INPROGRESS" } };
      }
      if (r.method === "GET" && r.path === `${root}/sb1`) return { json: polls++ < 1 ? { id: "sb1", status: "RUNNING", setup_status: "INPROGRESS" } : { id: "sb1", status: "RUNNING", setup_status: "SUCCESS" } };
      if (r.method === "POST" && r.path === `${root}/sb1/execs`) {
        const command = r.json().command as string;
        const id = `e${execs.size + 1}`;
        const x = fakeRun(command);
        execs.set(id, x);
        stderrFiles.set(/2> (\S+)$/.exec(command)![1]!, x.stderr);
        return { json: { execution_id: id, status: "INPROGRESS" } };
      }
      const one = new RegExp(`^${root}/sb1/execs/(e\\d+)(/log)?$`).exec(r.path);
      if (r.method === "GET" && one) {
        const x = execs.get(one[1]!)!;
        if (one[2]) return { json: { execution_id: one[1], lines: x.stdout.split("\n").filter(Boolean), next_offset: 1, truncated: false } };
        return { json: { execution_id: one[1], status: x.code ? "FAILED" : "SUCCESSFUL", exit_code: x.code } };
      }
      if (r.method === "POST" && r.path === `${root}/sb1/exec`) {
        const file = /cat (\S+)/.exec(r.json().command)![1]!;
        return { json: { exit_code: 0, stdout: stderrFiles.get(file) ?? "", stderr: "" } };
      }
      if (r.method === "POST" && r.path === `${root}/sb1/content/upload/tmp/a.txt`) {
        expect(r.headers["content-type"]).toMatch(/^multipart\/form-data/);
        const text = r.body.toString("latin1");
        expect(text).toContain('name="file"');
        const start = text.indexOf("\r\n\r\n") + 4;
        return files.set("/tmp/a.txt", r.body.subarray(start, text.indexOf("\r\n--", start))), { status: 201, json: { type: "FILE" } };
      }
      if (r.method === "GET" && r.path === `${root}/sb1/download/tmp/a.txt`) return { raw: files.get("/tmp/a.txt") ?? "" };
      if (r.method === "DELETE" && r.path === `${root}/sb1`) return { status: 204 };
      return undefined;
    });
    const env = { BUDDY_TOKEN: "bud_test", BUDDY_WORKSPACE: "acme", BUDDY_PROJECT: "proj", BUDDY_API_URL: url };
    const { router, clock } = routerFor(buddyProvider, env);
    const sbx = await router.create({ timeoutSec: 120 });
    const bad = await sbx.commands.run("exit 3");
    expect([bad.exitCode, bad.stdout, bad.stderr]).toEqual([3, "", "boom\n"]);
    await sbx.kill();
    await lifecycle(router, { files: true });
    await deletedAtDeadline(router, clock, seen, (id) => `DELETE /workspaces/acme/sandboxes/${id}`);
  });
});

describe("mosaic", () => {
  it("sends only known fields, keeps create-time env in a file, and moves the inactivity deadline", async () => {
    const files = new Map<string, string>();
    const { url, seen } = await mock((r) => {
      if (r.headers.authorization !== "Bearer msk_live_test") return { status: 401, json: {} };
      if (r.method === "POST" && r.path === "/v1/sandboxes") {
        const b = r.json();
        // Unknown top-level fields are refused with 400.
        for (const k of Object.keys(b)) expect(["template", "vcpu", "memory_mb", "region", "metadata", "ttl_seconds"]).toContain(k);
        expect(b).toMatchObject({ template: "base", vcpu: 2, memory_mb: 4096 });
        expect(LIFETIMES).toContain(b.ttl_seconds);
        expect(r.headers["idempotency-key"]).toBeTruthy();
        return { json: { id: "ms_1", state: "running" } };
      }
      if (r.method === "POST" && r.path === "/v1/sandboxes/ms_1/exec") {
        const x = fakeRun(r.json().cmd);
        return { json: { execution_id: "x", stdout: x.stdout, stderr: x.stderr, exit_code: x.code, success: !x.code } };
      }
      if (r.method === "PUT" && r.path === "/v1/sandboxes/ms_1/files/content") return files.set(r.json().path, r.json().content_base64), { json: {} };
      if (r.method === "GET" && r.path === "/v1/sandboxes/ms_1/files/content") return { json: { path: r.query.get("path"), content_base64: files.get(r.query.get("path")!) ?? "", eof: true } };
      if (r.method === "POST" && r.path === "/v1/sandboxes/ms_1/timeout") return expect(r.json()).toEqual({ ttl_seconds: 600 }), { status: 204 };
      if (r.method === "DELETE" && r.path === "/v1/sandboxes/ms_1") return { status: 204 };
      return undefined;
    });
    const { router, clock } = routerFor(mosaicProvider, { MOSAIC_API_TOKEN: "msk_live_test", MOSAIC_API_URL: url });
    await lifecycle(router, { files: true });

    const sbx = await router.create({ timeoutSec: 120, env: { GREETING: "it's" } });
    expect(Buffer.from(files.get("/tmp/.sbr-env")!, "base64").toString()).toBe("export GREETING='it'\\''s'\n");
    expect((await sbx.commands.run("echo hi")).stdout).toContain("[ -f /tmp/.sbr-env ] && . /tmp/.sbr-env; echo hi");
    await sbx.setTimeout(600);
    expect(seen).toContain("POST /v1/sandboxes/ms_1/timeout");
    await sbx.kill();
    // Activity pushes Mosaic's TTL out, so the deadline is the router's to enforce.
    await deletedAtDeadline(router, clock, seen, (id) => `DELETE /v1/sandboxes/${id}`);
  });
});

describe("nodus", () => {
  it("posts manifests, starts a process once across a 503 retry, and reads NDJSON output", async () => {
    const files = new Map<string, Buffer>();
    const procs = new Map<string, ReturnType<typeof fakeRun>>();
    const keys: string[] = [];
    let name = "";
    let busy = 1;
    const ns = "/apis/nodus.dev/v1/namespaces/proj";
    const { url, seen } = await mock((r) => {
      if (r.headers.authorization !== "Bearer nodus_sk_live_test") return { status: 401, json: {} };
      if (r.method === "POST" && r.path === `${ns}/sandboxes`) {
        const b = r.json();
        expect(b).toMatchObject({ apiVersion: "nodus.dev/v1", kind: "Sandbox" });
        expect(b.spec).toMatchObject({
          image: "nodus/agent-tools",
          resources: { cpu: "1", memory: "2048Mi" },
          network: { egress: { policy: "Open" } },
          lifecycle: { idleTimeout: "0s", maxLifetime: "120s" },
        });
        name = b.metadata.name;
        return { status: 201, json: { metadata: { name }, status: { phase: "Pending" } } };
      }
      if (r.method === "GET" && r.path === `${ns}/sandboxes/${name}`) return { json: { metadata: { name }, status: { phase: "Running" } } };
      if (r.method === "POST" && r.path === `${ns}/sandboxes/${name}/processes`) {
        keys.push(String(r.headers["idempotency-key"]));
        if (busy-- > 0) return { status: 503, json: { reason: "SandboxStarting" } };
        const b = r.json();
        expect(b.spec.command.slice(0, 2)).toEqual(["/bin/sh", "-c"]);
        const id = `p${procs.size + 1}`;
        procs.set(id, fakeRun(b.spec.command[2]));
        return { status: 201, json: { metadata: { name: id }, status: { phase: "Running" } } };
      }
      const p = new RegExp(`^${ns}/processes/(p\\d+)(/output)?$`).exec(r.path);
      if (r.method === "GET" && p) {
        const x = procs.get(p[1]!)!;
        if (!p[2]) return { json: { metadata: { name: p[1] }, status: { phase: x.code ? "Failed" : "Succeeded", exitCode: x.code } } };
        const text = r.query.get("stream") === "stderr" ? x.stderr : x.stdout;
        return { type: "application/x-ndjson", raw: `${JSON.stringify({ data: b64(text), offset: text.length, done: true })}\n` };
      }
      if (r.path === `${ns}/sandboxes/${name}/files` && r.method === "PUT") return files.set(r.query.get("path")!, r.body), { status: 204 };
      if (r.path === `${ns}/sandboxes/${name}/files` && r.method === "GET") return { raw: files.get(r.query.get("path")!) ?? "" };
      if (r.method === "DELETE" && r.path === `${ns}/sandboxes/${name}`) return { json: {} };
      return undefined;
    });
    const { router } = routerFor(nodusProvider, { NODUS_API_KEY: "nodus_sk_live_test", NODUS_PROJECT: "proj", NODUS_API_URL: url });
    const sbx = await lifecycle(router, { files: true });
    // The refused attempt and its retry carried the same key.
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
    expect(seen).toContain(`DELETE ${ns}/sandboxes/${sbx.providerSandboxId}`);
  });
});

describe("cathedral", () => {
  const api = (state: { deadline?: string } = {}) => {
    const files = new Map<string, Buffer>();
    const execs = new Map<string, ReturnType<typeof fakeRun>>();
    return mock((r) => {
      if (r.headers.authorization !== "Bearer cat_sk_test") return { status: 401, json: {} };
      // Create, delete, lifetime and background execs must carry a key of 8–128 characters.
      const keyed = () => expect(String(r.headers["idempotency-key"] ?? "").length).toBeGreaterThanOrEqual(8);
      if (r.method === "POST" && r.path === "/v1/sandboxes") {
        keyed();
        const b = r.json();
        expect(b).toMatchObject({ required_hardware: "amd_sev_snp", template: "sealed-2x4", network: "internet", lifetime_seconds: 120 });
        expect(b.max_spend_usd).toBeGreaterThanOrEqual(1);
        return { status: 202, json: { id: "c-1", state: "creating" } };
      }
      if (r.method === "GET" && r.path === "/v1/sandboxes/c-1") return { json: { id: "c-1", state: "running", lifetime_deadline_at: state.deadline } };
      if (r.method === "POST" && r.path === "/v1/sandboxes/c-1/execs") {
        keyed();
        const id = `x${execs.size + 1}`;
        execs.set(id, fakeRun(r.json().command));
        return { status: 202, json: { exec_id: id, state: "running" } };
      }
      const x = /^\/v1\/sandboxes\/c-1\/execs\/(x\d+)$/.exec(r.path);
      if (r.method === "GET" && x) {
        const done = execs.get(x[1]!)!;
        return { json: { exec_id: x[1], state: "exited", exit_code: done.code, stdout: done.stdout, stderr: done.stderr } };
      }
      if (r.path === "/v1/sandboxes/c-1/files" && r.method === "PUT") return files.set(r.query.get("path")!, r.body), { status: 204 };
      if (r.path === "/v1/sandboxes/c-1/files" && r.method === "GET") return { raw: files.get(r.query.get("path")!) ?? "" };
      if (r.method === "POST" && r.path === "/v1/sandboxes/c-1/lifetime") return keyed(), { json: { extend_by_seconds: r.json().extend_by_seconds } };
      if (r.method === "DELETE" && r.path === "/v1/sandboxes/c-1") return keyed(), { status: 202, json: { id: "c-1", state: "deleting" } };
      return undefined;
    });
  };

  it("creates with the required fields, polls background execs, and keeps files under /work", async () => {
    const { url, seen } = await api();
    const { router } = routerFor(cathedralProvider, { CATHEDRAL_API_KEY: "cat_sk_test", CATHEDRAL_API_URL: url });
    const sbx = await router.create({ timeoutSec: 120 });
    expect((await sbx.commands.run("echo hi")).stdout).toContain("echo hi");
    expect((await sbx.commands.run("exit 3")).exitCode).toBe(3);
    await sbx.files.write("/work/a.txt", "hello");
    expect(await sbx.files.read("/work/a.txt")).toBe("hello");
    await sbx.kill();
    expect(seen).toContain("DELETE /v1/sandboxes/c-1");
  });

  it("extends by the gap to the wanted deadline, and never asks to shorten", async () => {
    const state = { deadline: new Date(Date.now() + 100_000).toISOString() };
    const { url, seen } = await api(state);
    const ctx = { env: { CATHEDRAL_API_KEY: "cat_sk_test", CATHEDRAL_API_URL: url }, options: {} };
    const asked = async (timeoutSec: number) => {
      const before = seen.length;
      await cathedralProvider.setTimeout("c-1", timeoutSec, ctx);
      return seen.slice(before).includes("POST /v1/sandboxes/c-1/lifetime");
    };
    expect(await asked(600)).toBe(true);
    expect(await asked(50)).toBe(false);
  });
});

describe("tensorlake", () => {
  it("creates on the control plane, then runs and moves files on the sandbox's own host", async () => {
    const files = new Map<string, Buffer>();
    const { url, seen } = await mock((r) => {
      if (r.headers.authorization !== "Bearer tl_apiKey_test") return { status: 401, json: {} };
      if (r.method === "POST" && r.path === "/sandboxes") {
        const b = r.json();
        expect(b).toMatchObject({ resources: { cpus: 1, memory_mb: 1024 }, wait: true });
        expect(LIFETIMES).toContain(b.timeout_secs);
        // Unnamed, so an idle timeout terminates it instead of suspending it.
        expect(b.name).toBeUndefined();
        return { json: { sandbox_id: "tl1", status: "running" } };
      }
      if (r.method === "POST" && r.path === "/px/tl1/api/v1/processes/run") {
        const b = r.json();
        expect([b.command, b.args[0]]).toEqual(["sh", "-c"]);
        const x = fakeRun(b.args[1]);
        const lines = (text: string, stream: string) => text.split("\n").filter(Boolean).map((line): [undefined, unknown] => [undefined, { line, stream }]);
        return events([[undefined, { handle: "h", pid: 1 }], ...lines(x.stdout, "stdout"), ...lines(x.stderr, "stderr"), [undefined, { exit_code: x.code, signal: null }]]);
      }
      if (r.path === "/px/tl1/api/v1/files" && r.method === "PUT") return files.set(r.query.get("path")!, r.body), { status: 204 };
      if (r.path === "/px/tl1/api/v1/files" && r.method === "GET") return { raw: files.get(r.query.get("path")!) ?? "" };
      if (r.method === "DELETE" && r.path === "/sandboxes/tl1") return { json: {} };
      return undefined;
    });
    const env = { TENSORLAKE_API_KEY: "tl_apiKey_test", TENSORLAKE_API_URL: url, TENSORLAKE_SANDBOX_URL: `${url}/px/{id}` };
    const { router, clock } = routerFor(tensorlakeProvider, env);
    const sbx = await router.create({ timeoutSec: 120 });
    const bad = await sbx.commands.run("exit 3");
    expect([bad.exitCode, bad.stderr]).toEqual([3, "boom\n"]);
    await sbx.kill();
    await lifecycle(router, { files: true });
    // `timeout_secs` counts idle time, so a busy sandbox is the router's to end.
    await deletedAtDeadline(router, clock, seen, (id) => `DELETE /sandboxes/${id}`);
  });
});

describe("promigence", () => {
  it("starts a run of one sandbox, waits until it is ready, and sets the timeout as a total", async () => {
    const files = new Map<string, Buffer>();
    let polls = 0;
    const { url, seen } = await mock((r) => {
      if (r.headers.authorization !== "Bearer prom_api_test") return { status: 401, json: {} };
      if (r.method === "POST" && r.path === "/v1/runs") {
        expect(r.headers["idempotency-key"]).toBeTruthy();
        expect(r.json()).toMatchObject({ snapshot: "promigence/base", count: 1, tier: "small", timeout_ms: 120_000 });
        return { json: { run_id: "run_1", state: "queued", sandboxes: [{ sandbox_id: "p1", state: "queued" }] } };
      }
      if (r.method === "GET" && r.path === "/v1/sandboxes/p1") return { json: { sandbox_id: "p1", state: polls++ < 1 ? "queued" : "ready", elapsed_ms: 30_000 } };
      if (r.method === "POST" && r.path === "/v1/sandboxes/p1/execs") {
        const x = fakeRun(r.json().sh);
        return { json: { exec_id: "e", exit_code: x.code, stdout: x.stdout, stderr: x.stderr, timed_out: false } };
      }
      if (r.path === "/v1/sandboxes/p1/files" && r.method === "PUT") return files.set(r.query.get("path")!, r.body), { json: { ok: true } };
      if (r.path === "/v1/sandboxes/p1/files" && r.method === "GET") return { raw: files.get(r.query.get("path")!) ?? "" };
      if (r.method === "PATCH" && r.path === "/v1/sandboxes/p1") return expect(r.json()).toEqual({ timeout_ms: 630_000 }), { json: { ok: true } };
      if (r.method === "DELETE" && r.path === "/v1/sandboxes/p1") return { json: { ok: true, state: "ended" } };
      return undefined;
    });
    const { router } = routerFor(promigenceProvider, { PROMIGENCE_API_KEY: "prom_api_test", PROMIGENCE_API_URL: url });
    await lifecycle(router, { files: true });
    const sbx = await router.create({ timeoutSec: 120 });
    await sbx.setTimeout(600);
    expect(seen).toContain("PATCH /v1/sandboxes/p1");
    await sbx.kill();
  });
});

describe("dory", () => {
  it("mints one data token for many calls, confirms the delete, and is deleted at the deadline", async () => {
    const files = new Map<string, Buffer>();
    let self = "";
    let polls = 0;
    let mints = 0;
    const { url, seen } = await mock((r) => {
      if (r.path.startsWith("/data/")) {
        if (r.headers.authorization !== "Bearer cea_1") return { status: 401, json: {} };
        if (r.method === "POST" && r.path === "/data/exec") {
          const x = fakeRun(r.json().command);
          return { json: { proc_id: "p", exit_code: x.code, signal: null, timed_out: false, stdout: x.stdout, stderr: x.stderr, truncated: false, duration_ms: 1 } };
        }
        if (r.path === "/data/files" && r.method === "PUT") return files.set(r.query.get("path")!, r.body), { json: {} };
        if (r.path === "/data/files" && r.method === "GET") return { raw: files.get(r.query.get("path")!) ?? "" };
        return undefined;
      }
      if (r.headers.authorization !== "Bearer cek_live_test") return { status: 401, json: {} };
      if (r.method === "POST" && r.path === "/computers") {
        expect(r.headers["idempotency-key"]).toBeTruthy();
        expect(r.json()).toMatchObject({ size: "ac-2", desktop: false, on_timeout: "stop" });
        expect(LIFETIMES).toContain(r.json().timeout_seconds);
        return { status: 202, json: { operation: { id: "op_1", type: "create", state: "pending" }, computer: { id: "c1", state: "creating" } } };
      }
      if (r.method === "GET" && r.path === "/computers/c1") return { json: polls++ < 1 ? { id: "c1", state: "starting", ready: false } : { id: "c1", state: "running", ready: true } };
      if (r.method === "POST" && r.path === "/computers/c1/access") {
        mints++;
        expect(r.json().scopes).toEqual(["exec", "files"]);
        return { status: 201, json: { token: "cea_1", data_url: `${self}/data`, scopes: ["exec", "files"], expires_at: soon() } };
      }
      if (r.method === "DELETE" && r.path === "/computers/c1") {
        expect(r.headers["ce-confirm-delete"]).toBe("c1");
        return { status: 202, json: {} };
      }
      return undefined;
    });
    self = url;
    const { router, clock } = routerFor(doryProvider, { DORY_API_KEY: "cek_live_test", DORY_API_URL: url });
    await lifecycle(router, { files: true });
    expect(mints).toBe(1);
    // Its timer only stops the computer, which would keep billing storage.
    await deletedAtDeadline(router, clock, seen, (id) => `DELETE /computers/${id}`);
  });
});

describe("zode", () => {
  it("sends env as KEY=VALUE strings, caps commands at 55 s, and is deleted at the deadline", async () => {
    const { url, seen } = await mock((r) => {
      if (r.headers.authorization !== "Bearer zode_tok_test") return { status: 401, json: {} };
      if (r.method === "POST" && r.path === "/v1/sandboxes") {
        expect(r.json()).toMatchObject({ vcpus: 2, ram_mb: 4096 });
        return { status: 201, json: { id: "sbx_1", name: r.json().name, status: "running", vcpus: 2, ram_mb: 4096 } };
      }
      if (r.method === "POST" && r.path === "/v1/sandboxes/sbx_1/exec") {
        const b = r.json();
        expect(b.timeout_ms).toBeLessThanOrEqual(55_000);
        if (b.argv[2].includes("printenv")) return { json: { exit_code: 0, stdout: JSON.stringify(b.env), stderr: "" } };
        const x = fakeRun(b.argv[2]);
        return { json: { exit_code: x.code, stdout: x.stdout, stderr: x.stderr, duration_ms: 1 } };
      }
      if (r.method === "DELETE" && r.path === "/v1/sandboxes/sbx_1") return { json: { id: "sbx_1", status: "deleted" } };
      return undefined;
    });
    const { router, clock } = routerFor(zodeProvider, { ZODE_API_KEY: "zode_tok_test", ZODE_API_URL: url });
    const sbx = await router.create({ timeoutSec: 120 });
    expect((await sbx.commands.run("printenv", { env: { A: "1", B: "x y" }, timeoutSec: 600 })).stdout).toBe('["A=1","B=x y"]');
    await sbx.kill();
    // No file routes: files go through the router's exec fallback, which a mock can't run.
    await lifecycle(router);
    await deletedAtDeadline(router, clock, seen, (id) => `DELETE /v1/sandboxes/${id}`);
  });

  it("declares its exec limit, so longer commands are routed elsewhere", () => {
    expect(zodeProvider.info.maxExecSec).toBe(55);
  });
});

describe("maritime", () => {
  it("uses the sandbox's data plane and secret for commands and files", async () => {
    const files = new Map<string, Buffer>();
    let self = "";
    let lookups = 0;
    const { url, seen } = await mock((r) => {
      if (r.path.startsWith("/dp/")) {
        if (r.headers["x-maritime-token"] !== "sec_1") return { status: 401, json: {} };
        if (r.method === "POST" && r.path === "/dp/commands") {
          const x = fakeRun(r.json().cmd);
          return { json: { id: "cmd", state: "exited", exitCode: x.code, stdout: x.stdout, stderr: x.stderr } };
        }
        if (r.path === "/dp/files" && r.method === "PUT") return files.set(r.query.get("path")!, r.body), { json: {} };
        if (r.path === "/dp/files" && r.method === "GET") return { raw: files.get(r.query.get("path")!) ?? "" };
        return undefined;
      }
      if (r.headers.authorization !== "Bearer mk_test") return { status: 401, json: {} };
      if (r.method === "POST" && r.path === "/v1/sandboxes") {
        expect(r.json()).toMatchObject({ from: "base", vcpu: 2, memoryMib: 4096, timeLimitSeconds: 120, keepAwake: true });
        return { status: 201, json: { id: "sbx-1", state: "running", resources: { vcpu: 2, memoryMib: 4096 }, dataPlaneUrl: `${self}/dp`, secret: "sec_1" } };
      }
      if (r.method === "GET" && r.path === "/v1/sandboxes/sbx-1") return lookups++, { json: { id: "sbx-1", state: "running", dataPlaneUrl: `${self}/dp`, secret: "sec_1" } };
      if (r.method === "DELETE" && r.path === "/v1/sandboxes/sbx-1") return { json: { id: "sbx-1", state: "ended" } };
      return undefined;
    });
    self = url;
    const { router } = routerFor(maritimeProvider, { MARITIME_API_KEY: "mk_test", MARITIME_API_URL: url });
    await lifecycle(router, { files: true });
    // The create response already said where the data plane is.
    expect(lookups).toBe(0);
    expect(seen).toContain("DELETE /v1/sandboxes/sbx-1");
  });
});

describe("munito", () => {
  const ctx = (url: string) => ({ env: { MUNITO_API_KEY: "munitoai_test", MUNITO_API_URL: url }, options: {} });

  it("turns outbound network on, waits out a slow start, and moves the timeout", async () => {
    const files = new Map<string, Buffer>();
    let polls = 0;
    const { url, seen } = await mock((r) => {
      if (r.headers.authorization !== "Bearer munitoai_test") return { status: 401, json: {} };
      if (r.method === "POST" && r.path === "/sandboxes") {
        expect(r.json()).toMatchObject({ template: "base", vcpus: 2, memory_mib: 4096, timeout: 120, internet: true });
        return { status: 201, json: { id: "sbx_1", status: "pending" } };
      }
      if (r.method === "GET" && r.path === "/sandboxes/sbx_1") return { json: { id: "sbx_1", status: polls++ < 1 ? "pending" : "running", vcpus: 2, memory_mib: 4096 } };
      if (r.method === "POST" && r.path === "/sandboxes/sbx_1/exec") {
        const x = fakeRun(r.json().command);
        return { json: { exit_code: x.code, stdout: x.stdout, stderr: x.stderr, timed_out: false } };
      }
      if (r.path === "/sandboxes/sbx_1/files/content" && r.method === "PUT") return files.set(r.query.get("path")!, r.body), { status: 204 };
      if (r.path === "/sandboxes/sbx_1/files/content" && r.method === "GET") return { raw: files.get(r.query.get("path")!) ?? "" };
      if (r.method === "POST" && r.path === "/sandboxes/sbx_1/timeout") return expect(r.json()).toEqual({ timeout: 600 }), { json: {} };
      if (r.method === "DELETE" && r.path === "/sandboxes/sbx_1") return { json: { id: "sbx_1", status: "stopped" } };
      return undefined;
    });
    const { router } = routerFor(munitoProvider, { MUNITO_API_KEY: "munitoai_test", MUNITO_API_URL: url });
    await lifecycle(router, { files: true });
    const sbx = await router.create({ timeoutSec: 120 });
    await sbx.setTimeout(600);
    expect(seen).toContain("POST /sandboxes/sbx_1/timeout");
    await sbx.kill();
  });

  it("lists live sandboxes from either list shape, leaving stopped records out", async () => {
    const rows = [
      { id: "a", status: "running" },
      { id: "b", status: "stopped" },
      { id: "c", status: "paused" },
    ];
    const bare = await mock(() => ({ json: rows }));
    const paged = await mock(() => ({ json: { data: rows } }));
    expect(await munitoProvider.listAlive(ctx(bare.url))).toEqual(["a", "c"]);
    expect(await munitoProvider.listAlive(ctx(paged.url))).toEqual(["a", "c"]);
  });
});

describe("lizard", () => {
  const env = (url: string) => ({ LIZARD_API_KEY: "liz_test", LIZARD_PROJECT_ID: "prj_1", LIZARD_API_URL: url });

  it("always sends a timeout, checks the sandbox is running, and writes files as base64", async () => {
    const files = new Map<string, Buffer>();
    const { url, seen } = await mock((r) => {
      if (r.headers.authorization !== "Bearer liz_test") return { status: 401, json: {} };
      if (r.method === "POST" && r.path === "/api/sandboxes") {
        // The raw API's default is no expiration.
        expect(r.json()).toMatchObject({ template: "base", projectId: "prj_1", size: "small", timeoutMs: 120_000 });
        return { status: 201, json: { sandboxId: "lz1" } };
      }
      if (r.method === "GET" && r.path === "/api/sandboxes/lz1") return { json: { sandboxId: "lz1", status: "running" } };
      if (r.method === "POST" && r.path === "/api/sandboxes/lz1/exec") {
        const x = fakeRun(r.json().cmd);
        return { json: { stdout: x.stdout, stderr: x.stderr, exitCode: x.code } };
      }
      if (r.method === "POST" && r.path === "/api/sandboxes/lz1/files") {
        const b = r.json();
        expect(b.encoding).toBe("base64");
        return files.set(b.path, Buffer.from(b.content, "base64")), { json: {} };
      }
      if (r.method === "GET" && r.path === "/api/sandboxes/lz1/files") return { raw: files.get(r.query.get("path")!) ?? "" };
      if (r.method === "DELETE" && r.path === "/api/sandboxes/lz1") return { json: {} };
      return undefined;
    });
    const { router } = routerFor(lizardProvider, env(url));
    await lifecycle(router, { files: true });
    expect(seen).toContain("DELETE /api/sandboxes/lz1");
  });

  it("refuses a list it can't read, so the sweep can't take live sandboxes for gone", async () => {
    const good = await mock(() => ({ json: [{ sandboxId: "a", status: "running" }, { sandboxId: "b", status: "stopped" }] }));
    const odd = await mock(() => ({ json: { items: [] } }));
    const noIds = await mock(() => ({ json: [{ name: "x", status: "running" }] }));
    expect(await lizardProvider.listAlive({ env: env(good.url), options: {} })).toEqual(["a"]);
    await expect(lizardProvider.listAlive({ env: env(odd.url), options: {} })).rejects.toThrow(/unexpected response shape/);
    await expect(lizardProvider.listAlive({ env: env(noIds.url), options: {} })).rejects.toThrow(/without an id/);
  });
});
