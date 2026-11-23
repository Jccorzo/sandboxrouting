// E2B, Daytona and Vercel, which used to load their SDKs (`e2b`, `@daytona/sdk`, `@vercel/sandbox`)
// and now speak each provider's HTTP API with fetch. Each runs through the router against a local
// server that answers like the provider does, per its OpenAPI spec and the calls its official SDK
// makes. None has been run against the real service here.
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { fakeRun, lifecycle, mock, routerFor, type Req } from "./restmock.js";
import { e2bMock } from "./e2bmock.js";
import { classify } from "../src/core/errors.js";
import { builtinProviders } from "../src/providers/index.js";
import { e2bProvider } from "../src/providers/e2b.js";
import { daytonaProvider } from "../src/providers/daytona.js";
import { tarGz, vercelProvider } from "../src/providers/vercel.js";
import { loadSdk, sdkInstall } from "../src/providers/util.js";
import type { ProviderContext } from "../src/index.js";

const spec = { cpu: 2, memoryMiB: 2048, timeoutSec: 120, env: { A: "1" }, metadata: { "sandboxrouting.id": "sbr_1" } };
const kindOf = async (p: Promise<unknown>) => classify(await p.then(() => undefined, (e: unknown) => e)).kind;

/** The parts of a multipart/form-data body, by field name. */
function formParts(r: Req): Map<string, Buffer> {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/.exec(String(r.headers["content-type"]))!;
  const b = `--${m[1] ?? m[2]}`;
  const out = new Map<string, Buffer>();
  for (const part of r.body.toString("latin1").split(b).slice(1, -1)) {
    const [head, ...body] = part.split("\r\n\r\n");
    const name = /name="([^"]+)"/.exec(head!)![1]!;
    out.set(name, Buffer.from(body.join("\r\n\r\n").replace(/\r\n$/, ""), "latin1"));
  }
  return out;
}

describe("no provider SDK to install", () => {
  it("the E2B family, Daytona and Vercel name no SDK package", async () => {
    const ids = ["e2b", "novita", "tencent", "volcengine", "daytona", "vercel"];
    for (const id of ids) expect(builtinProviders().find((p) => p.info.id === id)!.info.sdkPackage, id).toBeUndefined();
    for (const f of ["e2b-compatible", "daytona", "vercel"]) expect(readFileSync(new URL(`../src/providers/${f}.ts`, import.meta.url), "utf8")).not.toMatch(/loadSdk|import\(/);
  });

  it("package.json installs or offers exactly the SDKs the adapters load", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { dependencies: Record<string, string>; peerDependencies: Record<string, string>; peerDependenciesMeta: Record<string, { optional?: boolean }> };
    // Cloudflare's SDK runs in the Worker its template deploys, not next to the router.
    const loaded = builtinProviders().flatMap((p) => (p.info.sdkPackage && p.info.id !== "cloudflare" ? [p.info.sdkPackage] : []));
    for (const sdk of loaded) expect(sdkInstall(sdk), sdk).toMatch(/^(bundled|optional)$/);
    // Every optional peer is one an adapter (or the agentrun connector) loads, and is marked optional.
    const peers = Object.keys(pkg.peerDependencies);
    expect(peers.filter((p) => !loaded.includes(p) && p !== "@parcha/agentrun-computer")).toEqual([]);
    for (const p of peers) expect(pkg.peerDependenciesMeta[p]?.optional, p).toBe(true);
    // Bundled ones are regular dependencies, not peers too.
    for (const sdk of loaded.filter((s) => sdkInstall(s) === "bundled")) expect(pkg.peerDependencies[sdk], sdk).toBeUndefined();
    // Only the gRPC-only and native-binding SDKs remain, all optional; nothing installs with us.
    expect([...loaded].sort()).toEqual(["@beamcloud/beam-js", "@boxd-sh/sdk", "@boxlite-ai/boxlite", "modal"]);
    expect(loaded.map((s) => sdkInstall(s))).toEqual(["optional", "optional", "optional", "optional"]);
    expect(sdkInstall("e2b")).toBeUndefined();
  });

  it("hints at installing an optional SDK, and at reinstalling for a bundled one", async () => {
    await expect(loadSdk("@no-such/sdk-for-test", "x")).rejects.toThrow(/x needs its SDK: npm install @no-such\/sdk-for-test/);
    // A regular dependency reads as bundled (the MCP SDK is one).
    expect(sdkInstall("@modelcontextprotocol/sdk")).toBe("bundled");
  });
});

describe("e2b over HTTP", () => {
  const envFor = (url: string) => ({ E2B_API_KEY: "e2b_k", E2B_API_URL: url, E2B_SANDBOX_URL: url });

  it("creates, runs, moves files and kills through the API and envd", async () => {
    const api = await e2bMock({ key: "e2b_k", token: "envd-tok" });
    const { router } = routerFor(e2bProvider, envFor(api.url));
    await lifecycle(router, { files: true });
    const create = api.bodies.find((b) => b.route === "POST /v2/sandboxes")!;
    expect(create.body).toMatchObject({ templateID: "base", timeout: 120, envVars: {}, metadata: { "sandboxrouting.id": expect.any(String) } });
    const start = api.bodies.find((b) => b.route === "POST /process.Process/Start")!;
    expect(start.headers).toMatchObject({ "content-type": "application/connect+json", "x-access-token": "envd-tok", "e2b-sandbox-id": "sbx-1", "e2b-sandbox-port": "49983", "keepalive-ping-interval": "50" });
    // envd 0.4+ picks its default user: no Authorization header, no username.
    expect(start.headers.authorization).toBeUndefined();
    expect(api.bodies.find((b) => b.route === "GET /files")!.query.get("username")).toBeNull();
  });

  it("sends the command through bash -l with its cwd and env, and streams output", async () => {
    const api = await e2bMock({ key: "e2b_k" });
    const ctx: ProviderContext = { env: envFor(api.url), options: {} };
    const { providerSandboxId: id } = await e2bProvider.create({ ...spec, nativeTemplate: "my-tpl" }, ctx);
    const chunks: string[] = [];
    const r = await e2bProvider.exec(id, "echo hi", { cwd: "/w", env: { B: "2" }, timeoutSec: 30, onStdout: (c) => chunks.push(c) }, ctx);
    expect(r).toEqual({ stdout: "ran: echo hi\n", stderr: "", exitCode: 0 });
    expect(chunks.join("")).toBe("ran: echo hi\n");
    const start = api.bodies.find((b) => b.route === "POST /process.Process/Start")!;
    expect(start.headers["connect-timeout-ms"]).toBe("30000");
    expect(api.boxes.get(id)!.template).toBe("my-tpl");
    expect(await e2bProvider.listFiles!(id, "/tmp", ctx)).toEqual([
      { name: "a.txt", path: "/tmp/a.txt", isDir: false, size: 5 },
      { name: "d", path: "/tmp/d", isDir: true, size: 0 },
    ]);
  });

  it("names the user for envd older than 0.4, as the SDK does", async () => {
    const api = await e2bMock({ key: "e2b_k", envdVersion: "0.3.1" });
    const ctx: ProviderContext = { env: envFor(api.url), options: {} };
    const { providerSandboxId: id } = await e2bProvider.create(spec, ctx);
    await e2bProvider.exec(id, "true", {}, ctx);
    await e2bProvider.writeFile!(id, "/tmp/x", new TextEncoder().encode("x"), ctx);
    expect(api.bodies.find((b) => b.route === "POST /process.Process/Start")!.headers.authorization).toBe(`Basic ${Buffer.from("user:").toString("base64")}`);
    expect(api.bodies.find((b) => b.route === "POST /files")!.query.get("username")).toBe("user");
  });

  it("reconnects from another process, pauses, resumes, extends and lists", async () => {
    const api = await e2bMock({ key: "e2b_k" });
    const ctx: ProviderContext = { env: envFor(api.url), options: {} };
    const a = await e2bProvider.create(spec, ctx);
    const b = await e2bProvider.create(spec, ctx);
    expect((await e2bProvider.listAlive!(ctx)).sort()).toEqual([a.providerSandboxId, b.providerSandboxId]);
    await e2bProvider.pause!(a.providerSandboxId, ctx);
    expect(api.boxes.get(a.providerSandboxId)!.paused).toBe(true);
    // Paused twice is still paused (409).
    await e2bProvider.pause!(a.providerSandboxId, ctx);
    await e2bProvider.resume!(a.providerSandboxId, ctx);
    expect(api.boxes.get(a.providerSandboxId)!.paused).toBe(false);
    await e2bProvider.setTimeout!(a.providerSandboxId, 600, ctx);
    expect(api.boxes.get(a.providerSandboxId)!.timeout).toBe(600);
    expect(await e2bProvider.getUrl!(a.providerSandboxId, 3000, ctx)).toBe(`https://3000-${a.providerSandboxId}.e2b.test`);
    // Killing one that is already gone succeeds.
    await e2bProvider.kill(b.providerSandboxId, ctx);
    await e2bProvider.kill(b.providerSandboxId, ctx);
    expect(api.boxes.has(b.providerSandboxId)).toBe(false);
  });

  it("reaches envd at sandbox.e2b.app on E2B's domain and at <port>-<id>.<domain> elsewhere", async () => {
    const urls: string[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (u: string | URL | Request, init?: RequestInit) => {
      urls.push(String(u));
      if (String(u).endsWith("/v2/sandboxes")) {
        const domain = JSON.parse(String(init!.body)).templateID === "other" ? "sb.example" : null;
        return new Response(JSON.stringify({ sandboxID: "s1", envdVersion: "0.5.8", envdAccessToken: "t", domain }), { status: 201 });
      }
      return new Response("{}", { status: 503 });
    }) as typeof fetch;
    try {
      const ctx: ProviderContext = { env: { E2B_API_KEY: "k" }, options: {} };
      await e2bProvider.create(spec, ctx);
      await e2bProvider.exec("s1", "true", {}, ctx).catch(() => undefined);
      await e2bProvider.create({ ...spec, nativeTemplate: "other" }, ctx);
      await e2bProvider.exec("s1", "true", {}, ctx).catch(() => undefined);
    } finally {
      globalThis.fetch = real;
    }
    expect(urls).toEqual([
      "https://api.e2b.app/v2/sandboxes",
      "https://sandbox.e2b.app/process.Process/Start",
      "https://api.e2b.app/v2/sandboxes",
      "https://49983-s1.sb.example/process.Process/Start",
    ]);
  });

  it("keeps the refusals the router reads: 402 quota, 401 auth, 429 rate limit, gone sandbox", async () => {
    for (const [status, kind] of [
      [402, "quota"],
      [401, "auth"],
      [429, "rate_limit"],
    ] as const) {
      const api = await e2bMock({ key: "e2b_k", createStatus: { status, json: { code: status, message: "refused" } } });
      expect(await kindOf(e2bProvider.create(spec, { env: envFor(api.url), options: {} }))).toBe(kind);
    }
    const api = await e2bMock({ key: "e2b_k" });
    const ctx: ProviderContext = { env: envFor(api.url), options: {} };
    const { providerSandboxId: id } = await e2bProvider.create(spec, ctx);
    api.boxes.delete(id);
    // envd's proxy answers 502 "The sandbox was not found"; reconnecting answers 404.
    expect(await kindOf(e2bProvider.exec(id, "true", {}, ctx))).toBe("not_found");
    expect(await kindOf(e2bProvider.exec("never-made", "true", {}, ctx))).toBe("not_found");
    expect(await kindOf(e2bProvider.readFile!(id, "/nope", ctx))).toBe("not_found");
  });
});

/** A Daytona control plane and toolbox, per openapi.json / toolbox-openapi.json. */
async function daytonaMock() {
  const boxes = new Map<string, { state: string; polls: number; labels: Record<string, string>; files: Map<string, Buffer>; activity: number }>();
  const bodies: { route: string; body: unknown; query: URLSearchParams }[] = [];
  let n = 0;
  const server = await mock((r) => {
    if (r.headers.authorization !== "Bearer dtn_k") return { status: 401, json: { statusCode: 401, message: "Unauthorized" } };
    const json = String(r.headers["content-type"]).includes("json") && r.body.length ? r.json() : undefined;
    bodies.push({ route: `${r.method} ${r.path}`, body: json, query: r.query });
    const dto = (id: string) => ({ id, state: boxes.get(id)!.state, toolboxProxyUrl: `${server.url}/toolbox` });
    if (r.method === "POST" && r.path === "/sandbox") {
      const id = `dt-${++n}`;
      boxes.set(id, { state: "creating", polls: 0, labels: json.labels, files: new Map(), activity: 0 });
      return { json: dto(id) };
    }
    if (r.method === "GET" && r.path === "/sandbox") {
      const items = [...boxes.keys()].map(dto);
      const from = Number(r.query.get("cursor") ?? 0);
      return { json: { items: items.slice(from, from + 1), nextCursor: from + 1 < items.length ? String(from + 1) : null } };
    }
    let m = /^\/sandbox\/([^/]+)(\/[a-z-]+)?$/.exec(r.path);
    if (m) {
      const box = boxes.get(m[1]!);
      if (!box) return { status: 404, json: { statusCode: 404, message: `Sandbox with ID ${m[1]} not found` } };
      if (r.method === "GET" && !m[2]) {
        // Starts on the second poll.
        if (box.state === "creating" && ++box.polls >= 2) box.state = "started";
        if (box.state === "stopping") box.state = "stopped";
        if (box.state === "starting") box.state = "started";
        return { json: dto(m[1]!) };
      }
      if (r.method === "DELETE") return boxes.delete(m[1]!), { json: {} };
      if (m[2] === "/stop") return (box.state = "stopping"), { json: {} };
      if (m[2] === "/start") return (box.state = "starting"), { json: dto(m[1]!) };
      if (m[2] === "/last-activity") return box.activity++, { status: 201, raw: "" };
    }
    m = /^\/sandbox\/([^/]+)\/ports\/(\d+)\/preview-url$/.exec(r.path);
    if (m) return { json: { url: `https://${m[2]}-${m[1]}.proxy.daytona.test`, token: "t" } };
    m = /^\/toolbox\/([^/]+)(\/.*)$/.exec(r.path);
    if (m) {
      const box = boxes.get(m[1]!);
      if (!box) return { status: 404, json: { message: "not found" } };
      if (box.state !== "started") return { status: 400, json: { message: `sandbox is ${box.state}` } };
      if (m[2] === "/process/execute") {
        const out = fakeRun(json.command);
        return { json: { exitCode: out.code, result: out.stdout + out.stderr } };
      }
      if (m[2] === "/files/download") {
        const f = box.files.get(r.query.get("path")!);
        return f ? { raw: f } : { status: 404, json: { message: "file not found" } };
      }
      if (m[2] === "/files/bulk-upload") {
        const parts = formParts(r);
        box.files.set(parts.get("files[0].path")!.toString(), parts.get("files[0].file")!);
        return { json: {} };
      }
      if (m[2] === "/files") return { json: [{ name: "a.txt", isDir: false, size: 5 }, { name: "d", isDir: true, size: 0 }] };
    }
    return undefined;
  });
  return { ...server, boxes, bodies };
}

describe("daytona over HTTP", () => {
  const envFor = (url: string) => ({ DAYTONA_API_KEY: "dtn_k", DAYTONA_API_URL: url });

  it("creates, waits for started, runs, moves files and deletes", async () => {
    const api = await daytonaMock();
    const { router } = routerFor(daytonaProvider, envFor(api.url));
    await lifecycle(router, { files: true });
    const create = api.bodies.find((b) => b.route === "POST /sandbox")!;
    expect(create.body).toMatchObject({ env: {}, ttlMinutes: 2, autoStopInterval: 0, autoDeleteInterval: 0, labels: { "code-toolbox-language": "python" } });
    // Polled until started before the first command.
    expect(api.seen.filter((s) => s === "GET /sandbox/dt-1").length).toBe(2);
    expect(api.seen).toContain("DELETE /sandbox/dt-1");
  });

  it("builds an image from a Dockerfile with its size, and passes cwd, env and timeout to execute", async () => {
    const api = await daytonaMock();
    const ctx: ProviderContext = { env: envFor(api.url), options: { pollMs: 5 } };
    const { providerSandboxId: id } = await daytonaProvider.create({ ...spec, image: "python:3.12", cpu: 1.5, memoryMiB: 3000, region: "eu" }, ctx);
    expect(api.bodies.find((b) => b.route === "POST /sandbox")!.body).toMatchObject({ buildInfo: { dockerfileContent: "FROM python:3.12\n" }, cpu: 2, memory: 3, target: "eu", env: { A: "1" } });
    const r = await daytonaProvider.exec(id, "echo hi", { cwd: "/w", env: { B: "2" }, timeoutSec: 9 }, ctx);
    expect(r).toEqual({ stdout: "ran: echo hi\n", stderr: "", exitCode: 0 });
    expect(api.bodies.find((b) => b.route === `POST /toolbox/${id}/process/execute`)!.body).toEqual({ command: "echo hi", timeout: 9, cwd: "/w", envs: { B: "2" } });
    expect(await daytonaProvider.listFiles!(id, "/tmp", ctx)).toEqual([
      { name: "a.txt", path: "/tmp/a.txt", isDir: false, size: 5 },
      { name: "d", path: "/tmp/d", isDir: true, size: 0 },
    ]);
  });

  it("pauses (stop), resumes (start), refreshes activity, gives preview URLs and lists live ones", async () => {
    const api = await daytonaMock();
    const ctx: ProviderContext = { env: envFor(api.url), options: { pollMs: 5 } };
    const a = await daytonaProvider.create(spec, ctx);
    const b = await daytonaProvider.create(spec, ctx);
    await daytonaProvider.pause!(a.providerSandboxId, ctx);
    expect(api.boxes.get(a.providerSandboxId)!.state).toBe("stopped");
    await daytonaProvider.resume!(a.providerSandboxId, ctx);
    expect(api.boxes.get(a.providerSandboxId)!.state).toBe("started");
    await daytonaProvider.setTimeout!(a.providerSandboxId, 600, ctx);
    expect(api.boxes.get(a.providerSandboxId)!.activity).toBe(1);
    expect(await daytonaProvider.getUrl!(a.providerSandboxId, 8080, ctx)).toBe(`https://8080-${a.providerSandboxId}.proxy.daytona.test`);
    expect((await daytonaProvider.listAlive!(ctx)).sort()).toEqual([a.providerSandboxId, b.providerSandboxId]);
  });

  it("doesn't hand one key's cached toolbox URL to a caller with another key (the hosted router runs many accounts in one process)", async () => {
    const api = await daytonaMock();
    const ctx: ProviderContext = { env: envFor(api.url), options: { pollMs: 5 } };
    const { providerSandboxId: id } = await daytonaProvider.create(spec, ctx);
    await daytonaProvider.exec(id, "true", {}, ctx);
    const before = api.seen.length;
    const other: ProviderContext = { env: { ...envFor(api.url), DAYTONA_API_KEY: "someone-else" }, options: { pollMs: 5 } };
    expect(await kindOf(daytonaProvider.exec(id, "true", {}, other))).toBe("auth");
    // Its own key asked the control plane for the toolbox, instead of reusing the first caller's.
    expect(api.seen[before]).toBe(`GET /sandbox/${id}/toolbox-proxy-url`);
  });

  it("keeps the refusals the router reads", async () => {
    const api = await daytonaMock();
    expect(await kindOf(daytonaProvider.create(spec, { env: { ...envFor(api.url), DAYTONA_API_KEY: "wrong" }, options: {} }))).toBe("auth");
    expect(await kindOf(daytonaProvider.kill("gone", { env: envFor(api.url), options: {} }))).toBe("not_found");
    const broke = await mock(() => ({ status: 403, json: { statusCode: 403, message: "Total CPU quota exceeded. Maximum allowed: 10" } }));
    expect(await kindOf(daytonaProvider.create(spec, { env: envFor(broke.url), options: {} }))).toBe("quota");
  });
});

/** Reads a one-file gzipped tar the way `tar` would: name (with ustar prefix) and contents. */
function untar(gz: Buffer): { name: string; data: Buffer } {
  const t = gunzipSync(gz);
  const str = (at: number, len: number) => t.subarray(at, at + len).toString().replace(/\0.*$/s, "");
  const name = [str(345, 155), str(0, 100)].filter(Boolean).join("/");
  const size = Number.parseInt(str(124, 12), 8);
  return { name, data: t.subarray(512, 512 + size) };
}

/** Vercel's sandbox API: named sandboxes with sessions, ndjson command streams, tar.gz writes. */
async function vercelMock(opts: { dropStream?: boolean } = {}) {
  const boxes = new Map<string, { session: string; stopped: boolean; files: Map<string, Buffer>; timeoutMs: number; body: Record<string, unknown> }>();
  const bodies: { route: string; body: unknown; query: URLSearchParams; headers: Req["headers"] }[] = [];
  const cmds = new Map<string, { stdout: string; stderr: string; code: number }>();
  let n = 0;
  const byName = (name: string) => boxes.get(name);
  const bySession = (sid: string) => [...boxes.values()].find((b) => b.session === sid);
  const view = (name: string) => {
    const b = byName(name)!;
    return { sandbox: { name }, session: { id: b.session, cwd: "/vercel/sandbox", status: b.stopped ? "stopped" : "running" }, routes: [{ port: 3000, subdomain: `sb-${name}` }] };
  };
  const server = await mock((r) => {
    if (r.headers.authorization !== "Bearer vt_k" || r.query.get("teamId") !== "team_1") return { status: 403, json: { error: { code: "forbidden", message: "Not authorized" } } };
    const json = String(r.headers["content-type"]).includes("json") && r.body.length ? r.json() : undefined;
    bodies.push({ route: `${r.method} ${r.path}`, body: json, query: r.query, headers: r.headers });
    if (r.method === "POST" && (r.path === "/v2/sandboxes" || r.path === "/v3/sandboxes")) {
      const name = `sbx_${++n}`;
      boxes.set(name, { session: `ses_${n}`, stopped: false, files: new Map(), timeoutMs: json.timeout, body: json });
      return { json: view(name) };
    }
    let m = /^\/v2\/sandboxes\/(sbx_[^/]+)$/.exec(r.path);
    if (m) {
      const b = byName(m[1]!);
      if (!b) return { status: 404, json: { error: { code: "not_found", message: "Sandbox not found" } } };
      if (r.query.get("projectId") !== "prj_1") return { status: 400, json: { error: { code: "bad_request", message: "projectId" } } };
      if (r.method === "DELETE") return boxes.delete(m[1]!), { json: { sandbox: { name: m[1] } } };
      if (r.query.get("resume") === "true" && b.stopped) {
        b.stopped = false;
        b.session = `ses_${++n}`;
      }
      return { json: view(m[1]!) };
    }
    m = /^\/v2\/sandboxes\/sessions\/([^/]+)\/(.+)$/.exec(r.path);
    if (m) {
      const b = bySession(m[1]!);
      if (!b || b.stopped) return { status: 410, json: { error: { code: "sandbox_stopped", message: "Session stopped" } } };
      if (m[2] === "cmd") {
        const out = fakeRun(json.args[1]);
        const id = `cmd_${++n}`;
        cmds.set(id, out);
        const lines = [{ command: { id, exitCode: null } }];
        if (out.stdout) lines.push({ stream: "stdout", data: out.stdout } as never);
        if (out.stderr) lines.push({ stream: "stderr", data: out.stderr } as never);
        if (!opts.dropStream) lines.push({ command: { id, exitCode: out.code } });
        // A dropped stream ends after the first half of the output.
        if (opts.dropStream && out.stdout) lines[1] = { stream: "stdout", data: out.stdout.slice(0, 4) } as never;
        return { raw: lines.map((l) => JSON.stringify(l)).join("\n") + "\n", type: "application/x-ndjson" };
      }
      m = /^cmd\/(cmd_\d+)(\/logs)?$/.exec(m[2]!) ?? m;
      if (m[0].startsWith("cmd/")) {
        const c = cmds.get(m[1]!)!;
        if (m[2]) return { raw: [c.stdout && { stream: "stdout", data: c.stdout }, c.stderr && { stream: "stderr", data: c.stderr }].filter(Boolean).map((l) => JSON.stringify(l)).join("\n"), type: "application/x-ndjson" };
        return { json: { command: { id: m[1], exitCode: c.code } } };
      }
      if (m[2] === "fs/write") {
        const { name, data } = untar(r.body);
        b.files.set(`/${name}`, data);
        return { json: {} };
      }
      if (m[2] === "fs/read") {
        const f = b.files.get(json.path);
        return f ? { raw: f, type: "application/octet-stream" } : { status: 404, json: { error: { code: "file_not_found", message: "no such file" } } };
      }
      if (m[2] === "extend-timeout") return (b.timeoutMs += json.duration), { json: { session: { id: b.session } } };
      if (m[2] === "stop") return (b.stopped = true), { json: { session: { id: b.session, status: "stopped" } } };
    }
    return undefined;
  });
  return { ...server, boxes, bodies };
}

describe("vercel over HTTP", () => {
  const envFor = (url: string) => ({ VERCEL_TOKEN: "vt_k", VERCEL_TEAM_ID: "team_1", VERCEL_PROJECT_ID: "prj_1", VERCEL_SANDBOX_API_URL: url });

  it("creates, runs through sh -c, moves files as tar.gz and deletes", async () => {
    const api = await vercelMock();
    const { router } = routerFor(vercelProvider, envFor(api.url));
    await lifecycle(router, { files: true });
    const create = api.bodies.find((b) => b.route === "POST /v2/sandboxes")!;
    expect(create.body).toEqual({ projectId: "prj_1", ports: [], timeout: 120_000, resources: { vcpus: 2 }, runtime: "node22", env: {}, tags: expect.any(Object), persistent: false });
    const cmd = api.bodies.find((b) => b.route === "POST /v2/sandboxes/sessions/ses_1/cmd")!;
    expect(cmd.body).toEqual({ command: "sh", args: ["-c", "echo hi"], env: {}, sudo: false, wait: true, logs: true });
    const write = api.bodies.find((b) => b.route === "POST /v2/sandboxes/sessions/ses_1/fs/write")!;
    expect(write.headers).toMatchObject({ "content-type": "application/gzip", "x-cwd": "/" });
    expect(api.boxes.size).toBe(0);
  });

  it("creates from an image at /v3 and finds the ids in an OIDC token", async () => {
    const api = await vercelMock();
    const claims = Buffer.from(JSON.stringify({ owner_id: "team_1", project_id: "prj_1" })).toString("base64url");
    // The mock checks the bearer token, so this one is refused; the request still shows the ids.
    const ctx: ProviderContext = { env: { VERCEL_OIDC_TOKEN: `h.${claims}.s`, VERCEL_SANDBOX_API_URL: api.url }, options: {} };
    expect(vercelProvider.isConfigured!(ctx)).toBe(true);
    expect(await kindOf(vercelProvider.create({ ...spec, image: "node:22" }, ctx))).toBe("auth");
    const ok: ProviderContext = { env: envFor(api.url), options: { ports: [3000] } };
    const { providerSandboxId: id } = await vercelProvider.create({ ...spec, image: "node:22" }, ok);
    expect(api.bodies.find((b) => b.route === "POST /v3/sandboxes")!.body).toMatchObject({ image: "node:22", ports: [3000] });
    expect(await vercelProvider.getUrl!(id, 3000, ok)).toBe(`https://sb-${id}.vercel.run`);
    await expect(vercelProvider.getUrl!(id, 4000, ok)).rejects.toThrow(/No route for port 4000/);
  });

  it("resumes a stopped session and retries, as the SDK does", async () => {
    const api = await vercelMock();
    const ctx: ProviderContext = { env: envFor(api.url), options: {} };
    const { providerSandboxId: id } = await vercelProvider.create(spec, ctx);
    await vercelProvider.pause!(id, ctx);
    expect(api.boxes.get(id)!.stopped).toBe(true);
    const r = await vercelProvider.exec(id, "echo back", {}, ctx);
    expect(r.stdout).toBe("ran: echo back\n");
    expect(api.bodies.some((b) => b.route === `GET /v2/sandboxes/${id}` && b.query.get("resume") === "true")).toBe(true);
    await vercelProvider.setTimeout!(id, 300, ctx);
    expect(api.boxes.get(id)!.timeoutMs).toBe(120_000 + 300_000);
  });

  it("finishes a command whose stream dropped from its logs and its result", async () => {
    const api = await vercelMock({ dropStream: true });
    const ctx: ProviderContext = { env: envFor(api.url), options: {} };
    const { providerSandboxId: id } = await vercelProvider.create(spec, ctx);
    const seen: string[] = [];
    const r = await vercelProvider.exec(id, "echo dropped", { onStdout: (c) => seen.push(c) }, ctx);
    expect(r).toEqual({ stdout: "ran: echo dropped\n", stderr: "", exitCode: 0 });
    // Each byte reaches the caller once.
    expect(seen.join("")).toBe("ran: echo dropped\n");
    expect((await vercelProvider.exec(id, "exit 4", {}, ctx)).exitCode).toBe(4);
  });

  it("maps a missing file and refusals for the router", async () => {
    const api = await vercelMock();
    const ctx: ProviderContext = { env: envFor(api.url), options: {} };
    const { providerSandboxId: id } = await vercelProvider.create(spec, ctx);
    expect(await kindOf(vercelProvider.readFile!(id, "/nope", ctx))).toBe("not_found");
    expect(await kindOf(vercelProvider.create(spec, { env: { ...envFor(api.url), VERCEL_TOKEN: "bad" }, options: {} }))).toBe("auth");
    const spent = await mock(() => ({ status: 402, json: { error: { code: "payment_required", message: "Sandbox creation paused: usage limit reached" } } }));
    expect(await kindOf(vercelProvider.create(spec, { env: envFor(spent.url), options: {} }))).toBe("quota");
  });

  it("writes tar archives that tar reads, long paths included", () => {
    const dir = mkdtempSync(join(tmpdir(), "sbr-tar-"));
    const long = `${"deep/".repeat(40)}file.txt`;
    for (const name of ["tmp/a.txt", long]) {
      writeFileSync(join(dir, "x.tgz"), tarGz(name, new TextEncoder().encode(`content of ${name}`)));
      execFileSync("tar", ["-xzf", join(dir, "x.tgz"), "-C", dir]);
      expect(readFileSync(join(dir, name), "utf8")).toBe(`content of ${name}`);
    }
  });
});
