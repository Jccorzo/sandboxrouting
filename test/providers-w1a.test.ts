// The adapters added on 2026-11-21 (wave 1: Groundbox, briq, Kubi, Orble, Runtime Cloud,
// DigitalOcean Harness Runtime, Docker Sandboxes cloud), driven through the router against
// local servers that speak each provider's wire format, from its OpenAPI spec, docs or official
// SDK. None has been run against the real service.
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { fakeRun, lifecycle, mock, routerFor, deletedAtDeadline } from "./restmock.js";
import type { ProviderAdapter } from "../src/index.js";
import { groundboxProvider, groundboxShape } from "../src/providers/groundbox.js";
import { briqProvider, briqSize } from "../src/providers/briq.js";
import { kubiProvider } from "../src/providers/kubi.js";
import { orbleProvider, orbleSize } from "../src/providers/orble.js";
import { runtimeProvider } from "../src/providers/runtime.js";
import { digitaloceanProvider, digitaloceanSize, digitaloceanSpec } from "../src/providers/digitalocean.js";
import { dockerCloudProvider, dockerCloudSize } from "../src/providers/docker-cloud.js";

/** The lifetimes the shared helpers ask for: `lifecycle` 120 s, `deletedAtDeadline` 60 s. */
const LIFETIMES = [120, 60];
const soon = () => new Date(Date.now() + 3_600_000).toISOString();
const ctx = (env: Record<string, string>) => ({ env, options: { pollMs: 1 } });

/** A create the provider refuses with `status` fails over with `kind`. */
async function refused(adapter: ProviderAdapter, env: Record<string, string>, kind: string) {
  const { router } = routerFor(adapter, env);
  await expect(router.create({ timeoutSec: 60 })).rejects.toMatchObject({ attempts: [expect.objectContaining({ provider: adapter.info.id, outcome: "failed", kind })] });
}

describe("sizes", () => {
  it("maps a request to each provider's sizes", () => {
    expect(groundboxShape(2, 4096)).toEqual({ cpus: 2, memory_gb: 4 });
    expect(groundboxShape(1, 9000)).toEqual({ cpus: 1, memory_gb: 4 });
    expect(groundboxShape(99, 1)).toEqual({ cpus: 16, memory_gb: 1 });
    expect(briqSize(1, 1024).size).toBe("small");
    expect(briqSize(2, 4096).size).toBe("medium");
    expect(briqSize(64, 1).size).toBe("xlarge");
    expect(orbleSize(2, 4096).size).toBe("s");
    expect(orbleSize(3, 1024).size).toBe("m");
    expect(digitaloceanSize(1, 2048).size).toBe("mars-2vcpu-2gb");
    expect(digitaloceanSize(5, 1024).size).toBe("mars-16vcpu-32gb");
    expect(dockerCloudSize(1, 1024).size).toBe("micro");
    expect(dockerCloudSize(2, 6000).size).toBe("medium");
  });
});

describe("groundbox", () => {
  it("creates with an idempotency key, polls until running, runs commands, moves files and lists a folder", async () => {
    const files = new Map<string, Buffer>();
    let polls = 0;
    const { url, seen } = await mock((r) => {
      if (r.headers.authorization !== "Bearer gbx_test") return { status: 401, json: { error: { code: "unauthorized", message: "no key" } } };
      if (r.method === "POST" && r.path === "/sandboxes") {
        expect(r.headers["idempotency-key"]).toBeTruthy();
        const b = r.json();
        expect(b).toMatchObject({ cpus: 2, memory_gb: 4, on_timeout: "delete" });
        expect(b.timeout_minutes).toBe(2);
        expect(b.metadata["sandboxrouting.id"]).toBeTruthy();
        return { json: { id: "sbx_abcdefgh", status: "starting" } };
      }
      if (r.method === "GET" && r.path === "/sandboxes/sbx_abcdefgh") return { json: { id: "sbx_abcdefgh", status: polls++ < 1 ? "starting" : "running", started_at: new Date().toISOString() } };
      if (r.method === "POST" && r.path === "/sandboxes/sbx_abcdefgh/exec") {
        const x = fakeRun(r.json().cmd);
        return { json: { exit_code: x.code, stdout: x.stdout, stderr: x.stderr, duration_ms: 1, timed_out: false } };
      }
      if (r.path === "/sandboxes/sbx_abcdefgh/files" && r.method === "PUT") return files.set(r.query.get("path")!, r.body), { json: { path: r.query.get("path"), size_bytes: r.body.length } };
      if (r.path === "/sandboxes/sbx_abcdefgh/files" && r.method === "GET" && r.query.get("dir")) {
        return { json: { dir: r.query.get("dir"), entries: [...files.keys()].map((p) => ({ name: p.split("/").pop(), path: p, type: "file", size_bytes: files.get(p)!.length, modified_at: soon() })) } };
      }
      if (r.path === "/sandboxes/sbx_abcdefgh/files" && r.method === "GET") return { raw: files.get(r.query.get("path")!) ?? "" };
      if (r.method === "DELETE" && r.path === "/sandboxes/sbx_abcdefgh") return { json: { id: "sbx_abcdefgh", status: "stopped" } };
      return undefined;
    });
    const env = { GROUNDBOX_API_KEY: "gbx_test", GROUNDBOX_API_URL: url };
    const { router } = routerFor(groundboxProvider, env);
    const sbx = await lifecycle(router, { files: true });
    expect(polls).toBe(2);
    expect(await groundboxProvider.listFiles!(sbx.providerSandboxId, "/tmp", ctx(env))).toEqual([{ name: "a.txt", path: "/tmp/a.txt", isDir: false, size: 5 }]);
    expect(seen).toContain("DELETE /sandboxes/sbx_abcdefgh");
  });

  it("deletes a sandbox that failed to start, and treats a 404 on delete as already gone", async () => {
    const { url, seen } = await mock((r) => {
      if (r.method === "POST" && r.path === "/sandboxes") return { json: { id: "sbx_failedxx", status: "queued" } };
      if (r.method === "GET" && r.path === "/sandboxes/sbx_failedxx") return { json: { id: "sbx_failedxx", status: "failed", error: "image pull failed" } };
      if (r.method === "DELETE" && r.path === "/sandboxes/sbx_failedxx") return { json: {} };
      if (r.method === "DELETE") return { status: 404, json: { error: { code: "not_found", message: "Nothing with that id in your team" } } };
      return undefined;
    });
    const env = { GROUNDBOX_API_KEY: "gbx_test", GROUNDBOX_API_URL: url };
    const { router } = routerFor(groundboxProvider, env);
    await expect(router.create({})).rejects.toThrow(/image pull failed/);
    expect(seen).toContain("DELETE /sandboxes/sbx_failedxx");
    await expect(groundboxProvider.kill("sbx_nevermade", ctx(env))).resolves.toBeUndefined();
  });

  it("moves the deadline from the sandbox's start, since timeout_minutes counts from there", async () => {
    let patched: number | undefined;
    const { url } = await mock((r) => {
      if (r.method === "GET") return { json: { id: "sbx_x", status: "running", started_at: new Date(Date.now() - 10 * 60_000 + 5_000).toISOString() } };
      if (r.method === "PATCH") return (patched = r.json().timeout_minutes), { json: {} };
      return undefined;
    });
    await groundboxProvider.setTimeout!("sbx_x", 300, ctx({ GROUNDBOX_API_KEY: "k", GROUNDBOX_API_URL: url }));
    expect(patched).toBe(15);
  });

  it("is refused past the free credit with a quota mark", async () => {
    const { url } = await mock(() => ({ status: 402, json: { error: { code: "trial_credit_exhausted", message: "The free credit is used up" } } }));
    await refused(groundboxProvider, { GROUNDBOX_API_KEY: "gbx_test", GROUNDBOX_API_URL: url }, "quota");
  });
});

describe("briq", () => {
  it("runs the sandbox recipe, polls a briq still creating, and runs short and long commands", async () => {
    const files = new Map<string, Buffer>();
    let polls = 0;
    const execs = new Map<string, ReturnType<typeof fakeRun>>();
    const { url, seen } = await mock((r) => {
      if (r.headers.authorization !== "Bearer briq_test") return { status: 401, json: { error: { code: "unauthorized", message: "no" } } };
      if (r.method === "POST" && r.path === "/v1/briqs") {
        const b = r.json();
        expect(r.headers["idempotency-key"]).toBeTruthy();
        expect(b).toMatchObject({ recipe: "sandbox", size: "medium", wait: true });
        expect(b.name).toMatch(/^sbr-[0-9a-f]{16}$/);
        expect(b.sleep).toMatch(/^\d+m$/);
        return { status: 201, json: { briqs: [{ id: "bq_1", state: "creating" }], ready: false, message: "bq_1 is still creating" } };
      }
      if (r.method === "GET" && r.path === "/v1/briqs/bq_1") return { json: { briq: { id: "bq_1", state: polls++ < 1 ? "creating" : "running" } } };
      if (r.method === "POST" && r.path === "/v1/briqs/bq_1/exec") {
        const b = r.json();
        expect(b.cmd.slice(0, 2)).toEqual(["sh", "-c"]);
        const x = fakeRun(b.cmd[2]);
        if (b.async) {
          execs.set("ex_1", x);
          return { status: 202, json: { exec: { id: "ex_1", state: "running" }, costLine: "" } };
        }
        expect(b.timeoutMs).toBeLessThanOrEqual(60_000);
        return { json: { stdout: x.stdout, stderr: x.stderr, exitCode: x.code, timedOut: false, truncated: false, costLine: "" } };
      }
      if (r.method === "GET" && r.path === "/v1/briqs/bq_1/execs/ex_1") {
        const x = execs.get("ex_1")!;
        const offset = r.query.get("offset");
        if (offset === null) return { json: { exec: { id: "ex_1", state: "exited", exitCode: x.code } } };
        const text = r.query.get("stream") === "stderr" ? x.stderr : x.stdout;
        const from = Number(offset);
        // Two reads per stream, to follow nextOffset.
        const part = from === 0 ? text.slice(0, 3) : text.slice(from);
        return { json: { exec: { id: "ex_1", state: "exited", read: { data: part, nextOffset: from + part.length, eof: from !== 0 || part.length === text.length } } } };
      }
      if (r.path === "/v1/briqs/bq_1/files" && r.method === "PUT") return files.set(r.query.get("path")!, r.body), { json: { path: r.query.get("path"), bytes: r.body.length, sha256: "", verified: true } };
      if (r.path === "/v1/briqs/bq_1/files/raw" && r.method === "GET") return { raw: files.get(r.query.get("path")!) ?? "" };
      if (r.method === "DELETE" && r.path === "/v1/briqs/bq_1") return { json: { briq: { id: "bq_1", state: "destroyed" } } };
      return undefined;
    });
    const env = { BRIQ_API_KEY: "briq_test", BRIQ_API_URL: url };
    const { router, clock } = routerFor(briqProvider, env);
    const sbx = await router.create({ timeoutSec: 120 });
    expect(polls).toBe(2);
    expect((await sbx.commands.run("echo hi", { timeoutSec: 30 })).stdout).toBe("ran: echo hi\n");
    const long = await sbx.commands.run("echo long", { timeoutSec: 600 });
    expect(long).toMatchObject({ stdout: "ran: echo long\n", exitCode: 0 });
    expect((await sbx.commands.run("exit 3", { timeoutSec: 600 })).exitCode).toBe(3);
    await sbx.files.write("/work/a.txt", "hello");
    expect(await sbx.files.read("/work/a.txt")).toBe("hello");
    await sbx.kill();
    expect(seen).toContain("DELETE /v1/briqs/bq_1");
    // Nothing ends a briq on time: the router deletes it at the deadline.
    await deletedAtDeadline(router, clock, seen, (id) => `DELETE /v1/briqs/${id}`);
  });

  it("reads a plan_limit 403 as a quota, not a bad key; a 404 on delete is already gone", async () => {
    const { url } = await mock((r) =>
      r.method === "DELETE"
        ? { status: 404, json: { error: { code: "not_found", message: "not found" } } }
        : { status: 403, json: { error: { code: "plan_limit", message: "size large is not on the Hobby plan" } } },
    );
    const env = { BRIQ_API_KEY: "briq_test", BRIQ_API_URL: url };
    await refused(briqProvider, env, "quota");
    await expect(briqProvider.kill("bq_gone", ctx(env))).resolves.toBeUndefined();
  });
});

describe("kubi", () => {
  it("creates a disposable screen, waits on its operation, keeps env in a file, and follows a long command", async () => {
    const files = new Map<string, Buffer>();
    let opPolls = 0;
    let execPolls = 0;
    const { url, seen } = await mock((r) => {
      if (r.headers.authorization !== "Bearer kubi_test") return { status: 401, json: { error: { code: "UNAUTHENTICATED", message: "no" } } };
      if (r.method === "POST" && r.path === "/screens") {
        const b = r.json();
        expect(r.headers["idempotency-key"]!.length).toBeGreaterThanOrEqual(8);
        expect(b).toMatchObject({ kind: "disposable" });
        expect(b.ends_in_s).toBe(300); // 120 s asked; 5 minutes is the least
        expect(b.labels["sandboxrouting.id"]).toBeTruthy();
        return { status: 202, json: { id: "op_1", kind: "screen.create", status: "queued", screen_id: "scr_1" } };
      }
      if (r.method === "GET" && r.path === "/operations/op_1") return { json: { id: "op_1", kind: "screen.create", status: opPolls++ < 1 ? "running" : "succeeded", screen_id: "scr_1" } };
      if (r.method === "POST" && r.path === "/screens/scr_1/exec") {
        const b = r.json();
        expect(b.command).toContain(". /home/user/.sbr-env");
        const x = fakeRun(b.command);
        if (b.command.includes("slow")) return { status: 202, json: { id: "ex_1", screen_id: "scr_1", status: "running", stdout: "part ", stderr: "", stdout_bytes: 5, stderr_bytes: 0, incarnation: 0 } };
        return { json: { id: "ex_0", screen_id: "scr_1", status: "exited", exit_code: x.code, stdout: x.stdout, stderr: x.stderr, stdout_bytes: x.stdout.length, stderr_bytes: x.stderr.length, incarnation: 0 } };
      }
      if (r.method === "GET" && r.path === "/screens/scr_1/exec/ex_1") {
        expect(r.query.get("stdout_from")).toBe(execPolls === 0 ? "5" : "9");
        return execPolls++ === 0
          ? { json: { id: "ex_1", status: "running", stdout: "two ", stderr: "", stdout_bytes: 9, stderr_bytes: 0, incarnation: 0 } }
          : { json: { id: "ex_1", status: "exited", exit_code: 0, stdout: "done", stderr: "", stdout_bytes: 13, stderr_bytes: 0, incarnation: 0 } };
      }
      if (r.path === "/screens/scr_1/files" && r.method === "PUT") return files.set(r.query.get("path")!, r.body), { json: {} };
      if (r.path === "/screens/scr_1/files" && r.method === "GET") return files.has(r.query.get("path")!) ? { raw: files.get(r.query.get("path")!)! } : { status: 404, json: { error: { code: "FILE_NOT_FOUND", message: "nothing there" } } };
      if (r.method === "DELETE" && r.path === "/screens/scr_1") return { status: 202, json: { id: "op_2", kind: "screen.delete", status: "queued", screen_id: "scr_1" } };
      if (r.method === "DELETE") return { status: 404, json: { error: { code: "SCREEN_NOT_FOUND", message: "No such screen" } } };
      return undefined;
    });
    const env = { KUBI_API_KEY: "kubi_test", KUBI_API_URL: url };
    const { router } = routerFor(kubiProvider, env);
    const sbx = await router.create({ timeoutSec: 120, env: { TOKEN: "it's" } });
    expect(files.get("/home/user/.sbr-env")!.toString()).toBe("export TOKEN='it'\\''s'\n");
    expect((await sbx.commands.run("echo hi")).stdout).toBe("ran: [ -f /home/user/.sbr-env ] && . /home/user/.sbr-env; echo hi\n");
    expect((await sbx.commands.run("exit 3")).exitCode).toBe(3);
    expect(await sbx.commands.run("slow")).toMatchObject({ stdout: "part two done", exitCode: 0 });
    await sbx.files.write("/home/user/a.txt", "hello");
    expect(await sbx.files.read("/home/user/a.txt")).toBe("hello");
    await sbx.kill();
    expect(seen).toContain("DELETE /screens/scr_1");
    await expect(kubiProvider.kill("scr_gone", ctx(env))).resolves.toBeUndefined();
  });

  it("deletes a screen whose create failed, and fails over on CREDIT_EXHAUSTED as a quota", async () => {
    const failed = await mock((r) => {
      if (r.method === "POST") return { status: 202, json: { id: "op_9", status: "queued", screen_id: "scr_9" } };
      if (r.method === "GET") return { json: { id: "op_9", status: "failed", screen_id: "scr_9", error: { code: "NO_CAPACITY", message: "no machine" } } };
      if (r.method === "DELETE") return { status: 202, json: { id: "op_10", status: "queued", screen_id: "scr_9" } };
      return undefined;
    });
    const { router } = routerFor(kubiProvider, { KUBI_API_KEY: "k", KUBI_API_URL: failed.url });
    await expect(router.create({})).rejects.toThrow(/NO_CAPACITY/);
    expect(failed.seen).toContain("DELETE /screens/scr_9");
    const broke = await mock(() => ({ status: 402, json: { error: { code: "CREDIT_EXHAUSTED", message: "The usage credit is used up" } } }));
    await refused(kubiProvider, { KUBI_API_KEY: "k", KUBI_API_URL: broke.url }, "quota");
  });
});

describe("orble", () => {
  it("names the box from the router id, asks again for a job still running, and is deleted at the deadline", async () => {
    const files = new Map<string, Buffer>();
    const names: string[] = [];
    let polls = 0;
    const { url, seen } = await mock((r) => {
      if (r.headers.authorization !== "Bearer orble_test") return { status: 401, json: { error: "unauthorized" } };
      if (r.method === "POST" && r.path === "/v1/boxes") {
        const b = r.json();
        expect(b.name).toMatch(/^sbr-[0-9a-f]{16}$/);
        expect(b.size).toBe("s");
        names.push(b.name);
        return { json: { name: b.name, state: "starting" } };
      }
      const m = /^\/v1\/boxes\/(sbr-[0-9a-f]+)(\/.*)?$/.exec(r.path);
      if (!m) return undefined;
      if (r.method === "GET" && !m[2]) return { json: { name: m[1], state: polls++ < 1 ? "starting" : "running" } };
      if (r.method === "POST" && m[2] === "/exec") {
        const b = r.json();
        if (b.job) return { json: { exit_code: 0, stdout: "finished\n", stderr: "", timed_out: false } };
        expect(b.timeout_s).toBeLessThanOrEqual(600);
        if (b.command.includes("slow")) return { json: { running: true, job: "j1" } };
        const x = fakeRun(b.command);
        return { json: { exit_code: x.code, stdout: x.stdout, stderr: x.stderr, timed_out: false } };
      }
      if (r.method === "PUT" && m[2] === "/files") return files.set(r.query.get("path")!, r.body), { json: {} };
      if (r.method === "GET" && m[2] === "/files") {
        const all = files.get(r.query.get("path")!) ?? Buffer.alloc(0);
        const offset = Number(r.query.get("offset"));
        const part = all.subarray(offset, offset + 3);
        return { json: { content: part.toString("base64"), encoding: "base64", bytes: part.length, size: all.length } };
      }
      if (r.method === "DELETE" && !m[2]) return { json: {} };
      return undefined;
    });
    const env = { ORBLE_API_KEY: "orble_test", ORBLE_API_URL: url };
    const { router, clock } = routerFor(orbleProvider, env);
    const sbx = await lifecycle(router, { files: true });
    expect(sbx.providerSandboxId).toBe(names[0]);
    expect(seen).toContain(`DELETE /v1/boxes/${names[0]}`);
    const again = await router.create({});
    expect((await again.commands.run("slow")).stdout).toBe("finished\n");
    await again.kill();
    await deletedAtDeadline(router, clock, seen, (id) => `DELETE /v1/boxes/${id}`);
  });

  it("treats a 404 on delete as already gone, and a 402 as out of credit", async () => {
    const { url } = await mock((r) => (r.method === "DELETE" ? { status: 404, json: { error: "box not found" } } : { status: 402, json: { error: "insufficient credit" } }));
    const env = { ORBLE_API_KEY: "orble_test", ORBLE_API_URL: url };
    await expect(orbleProvider.kill("sbr-gone", ctx(env))).resolves.toBeUndefined();
    await refused(orbleProvider, env, "quota");
  });
});

describe("runtime", () => {
  it("creates with a lifetime, reads a command's output from a cursor, and moves the lifetime from now", async () => {
    const files = new Map<string, Buffer>();
    let polls = 0;
    const procs = new Map<string, ReturnType<typeof fakeRun>>();
    let updated: number | undefined;
    const { url, seen } = await mock((r) => {
      if (r.headers.authorization !== "Bearer rt_test") return { status: 401, json: { error: { code: "unauthorized", message: "no" } } };
      expect(r.headers["runtime-version"]).toBe("2026-10-27");
      if (r.method === "POST" && r.path === "/v2/sandboxes") {
        const b = r.json();
        expect(r.headers["idempotency-key"]).toBeTruthy();
        expect(b).toMatchObject({ vcpu: 2, memoryGB: 4 });
        expect(LIFETIMES).toContain(b.deleteAfterSeconds);
        return { json: { id: "sb_1", state: "starting", vcpu: 2, memoryGB: 4 } };
      }
      if (r.method === "GET" && r.path === "/v2/sandboxes/sb_1") return { json: { id: "sb_1", state: polls++ < 1 ? "starting" : "running" } };
      if (r.method === "POST" && r.path === "/v2/sandboxes/sb_1:exec") {
        const b = r.json();
        expect(b.wait).toBe(false);
        const id = `p${procs.size}`;
        procs.set(id, fakeRun(b.cmd));
        return { json: { id, object: "process", state: "running" } };
      }
      const out = /^\/v2\/sandboxes\/sb_1\/processes\/(p\d+)\/output$/.exec(r.path);
      if (out && r.method === "GET") {
        const x = procs.get(out[1]!)!;
        const cursor = Number(r.query.get("cursor"));
        const chunks = cursor === 0 ? [...(x.stdout ? [{ offset: 0, stream: "stdout", text: x.stdout }] : []), ...(x.stderr ? [{ offset: 0, stream: "stderr", text: x.stderr }] : [])] : [];
        const next = cursor === 0 ? x.stdout.length + x.stderr.length : cursor;
        return { json: { chunks, nextCursor: next, truncated: false, droppedBytes: 0, process: { id: out[1], state: cursor === 0 ? "running" : "exited", exitCode: x.code } } };
      }
      if (r.path === "/v2/sandboxes/sb_1/files" && r.method === "PUT") return files.set(r.query.get("path")!, r.body), { json: { path: r.query.get("path") } };
      if (r.path === "/v2/sandboxes/sb_1/files" && r.method === "GET") return { raw: files.get(r.query.get("path")!) ?? "" };
      if (r.path === "/v2/sandboxes/sb_1:update" && r.method === "POST") return (updated = r.json().deleteAfterSeconds), { json: { id: "sb_1", state: "running" } };
      if (r.method === "DELETE" && r.path === "/v2/sandboxes/sb_1") return { json: { id: "sb_1", state: "deleted" } };
      return undefined;
    });
    const env = { RUNTIME_API_KEY: "rt_test", RUNTIME_API_URL: url };
    const { router } = routerFor(runtimeProvider, env);
    const sbx = await router.create({ timeoutSec: 120 });
    await sbx.setTimeout(900);
    expect(updated).toBe(900);
    const ok = await sbx.commands.run("echo hi");
    expect(ok).toMatchObject({ stdout: "ran: echo hi\n", exitCode: 0 });
    const bad = await sbx.commands.run("exit 3");
    expect(bad).toMatchObject({ stderr: "boom\n", exitCode: 3 });
    await sbx.files.write("/tmp/a.txt", "hello");
    expect(await sbx.files.read("/tmp/a.txt")).toBe("hello");
    await sbx.kill();
    expect(seen).toContain("DELETE /v2/sandboxes/sb_1");
  });

  it("deletes a machine that ended in error; 404 on delete is gone; limit_exceeded is a rate limit", async () => {
    const failed = await mock((r) => {
      if (r.method === "POST") return { json: { id: "sb_9", state: "starting" } };
      if (r.method === "GET") return { json: { id: "sb_9", state: "error" } };
      if (r.method === "DELETE" && r.path === "/v2/sandboxes/sb_9") return { json: { id: "sb_9", state: "deleted" } };
      if (r.method === "DELETE") return { status: 404, json: { error: { code: "not_found", message: "No such sandbox." } } };
      return undefined;
    });
    const env = { RUNTIME_API_KEY: "k", RUNTIME_API_URL: failed.url };
    const { router } = routerFor(runtimeProvider, env);
    await expect(router.create({})).rejects.toThrow(/is error/);
    expect(failed.seen).toContain("DELETE /v2/sandboxes/sb_9");
    await expect(runtimeProvider.kill("sb_gone", ctx(env))).resolves.toBeUndefined();
    const full = await mock(() => ({ status: 403, json: { error: { code: "limit_exceeded", message: "100 vCPUs are running" } } }));
    await refused(runtimeProvider, { RUNTIME_API_KEY: "k", RUNTIME_API_URL: full.url }, "rate_limit");
  });
});

describe("digitalocean", () => {
  const footer = (b: Buffer) => Buffer.concat([b, Buffer.from(`DOWSSHA1${createHash("sha256").update(b).digest("hex")}\n`)]);

  it("writes the spec as YAML a parser reads back", async () => {
    const { parse } = await import("yaml");
    expect(parse(digitaloceanSpec("sbr-1", "mars-2vcpu-4gb", { "sandboxrouting.id": "a: b", q: 'say "hi"' }))).toEqual({
      name: "sbr-1",
      harness: "none",
      size: "mars-2vcpu-4gb",
      labels: { "sandboxrouting.id": "a: b", q: 'say "hi"' },
    });
  });

  it("creates a sandbox session from YAML, polls until ready, runs argv, moves workspace files, and deletes its config", async () => {
    const files = new Map<string, Buffer>();
    let polls = 0;
    const { url, seen } = await mock((r) => {
      if (r.headers.authorization !== "Bearer dop_v1_test") return { status: 401, json: { id: "unauthorized", message: "Unable to authenticate you" } };
      if (r.method === "POST" && r.path === "/v2/harness-runtime/sessions") {
        expect(r.headers["content-type"]).toBe("application/x-yaml");
        const spec = r.body.toString();
        expect(spec).toContain("harness: none");
        expect(spec).toContain('size: "mars-2vcpu-4gb"');
        return { json: { session: { session_id: "s-1", status: "SESSION_STATUS_PROVISIONING", config_id: "cfg-1" } } };
      }
      if (r.method === "GET" && r.path === "/v2/harness-runtime/sessions/s-1") return { json: { session: { session_id: "s-1", status: polls++ < 1 ? "SESSION_STATUS_PROVISIONING" : "SESSION_STATUS_READY", config_id: "cfg-1" } } };
      if (r.method === "POST" && r.path === "/v2/harness-runtime/sessions/s-1/sandbox/exec") {
        const b = r.json();
        expect(b.argv.slice(0, 2)).toEqual(["sh", "-c"]);
        expect(b.timeout_seconds).toBeLessThanOrEqual(240);
        if (b.stdin !== undefined) return files.set("/tmp/.sbr-env", Buffer.from(b.stdin, "base64")), { json: { exit_code: 0, stdout: "", stderr: "" } };
        const x = fakeRun(b.argv[2]);
        return { json: { exit_code: x.code, stdout: x.stdout, stderr: x.stderr, duration_ms: 1 } };
      }
      if (r.method === "POST" && r.path === "/v2/harness-runtime/sessions/s-1/workspace/upload") return files.set(r.query.get("path")!, r.body), { json: { bytes_written: r.body.length, path: r.query.get("path") } };
      if (r.method === "GET" && r.path === "/v2/harness-runtime/sessions/s-1/workspace/download") return { raw: footer(files.get(r.query.get("path")!) ?? Buffer.alloc(0)) };
      if (r.method === "DELETE" && r.path === "/v2/harness-runtime/sessions/s-1") return { status: 204, raw: "" };
      if (r.method === "DELETE" && r.path === "/v2/harness-runtime/configs/cfg-1") return { status: 204, raw: "" };
      return undefined;
    });
    const env = { DIGITALOCEAN_TOKEN: "dop_v1_test", DIGITALOCEAN_API_URL: url };
    const { router, clock } = routerFor(digitaloceanProvider, env);
    const sbx = await router.create({ timeoutSec: 120, env: { API_KEY: "secret" } });
    expect(files.get("/tmp/.sbr-env")!.toString()).toBe("export API_KEY='secret'\n");
    expect((await sbx.commands.run("echo hi")).stdout).toContain("echo hi");
    expect((await sbx.commands.run("exit 3")).exitCode).toBe(3);
    await sbx.files.write("/workspace/a.txt", "hello");
    expect(await sbx.files.read("/workspace/a.txt")).toBe("hello");
    await sbx.kill();
    expect(seen).toContain("DELETE /v2/harness-runtime/sessions/s-1");
    expect(seen).toContain("DELETE /v2/harness-runtime/configs/cfg-1");
    await deletedAtDeadline(router, clock, seen, (id) => `DELETE /v2/harness-runtime/sessions/${id}`);
  });

  it("finds a retried create's session by name, and a gone session needs no delete", async () => {
    const { url, seen } = await mock((r) => {
      if (r.method === "POST" && r.path === "/v2/harness-runtime/sessions") return { status: 409, json: { id: "conflict", message: "a live session name already exists" } };
      if (r.method === "GET" && r.path === "/v2/harness-runtime/sessions") {
        expect(r.query.get("name")).toMatch(/^sbr-/);
        return { json: { sessions: [{ session_id: "s-2", status: "SESSION_STATUS_READY", config_id: "cfg-2" }] } };
      }
      if (r.path === "/v2/harness-runtime/sessions/gone") return { status: 404, json: { id: "not_found", message: "The resource you were accessing could not be found." } };
      return undefined;
    });
    const env = { DIGITALOCEAN_TOKEN: "t", DIGITALOCEAN_API_URL: url };
    expect((await digitaloceanProvider.create({ cpu: 2, memoryMiB: 4096, timeoutSec: 60, env: {}, metadata: { "sandboxrouting.id": "r1" } }, ctx(env))).providerSandboxId).toBe("s-2");
    await expect(digitaloceanProvider.kill("gone", ctx(env))).resolves.toBeUndefined();
    expect(seen.filter((s) => s.startsWith("DELETE"))).toEqual([]);
  });

  it("is refused by the prepayment gate as a quota", async () => {
    const { url } = await mock(() => ({ status: 402, json: { id: "payment_required", message: "The team is blocked by the prepayment gate." } }));
    await refused(digitaloceanProvider, { DIGITALOCEAN_TOKEN: "t", DIGITALOCEAN_API_URL: url }, "quota");
  });
});

describe("docker-cloud", () => {
  it("exchanges the PAT, creates from an image, gets a scoped endpoint credential once, and deletes with the ETag", async () => {
    const files = new Map<string, Buffer>();
    let self = "";
    let polls = 0;
    let exchanges = 0;
    let credentials = 0;
    let etag = 0;
    const { url, seen } = await mock((r) => {
      if (r.method === "POST" && r.path === "/hub/token") {
        exchanges++;
        expect(r.json()).toEqual({ identifier: "me", secret: "dckr_pat_test" });
        return { json: { access_token: "hub_access" } };
      }
      if (r.path.startsWith("/endpoint/")) {
        if (r.headers.authorization !== "Bearer scoped_1") return { status: 401, json: { code: "unauthenticated", message: "management tokens are not accepted" } };
        if (r.method === "POST" && r.path === "/endpoint/v1/processes/exec") {
          const b = r.json();
          const x = fakeRun(b.cmd[2]);
          return { json: { exitCode: x.code, stdout: Buffer.from(x.stdout).toString("base64"), stderr: Buffer.from(x.stderr).toString("base64"), incomplete: false } };
        }
        if (r.path === "/endpoint/v1/files/content" && r.method === "PUT") return files.set(r.query.get("path")!, r.body), { json: { info: { path: r.query.get("path") } } };
        if (r.path === "/endpoint/v1/files/content" && r.method === "GET") return { raw: files.get(r.query.get("path")!) ?? "" };
        return undefined;
      }
      if (r.headers.authorization !== "Bearer hub_access") return { status: 401, json: { code: "unauthenticated", message: "no" } };
      const sandbox = (status: string) => ({ name: "sandboxes/u1", uid: "u1", core: { status, etag: `"e${etag}"`, createdAt: soon(), endpoint: { uri: `${self}/endpoint`, sandbox: "sandboxes/u1" } } });
      if (r.method === "POST" && r.path === "/api/v1/sandboxes") {
        const b = r.json();
        expect(r.headers["idempotency-key"]).toBeTruthy();
        expect(b).toMatchObject({ imageRef: "ubuntu:24.04", resources: { cpus: 2, memoryMib: 4096 }, features: { timeouts: { onTimeout: "delete" } } });
        expect(LIFETIMES.map((s) => `${s}s`)).toContain(b.features.timeouts.timeout);
        return { status: 202, json: sandbox("creating") };
      }
      if (r.method === "GET" && r.path === "/api/v1/sandboxes/u1") return { json: sandbox(polls++ < 1 ? "creating" : "running") };
      if (r.method === "POST" && r.path === "/api/v1/sandboxes/u1/endpoint-credentials") {
        credentials++;
        return { json: { token: "scoped_1", expireTime: soon(), permissions: r.json().permissions, sandbox: "sandboxes/u1", audience: "a" } };
      }
      if (r.method === "DELETE" && r.path === "/api/v1/sandboxes/u1") {
        expect(r.query.get("force")).toBe("true");
        // The first delete loses a race with another change and must re-read the ETag.
        if (r.headers["if-match"] !== `"e${etag}"` || etag === 0) return etag++, { status: 412, json: { code: "failedPrecondition", message: "etag_mismatch" } };
        return { status: 204, raw: "" };
      }
      return undefined;
    });
    self = url;
    const env = { DOCKER_ID: "me", DOCKER_PAT: "dckr_pat_test", DOCKER_SANDBOXES_API_URL: `${url}/api`, DOCKER_HUB_AUTH_URL: `${url}/hub/token` };
    const { router } = routerFor(dockerCloudProvider, env);
    const sbx = await lifecycle(router, { files: true });
    expect(exchanges).toBe(1);
    expect(credentials).toBe(1);
    expect(seen.filter((s) => s === `DELETE /api/v1/sandboxes/${sbx.providerSandboxId}`)).toHaveLength(2);
  });

  it("treats a sandbox already gone as deleted, and a resourceExhausted 429 as a rate limit", async () => {
    const { url, seen } = await mock((r) => {
      if (r.path === "/hub/token") return { json: { access_token: "hub_access" } };
      if (r.method === "GET" && r.path === "/api/v1/sandboxes/gone") return { status: 404, json: { code: "notFound", message: "not found" } };
      return { status: 429, json: { code: "resourceExhausted", message: "too many requests, slow down" } };
    });
    const env = { DOCKER_ID: "me", DOCKER_PAT: "p", DOCKER_SANDBOXES_API_URL: `${url}/api`, DOCKER_HUB_AUTH_URL: `${url}/hub/token` };
    await expect(dockerCloudProvider.kill("gone", ctx(env))).resolves.toBeUndefined();
    expect(seen).not.toContain("DELETE /api/v1/sandboxes/gone");
    await refused(dockerCloudProvider, env, "rate_limit");
  });
});
