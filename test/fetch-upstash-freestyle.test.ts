// Upstash Box and Freestyle, which used to load their SDKs (`@upstash/box`, `freestyle`) and now
// speak each provider's HTTP API with fetch. Each runs against a local server that answers like
// the provider does, per the calls its official SDK makes; commands run in a real local shell so
// quoting, cwd and env are exercised for real. None has been run against the real service here.
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mock, routerFor, type Req, type Reply } from "./restmock.js";
import { classify } from "../src/core/errors.js";
import { upstashProvider } from "../src/providers/upstash.js";
import { freestyleProvider } from "../src/providers/freestyle.js";
import type { ProviderContext } from "../src/index.js";

const spec = { cpu: 2, memoryMiB: 2048, timeoutSec: 120, env: { A: "1" }, metadata: { "sandboxrouting.id": "sbr_1" } };
const kindOf = async (p: Promise<unknown>) => classify(await p.then(() => undefined, (e: unknown) => e)).kind;
const tmpDir = () => execFileSync("mktemp", ["-d"], { encoding: "utf8" }).trim();
const QUOTED = `echo "it's $X" && pwd && echo oops >&2 && exit 3`;

describe("no provider SDK to install", () => {
  it("Upstash and Freestyle name no SDK package and load none", () => {
    expect(upstashProvider.info.sdkPackage).toBeUndefined();
    expect(freestyleProvider.info.sdkPackage).toBeUndefined();
    for (const f of ["upstash", "freestyle"]) {
      const src = readFileSync(new URL(`../src/providers/${f}.ts`, import.meta.url), "utf8");
      expect(src, f).not.toMatch(/loadSdk|import\(|@upstash\/box"|from "freestyle"/);
    }
  });
});

/** An Upstash Box API: ephemeral boxes whose exec runs argv in a local shell. */
async function upstashMock(opts: { key?: string; createStatus?: Reply } = {}) {
  const boxes = new Map<string, { files: Map<string, Buffer> }>();
  const bodies: { route: string; body: unknown; query: URLSearchParams; headers: Req["headers"] }[] = [];
  let n = 0;
  const server = await mock((r) => {
    if (r.headers["x-box-api-key"] !== (opts.key ?? "ub_k")) return { status: 401, json: { error: "invalid api key" } };
    const body = r.body.length ? r.json() : undefined;
    bodies.push({ route: `${r.method} ${r.path}`, body, query: r.query, headers: r.headers });
    if (r.path === "/v2/box" && r.method === "POST") {
      if (opts.createStatus) return opts.createStatus;
      const id = `ub-${++n}`;
      boxes.set(id, { files: new Map() });
      return { json: { id, status: "running", size: body.size, expires_at: 1_900_000_000 } };
    }
    if (r.path === "/v2/box" && r.method === "GET") return { json: [...boxes.keys()].map((id) => ({ id, status: "running" })) };
    const m = /^\/v2\/box\/([^/]+)(\/.*)?$/.exec(r.path);
    const box = m && boxes.get(m[1]!);
    if (!m || !box) return { status: 404, json: { error: "box not found" } };
    const rest = m[2] ?? "";
    if (r.method === "DELETE" && !rest) return boxes.delete(m[1]!), { json: {} };
    if (rest === "/exec") {
      const [cmd, ...args] = body.command as string[];
      const out = spawnSync(cmd!, args, { encoding: "utf8" });
      return { json: { output: out.stdout, error: out.stderr, exit_code: out.status } };
    }
    if (rest === "/files/write") return box.files.set(body.path, Buffer.from(body.content, "base64")), { json: {} };
    if (rest === "/files/read") {
      const f = box.files.get(r.query.get("path")!);
      return f ? { json: { content: f.toString("base64") } } : { status: 404, json: { error: "file not found" } };
    }
    if (rest === "/files/list") {
      const dir = r.query.get("folder")!;
      const files = [...box.files].filter(([p]) => p.startsWith(`${dir}/`)).map(([p, b]) => ({ name: p.slice(dir.length + 1), path: p, is_dir: false, size: b.length }));
      return { json: { files } };
    }
    return undefined;
  });
  return { ...server, boxes, bodies };
}

describe("upstash over HTTP", () => {
  const envFor = (url: string) => ({ UPSTASH_BOX_API_KEY: "ub_k", UPSTASH_BOX_BASE_URL: `${url}/` });

  it("runs commands with quoting, cwd, env and exit codes intact, moves files, then kills", async () => {
    const api = await upstashMock();
    const { router } = routerFor(upstashProvider, envFor(api.url));
    const sbx = await router.create({ timeoutSec: 60, env: { FROM_CREATE: "yes" } });
    expect(sbx.provider).toBe("upstash");
    const create = api.bodies.find((b) => b.route === "POST /v2/box")!;
    expect(create.body).toEqual({ ephemeral: true, size: "small", ttl: 60, runtime: "python", env_vars: { FROM_CREATE: "yes" } });
    expect(create.headers["x-box-api-key"]).toBe("ub_k");
    const tmp = tmpDir();
    const out = await sbx.commands.run(QUOTED, { cwd: tmp, env: { X: "a b" } });
    expect(out.stdout.split("\n")[0]).toBe("it's a b");
    expect(out.stdout).toContain(tmp.split("/").pop()!);
    expect(out.exitCode).toBe(3);
    expect(out.stderr.trim()).toBe("oops");
    const exec = api.bodies.find((b) => b.route === `POST /v2/box/${sbx.providerSandboxId}/exec`)!;
    expect((exec.body as { command: string[] }).command.slice(0, 2)).toEqual(["sh", "-c"]);
    await sbx.files.write("/tmp/sub/bin.dat", new Uint8Array([0, 1, 255]));
    expect([...(await sbx.files.readBytes("/tmp/sub/bin.dat"))]).toEqual([0, 1, 255]);
    expect(await sbx.files.list("/tmp/sub")).toEqual([{ name: "bin.dat", path: "/tmp/sub/bin.dat", isDir: false, size: 3 }]);
    await sbx.kill();
    expect(api.boxes.size).toBe(0);
    expect((await sbx.info())!.state).toBe("stopped");
  });

  it("sizes the box, picks a runtime from the template, caps the TTL and streams output", async () => {
    const api = await upstashMock();
    const ctx: ProviderContext = { env: envFor(api.url), options: {} };
    expect(await upstashProvider.create({ ...spec, cpu: 3, timeoutSec: 999_999, nativeTemplate: "node" }, ctx)).toEqual({ providerSandboxId: "ub-1", cpu: 4 });
    expect(api.bodies[0]!.body).toMatchObject({ size: "medium", ttl: 259_200, runtime: "node" });
    expect(await upstashProvider.create({ ...spec, cpu: 8, nativeTemplate: "ubuntu:24.04" }, ctx)).toEqual({ providerSandboxId: "ub-2", cpu: 8 });
    expect(api.bodies[1]!.body).toMatchObject({ size: "large", runtime: "python" });
    const out: string[] = [];
    const err: string[] = [];
    const r = await upstashProvider.exec("ub-1", "echo hi; echo no >&2", { onStdout: (c) => out.push(c), onStderr: (c) => err.push(c) }, ctx);
    expect(r).toEqual({ stdout: "hi\n", stderr: "no\n", exitCode: 0 });
    expect([out.join(""), err.join("")]).toEqual(["hi\n", "no\n"]);
    // Relative paths resolve against the SDK's working directory.
    await upstashProvider.writeFile!("ub-1", "rel.txt", new TextEncoder().encode("x"), ctx);
    expect(api.bodies.at(-1)!.body).toEqual({ path: "/workspace/home/rel.txt", content: "eA==", encoding: "base64" });
    expect((await upstashProvider.listAlive!(ctx)).sort()).toEqual(["ub-1", "ub-2"]);
  });

  it("keeps the refusals the router reads: 401 auth, 402 quota, 429 rate limit, gone box", async () => {
    for (const [status, kind] of [
      [402, "quota"],
      [429, "rate_limit"],
    ] as const) {
      const api = await upstashMock({ createStatus: { status, json: { error: "refused" } } });
      expect(await kindOf(upstashProvider.create(spec, { env: envFor(api.url), options: {} }))).toBe(kind);
    }
    const api = await upstashMock({ key: "other" });
    expect(await kindOf(upstashProvider.create(spec, { env: envFor(api.url), options: {} }))).toBe("auth");
    const ok = await upstashMock();
    const ctx: ProviderContext = { env: envFor(ok.url), options: {} };
    expect(await kindOf(upstashProvider.exec("gone", "true", {}, ctx))).toBe("not_found");
    expect(await kindOf(upstashProvider.kill("gone", ctx))).toBe("not_found");
  });
});

/** A Freestyle API: VMs whose exec runs in a local shell, with background (202) requests. */
async function freestyleMock(opts: { background?: (route: string) => boolean; createStatus?: Reply } = {}) {
  const vms = new Map<string, { state: string; files: Map<string, Buffer> }>();
  const bodies: { route: string; body: unknown; query: URLSearchParams; headers: Req["headers"] }[] = [];
  const pending = new Map<string, { reply: Reply; polls: number }>();
  const uploads = new Map<string, { path: string; size: number; sha256: string; data: Buffer[] }>();
  let n = 0;
  const handle = (r: Req, route: string): Reply | undefined => {
    const json = String(r.headers["content-type"]).includes("json") && r.body.length ? r.json() : undefined;
    bodies.push({ route, body: json, query: r.query, headers: r.headers });
    if (route === "POST /v5/vms") {
      if (opts.createStatus) return opts.createStatus;
      const id = `fs-${++n}`;
      vms.set(id, { state: "running", files: new Map() });
      return { json: { id, state: "running", metadata: json.metadata } };
    }
    if (route === "GET /v5/vms") return { json: { vms: [...vms].map(([id, v]) => ({ id, state: v.state })), totalCount: vms.size } };
    let m = /^\/v5\/vms\/([^/]+)(\/.*)?$/.exec(r.path);
    const vm = m && vms.get(decodeURIComponent(m[1]!));
    if (!m || !vm) return { status: 404, json: { code: "VM_NOT_FOUND", message: "VM not found" } };
    const rest = m[2] ?? "";
    if (r.method === "DELETE" && !rest) return vms.delete(decodeURIComponent(m[1]!)), { status: 204, raw: "" };
    if (rest === "/exec-await") {
      const out = spawnSync("sh", ["-c", json.command], { env: { ...process.env, ...json.env }, encoding: "utf8" });
      return { json: { stdout: out.stdout, stderr: out.stderr, statusCode: out.status } };
    }
    if (rest === "/pause") return (vm.state = "paused"), { json: { id: m[1], state: vm.state } };
    if (rest === "/start") return (vm.state = "running"), { json: { id: m[1], state: vm.state } };
    if (rest === "/fs/write") {
      if (createHash("sha256").update(r.body).digest("hex") !== r.query.get("sha256")) return { status: 400, json: { code: "SHA_MISMATCH", message: "damaged" } };
      return vm.files.set(r.query.get("path")!, r.body), { status: 204, raw: "" };
    }
    if (rest === "/fs/read") {
      const f = vm.files.get(r.query.get("path")!);
      return f ? { raw: f } : { status: 404, json: { code: "FILE_NOT_FOUND", message: "no such file" } };
    }
    if (rest === "/fs/dir") {
      const dir = r.query.get("path")!.replace(/\/$/, "");
      return { json: { entries: [...vm.files.keys()].filter((p) => p.startsWith(`${dir}/`)).map((p) => ({ name: p.slice(dir.length + 1), kind: "file" })).concat([{ name: "d", kind: "directory" }]) } };
    }
    if (rest === "/fs/uploads") {
      const uploadId = `up-${uploads.size + 1}`;
      uploads.set(uploadId, { path: json.path, size: json.size, sha256: json.sha256, data: [] });
      return { json: { uploadId, path: json.path, size: json.size, receivedBytes: 0 } };
    }
    m = /^\/fs\/uploads\/([^/]+)(\/commit)?$/.exec(rest);
    const up = m && uploads.get(m[1]!);
    if (m && up) {
      const received = () => up.data.reduce((s, b) => s + b.length, 0);
      if (r.method === "PUT") {
        if (Number(r.query.get("offset")) !== received()) return { status: 409, json: { code: "OFFSET", message: "wrong offset" } };
        up.data.push(r.body);
        return { json: { uploadId: m[1], receivedBytes: received() } };
      }
      if (m[2]) {
        const whole = Buffer.concat(up.data);
        if (createHash("sha256").update(whole).digest("hex") !== up.sha256) return { status: 400, json: { code: "SHA_MISMATCH", message: "damaged" } };
        return vm.files.set(up.path, whole), { json: {} };
      }
    }
    return undefined;
  };
  const server = await mock((r) => {
    if (r.headers.authorization !== "Bearer fs_k") return { status: 401, json: { code: "UNAUTHORIZED", message: "bad key" } };
    const route = `${r.method} ${r.path}`;
    const bg = /^\/v5\/background-requests\/(.+)$/.exec(r.path);
    if (bg) {
      const p = pending.get(bg[1]!)!;
      // Still running on the first poll; the stored result carries the request id, even an error.
      if (p.polls++ === 0) return { status: 202, json: {} };
      return { ...p.reply, headers: { ...p.reply.headers, "x-freestyle-background-request-id": bg[1]! } };
    }
    const reply = handle(r, route);
    if (reply && r.headers["x-freestyle-background-after-secs"] === "5" && opts.background?.(route)) {
      const id = `bg-${pending.size + 1}`;
      pending.set(id, { reply, polls: 0 });
      return { status: 202, json: { requestId: id }, headers: { "x-freestyle-background-request-id": id } };
    }
    return reply;
  });
  return { ...server, vms, bodies };
}

describe("freestyle over HTTP", () => {
  const envFor = (url: string) => ({ FREESTYLE_API_KEY: "fs_k", FREESTYLE_API_URL: url });

  it("runs commands with quoting, cwd, env and exit codes intact, moves files, then kills", async () => {
    const api = await freestyleMock();
    const { router } = routerFor(freestyleProvider, envFor(api.url));
    const sbx = await router.create({ timeoutSec: 60 });
    expect(sbx.provider).toBe("freestyle");
    const create = api.bodies.find((b) => b.route === "POST /v5/vms")!;
    expect(create.body).toEqual({
      snapshotId: null,
      metadata: { "sandboxrouting.id": expect.any(String) },
      ttlSeconds: 60,
      autoDeleteSeconds: 0,
      firewall: { rules: [{ action: "allow", source: {}, destination: { public: true } }] },
    });
    expect(create.headers["x-freestyle-background-after-secs"]).toBe("5");
    const tmp = tmpDir();
    const out = await sbx.commands.run(QUOTED, { cwd: tmp, env: { X: "a b" } });
    expect(out.stdout.split("\n")[0]).toBe("it's a b");
    expect(out.stdout).toContain(tmp.split("/").pop()!);
    expect(out.exitCode).toBe(3);
    expect(out.stderr.trim()).toBe("oops");
    const exec = api.bodies.find((b) => b.route === `POST /v5/vms/${sbx.providerSandboxId}/exec-await`)!;
    expect(exec.body).toMatchObject({ env: { X: "a b" } });
    await sbx.files.write("/tmp/sub/bin.dat", new Uint8Array([0, 1, 255]));
    expect([...(await sbx.files.readBytes("/tmp/sub/bin.dat"))]).toEqual([0, 1, 255]);
    expect(await sbx.files.list("/tmp/sub")).toEqual([
      { name: "bin.dat", path: "/tmp/sub/bin.dat", isDir: false },
      { name: "d", path: "/tmp/sub/d", isDir: true },
    ]);
    await sbx.kill();
    expect(api.vms.size).toBe(0);
    expect((await sbx.info())!.state).toBe("stopped");
  });

  it("follows background requests (202) to their stored result, errors included", async () => {
    const api = await freestyleMock({ background: (route) => route === "POST /v5/vms" || route.endsWith("/exec-await") || route.endsWith("/pause") });
    const ctx: ProviderContext = { env: envFor(api.url), options: { pollMs: 1, firewall: { rules: [] } } };
    const { providerSandboxId: id } = await freestyleProvider.create({ ...spec, nativeTemplate: "snap-1" }, ctx);
    expect(id).toBe("fs-1");
    expect(api.bodies[0]!.body).toMatchObject({ snapshotId: "snap-1", ttlSeconds: 120, firewall: { rules: [] } });
    const chunks: string[] = [];
    const r = await freestyleProvider.exec(id, "echo hi", { timeoutSec: 30, onStdout: (c) => chunks.push(c) }, ctx);
    expect(r).toEqual({ stdout: "hi\n", stderr: "", exitCode: 0 });
    expect(chunks).toEqual(["hi\n"]);
    expect(api.bodies.find((b) => b.route.endsWith("/exec-await"))!.body).toEqual({ command: "echo hi", timeoutMs: 30_000 });
    expect(api.seen.filter((s) => s.startsWith("GET /v5/background-requests/")).length).toBe(4);
    // A stored 404 is the call's error, not something to poll past.
    expect(await kindOf(freestyleProvider.exec("gone", "true", {}, ctx))).toBe("not_found");
    await freestyleProvider.pause!(id, ctx);
    expect(api.vms.get(id)!.state).toBe("paused");
  });

  it("writes a large file as a chunked upload session", async () => {
    const api = await freestyleMock();
    const ctx: ProviderContext = { env: envFor(api.url), options: {} };
    const { providerSandboxId: id } = await freestyleProvider.create(spec, ctx);
    const big = Buffer.alloc(9 * 1024 * 1024, 7);
    await freestyleProvider.writeFile!(id, "/data/big.bin", big, ctx);
    expect(api.seen).toContain(`POST /v5/vms/${id}/fs/uploads`);
    expect(api.seen).toContain(`POST /v5/vms/${id}/fs/uploads/up-1/commit`);
    expect(Buffer.from(await freestyleProvider.readFile!(id, "/data/big.bin", ctx)).equals(big)).toBe(true);
  });

  it("pauses, resumes, lists live VMs and retries a read the gateway dropped", async () => {
    let flaky = 1;
    const api = await freestyleMock();
    const ctx: ProviderContext = { env: envFor(api.url), options: {} };
    const a = await freestyleProvider.create(spec, ctx);
    const b = await freestyleProvider.create(spec, ctx);
    await freestyleProvider.pause!(a.providerSandboxId, ctx);
    expect(api.vms.get(a.providerSandboxId)!.state).toBe("paused");
    await freestyleProvider.resume!(a.providerSandboxId, ctx);
    expect(api.vms.get(a.providerSandboxId)!.state).toBe("running");
    api.vms.get(b.providerSandboxId)!.state = "stopped";
    expect(await freestyleProvider.listAlive!(ctx)).toEqual([a.providerSandboxId]);
    expect(api.bodies.find((x) => x.route === "GET /v5/vms")!.query.get("limit")).toBe("1000");
    // A 503 from the gateway on a read is retried; on a create it is not.
    const gw = await mock((r) => {
      if (r.method === "GET" && flaky-- > 0) return { status: 503, json: { code: "UNAVAILABLE", message: "try again" } };
      if (r.method === "GET") return { json: { vms: [{ id: "v", state: "running" }] } };
      return { status: 503, json: { code: "UNAVAILABLE", message: "try again" } };
    });
    const gctx: ProviderContext = { env: envFor(gw.url), options: {} };
    expect(await freestyleProvider.listAlive!(gctx)).toEqual(["v"]);
    expect(await kindOf(freestyleProvider.create(spec, gctx))).toBe("transient");
    expect(gw.seen.filter((s) => s === "POST /v5/vms").length).toBe(1);
  });

  it("keeps the refusals the router reads: 401 auth, 402 quota, 429 rate limit, gone VM", async () => {
    for (const [status, kind] of [
      [402, "quota"],
      [429, "rate_limit"],
    ] as const) {
      const api = await freestyleMock({ createStatus: { status, json: { code: "REFUSED", message: "refused" } } });
      expect(await kindOf(freestyleProvider.create(spec, { env: envFor(api.url), options: {} }))).toBe(kind);
    }
    const api = await freestyleMock();
    expect(await kindOf(freestyleProvider.create(spec, { env: { ...envFor(api.url), FREESTYLE_API_KEY: "wrong" }, options: {} }))).toBe("auth");
    const ctx: ProviderContext = { env: envFor(api.url), options: {} };
    expect(await kindOf(freestyleProvider.exec("gone", "true", {}, ctx))).toBe("not_found");
    expect(await kindOf(freestyleProvider.readFile!("gone", "/x", ctx))).toBe("not_found");
    expect(await kindOf(freestyleProvider.kill("gone", ctx))).toBe("not_found");
  });
});
