// Namespace and Morph Cloud, which used to load their SDKs (`@namespacelabs/sdk`, `morphcloud`) and
// now speak each provider's HTTP API with fetch: Namespace's Connect (JSON) services and Morph's
// REST API. Each runs against a local server that answers as the provider does, per the calls its
// official SDK makes; commands run in a real local shell so quoting, cwd and env are exercised for
// real. None has been run against the real service here.
import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, routerFor, type Req } from "./restmock.js";
import { classify } from "../src/core/errors.js";
import { builtinProviders } from "../src/providers/index.js";
import { namespaceProvider } from "../src/providers/namespace.js";
import { morphProvider } from "../src/providers/morph.js";
import type { ProviderContext } from "../src/index.js";

const spec = { cpu: 2, memoryMiB: 2048, timeoutSec: 120, env: { A: "1" }, metadata: { "sandboxrouting.id": "sbr_1" } };
const kindOf = async (p: Promise<unknown>) => classify(await p.then(() => undefined, (e: unknown) => e)).kind;
const QUOTING = `echo "it's $X" && pwd && echo oops >&2 && exit 3`;

/** Runs argv locally, as the sandbox would. */
function sh(argv: string[], opts: { cwd?: string; env?: Record<string, string> } = {}) {
  const r = spawnSync(argv[0]!, argv.slice(1), { cwd: opts.cwd, env: { ...process.env, ...opts.env }, encoding: "utf8" });
  return { stdout: r.stdout, stderr: r.stderr, code: r.status ?? 1 };
}
const tmp = () => execFileSync("mktemp", ["-d"], { encoding: "utf8" }).trim();
/** An unsigned JWT with these claims, the shape Namespace's tokens have. */
const jwt = (claims: Record<string, unknown>) => `nsct_${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;

describe("no provider SDK to install", () => {
  it("Namespace and Morph name no SDK package and load none", () => {
    for (const id of ["namespace", "morph"]) expect(builtinProviders().find((p) => p.info.id === id)!.info.sdkPackage, id).toBeUndefined();
    for (const f of ["namespace", "morph"]) expect(readFileSync(new URL(`../src/providers/${f}.ts`, import.meta.url), "utf8")).not.toMatch(/loadSdk|import\(/);
  });
});

// ---------------------------------------------------------------------------------------------
// Namespace

const COMPUTE = "/namespace.cloud.compute.v1beta.ComputeService";
const COMMAND = "/namespace.cloud.compute.v1beta.CommandService";
const ISSUE = "/namespace.private.sessions.v1beta.UserSessionsService/IssueTenantTokenFromSession";

/** Namespace's regional Connect API plus the IAM session endpoint, on one server. */
async function nsMock(opts: { tokens?: string[]; session?: string; tenantToken?: string; error?: { status: number; code: string; message: string } } = {}) {
  const tokens = opts.tokens ?? ["nsc_k"];
  const boxes = new Map<string, { status: string; body: Record<string, unknown>; deadline?: string; reason?: string }>();
  const calls: { route: string; body: Record<string, unknown>; headers: Req["headers"] }[] = [];
  let n = 0;
  const connectErr = (status: number, code: string, message: string) => ({ status, json: { code, message } });
  const server = await mock((r) => {
    const body = r.body.length ? r.json() : {};
    calls.push({ route: r.path, body, headers: r.headers });
    if (r.method !== "POST" || r.headers["connect-protocol-version"] !== "1") return connectErr(415, "unknown", "not a Connect call");
    if (r.path === ISSUE) {
      if (r.headers.authorization !== `Bearer ${opts.session}`) return connectErr(401, "unauthenticated", "bad session");
      return { json: { tenantToken: opts.tenantToken } };
    }
    if (!tokens.some((t) => r.headers.authorization === `Bearer ${t}`)) return connectErr(401, "unauthenticated", "invalid token");
    if (opts.error) return connectErr(opts.error.status, opts.error.code, opts.error.message);
    const box = boxes.get(String(body.instanceId));
    const gone = () => connectErr(404, "not_found", `instance ${body.instanceId} does not exist`);
    switch (r.path) {
      case `${COMPUTE}/CreateInstance`: {
        const id = `ns-${++n}`;
        boxes.set(id, { status: "CREATING", body });
        return { json: { instanceUrl: `https://cloud.namespace.so/x/instance/${id}`, metadata: { instanceId: id, status: "CREATING" } } };
      }
      case `${COMPUTE}/WaitInstanceSync`:
        if (!box) return gone();
        box.status = "RUNNING";
        return { json: { metadata: { instanceId: body.instanceId, status: "RUNNING" } } };
      case `${COMMAND}/RunCommandSync`: {
        if (!box || box.status !== "RUNNING") return gone();
        if (body.targetContainerName !== "sandbox") return connectErr(404, "not_found", "no such container");
        const c = body.command as { command: string[]; cwd?: string; envVars?: { name: string; value: string }[] };
        const out = sh(c.command, { cwd: c.cwd, env: Object.fromEntries((c.envVars ?? []).map((e) => [e.name, e.value])) });
        // protobuf JSON leaves out empty bytes and a zero exit code.
        const json: Record<string, unknown> = {};
        if (out.stdout) json.stdout = Buffer.from(out.stdout).toString("base64");
        if (out.stderr) json.stderr = Buffer.from(out.stderr).toString("base64");
        if (out.code) json.exitCode = out.code;
        return { json };
      }
      case `${COMPUTE}/ExtendInstance`:
        if (!box) return gone();
        box.deadline = String(body.newDeadline);
        return { json: { newDeadline: body.newDeadline } };
      case `${COMPUTE}/DestroyInstance`:
        if (!box) return gone();
        box.status = "DESTROYED";
        box.reason = String(body.reason);
        return { json: {} };
      case `${COMPUTE}/ListInstances`:
        return { json: { instances: [...boxes].map(([instanceId, b]) => ({ instanceId, status: b.status })) } };
    }
    return undefined;
  });
  return { ...server, boxes, calls };
}

describe("namespace over Connect", () => {
  const envFor = (url: string) => ({ NSC_TOKEN: "nsc_k", NSC_API_URL: url });

  it("runs commands with quoting, cwd, env and exit codes intact, then kills", async () => {
    const api = await nsMock();
    const { router } = routerFor(namespaceProvider, envFor(api.url));
    const sbx = await router.create({ timeoutSec: 60 });
    expect(sbx.provider).toBe("namespace");
    const dir = tmp();
    const out = await sbx.commands.run(QUOTING, { cwd: dir, env: { X: "a b" } });
    expect(out.stdout.split("\n")[0]).toBe("it's a b");
    expect(out.stdout).toContain(dir.split("/").pop()!);
    expect(out.stderr.trim()).toBe("oops");
    expect(out.exitCode).toBe(3);
    expect((await sbx.commands.run("echo fine")).exitCode).toBe(0);
    await sbx.kill();
    expect(api.boxes.get(sbx.providerSandboxId)).toMatchObject({ status: "DESTROYED", reason: "sandboxrouting kill" });
    expect((await sbx.info())!.state).toBe("stopped");
  });

  it("creates the instance the SDK call described, and waits for it", async () => {
    const api = await nsMock();
    const ctx: ProviderContext = { env: envFor(api.url), options: { arch: "arm64" } };
    const before = Math.floor(Date.now() / 1000);
    const made = await namespaceProvider.create({ ...spec, cpu: 1.6, image: "node:22" }, ctx);
    expect(made).toEqual({ providerSandboxId: "ns-1", cpu: 2, memoryMiB: 2048 });
    const create = api.calls.find((c) => c.route === `${COMPUTE}/CreateInstance`)!;
    expect(create.headers.authorization).toBe("Bearer nsc_k");
    expect(create.headers["content-type"]).toBe("application/json");
    expect(create.body).toEqual({
      shape: { os: "linux", machineArch: "arm64", virtualCpu: 2, memoryMegabytes: 2048 },
      deadline: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/),
      documentedPurpose: "sandboxrouting",
      labels: [{ name: "sandboxrouting.id", value: "sbr_1" }],
      containers: [{ name: "sandbox", imageRef: "node:22", args: ["sleep", "infinity"], envVars: [{ name: "A", value: "1" }] }],
    });
    const deadline = Date.parse(String(create.body.deadline)) / 1000;
    expect(deadline - before).toBeGreaterThanOrEqual(120);
    expect(deadline - before).toBeLessThanOrEqual(122);
    const wait = api.calls.find((c) => c.route === `${COMPUTE}/WaitInstanceSync`)!;
    expect(wait.body).toEqual({ instanceId: "ns-1" });
    expect(wait.headers["connect-timeout-ms"]).toBe("180000");
    // A native template wins over the image; neither gives ubuntu:24.04.
    await namespaceProvider.create({ ...spec, nativeTemplate: "nscr.io/me/img:1", image: "node:22" }, ctx);
    await namespaceProvider.create(spec, ctx);
    const images = api.calls.filter((c) => c.route === `${COMPUTE}/CreateInstance`).map((c) => (c.body.containers as { imageRef: string }[])[0]!.imageRef);
    expect(images).toEqual(["node:22", "nscr.io/me/img:1", "ubuntu:24.04"]);
  });

  it("sends exec's deadline, leaves out an empty cwd, and hands the output to the callbacks", async () => {
    const api = await nsMock();
    const ctx: ProviderContext = { env: envFor(api.url), options: {} };
    const { providerSandboxId: id } = await namespaceProvider.create(spec, ctx);
    const out: string[] = [];
    const err: string[] = [];
    const r = await namespaceProvider.exec(id, "echo hi; echo no >&2", { timeoutSec: 30, onStdout: (c) => out.push(c), onStderr: (c) => err.push(c) }, ctx);
    expect(r).toEqual({ stdout: "hi\n", stderr: "no\n", exitCode: 0 });
    expect([out, err]).toEqual([["hi\n"], ["no\n"]]);
    const runs = () => api.calls.filter((c) => c.route === `${COMMAND}/RunCommandSync`);
    expect(runs()[0]!.body).toEqual({ instanceId: id, targetContainerName: "sandbox", command: { command: ["sh", "-c", "echo hi; echo no >&2"], envVars: [] } });
    expect(runs()[0]!.headers["connect-timeout-ms"]).toBe("30000");
    await namespaceProvider.exec(id, "true", {}, ctx);
    expect(runs()[1]!.headers["connect-timeout-ms"]).toBe("3600000");
  });

  it("extends the deadline and lists instances that aren't destroyed", async () => {
    const api = await nsMock();
    const ctx: ProviderContext = { env: envFor(api.url), options: {} };
    const a = await namespaceProvider.create(spec, ctx);
    const b = await namespaceProvider.create(spec, ctx);
    const before = Math.floor(Date.now() / 1000);
    await namespaceProvider.setTimeout!(a.providerSandboxId, 600, ctx);
    const deadline = Date.parse(api.boxes.get(a.providerSandboxId)!.deadline!) / 1000;
    expect(deadline - before).toBeGreaterThanOrEqual(600);
    expect(deadline - before).toBeLessThanOrEqual(602);
    await namespaceProvider.kill(b.providerSandboxId, ctx);
    expect(await namespaceProvider.listAlive!(ctx)).toEqual([a.providerSandboxId]);
    expect(api.calls.find((c) => c.route === `${COMPUTE}/ListInstances`)!.body).toEqual({});
  });

  it("reads a bearer token from NSC_TOKEN_FILE when NSC_TOKEN is unset", async () => {
    const api = await nsMock({ tokens: ["file-bearer"] });
    const dir = mkdtempSync(join(tmpdir(), "nsc-"));
    writeFileSync(join(dir, "token.json"), JSON.stringify({ bearer_token: "file-bearer" }));
    const ctx: ProviderContext = { env: { NSC_API_URL: api.url, NSC_TOKEN_FILE: join(dir, "token.json") }, options: {} };
    expect(await namespaceProvider.listAlive!(ctx)).toEqual([]);
    expect(api.calls[0]!.headers.authorization).toBe("Bearer file-bearer");
  });

  it("turns an `nsc login` session token into a tenant token, once while it lasts", async () => {
    const session = jwt({ tenant_id: "t1" });
    const tenantToken = jwt({ tenant_id: "t1", exp: Math.floor(Date.now() / 1000) + 600 });
    const api = await nsMock({ tokens: [tenantToken], session, tenantToken });
    const dir = mkdtempSync(join(tmpdir(), "nsc-"));
    writeFileSync(join(dir, "token.json"), JSON.stringify({ session_token: session }));
    const ctx: ProviderContext = { env: { NSC_API_URL: api.url, NSC_IAM_ENDPOINT: api.url, NSC_TOKEN_FILE: join(dir, "token.json") }, options: {} };
    await namespaceProvider.listAlive!(ctx);
    await namespaceProvider.listAlive!(ctx);
    const issued = api.calls.filter((c) => c.route === ISSUE);
    expect(issued).toHaveLength(1);
    expect(issued[0]!.body).toEqual({ tokenDuration: "600s" });
    expect(issued[0]!.headers.authorization).toBe(`Bearer ${session}`);
    expect(api.calls.filter((c) => c.route.endsWith("/ListInstances")).map((c) => c.headers.authorization)).toEqual([`Bearer ${tenantToken}`, `Bearer ${tenantToken}`]);
  });

  it("uses the tenant token `nsc` cached next to the session when it is for the same tenant and fresh", async () => {
    const session = jwt({ tenant_id: "t2" });
    const cached = jwt({ tenant_id: "t2", exp: Math.floor(Date.now() / 1000) + 3600 });
    const api = await nsMock({ tokens: [cached], session });
    const dir = mkdtempSync(join(tmpdir(), "nsc-"));
    writeFileSync(join(dir, "token.json"), JSON.stringify({ session_token: session }));
    writeFileSync(join(dir, "token.cache"), cached);
    const ctx: ProviderContext = { env: { NSC_API_URL: api.url, NSC_IAM_ENDPOINT: api.url, NSC_TOKEN_FILE: join(dir, "token.json") }, options: {} };
    await namespaceProvider.listAlive!(ctx);
    expect(api.calls.filter((c) => c.route === ISSUE)).toHaveLength(0);
  });

  it("reads a missing token file as not logged in", async () => {
    const ctx: ProviderContext = { env: { NSC_API_URL: "http://127.0.0.1:9", NSC_TOKEN_FILE: join(tmpdir(), "no-such-nsc-token.json") }, options: {} };
    await expect(namespaceProvider.listAlive!(ctx)).rejects.toThrow(/not logged in/);
    expect(await kindOf(namespaceProvider.listAlive!(ctx))).toBe("auth");
  });

  it("classifies Connect errors by the HTTP status their code maps to", async () => {
    const api = await nsMock();
    const ctx: ProviderContext = { env: envFor(api.url), options: {} };
    expect(await kindOf(namespaceProvider.create(spec, { ...ctx, env: { ...ctx.env, NSC_TOKEN: "wrong" } }))).toBe("auth");
    expect(await kindOf(namespaceProvider.exec("ns-404", "true", {}, ctx))).toBe("not_found");
    expect(await kindOf(namespaceProvider.kill("ns-404", ctx))).toBe("not_found");
    const busy = await nsMock({ error: { status: 429, code: "resource_exhausted", message: "concurrency limit reached" } });
    expect(await kindOf(namespaceProvider.create(spec, { env: envFor(busy.url), options: {} }))).toBe("rate_limit");
    const bad = await nsMock({ error: { status: 400, code: "invalid_argument", message: "no such region" } });
    expect(await kindOf(namespaceProvider.create(spec, { env: envFor(bad.url), options: {} }))).toBe("invalid");
    const denied = await nsMock({ error: { status: 403, code: "permission_denied", message: "token lacks compute access" } });
    expect(await kindOf(namespaceProvider.create(spec, { env: envFor(denied.url), options: {} }))).toBe("auth");
  });
});

// ---------------------------------------------------------------------------------------------
// Morph Cloud

/** Morph's REST API: snapshots, instances that start pending, exec plain and as an event stream. */
async function morphMock(opts: { failBoot?: boolean; error?: { status: number; body: unknown } } = {}) {
  type Box = { id: string; status: string; polls: number; vcpus: number; memory: number; services: { name: string; port: number; url: string }[]; ttl?: unknown; body: unknown };
  const boxes = new Map<string, Box>();
  const calls: { method: string; route: string; body: Record<string, unknown> | undefined; query: URLSearchParams; headers: Req["headers"] }[] = [];
  let n = 0;
  const view = (b: Box) => ({
    id: b.id,
    object: "instance",
    status: b.status,
    spec: { vcpus: b.vcpus, memory: b.memory, disk_size: 8192 },
    refs: { snapshot_id: "snapshot_1", image_id: "morphvm-minimal" },
    networking: { internal_ip: "10.0.0.2", http_services: b.services },
  });
  const server = await mock((r) => {
    const body = r.body.length ? r.json() : undefined;
    calls.push({ method: r.method, route: `${r.method} ${r.path}`, body, query: r.query, headers: r.headers });
    if (r.headers.authorization !== "Bearer morph_k") return { status: 401, json: { detail: "Invalid API key" } };
    if (opts.error) return { status: opts.error.status, json: opts.error.body };
    if (r.method === "POST" && r.path === "/snapshot") return { json: { id: `snapshot_${++n}`, object: "snapshot", status: "ready" } };
    if (r.method === "POST" && r.path === "/instance") {
      const id = `morphvm_${++n}`;
      boxes.set(id, { id, status: "pending", polls: 0, vcpus: 2, memory: 2048, services: [], body });
      return { json: view(boxes.get(id)!) };
    }
    if (r.method === "GET" && r.path === "/instance") return { json: { object: "list", data: [...boxes.values()].map(view) } };
    const m = /^\/instance\/([^/]+)(\/.*)?$/.exec(r.path);
    const b = m && boxes.get(m[1]!);
    if (!b) return { status: 404, json: { detail: "Instance not found" } };
    const rest = m![2] ?? "";
    if (r.method === "GET" && !rest) {
      // Ready (or failed) on the second look.
      if (b.status === "pending" && ++b.polls >= 2) b.status = opts.failBoot ? "error" : "ready";
      return { json: view(b) };
    }
    if (r.method === "DELETE" && !rest) return boxes.delete(b.id), { json: {} };
    if (r.method !== "POST") return undefined;
    if (rest === "/exec" || rest === "/exec/sse") {
      const out = sh(body.command);
      if (rest === "/exec") return { json: { exit_code: out.code, stdout: out.stdout, stderr: out.stderr } };
      const events = [
        ...out.stdout.split(/(?<=\n)/).filter(Boolean).map((c) => ({ type: "stdout", content: c })),
        ...out.stderr.split(/(?<=\n)/).filter(Boolean).map((c) => ({ type: "stderr", content: c })),
        { type: "exit_code", content: String(out.code) },
      ];
      return { raw: events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""), type: "text/event-stream" };
    }
    if (rest === "/http") {
      b.services.push({ name: body.name, port: body.port, url: `https://${body.name}-${b.id}.http.cloud.morph.so` });
      return { json: view(b) };
    }
    if (rest === "/ttl") return (b.ttl = body), { json: view(b) };
    if (rest === "/pause") return (b.status = "paused"), { json: view(b) };
    if (rest === "/resume") return (b.status = "ready"), { json: view(b) };
    return undefined;
  });
  return { ...server, boxes, calls };
}

describe("morph over REST", () => {
  const envFor = (url: string) => ({ MORPH_API_KEY: "morph_k", MORPH_BASE_URL: url });

  it("runs commands with quoting, cwd, env and exit codes intact, then kills", async () => {
    const api = await morphMock();
    const { router } = routerFor(morphProvider, envFor(api.url));
    const sbx = await router.create({ timeoutSec: 60 });
    expect(sbx.provider).toBe("morph");
    const dir = tmp();
    const out = await sbx.commands.run(QUOTING, { cwd: dir, env: { X: "a b" } });
    expect(out.stdout.split("\n")[0]).toBe("it's a b");
    expect(out.stdout).toContain(dir.split("/").pop()!);
    expect(out.stderr.trim()).toBe("oops");
    expect(out.exitCode).toBe(3);
    await sbx.kill();
    expect(api.calls.map((c) => c.route)).toContain(`DELETE /instance/${sbx.providerSandboxId}`);
    expect(api.boxes.has(sbx.providerSandboxId)).toBe(false);
    expect((await sbx.info())!.state).toBe("stopped");
  });

  it("creates the snapshot once per size and starts instances from it, waiting until ready", async () => {
    const api = await morphMock();
    const ctx: ProviderContext = { env: envFor(api.url), options: { pollMs: 1, imageId: "img-test" } };
    const made = await morphProvider.create({ ...spec, cpu: 2, memoryMiB: 512 }, ctx);
    expect(made).toEqual({ providerSandboxId: expect.stringMatching(/^morphvm_/), cpu: 2, memoryMiB: 2048 });
    const snap = api.calls.find((c) => c.route === "POST /snapshot")!;
    expect(snap.headers.authorization).toBe("Bearer morph_k");
    expect(snap.body).toEqual({
      image_id: "img-test",
      vcpus: 2,
      memory: 1024,
      disk_size: 8192,
      digest: "sbr-img-test:2:1024",
      readiness_check: { type: "timeout", timeout: 10 },
      metadata: {},
    });
    const start = api.calls.find((c) => c.route === "POST /instance")!;
    expect(start.query.get("snapshot_id")).toBe("snapshot_1");
    expect(start.body).toEqual({ metadata: { "sandboxrouting.id": "sbr_1" }, ttl_seconds: 120, ttl_action: "stop" });
    // Pending on the first look, ready on the second.
    expect(api.calls.filter((c) => c.route === `GET /instance/${made.providerSandboxId}`)).toHaveLength(2);
    await morphProvider.create({ ...spec, cpu: 2, memoryMiB: 512 }, ctx);
    expect(api.calls.filter((c) => c.route === "POST /snapshot")).toHaveLength(1);
    // A native template is the snapshot itself.
    await morphProvider.create({ ...spec, nativeTemplate: "snapshot_mine" }, ctx);
    expect(api.calls.filter((c) => c.route === "POST /snapshot")).toHaveLength(1);
    expect(api.calls.filter((c) => c.route === "POST /instance").map((c) => c.query.get("snapshot_id"))).toEqual(["snapshot_1", "snapshot_1", "snapshot_mine"]);
  });

  it("stops an instance that fails to boot, and throws", async () => {
    const api = await morphMock({ failBoot: true });
    const ctx: ProviderContext = { env: envFor(api.url), options: { pollMs: 1, imageId: "img-fail" } };
    await expect(morphProvider.create(spec, ctx)).rejects.toThrow(/encountered an error/);
    expect(api.calls.filter((c) => c.method === "DELETE").map((c) => c.route)).toEqual(["DELETE /instance/morphvm_2"]);
    expect(api.boxes.size).toBe(0);
  });

  it("sends exec as argv in one request, or streams it when asked for output as it comes", async () => {
    const api = await morphMock();
    const ctx: ProviderContext = { env: envFor(api.url), options: { pollMs: 1, imageId: "img-exec" } };
    const { providerSandboxId: id } = await morphProvider.create(spec, ctx);
    const plain = await morphProvider.exec(id, "echo hi", { env: { B: "x'y" } }, ctx);
    expect(plain).toEqual({ stdout: "hi\n", stderr: "", exitCode: 0 });
    expect(api.calls.find((c) => c.route === `POST /instance/${id}/exec`)!.body).toEqual({ command: ["sh", "-c", `export B='x'\\''y'; echo hi`] });
    const out: string[] = [];
    const err: string[] = [];
    const streamed = await morphProvider.exec(id, "echo one; echo two; echo bad >&2; exit 4", { onStdout: (c) => out.push(c), onStderr: (c) => err.push(c) }, ctx);
    expect(streamed).toEqual({ stdout: "one\ntwo\n", stderr: "bad\n", exitCode: 4 });
    expect([out, err]).toEqual([["one\n", "two\n"], ["bad\n"]]);
    const sse = api.calls.find((c) => c.route === `POST /instance/${id}/exec/sse`)!;
    expect(sse.headers.accept).toBe("text/event-stream");
    expect(sse.body).toEqual({ command: ["sh", "-c", "echo one; echo two; echo bad >&2; exit 4"] });
    // A callback that throws doesn't end the stream.
    const throwing = () => {
      throw new Error("cb");
    };
    const kept = await morphProvider.exec(id, "echo a; echo b", { onStdout: throwing }, ctx);
    expect(kept.stdout).toBe("a\nb\n");
  });

  it("fails a command at its timeout with the SDK's message", async () => {
    const server = createServer(() => undefined); // never answers
    server.listen(0, "127.0.0.1");
    await new Promise((ok) => server.once("listening", ok));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      await expect(morphProvider.exec("morphvm_x", "sleep 5", { timeoutSec: 1 }, { env: envFor(url), options: {} })).rejects.toThrow("Command execution timed out after 1 second");
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  it("exposes a port, sets the TTL, pauses, resumes and lists the instances that aren't stopped", async () => {
    const api = await morphMock();
    const ctx: ProviderContext = { env: envFor(api.url), options: { pollMs: 1, imageId: "img-more" } };
    const a = await morphProvider.create(spec, ctx);
    const b = await morphProvider.create(spec, ctx);
    expect(await morphProvider.getUrl!(a.providerSandboxId, 8080, ctx)).toBe(`https://p8080-${a.providerSandboxId}.http.cloud.morph.so`);
    expect(api.calls.find((c) => c.route === `POST /instance/${a.providerSandboxId}/http`)!.body).toEqual({ name: "p8080", port: 8080 });
    await morphProvider.setTimeout!(a.providerSandboxId, 900, ctx);
    expect(api.boxes.get(a.providerSandboxId)!.ttl).toEqual({ ttl_seconds: 900, ttl_action: "stop" });
    await morphProvider.pause!(a.providerSandboxId, ctx);
    expect(api.boxes.get(a.providerSandboxId)!.status).toBe("paused");
    await morphProvider.resume!(a.providerSandboxId, ctx);
    expect(api.boxes.get(a.providerSandboxId)!.status).toBe("ready");
    api.boxes.get(b.providerSandboxId)!.status = "stopped";
    expect(await morphProvider.listAlive!(ctx)).toEqual([a.providerSandboxId]);
  });

  it("classifies refusals by status", async () => {
    const api = await morphMock();
    const ctx: ProviderContext = { env: envFor(api.url), options: { pollMs: 1, imageId: "img-err" } };
    expect(await kindOf(morphProvider.create(spec, { ...ctx, env: { ...ctx.env, MORPH_API_KEY: "wrong" } }))).toBe("auth");
    expect(await kindOf(morphProvider.exec("morphvm_gone", "true", {}, ctx))).toBe("not_found");
    expect(await kindOf(morphProvider.kill("morphvm_gone", ctx))).toBe("not_found");
    const broke = await morphMock({ error: { status: 402, body: { detail: "Insufficient credits" } } });
    expect(await kindOf(morphProvider.create(spec, { env: envFor(broke.url), options: { imageId: "img-402" } }))).toBe("quota");
    const busy = await morphMock({ error: { status: 429, body: { detail: "Too many instances" } } });
    expect(await kindOf(morphProvider.create(spec, { env: envFor(busy.url), options: { imageId: "img-429" } }))).toBe("rate_limit");
  });
});
