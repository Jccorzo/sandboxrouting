// Luxor Agent Cloud (tenki) and Depot, which used to load their SDKs (`@tenkicloud/sandbox`,
// `@depot/sandbox`) and now speak each provider's API directly: Connect JSON over fetch for the
// control planes, and for Luxor's per-session data plane gRPC over HTTP/2. Each runs against local
// servers that answer as the calls the official SDKs make expect. Commands run in a real local
// shell, so quoting, cwd and env go through for real. None has been run against the real service.
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type Http2Server, type IncomingHttpHeaders } from "node:http2";
import type { AddressInfo } from "node:net";
import { mock, routerFor, type Req, type Reply } from "./restmock.js";
import { classify } from "../src/core/errors.js";
import { decode, get, pb, type Fields } from "../src/providers/grpc-web.js";
import { concat, lenField } from "../src/providers/tenki-grpc.js";
import { tenkiProvider } from "../src/providers/tenki.js";
import { depotProvider, depotStatus } from "../src/providers/depot.js";
import type { ProviderContext } from "../src/index.js";

const spec = { cpu: 2, memoryMiB: 4096, timeoutSec: 120, env: { A: "1" }, metadata: { "sandboxrouting.id": "sbr_1" } };
const kindOf = async (p: Promise<unknown>) => classify(await p.then(() => undefined, (e: unknown) => e)).kind;
const ctxOf = (env: Record<string, string>): ProviderContext => ({ env, options: { pollMs: 1 } });

/** Runs argv locally like the sandbox would. */
function sh(argv: string[], opts: { cwd?: string; env?: Record<string, string> } = {}) {
  const r = spawnSync(argv[0]!, argv.slice(1), { cwd: opts.cwd || undefined, env: { ...process.env, ...opts.env }, encoding: "buffer" });
  return { stdout: r.stdout, stderr: r.stderr, exitCode: r.status ?? 1 };
}

/** One Connect envelope: flags byte, big-endian length, JSON. */
const envelope = (msg: unknown, flags = 0) => {
  const json = Buffer.from(JSON.stringify(msg));
  const head = Buffer.alloc(5);
  head[0] = flags;
  head.writeUInt32BE(json.length, 1);
  return Buffer.concat([head, json]);
};
/** The request envelopes of a Connect streaming call. */
function envelopes(body: Buffer): unknown[] {
  const out: unknown[] = [];
  for (let i = 0; i + 5 <= body.length; ) {
    const len = body.readUInt32BE(i + 1);
    out.push(JSON.parse(body.subarray(i + 5, i + 5 + len).toString()));
    i += 5 + len;
  }
  return out;
}
/** A Connect streaming reply: messages, then end-of-stream (with an error, if given). */
const streamReply = (msgs: unknown[], error?: { code: string; message: string }): Reply => ({
  raw: Buffer.concat([...msgs.map((m) => envelope(m)), envelope(error ? { error } : {}, 0x02)]),
  type: "application/connect+json",
});
/** A Connect unary error, with the HTTP status the protocol pairs with its code. */
const connectErr = (status: number, code: string, message: string): Reply => ({ status, json: { code, message } });

/** create → exec (ok and non-zero) → files → kill, with commands run by a real shell. */
async function lifecycle(router: ReturnType<typeof routerFor>["router"]) {
  const sbx = await router.create({ timeoutSec: 120 });
  const ok = await sbx.commands.run("echo hi");
  expect(ok.stdout.trim()).toBe("hi");
  expect(ok.exitCode).toBe(0);
  expect((await sbx.commands.run("exit 3")).exitCode).toBe(3);
  await sbx.files.write("/tmp/a.txt", "hello");
  expect(await sbx.files.read("/tmp/a.txt")).toBe("hello");
  await sbx.kill();
  expect((await sbx.info())!.state).toBe("stopped");
}

describe("no provider SDK to install", () => {
  it("tenki and depot name no SDK package and load none", () => {
    expect(tenkiProvider.info.sdkPackage).toBeUndefined();
    expect(depotProvider.info.sdkPackage).toBeUndefined();
    for (const f of ["tenki", "tenki-grpc", "depot"]) expect(readFileSync(new URL(`../src/providers/${f}.ts`, import.meta.url), "utf8")).not.toMatch(/loadSdk|import\(/);
  });
});

// ---------------------------------------------------------------------------------------------
// Depot: depot.sandbox.v1.SandboxService over Connect JSON.

interface DepotBox {
  id: string;
  status: string;
  files: Map<string, Buffer>;
  timeoutMinutes?: number;
}

async function depotMock(opts: { token?: string; createError?: Reply; runError?: { code: string; message: string } } = {}) {
  const boxes = new Map<string, DepotBox>();
  const bodies: { method: string; body: unknown; headers: Req["headers"] }[] = [];
  let n = 0;
  const server = await mock((r) => {
    const method = r.path.replace("/depot.sandbox.v1.SandboxService/", "");
    const streaming = String(r.headers["content-type"]).includes("connect+json");
    const msgs = streaming ? envelopes(r.body) : [r.json()];
    bodies.push({ method, body: streaming ? msgs : msgs[0], headers: r.headers });
    if (r.headers.authorization !== `Bearer ${opts.token ?? "dp_tok"}`) return connectErr(401, "unauthenticated", "invalid token");
    const b = msgs[0] as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    const box = boxes.get(b?.sandbox?.id ?? b?.init?.sandbox?.id);
    if (method === "CreateSandbox") {
      if (opts.createError) return opts.createError;
      const id = `dp-${++n}`;
      boxes.set(id, { id, status: "SANDBOX_STATUS_RUNNING", files: new Map(), timeoutMinutes: b.timeoutMinutes });
      return { json: { sandbox: { sandboxId: id, organizationId: "org", status: "SANDBOX_STATUS_RUNNING", resources: { vcpus: b.resources.vcpus, memoryMb: b.resources.memoryMb, diskGb: 20 } } } };
    }
    if (method === "ListSandboxes") {
      if (!b.pageToken) {
        return {
          json: {
            sandboxes: [
              { sandboxId: "dp-a", status: "SANDBOX_STATUS_RUNNING" },
              { sandboxId: "dp-b", status: "SANDBOX_STATUS_FINISHED" },
              { sandboxId: "dp-c", status: "SANDBOX_STATUS_UNSPECIFIED" },
            ],
            nextPageToken: "p2",
          },
        };
      }
      return { json: { sandboxes: [{ sandboxId: "dp-d", status: "SANDBOX_STATUS_STARTING" }, { sandboxId: "dp-e", status: "SANDBOX_STATUS_CANCELLED" }, { sandboxId: "dp-f" }] } };
    }
    if (!box) return method === "RunCommand" || method === "ReadFile" ? streamReply([], { code: "not_found", message: "sandbox not found" }) : connectErr(404, "not_found", "sandbox not found");
    switch (method) {
      case "RunCommand": {
        if (opts.runError) return streamReply([{ started: { cmdId: "c1" } }], opts.runError);
        const out = sh([b.cmd, ...b.args], { cwd: b.cwd, env: b.env });
        const ev: unknown[] = [{ started: { cmdId: "c1", startedAt: "2026-11-22T00:00:00Z" } }];
        // Split stdout in the middle of a byte sequence, as a stream may.
        const half = Math.floor(out.stdout.length / 2);
        for (const part of [out.stdout.subarray(0, half), out.stdout.subarray(half)]) if (part.length) ev.push({ stdout: { data: part.toString("base64"), byteOffset: "0" } });
        if (out.stderr.length) ev.push({ stderr: { data: out.stderr.toString("base64"), byteOffset: "0" } });
        ev.push({ finished: { ...(out.exitCode ? { exitCode: out.exitCode } : {}), finishedAt: "2026-11-22T00:00:01Z" } });
        return streamReply(ev);
      }
      case "ReadFile": {
        const f = box.files.get(b.path);
        if (!f) return streamReply([], { code: "not_found", message: `open ${b.path}: no such file or directory` });
        return streamReply([{ data: f.subarray(0, 2).toString("base64") }, { data: f.subarray(2).toString("base64"), eof: true }]);
      }
      case "WriteFile": {
        const [init, ...data] = msgs as [{ init: { path: string } }, ...{ data: string }[]];
        box.files.set(init.init.path, Buffer.concat(data.map((d) => Buffer.from(d.data, "base64"))));
        return streamReply([{ bytesWritten: "5" }]);
      }
      case "ReadDir":
        return { json: { entries: [{ name: "a.txt", type: "FILE_TYPE_FILE" }, { name: "d", type: "FILE_TYPE_DIRECTORY" }] } };
      case "SetSandboxTimeout":
        box.timeoutMinutes = b.timeoutMinutes;
        return { json: { sandbox: { sandboxId: box.id, status: box.status } } };
      case "KillSandbox":
        box.status = "SANDBOX_STATUS_CANCELLED";
        return { json: { sandbox: { sandboxId: box.id, status: box.status } } };
    }
    return undefined;
  });
  return { ...server, boxes, bodies };
}

describe("depot over Connect", () => {
  it("creates with the SDK's payload and Bearer token, then runs the shared lifecycle", async () => {
    const m = await depotMock();
    const env = { DEPOT_TOKEN: "dp_tok", DEPOT_API_URL: m.url };
    const { router } = routerFor(depotProvider, env);
    await lifecycle(router);
    const create = m.bodies.find((b) => b.method === "CreateSandbox")!;
    expect(create.headers.authorization).toBe("Bearer dp_tok");
    expect(create.headers["connect-protocol-version"]).toBe("1");
    expect(create.body).toMatchObject({ resources: { vcpus: 2 }, timeoutMinutes: 2 });
    expect(m.bodies.map((b) => b.method)).toContain("KillSandbox");
  });

  it("maps the spec: at least 2 vCPU, minutes rounded up, the snapshot by id, the router id as name", async () => {
    const m = await depotMock();
    const ctx = ctxOf({ DEPOT_TOKEN: "dp_tok", DEPOT_API_URL: m.url });
    const r = await depotProvider.create({ ...spec, cpu: 1, timeoutSec: 61, nativeTemplate: "snap-1" }, ctx);
    expect(r).toEqual({ providerSandboxId: "dp-1", cpu: 2, memoryMiB: 4096 });
    expect(m.bodies[0]!.body).toEqual({
      name: "sbr_1",
      resources: { vcpus: 2, memoryMb: 4096 },
      env: { A: "1" },
      timeoutMinutes: 2,
      snapshot: { id: "snap-1" },
    });
  });

  it("runs through sh -c with quoting, cwd and env intact, stderr apart, and the exit code", async () => {
    const m = await depotMock();
    const { router } = routerFor(depotProvider, { DEPOT_TOKEN: "dp_tok", DEPOT_API_URL: m.url });
    const sbx = await router.create({ timeoutSec: 60 });
    const tmp = execFileSync("mktemp", ["-d"], { encoding: "utf8" }).trim();
    const seen: string[] = [];
    const out = await sbx.commands.run(`echo "it's $X ü" && pwd && echo oops >&2 && exit 3`, { cwd: tmp, env: { X: "a b" }, onStdout: (s) => seen.push(s) });
    expect(out.stdout.split("\n")[0]).toBe("it's a b ü");
    expect(out.stdout).toContain(tmp.split("/").pop()!);
    expect(out.stderr.trim()).toBe("oops");
    expect(out.exitCode).toBe(3);
    expect(seen.join("")).toBe(out.stdout);
    const run = m.bodies.find((b) => b.method === "RunCommand")!.body as unknown[];
    expect(run[0]).toMatchObject({ sandbox: { id: sbx.providerSandboxId }, cmd: "/bin/sh", cwd: tmp, env: { X: "a b" } });
    expect(m.bodies.find((b) => b.method === "RunCommand")!.headers["content-type"]).toBe("application/connect+json");
  });

  it("moves files with streams, writes in one client-stream body, and lists with types", async () => {
    const m = await depotMock();
    const ctx = ctxOf({ DEPOT_TOKEN: "dp_tok", DEPOT_API_URL: m.url });
    const { providerSandboxId: id } = await depotProvider.create(spec, ctx);
    await depotProvider.writeFile!(id, "/w/b.bin", new Uint8Array([0, 1, 255, 7, 9]), ctx);
    const write = m.bodies.find((b) => b.method === "WriteFile")!.body as unknown[];
    expect(write[0]).toEqual({ init: { sandbox: { id }, path: "/w/b.bin", append: false } });
    expect([...(await depotProvider.readFile!(id, "/w/b.bin", ctx))]).toEqual([0, 1, 255, 7, 9]);
    // An empty file is the init message alone.
    await depotProvider.writeFile!(id, "/w/empty", new Uint8Array(), ctx);
    expect(m.bodies.at(-1)!.body).toHaveLength(1);
    expect([...(await depotProvider.readFile!(id, "/w/empty", ctx))]).toEqual([]);
    expect(await depotProvider.listFiles!(id, "/w", ctx)).toEqual([
      { name: "a.txt", path: "/w/a.txt", isDir: false },
      { name: "d", path: "/w/d", isDir: true },
    ]);
    expect(m.bodies.at(-1)!.body).toEqual({ sandbox: { id }, path: "/w", withFileTypes: true });
    expect(await kindOf(depotProvider.readFile!(id, "/nope", ctx))).toBe("not_found");
  });

  it("sets the timeout in whole minutes, kills, and lists every page of live sandboxes", async () => {
    const m = await depotMock();
    const ctx = ctxOf({ DEPOT_TOKEN: "dp_tok", DEPOT_API_URL: m.url });
    const { providerSandboxId: id } = await depotProvider.create(spec, ctx);
    await depotProvider.setTimeout!(id, 601, ctx);
    expect(m.boxes.get(id)!.timeoutMinutes).toBe(11);
    await depotProvider.kill(id, ctx);
    expect(m.boxes.get(id)!.status).toBe("SANDBOX_STATUS_CANCELLED");
    expect(await depotProvider.listAlive!(ctx)).toEqual(["dp-a", "dp-d"]);
    expect(m.bodies.filter((b) => b.method === "ListSandboxes").map((b) => b.body)).toEqual([{}, { pageToken: "p2" }]);
    expect([depotStatus("SANDBOX_STATUS_RUNNING"), depotStatus("SANDBOX_STATUS_UNSPECIFIED"), depotStatus(7)]).toEqual(["running", undefined, undefined]);
  });

  it("classifies refusals by their Connect status", async () => {
    const env = (url: string) => ctxOf({ DEPOT_TOKEN: "dp_tok", DEPOT_API_URL: url });
    expect(await kindOf(depotProvider.create(spec, ctxOf({ DEPOT_TOKEN: "wrong", DEPOT_API_URL: (await depotMock()).url })))).toBe("auth");
    expect(await kindOf(depotProvider.create(spec, env((await depotMock({ createError: connectErr(429, "resource_exhausted", "too many sandboxes") })).url)))).toBe("rate_limit");
    expect(await kindOf(depotProvider.create(spec, env((await depotMock({ createError: connectErr(402, "unknown", "payment required") })).url)))).toBe("quota");
    expect(await kindOf(depotProvider.create(spec, env((await depotMock({ createError: connectErr(400, "failed_precondition", "out of minutes on your plan") })).url)))).toBe("quota");
    const m = await depotMock();
    expect(await kindOf(depotProvider.kill("dp-404", env(m.url)))).toBe("not_found");
    expect(await kindOf(depotProvider.exec("dp-404", "true", {}, env(m.url)))).toBe("not_found");
    const run = await depotMock({ runError: { code: "permission_denied", message: "forbidden" } });
    const { providerSandboxId: id } = await depotProvider.create(spec, env(run.url));
    expect(await kindOf(depotProvider.exec(id, "true", {}, env(run.url)))).toBe("auth");
  });

  it("fails a command whose stream ends without finishing, naming the reason it gave", async () => {
    const server = await mock((r) => {
      if (r.path.endsWith("/RunCommand")) return streamReply([{ started: { cmdId: "c9" } }, { error: { reason: "guest died" } }]);
      return undefined;
    });
    await expect(depotProvider.exec("dp-1", "true", {}, ctxOf({ DEPOT_TOKEN: "t", DEPOT_API_URL: server.url }))).rejects.toThrow(/c9 failed: guest died/);
    const first = await mock(() => streamReply([{ stdout: { data: "aGk=" } }]));
    await expect(depotProvider.exec("dp-1", "true", {}, ctxOf({ DEPOT_TOKEN: "t", DEPOT_API_URL: first.url }))).rejects.toThrow(/expected started/);
  });
});

// ---------------------------------------------------------------------------------------------
// Luxor: tenki.sandbox.v1.SandboxService over Connect JSON, and the data plane over gRPC.

const h2servers: Http2Server[] = [];
afterEach(() => h2servers.splice(0).forEach((s) => s.close()));

type DpReply = { http?: number; messages?: Uint8Array[]; status?: number; message?: string };

/** A local data plane: gRPC over cleartext HTTP/2, one handler per call. */
async function dataPlane(handler: (method: string, requests: Fields[], headers: IncomingHttpHeaders) => DpReply) {
  const calls: { method: string; requests: Fields[]; headers: IncomingHttpHeaders }[] = [];
  const server = createServer();
  server.on("stream", (stream, headers) => {
    const method = String(headers[":path"]).split("/").pop()!;
    let buf = Buffer.alloc(0);
    const requests: Fields[] = [];
    let answered = false;
    const answer = () => {
      if (answered) return;
      answered = true;
      calls.push({ method, requests, headers });
      const r = handler(method, requests, headers);
      if (r.http) {
        stream.respond({ ":status": r.http });
        stream.end();
        return;
      }
      stream.respond({ ":status": 200, "content-type": "application/grpc" }, { waitForTrailers: true });
      stream.on("wantTrailers", () => stream.sendTrailers({ "grpc-status": String(r.status ?? 0), ...(r.message ? { "grpc-message": encodeURIComponent(r.message) } : {}) }));
      for (const m of r.messages ?? []) {
        const head = Buffer.alloc(5);
        head.writeUInt32BE(m.length, 1);
        stream.write(Buffer.concat([head, m]));
      }
      stream.end();
    };
    stream.on("data", (c: Buffer) => {
      buf = Buffer.concat([buf, c]);
      while (buf.length >= 5 && buf.length >= 5 + buf.readUInt32BE(1)) {
        const len = buf.readUInt32BE(1);
        requests.push(decode(new Uint8Array(buf.subarray(5, 5 + len))));
        buf = buf.subarray(5 + len);
      }
      // Run keeps its request side open until the exit frame: answer once start and stdin_close are in.
      if (method === "Run" && requests.length >= 2) answer();
    });
    stream.on("end", answer);
    stream.on("error", () => undefined);
  });
  server.listen(0, "127.0.0.1");
  await new Promise((ok) => server.once("listening", ok));
  h2servers.push(server);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls };
}

const u8 = (n: number[]) => Uint8Array.from(n);
/** RunResponse frames, each in the service's wrapper message. */
const runFrame = (frame: Uint8Array) => lenField(1, frame);
const stdoutFrame = (b: Buffer) => runFrame(lenField(2, b));
const stderrFrame = (b: Buffer) => runFrame(lenField(3, b));
const exitFrame = (code: number, reason = "exit") => runFrame(lenField(4, concat(pb.uint(1, code), pb.str(5, reason))));

interface LuxorOpts {
  createError?: Reply;
  getError?: Reply;
  /** The data-plane endpoint the control plane hands out. */
  endpoint: string;
  /** Answer CreateSession already RUNNING with a verified route (no WaitSession). */
  readyAtCreate?: boolean;
  credential?: string;
}

async function luxorControl(o: LuxorOpts) {
  const sessions = new Map<string, { id: string; state: string; timeoutAt: string; cpuCores: number; memoryMb: number }>();
  const bodies: { method: string; body: any; headers: Req["headers"] }[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  let n = 0;
  let minted = 0;
  const server = await mock((r) => {
    const method = r.path.replace("/tenki.sandbox.v1.SandboxService/", "");
    const streaming = String(r.headers["content-type"]).includes("connect+json");
    const body = streaming ? envelopes(r.body)[0] : r.json();
    bodies.push({ method, body, headers: r.headers });
    if (!/^Bearer (lx|tk)_/.test(String(r.headers.authorization))) return connectErr(401, "unauthenticated", "invalid token");
    const b = body as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    const s = sessions.get(b.sessionId);
    const dp = { dataPlaneEndpoint: o.endpoint, credential: { credential: o.credential ?? "cert-1", expiresAt: "2099-01-01T00:00:00Z" } };
    switch (method) {
      case "CreateSession": {
        if (o.createError) return o.createError;
        const id = `tk-${++n}`;
        const session = { id, state: o.readyAtCreate ? "SESSION_STATE_RUNNING" : "SESSION_STATE_CREATING", timeoutAt: "2026-11-22T12:00:00Z", cpuCores: b.cpuCores, memoryMb: b.memoryMb };
        sessions.set(id, session);
        return { json: o.readyAtCreate ? { session, ...dp, routeStatus: "DATA_PLANE_ROUTE_STATUS_VERIFIED" } : { session, routeStatus: "DATA_PLANE_ROUTE_STATUS_NOT_READY" } };
      }
      case "WaitSession": {
        if (!s) return streamReply([], { code: "not_found", message: "session not found" });
        s.state = "SESSION_STATE_RUNNING";
        return streamReply([{ session: { ...s, state: "SESSION_STATE_CREATING" } }, { session: s, ...dp, routeStatus: "DATA_PLANE_ROUTE_STATUS_NOT_READY" }]);
      }
      case "CreateSessionCredential":
        minted++;
        return { json: { ...dp, credential: { credential: `cert-${minted + 1}`, expiresAt: "2099-01-01T00:00:00Z" }, routeStatus: "DATA_PLANE_ROUTE_STATUS_VERIFIED" } };
      case "ListWorkspaceSandboxes":
        if (!b.pageToken) return { json: { sessions: [{ id: "a", state: "SESSION_STATE_RUNNING" }, { id: "b", state: "SESSION_STATE_TERMINATED" }, { id: "c", state: "SESSION_STATE_PAUSED" }], nextPageToken: "p2" } };
        return { json: { sessions: [{ id: "d", state: "SESSION_STATE_USER_SHUTDOWN" }, { id: "e", state: "SESSION_STATE_TERMINATING" }, { id: "f", state: "SESSION_STATE_CREATING" }] } };
    }
    if (o.getError && method === "GetSession") return o.getError;
    if (!s) return connectErr(404, "not_found", "session not found");
    switch (method) {
      case "GetSession":
        return { json: { session: s } };
      case "ExtendSession":
        s.timeoutAt = new Date(Date.parse(s.timeoutAt) + Number.parseFloat(b.additionalDuration) * 1000).toISOString();
        return { json: { session: s } };
      case "ExposePort":
        return { json: { port: b.port, previewUrl: `https://${b.port}-${s.id}.preview.luxor.test`, hostAddress: "h" } };
      case "PauseSession":
        s.state = "SESSION_STATE_PAUSED";
        return { json: { session: s } };
      case "ResumeSession":
        s.state = "SESSION_STATE_RUNNING";
        return { json: { session: s } };
      case "TerminateSession":
        s.state = "SESSION_STATE_TERMINATED";
        return { json: { session: s } };
    }
    return undefined;
  });
  return { ...server, sessions, bodies, minted: () => minted };
}

/** A data plane that runs Run in a local shell and keeps files in memory. */
async function luxorDataPlane(opts: { notReadyStats?: number; notReadyRuns?: number; expectCert?: string } = {}) {
  const files = new Map<string, Buffer>();
  let stats = 0;
  let runs = 0;
  const dp = await dataPlane((method, requests, headers) => {
    if (opts.expectCert && headers["x-tenki-session-cert"] !== opts.expectCert) return { status: 16, message: "credential expired" };
    const inner = get.msg(requests[0]!, 1)!;
    if (method === "Stat") return ++stats <= (opts.notReadyStats ?? 0) ? { http: 404 } : { messages: [lenField(1, concat(pb.str(1, get.str(inner, 2))))] };
    if (method === "Run") {
      if (++runs <= (opts.notReadyRuns ?? 0)) return { http: 404 };
      const start = get.msg(inner, 1)!;
      const argv = (start.get(2) ?? []).map((v) => new TextDecoder().decode(v as Uint8Array));
      const env = Object.fromEntries(get.msgs(start, 4).map((e) => [get.str(e, 1), get.str(e, 2)]));
      const out = sh(argv, { cwd: get.str(start, 3), env });
      const reason = argv.at(-1) === "kill-session" ? "session_terminated:operator" : "exit";
      return {
        messages: [
          runFrame(lenField(1, pb.uint(1, 42))),
          runFrame(u8(pb.bool(6, true))),
          ...(out.stdout.length ? [stdoutFrame(out.stdout)] : []),
          ...(out.stderr.length ? [stderrFrame(out.stderr)] : []),
          exitFrame(out.exitCode, reason),
        ],
      };
    }
    const path = get.str(inner, 2);
    if (method === "WriteFile") {
      const v = inner.get(3)?.at(-1);
      files.set(path, Buffer.from(v instanceof Uint8Array ? v : new Uint8Array()));
      return { messages: [lenField(1, new Uint8Array())] };
    }
    if (method === "ReadFile") {
      const f = files.get(path);
      if (!f) return { status: 5, message: `open ${path}: no such file or directory` };
      return { messages: [lenField(1, concat(pb.str(1, path), lenField(2, f)))] };
    }
    if (method === "List") {
      const entry = (name: string, dir: boolean, size: number) => lenField(1, concat(pb.str(1, name), pb.bool(2, dir), pb.uint(3, size)));
      return { messages: [lenField(1, concat(entry("a.txt", false, 5), entry("sub", true, 0)))] };
    }
    return { status: 12, message: "unknown method" };
  });
  return { ...dp, files };
}

describe("tenki (Luxor) over Connect and gRPC", () => {
  it("creates with the SDK's payload, waits on WaitSession, and runs the shared lifecycle", async () => {
    const dp = await luxorDataPlane();
    const cp = await luxorControl({ endpoint: dp.url });
    const { router } = routerFor(tenkiProvider, { TENKI_API_KEY: "tk_key", TENKI_API_URL: cp.url });
    await lifecycle(router);
    const create = cp.bodies.find((b) => b.method === "CreateSession")!;
    expect(create.headers.authorization).toBe("Bearer tk_key");
    expect(create.body).toMatchObject({
      ownerType: "SERVICE",
      ownerId: "self",
      allowInbound: true,
      allowOutbound: true,
      cpuCores: 2,
      diskSizeGb: 5,
      maxDuration: "120s",
      waitReady: false,
      disableTailnet: false,
    });
    expect(cp.bodies.map((b) => b.method)).toEqual(expect.arrayContaining(["CreateSession", "WaitSession", "TerminateSession"]));
    // The credential WaitSession handed out is what the data plane sees; no extra mint was needed.
    expect(dp.calls.every((c) => c.headers["x-tenki-session-cert"] === "cert-1")).toBe(true);
    expect(cp.minted()).toBe(0);
    expect(dp.calls[0]!.headers["content-type"]).toBe("application/grpc");
  });

  it("maps the spec and returns the size the session got", async () => {
    const dp = await luxorDataPlane();
    const cp = await luxorControl({ endpoint: dp.url, readyAtCreate: true });
    const ctx = ctxOf({ LUXOR_API_KEY: "lx_key", LUXOR_API_ENDPOINT: cp.url });
    expect(await tenkiProvider.create({ ...spec, cpu: 0.4, nativeTemplate: "snap-1" }, ctx)).toEqual({ providerSandboxId: "tk-1", cpu: 1, memoryMiB: 4096 });
    expect(cp.bodies[0]!.body).toEqual({
      ownerType: "SERVICE",
      ownerId: "self",
      allowInbound: true,
      allowOutbound: true,
      metadata: { "sandboxrouting.id": "sbr_1" },
      env: { A: "1" },
      cpuCores: 1,
      memoryMb: 4096,
      maxDuration: "120s",
      waitReady: false,
      waitForRuntime: false,
      snapshotId: "snap-1",
      disableTailnet: false,
    });
    expect(cp.bodies.map((b) => b.method)).toEqual(["CreateSession"]);
    expect(await kindOf(tenkiProvider.create({ ...spec, image: "python:3.12", nativeTemplate: "snap-1" }, ctx))).toBe("invalid");
  });

  it("runs through sh -c on the data plane with quoting, cwd, env, timeout and exit codes intact", async () => {
    const dp = await luxorDataPlane();
    const cp = await luxorControl({ endpoint: dp.url, readyAtCreate: true });
    const { router } = routerFor(tenkiProvider, { LUXOR_API_KEY: "lx_key", LUXOR_API_ENDPOINT: cp.url });
    const sbx = await router.create({ timeoutSec: 60 });
    const tmp = execFileSync("mktemp", ["-d"], { encoding: "utf8" }).trim();
    const seen: string[] = [];
    const out = await sbx.commands.run(`echo "it's $X" && pwd && echo oops >&2 && exit 3`, { cwd: tmp, env: { X: "a b" }, timeoutSec: 30, onStderr: (s) => seen.push(s) });
    expect(out.stdout.split("\n")[0]).toBe("it's a b");
    expect(out.stdout).toContain(tmp.split("/").pop()!);
    expect(out.exitCode).toBe(3);
    expect(out.stderr).toBe("oops");
    expect(seen).toEqual(["oops"]);
    const start = get.msg(get.msg(dp.calls.find((c) => c.method === "Run")!.requests[0]!, 1)!, 1)!;
    expect(get.str(start, 1)).toBe(sbx.providerSandboxId);
    expect(get.bool(start, 6)).toBe(true); // stream_stdin
    expect(get.int(start, 7)).toBe(30_000); // timeout_ms
    // Then stdin_close, as the SDK's exec sends right after start.
    expect(get.bool(get.msg(dp.calls.find((c) => c.method === "Run")!.requests[1]!, 1)!, 4)).toBe(true);
    // No timeout: an hour, as the adapter always passed.
    await sbx.commands.run("true");
    expect(get.int(get.msg(get.msg(dp.calls.filter((c) => c.method === "Run")[1]!.requests[0]!, 1)!, 1)!, 7)).toBe(3_600_000);
    // An empty argument survives the protobuf encoding.
    expect((await sbx.commands.run(`set -- "" x; echo $#`)).stdout).toBe("2");
  });

  it("waits out an edge that has not applied the route yet (HTTP 404) for files and Run", async () => {
    const dp = await luxorDataPlane({ notReadyStats: 2, notReadyRuns: 2 });
    const cp = await luxorControl({ endpoint: dp.url });
    const ctx = ctxOf({ TENKI_API_KEY: "tk_key", TENKI_API_URL: cp.url });
    const { providerSandboxId: id } = await tenkiProvider.create(spec, ctx);
    await tenkiProvider.writeFile!(id, "/home/tenki/x", new TextEncoder().encode("hey"), ctx);
    expect(dp.calls.filter((c) => c.method === "Stat")).toHaveLength(3);
    expect(new TextDecoder().decode(await tenkiProvider.readFile!(id, "/home/tenki/x", ctx))).toBe("hey");
    // Once the route served, files don't probe again.
    expect(dp.calls.filter((c) => c.method === "Stat")).toHaveLength(3);
    expect((await tenkiProvider.exec(id, "echo ok", {}, ctx)).stdout).toBe("ok");
    expect(dp.calls.filter((c) => c.method === "Run")).toHaveLength(3);
  });

  it("mints a data-plane credential when it has none, and again once when the data plane refuses it", async () => {
    const dp = await luxorDataPlane({ expectCert: "cert-3" });
    const cp = await luxorControl({ endpoint: dp.url, readyAtCreate: true });
    const ctx = ctxOf({ TENKI_AUTH_TOKEN: "tk_tok", TENKI_API_URL: cp.url });
    const { providerSandboxId: id } = await tenkiProvider.create(spec, ctx);
    // cert-1 from create is refused; a mint gives cert-2 (refused too, so the error stands).
    expect(await kindOf(tenkiProvider.exec(id, "true", {}, ctx))).toBe("auth");
    expect(cp.minted()).toBe(1);
    // The next call starts from cert-2, is refused, and re-mints cert-3, which works.
    expect((await tenkiProvider.exec(id, "echo again", {}, ctx)).stdout).toBe("again");
    expect(cp.minted()).toBe(2);
    expect((await tenkiProvider.listFiles!(id, "/home/tenki", ctx)).map((f) => f.path)).toEqual(["/home/tenki/a.txt", "/home/tenki/sub"]);
  });

  it("lists files with names, paths, kinds and sizes; exposes ports; extends from the current deadline", async () => {
    const dp = await luxorDataPlane();
    const cp = await luxorControl({ endpoint: dp.url, readyAtCreate: true });
    const ctx = ctxOf({ LUXOR_API_KEY: "lx_key", LUXOR_API_ENDPOINT: cp.url });
    const { providerSandboxId: id } = await tenkiProvider.create(spec, ctx);
    expect(await tenkiProvider.listFiles!(id, "/tmp/", ctx)).toEqual([
      { name: "a.txt", path: "/tmp/a.txt", isDir: false, size: 5 },
      { name: "sub", path: "/tmp/sub", isDir: true, size: 0 },
    ]);
    expect(await tenkiProvider.getUrl!(id, 3000, ctx)).toBe(`https://3000-${id}.preview.luxor.test`);
    expect(cp.bodies.at(-1)!.body).toEqual({ sessionId: id, port: 3000 });
    const s = cp.sessions.get(id)!;
    s.timeoutAt = new Date(Date.now() + 60_000).toISOString();
    await tenkiProvider.setTimeout!(id, 600, ctx);
    const extend = cp.bodies.find((b) => b.method === "ExtendSession")!.body;
    expect(Number.parseFloat(extend.additionalDuration)).toBeGreaterThan(535);
    expect(Number.parseFloat(extend.additionalDuration)).toBeLessThanOrEqual(541);
    expect(extend.additionalDuration).toMatch(/s$/);
    // Already long enough: nothing to extend.
    await tenkiProvider.setTimeout!(id, 60, ctx);
    expect(cp.bodies.filter((b) => b.method === "ExtendSession")).toHaveLength(1);
    expect(await kindOf(tenkiProvider.readFile!(id, "/nope", ctx))).toBe("not_found");
  });

  it("pauses and resumes synchronously, kills, and lists live sessions across pages", async () => {
    const dp = await luxorDataPlane();
    const cp = await luxorControl({ endpoint: dp.url, readyAtCreate: true });
    const ctx = ctxOf({ LUXOR_API_KEY: "lx_key", LUXOR_API_ENDPOINT: cp.url });
    const { providerSandboxId: id } = await tenkiProvider.create(spec, ctx);
    await tenkiProvider.pause!(id, ctx);
    expect(cp.sessions.get(id)!.state).toBe("SESSION_STATE_PAUSED");
    await tenkiProvider.resume!(id, ctx);
    expect(cp.sessions.get(id)!.state).toBe("SESSION_STATE_RUNNING");
    expect(cp.bodies.filter((b) => /Pause|Resume/.test(b.method)).map((b) => b.body)).toEqual([
      { sessionId: id, async: false },
      { sessionId: id, async: false },
    ]);
    // Resume drops the old data-plane access; the next call mints fresh.
    await tenkiProvider.exec(id, "true", {}, ctx);
    expect(cp.minted()).toBe(1);
    await tenkiProvider.kill(id, ctx);
    expect(cp.sessions.get(id)!.state).toBe("SESSION_STATE_TERMINATED");
    expect(await tenkiProvider.listAlive!(ctx)).toEqual(["a", "c", "f"]);
    expect(cp.bodies.filter((b) => b.method === "ListWorkspaceSandboxes").map((b) => b.body)).toEqual([
      { pageSize: 100, pageToken: "", includeTerminated: false },
      { pageSize: 100, pageToken: "p2", includeTerminated: false },
    ]);
  });

  it("reads LUXOR_* before TENKI_* and refuses keys that are not lx_/tk_", async () => {
    const dp = await luxorDataPlane();
    const cp = await luxorControl({ endpoint: dp.url, readyAtCreate: true });
    await tenkiProvider.create(spec, ctxOf({ LUXOR_AUTH_TOKEN: "lx_tok", TENKI_API_KEY: "tk_key", LUXOR_API_ENDPOINT: cp.url, TENKI_API_ENDPOINT: "http://127.0.0.1:1" }));
    expect(cp.bodies.at(-1)!.headers.authorization).toBe("Bearer lx_tok");
    expect(await kindOf(tenkiProvider.create(spec, ctxOf({ TENKI_API_KEY: "sk_nope", TENKI_API_URL: cp.url })))).toBe("auth");
    expect(await kindOf(tenkiProvider.create(spec, ctxOf({ TENKI_API_URL: cp.url })))).toBe("auth");
  });

  it("classifies refusals: auth, concurrency, credit, a gone session, and a session that ended under a command", async () => {
    const dp = await luxorDataPlane();
    const env = (url: string) => ctxOf({ TENKI_API_KEY: "tk_key", TENKI_API_URL: url });
    const control = (o: Partial<LuxorOpts>) => luxorControl({ endpoint: dp.url, ...o });
    expect(await kindOf(tenkiProvider.create(spec, env((await control({ createError: connectErr(401, "unauthenticated", "token revoked") })).url)))).toBe("auth");
    expect(await kindOf(tenkiProvider.create(spec, env((await control({ createError: connectErr(429, "resource_exhausted", "max concurrent sessions reached") })).url)))).toBe("rate_limit");
    expect(await kindOf(tenkiProvider.create(spec, env((await control({ createError: connectErr(400, "failed_precondition", "insufficient credit balance") })).url)))).toBe("quota");
    expect(await kindOf(tenkiProvider.create(spec, env((await control({ createError: connectErr(402, "unknown", "payment required") })).url)))).toBe("quota");
    const cp = await control({ readyAtCreate: true });
    expect(await kindOf(tenkiProvider.kill("tk-404", env(cp.url)))).toBe("not_found");
    expect(await kindOf(tenkiProvider.setTimeout!("tk-404", 60, env(cp.url)))).toBe("not_found");
    const { providerSandboxId: id } = await tenkiProvider.create(spec, env(cp.url));
    expect(await kindOf(tenkiProvider.exec(id, "kill-session", {}, env(cp.url)))).toBe("not_found");
  });

  it("fails create when the session ends before it is ready", async () => {
    const server = await mock((r) => {
      if (r.path.endsWith("/CreateSession")) return { json: { session: { id: "tk-x", state: "SESSION_STATE_CREATING" } } };
      if (r.path.endsWith("/WaitSession")) return streamReply([{ session: { id: "tk-x", state: "SESSION_STATE_TERMINATED", terminalError: "image pull failed" } }]);
      return undefined;
    });
    await expect(tenkiProvider.create(spec, ctxOf({ TENKI_API_KEY: "tk_key", TENKI_API_URL: server.url }))).rejects.toThrow(/terminal state: TERMINATED: image pull failed/);
  });

  it("polls GetSession when WaitSession is not served", async () => {
    let polls = 0;
    const server = await mock((r) => {
      if (r.path.endsWith("/CreateSession")) return { json: { session: { id: "tk-p", state: "SESSION_STATE_CREATING" } } };
      if (r.path.endsWith("/WaitSession")) return streamReply([], { code: "unimplemented", message: "not here" });
      if (r.path.endsWith("/GetSession")) {
        polls++;
        if (polls === 1) return connectErr(404, "not_found", "session not found"); // replica lag
        return { json: { session: { id: "tk-p", state: polls < 3 ? "SESSION_STATE_CREATING" : "SESSION_STATE_RUNNING", cpuCores: 2, memoryMb: 4096 } } };
      }
      return undefined;
    });
    expect(await tenkiProvider.create(spec, ctxOf({ TENKI_API_KEY: "tk_key", TENKI_API_URL: server.url }))).toEqual({ providerSandboxId: "tk-p", cpu: 2, memoryMiB: 4096 });
    expect(polls).toBe(3);
  });
});
