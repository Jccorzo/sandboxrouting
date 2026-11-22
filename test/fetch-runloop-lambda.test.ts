// Runloop and AWS Lambda MicroVMs, which used to load their SDKs (`@runloop/api-client`,
// `@aws-sdk/client-lambda-microvms`) and now speak HTTP with fetch. Runloop runs against a local
// server that answers as its REST API does, per the calls its SDK makes, running commands in a real
// `sh`. Lambda MicroVMs runs against a fake control plane that checks every SigV4 signature, with
// the real execd from templates/aws-lambda-microvm behind a fake VM endpoint. Neither has been run
// against the real service here.
import { afterAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, type Req } from "./restmock.js";
import { classify } from "../src/core/errors.js";
import { runloopProvider } from "../src/providers/runloop.js";
import { lambdaMicrovmProvider } from "../src/providers/lambda-microvm.js";
import { signV4 } from "../src/providers/aws-sigv4.js";
import { SandboxRouter, MemoryLedger, type ProviderAdapter, type ProviderContext } from "../src/index.js";

const spec = { cpu: 1, memoryMiB: 2048, timeoutSec: 120, env: { A: "1" }, metadata: { "sandboxrouting.id": "sbr_1" } };
const kindOf = async (p: Promise<unknown>) => classify(await p.then(() => undefined, (e: unknown) => e)).kind;
const sh = (command: string) => {
  const r = spawnSync("sh", ["-c", command], { encoding: "utf8" });
  return { stdout: r.stdout, stderr: r.stderr, code: r.status ?? 1 };
};

/** A router that has the adapter on (Runloop is off by default) and polls fast. */
function routerOn(adapter: ProviderAdapter, env: Record<string, string>) {
  return new SandboxRouter({ providers: [adapter], ledger: new MemoryLedger(), env, config: { allowPaid: true, providers: { [adapter.info.id]: { enabled: true, options: { pollMs: 5 } } } } });
}

/** Commands run in the real shell must keep quoting, cwd, env, stderr and the exit code. */
async function quotingSurvives(router: SandboxRouter) {
  const sbx = await router.create({ timeoutSec: 60 });
  const tmp = execFileSync("mktemp", ["-d"], { encoding: "utf8" }).trim();
  const out = await sbx.commands.run(`echo "it's $X" && pwd && echo oops >&2 && exit 3`, { cwd: tmp, env: { X: "a b" } });
  expect(out.stdout.split("\n")[0]).toBe("it's a b");
  expect(out.stdout).toContain(tmp.split("/").pop()!);
  expect(out.exitCode).toBe(3);
  expect(out.stderr.trim()).toBe("oops");
  await sbx.kill();
  return sbx;
}

describe("no provider SDK to install", () => {
  it("Runloop and Lambda MicroVMs name no SDK package and load none", () => {
    expect(runloopProvider.info.sdkPackage).toBeUndefined();
    expect(lambdaMicrovmProvider.info.sdkPackage).toBeUndefined();
    for (const f of ["runloop", "lambda-microvm", "aws-sigv4"]) expect(readFileSync(new URL(`../src/providers/${f}.ts`, import.meta.url), "utf8")).not.toMatch(/loadSdk|import\(|from "@runloop|from "@aws-sdk/);
  });
});

// ---------------------------------------------------------------- Runloop

interface Exec {
  execution_id: string;
  status: string;
  exit_status?: number;
  stdout: string;
  stderr: string;
  stdout_truncated?: boolean;
  full?: { stdout: string; stderr: string };
}

async function runloopMock(opts: { refuse?: (r: Req) => { status: number; json?: unknown; headers?: Record<string, string> } | undefined } = {}) {
  const bodies: { route: string; body: unknown; headers: Req["headers"] }[] = [];
  const execs = new Map<string, Exec>();
  const files = new Map<string, string>();
  const boxes = new Map<string, { status: string; tunnel?: { tunnel_key: string } }>();
  let waits = 0;
  let n = 0;
  const run = (command: string): Exec => {
    const r = sh(command);
    const id = `ex_${++n}`;
    const e: Exec = { execution_id: id, status: "completed", exit_status: r.code, stdout: r.stdout, stderr: r.stderr };
    // "big" output comes back cut short, the whole of it only from the stream.
    if (command.includes("big")) Object.assign(e, { stdout: r.stdout.slice(0, 3), stdout_truncated: true, full: r });
    execs.set(id, e);
    return e;
  };
  const sseOf = (text: string) => ({
    raw: [...text.matchAll(/[^\n]*\n?/g)].filter((m) => m[0]).map((m, i) => `data: ${JSON.stringify({ output: m[0], offset: i + 1 })}\n\n`).join(""),
    type: "text/event-stream",
  });
  const api = await mock((r) => {
    const route = `${r.method} ${r.path}`;
    bodies.push({ route, body: r.body.length ? r.json() : undefined, headers: r.headers });
    const refused = opts.refuse?.(r);
    if (refused) return refused;
    if (r.headers.authorization !== "Bearer rl_k") return { status: 401, json: { error: "unauthorized" } };
    if (route === "POST /v1/devboxes/create_and_await_running") {
      const id = `dbx_${++n}`;
      boxes.set(id, { status: "provisioning" });
      return { json: { id, status: "provisioning" } };
    }
    if (route === "GET /v1/devboxes") {
      // Two pages of running devboxes, cursor by id.
      if (!r.query.get("starting_after")) return { json: { devboxes: [{ id: "dbx_a" }, { id: "dbx_b" }], has_more: true } };
      return { json: { devboxes: r.query.get("starting_after") === "dbx_b" ? [{ id: "dbx_c" }] : [], has_more: false } };
    }
    const m = /^\/v1\/devboxes\/([^/]+)(?:\/(.+))?$/.exec(r.path);
    if (!m) return undefined;
    const [, id, op] = m as unknown as [string, string, string | undefined];
    const dbx = boxes.get(id);
    if (!dbx) return { status: 404, json: { error: `devbox ${id} not found` } };
    if (r.method === "GET" && !op) return { json: { id, status: dbx.status, tunnel: dbx.tunnel ?? null } };
    if (op === "wait_for_status") {
      // The first long poll times out on the server, as a real one does after ~25 s.
      if (waits++ === 0) return { status: 408, json: { error: "timeout" } };
      dbx.status = "running";
      return { json: { id, status: "running" } };
    }
    if (op === "execute") {
      const e = run(r.json().command);
      // A "slow" command isn't done when execute answers; the client long-polls for it.
      return { json: r.json().command.includes("slow") ? { ...e, status: "running", exit_status: undefined } : e };
    }
    if (op === "execute_async") return { json: { ...run(r.json().command), status: "running" } };
    const ex = /^executions\/([^/]+)\/(wait_for_status|stream_stdout_updates|stream_stderr_updates)$/.exec(op ?? "");
    if (ex) {
      const e = execs.get(ex[1]!)!;
      if (ex[2] === "wait_for_status") return { json: e };
      const which = ex[2] === "stream_stdout_updates" ? "stdout" : "stderr";
      return sseOf((e.full ?? e)[which]);
    }
    if (op === "read_file_contents") {
      const path = r.json().file_path as string;
      return files.has(path) ? { raw: files.get(path)!, type: "text/plain" } : { status: 404, json: { error: "file not found" } };
    }
    if (op === "write_file_contents") {
      files.set(r.json().file_path, r.json().contents);
      return { json: { execution_id: "w", status: "completed", exit_status: 0 } };
    }
    if (op === "enable_tunnel") {
      dbx.tunnel = { tunnel_key: "tk9" };
      return { json: dbx.tunnel };
    }
    if (op === "keep_alive") return { json: {} };
    const moved = { suspend: "suspended", resume: "resuming", shutdown: "shutdown" }[op ?? ""];
    if (moved) {
      dbx.status = moved;
      return { json: { id, status: moved } };
    }
    return undefined;
  });
  const routes = () => bodies.map((b) => b.route);
  return { ...api, bodies, routes, execs, files, boxes, env: { RUNLOOP_API_KEY: "rl_k", RUNLOOP_BASE_URL: api.url } };
}

describe("runloop over HTTP", () => {
  it("runs commands through the router with quoting, cwd, env and exit codes intact, then shuts down", async () => {
    const api = await runloopMock();
    const sbx = await quotingSurvives(routerOn(runloopProvider, api.env));
    expect(api.routes()).toContain(`POST /v1/devboxes/${sbx.providerSandboxId}/shutdown`);
  });

  it("creates with the SDK's payload and Bearer key, then long-polls until running", async () => {
    const api = await runloopMock();
    const ctx: ProviderContext = { env: api.env, options: { pollMs: 5 } };
    const { providerSandboxId: id } = await runloopProvider.create(spec, ctx);
    const create = api.bodies.find((b) => b.route === "POST /v1/devboxes/create_and_await_running")!;
    expect(create.body).toEqual({
      blueprint_name: null,
      environment_variables: { A: "1" },
      metadata: { "sandboxrouting.id": "sbr_1" },
      launch_parameters: { keep_alive_time_seconds: 120, resource_size_request: "SMALL" },
    });
    expect(create.headers.authorization).toBe("Bearer rl_k");
    expect(create.headers["x-request-id"]).toMatch(/^stainless-node-retry-/);
    // Booting: asked to wait (408 once, then running), with the statuses the SDK waits for.
    const waits = api.bodies.filter((b) => b.route === `POST /v1/devboxes/${id}/wait_for_status`);
    expect(waits.length).toBe(2);
    expect(waits[0]!.body).toEqual({ statuses: ["running", "failure", "shutdown"] });

    await runloopProvider.create({ ...spec, cpu: 3.4, memoryMiB: 5000, nativeTemplate: "bp" }, ctx);
    expect(api.bodies.filter((b) => b.route === "POST /v1/devboxes/create_and_await_running")[1]!.body).toMatchObject({
      blueprint_name: "bp",
      launch_parameters: { keep_alive_time_seconds: 120, resource_size_request: "CUSTOM_SIZE", custom_cpu_cores: 3, custom_gb_memory: 5 },
    });
  });

  it("execs without callbacks through execute, long-polling a command that isn't done", async () => {
    const api = await runloopMock();
    const ctx: ProviderContext = { env: api.env, options: { pollMs: 5 } };
    const { providerSandboxId: id } = await runloopProvider.create(spec, ctx);
    const r = await runloopProvider.exec(id, "echo slow; echo e >&2; exit 4", { env: { Q: "x'y" }, cwd: "/" }, ctx);
    expect(r).toEqual({ stdout: "slow\n", stderr: "e\n", exitCode: 4 });
    const exec = api.bodies.find((b) => b.route === `POST /v1/devboxes/${id}/execute`)!.body as { command: string; command_id: string };
    expect(exec.command).toBe(`export Q='x'\\''y'; cd '/' && echo slow; echo e >&2; exit 4`);
    expect(exec.command_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const eid = [...api.execs.keys()].pop();
    expect(api.bodies.find((b) => b.route === `POST /v1/devboxes/${id}/executions/${eid}/wait_for_status`)!.body).toEqual({ statuses: ["completed"] });
  });

  it("streams through execute_async when asked, and reads truncated output whole", async () => {
    const api = await runloopMock();
    const ctx: ProviderContext = { env: api.env, options: { pollMs: 5 } };
    const { providerSandboxId: id } = await runloopProvider.create(spec, ctx);
    const out: string[] = [];
    const err: string[] = [];
    const r = await runloopProvider.exec(id, "echo big one; echo two; echo bad >&2", { onStdout: (s) => out.push(s), onStderr: (s) => err.push(s) }, ctx);
    expect(out).toEqual(["big one\n", "two\n"]);
    expect(err).toEqual(["bad\n"]);
    // The result held 3 bytes and said so; stdout is read again from the stream.
    expect(r).toEqual({ stdout: "big one\ntwo\n", stderr: "bad\n", exitCode: 0 });
    expect(api.routes()).toContain(`POST /v1/devboxes/${id}/execute_async`);
    const stream = api.bodies.find((b) => b.route.endsWith("/stream_stdout_updates"))!;
    expect(stream.headers.accept).toBe("text/event-stream");
  });

  it("moves text files, gives tunnel URLs, keeps alive, suspends, resumes and lists running devboxes", async () => {
    const api = await runloopMock();
    const ctx: ProviderContext = { env: api.env, options: { pollMs: 5 } };
    const { providerSandboxId: id } = await runloopProvider.create(spec, ctx);
    await runloopProvider.writeFile!(id, "/tmp/a.txt", new TextEncoder().encode("hello"), ctx);
    expect(api.bodies.find((b) => b.route.endsWith("/write_file_contents"))!.body).toEqual({ file_path: "/tmp/a.txt", contents: "hello" });
    expect(new TextDecoder().decode(await runloopProvider.readFile!(id, "/tmp/a.txt", ctx))).toBe("hello");
    expect(api.bodies.find((b) => b.route.endsWith("/read_file_contents"))!.headers.accept).toBe("text/plain");
    // Binary can't go through the text API: the router falls back to exec.
    expect(await kindOf(runloopProvider.writeFile!(id, "/b", new Uint8Array([0xff, 0xfe]), ctx))).toBe("unsupported");

    expect(await runloopProvider.getUrl!(id, 3000, ctx)).toBe("https://3000-tk9.tunnel.127.0.0.1");
    expect(api.bodies.find((b) => b.route.endsWith("/enable_tunnel"))!.body).toEqual({ auth_mode: "open" });
    await runloopProvider.getUrl!(id, 3001, ctx);
    expect(api.routes().filter((r) => r.endsWith("/enable_tunnel")).length).toBe(1);

    await runloopProvider.setTimeout!(id, 600, ctx);
    expect(api.routes()).toContain(`POST /v1/devboxes/${id}/keep_alive`);
    await runloopProvider.pause!(id, ctx);
    expect(api.boxes.get(id)!.status).toBe("suspended");
    await runloopProvider.resume!(id, ctx);
    expect(api.boxes.get(id)!.status).toBe("running");
    expect(api.routes().slice(-2)).toEqual([`POST /v1/devboxes/${id}/resume`, `POST /v1/devboxes/${id}/wait_for_status`]);

    expect(await runloopProvider.listAlive!(ctx)).toEqual(["dbx_a", "dbx_b", "dbx_c"]);
    const lists = api.bodies.filter((b) => b.route === "GET /v1/devboxes");
    expect(lists.length).toBe(2);
  });

  it("retries what the SDK retries with one idempotency key, and keeps the refusals the router reads", async () => {
    let flaky = 0;
    const api = await runloopMock({
      refuse: (r) => {
        if (r.path.endsWith("/keep_alive") && flaky++ === 0) return { status: 503, json: { error: "unavailable" } };
        if (r.path === "/v1/devboxes/create_and_await_running" && r.json().metadata?.case === "busy") return { status: 429, json: { error: "too many requests" } };
        if (r.path === "/v1/devboxes/create_and_await_running" && r.json().metadata?.case === "broke") return { status: 402, json: { error: "payment required" } };
        return undefined;
      },
    });
    const ctx: ProviderContext = { env: api.env, options: { pollMs: 5 } };
    const { providerSandboxId: id } = await runloopProvider.create(spec, ctx);
    await runloopProvider.setTimeout!(id, 60, ctx);
    const keeps = api.bodies.filter((b) => b.route.endsWith("/keep_alive"));
    expect(keeps.length).toBe(2);
    expect(keeps[0]!.headers["x-request-id"]).toBe(keeps[1]!.headers["x-request-id"]);

    expect(await kindOf(runloopProvider.create({ ...spec, metadata: { case: "busy" } }, ctx))).toBe("rate_limit");
    // The first try and the SDK's five retries.
    expect(api.bodies.filter((b) => (b.body as { metadata?: { case?: string } } | undefined)?.metadata?.case === "busy").length).toBe(6);
    expect(await kindOf(runloopProvider.create({ ...spec, metadata: { case: "broke" } }, ctx))).toBe("quota");
    expect(await kindOf(runloopProvider.create(spec, { env: { ...api.env, RUNLOOP_API_KEY: "wrong" }, options: {} }))).toBe("auth");
    expect(await kindOf(runloopProvider.create(spec, { env: { RUNLOOP_BASE_URL: api.url }, options: {} }))).toBe("auth");
    expect(await kindOf(runloopProvider.kill("dbx_gone", ctx))).toBe("not_found");
  });

  it("stays off by default: a key alone doesn't route there", async () => {
    const api = await runloopMock();
    const r = new SandboxRouter({ providers: [runloopProvider], ledger: new MemoryLedger(), env: api.env, config: {} });
    expect((await r.plan()).ordered).toEqual([]);
  });
});

// ---------------------------------------------------------------- Lambda MicroVMs

// The real execd, behind a stand-in for the VM's HTTPS endpoint that wants the auth token headers.
const execd = await import("../templates/aws-lambda-microvm/execd.mjs");
execd.server.listen(0, "127.0.0.1");
await new Promise((ok) => execd.server.once("listening", ok));
const execdUrl = `http://127.0.0.1:${(execd.server.address() as AddressInfo).port}`;
const proxied: string[] = [];
const endpoint: Server = createServer(async (req, res) => {
  if (req.headers["x-aws-proxy-auth"] !== "jwe-token" || req.headers["x-aws-proxy-port"] !== "8080") {
    res.writeHead(403).end("no token");
    return;
  }
  proxied.push(`${req.method} ${req.url}`);
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = Buffer.concat(chunks);
  const r = await fetch(`${execdUrl}${req.url}`, { method: req.method, headers: { "content-type": String(req.headers["content-type"] ?? "") }, body: body.length ? body : undefined });
  res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "" }).end(Buffer.from(await r.arrayBuffer()));
});
endpoint.listen(0, "127.0.0.1");
await new Promise((ok) => endpoint.once("listening", ok));
const endpointUrl = `http://127.0.0.1:${(endpoint.address() as AddressInfo).port}`;
afterAll(() => {
  execd.server.close();
  endpoint.close();
});

const AUTH = /^AWS4-HMAC-SHA256 Credential=AKIDTEST\/(\d{8})\/us-east-1\/lambda\/aws4_request, SignedHeaders=([a-z0-9;-]+), Signature=([0-9a-f]{64})$/;

/** Recomputes the request's signature from what arrived on the wire. */
function checkSignature(r: Req, token?: string): string | undefined {
  const m = AUTH.exec(String(r.headers.authorization));
  if (!m) return `bad authorization: ${r.headers.authorization}`;
  const signed = m[2]!.split(";");
  for (const h of ["host", "x-amz-date", "x-amz-content-sha256", ...(token ? ["x-amz-security-token"] : [])]) if (!signed.includes(h)) return `${h} not signed`;
  if (r.headers["x-amz-content-sha256"] !== createHash("sha256").update(r.body).digest("hex")) return "payload hash differs";
  if (token && r.headers["x-amz-security-token"] !== token) return "session token missing";
  const amzDate = String(r.headers["x-amz-date"]);
  const date = new Date(`${amzDate.slice(0, 4)}-${amzDate.slice(4, 6)}-${amzDate.slice(6, 8)}T${amzDate.slice(9, 11)}:${amzDate.slice(11, 13)}:${amzDate.slice(13, 15)}Z`);
  const headers = Object.fromEntries(signed.filter((h) => h !== "host").map((h) => [h, String(r.headers[h])]));
  const again = signV4(
    { method: r.method, host: String(r.headers.host), path: r.path, query: r.query.toString(), headers, body: r.body.length ? r.body : undefined },
    { region: "us-east-1", service: "lambda", credentials: { accessKeyId: "AKIDTEST", secretAccessKey: "secret", sessionToken: token }, date, signBody: true },
  );
  return again["authorization"] === r.headers.authorization ? undefined : "signature differs";
}

let vmCount = 0;

async function lambdaMock(opts: { token?: string; refuse?: (r: Req) => { status: number; json?: unknown; headers?: Record<string, string> } | undefined } = {}) {
  const bodies: { route: string; body: unknown }[] = [];
  const problems: string[] = [];
  const vms = new Map<string, { state: string; ready: boolean }>();
  const api = await mock((r) => {
    const route = `${r.method} ${r.path}`;
    bodies.push({ route, body: r.body.length ? r.json() : undefined });
    const problem = checkSignature(r, opts.token);
    if (problem) {
      problems.push(`${route}: ${problem}`);
      return { status: 403, json: { message: problem }, headers: { "x-amzn-errortype": "InvalidSignatureException" } };
    }
    const refused = opts.refuse?.(r);
    if (refused) return refused;
    if (route === "POST /2025-09-09/microvms") {
      const id = `mv-${++vmCount}`;
      const vm = { state: "PENDING", ready: false };
      vms.set(id, vm);
      // Lambda hands runHookPayload to the image's /run hook; the VM runs once that has finished.
      void fetch(`${execdUrl}/run`, { method: "POST", body: String(r.json().runHookPayload) }).then(() => {
        vm.ready = true;
      });
      return { json: { microvmId: id, state: "PENDING", endpoint: endpointUrl } };
    }
    if (route === "GET /2025-09-09/microvms") {
      if (!r.query.get("nextToken"))
        return {
          json: {
            items: [
              { microvmId: "mv-a", state: "RUNNING" },
              { microvmId: "mv-b", state: "TERMINATED" },
            ],
            nextToken: "p2",
          },
        };
      return {
        json: {
          items: [
            { microvmId: "mv-c", state: "SUSPENDED" },
            { microvmId: "mv-d", state: "TERMINATING" },
          ],
        },
      };
    }
    const m = /^\/2025-09-09\/microvms\/([^/]+)(?:\/(.+))?$/.exec(r.path);
    if (!m) return undefined;
    const id = decodeURIComponent(m[1]!);
    const vm = vms.get(id);
    if (!vm) return { status: 404, json: { message: `MicroVM ${id} not found` }, headers: { "x-amzn-errortype": "ResourceNotFoundException:http://internal.amazon.com/coral/com.amazonaws.lambdamicrovms/" } };
    if (r.method === "GET" && !m[2]) return { json: { microvmId: id, state: vm.ready ? vm.state.replace("PENDING", "RUNNING") : "PENDING", endpoint: endpointUrl } };
    if (m[2] === "auth-token") return { json: { authToken: { "X-aws-proxy-auth": "jwe-token" } } };
    const moved = r.method === "DELETE" ? "TERMINATED" : { suspend: "SUSPENDED", resume: "RUNNING" }[m[2] ?? ""];
    if (moved) {
      vm.state = moved;
      return { json: {} };
    }
    return undefined;
  });
  const none = join(tmpdir(), "sbr-no-aws-file");
  const env = {
    LAMBDA_MICROVM_IMAGE: "arn:aws:lambda:us-east-1:123:microvm-image/img",
    AWS_ACCESS_KEY_ID: "AKIDTEST",
    AWS_SECRET_ACCESS_KEY: "secret",
    ...(opts.token ? { AWS_SESSION_TOKEN: opts.token } : {}),
    AWS_REGION: "us-east-1",
    AWS_ENDPOINT_URL_LAMBDA_MICROVMS: api.url,
    AWS_CONFIG_FILE: none,
    AWS_SHARED_CREDENTIALS_FILE: none,
  };
  return { ...api, bodies, problems, vms, env, routes: () => bodies.map((b) => b.route) };
}

describe("lambda-microvm over SigV4", () => {
  it("runs commands through execd with quoting, cwd, env and exit codes intact, then terminates", async () => {
    const api = await lambdaMock();
    const sbx = await quotingSurvives(routerOn(lambdaMicrovmProvider, api.env));
    expect(api.problems).toEqual([]);
    expect(api.routes()).toContain(`DELETE /2025-09-09/microvms/${sbx.providerSandboxId}`);
    expect(api.vms.get(sbx.providerSandboxId)!.state).toBe("TERMINATED");
  });

  it("applies runHookPayload env and moves files through the endpoint, every call signed", async () => {
    const api = await lambdaMock({ token: "session-tok" });
    const r = routerOn(lambdaMicrovmProvider, api.env);
    const sbx = await r.create({ timeoutSec: 60, env: { FROM_CREATE: "yes" } });
    const run = api.bodies.find((b) => b.route === "POST /2025-09-09/microvms")!.body as Record<string, unknown>;
    expect(run).toMatchObject({ imageIdentifier: api.env.LAMBDA_MICROVM_IMAGE, maximumDurationInSeconds: 60, runHookPayload: JSON.stringify({ env: { FROM_CREATE: "yes" } }) });
    expect(run["clientToken"]).toBe(sbx.id);
    expect((await sbx.commands.run("echo $FROM_CREATE")).stdout.trim()).toBe("yes");
    const dir = execFileSync("mktemp", ["-d"], { encoding: "utf8" }).trim();
    await sbx.files.write(`${dir}/sub/bin.dat`, new Uint8Array([0, 1, 255]));
    expect([...(await sbx.files.readBytes(`${dir}/sub/bin.dat`))]).toEqual([0, 1, 255]);
    expect((await sbx.files.list(`${dir}/sub`)).map((f) => f.name)).toEqual(["bin.dat"]);
    // One auth token, for execd's port, reused while it lasts.
    const tokens = api.bodies.filter((b) => b.route.endsWith("/auth-token"));
    expect(tokens.map((b) => b.body)).toEqual([{ expirationInMinutes: 60, allowedPorts: [{ port: 8080 }] }]);
    expect(proxied).toContain("POST /exec");
    await sbx.kill();
    expect(api.problems).toEqual([]);
  });

  it("suspends, resumes and lists live microVMs across pages", async () => {
    const api = await lambdaMock();
    const ctx: ProviderContext = { env: api.env, options: { pollMs: 5 } };
    const { providerSandboxId: id } = await lambdaMicrovmProvider.create(spec, ctx);
    await lambdaMicrovmProvider.pause!(id, ctx);
    expect(api.vms.get(id)!.state).toBe("SUSPENDED");
    await lambdaMicrovmProvider.resume!(id, ctx);
    expect(api.vms.get(id)!.state).toBe("RUNNING");
    expect(api.routes()).toEqual(expect.arrayContaining([`POST /2025-09-09/microvms/${id}/suspend`, `POST /2025-09-09/microvms/${id}/resume`]));
    expect(await lambdaMicrovmProvider.listAlive!(ctx)).toEqual(["mv-a", "mv-c"]);
    expect(api.problems).toEqual([]);
  });

  it("signs the encoded path of an ARN identifier", async () => {
    const api = await lambdaMock();
    const ctx: ProviderContext = { env: api.env, options: {} };
    const arn = "arn:aws:lambda:us-east-1:123:microvm/x y";
    expect(await kindOf(lambdaMicrovmProvider.kill(arn, ctx))).toBe("not_found");
    expect(api.routes()).toContain("DELETE /2025-09-09/microvms/arn%3Aaws%3Alambda%3Aus-east-1%3A123%3Amicrovm%2Fx%20y");
    expect(api.problems).toEqual([]);
  });

  it("keeps the refusals the router reads, retrying throttling as the SDK does", async () => {
    const api = await lambdaMock({
      refuse: (r) => {
        const image = r.method === "POST" && r.path === "/2025-09-09/microvms" ? String(r.json().imageIdentifier) : "";
        if (image === "quota") return { status: 402, json: { message: "You have reached the quota for running MicroVMs" }, headers: { "x-amzn-errortype": "ServiceQuotaExceededException" } };
        if (image === "slow") return { status: 429, json: { message: "Rate exceeded" }, headers: { "x-amzn-errortype": "ThrottlingException" } };
        if (image === "denied") return { status: 403, json: { message: "not authorized to perform lambda:RunMicrovm" }, headers: { "x-amzn-errortype": "AccessDeniedException" } };
        return undefined;
      },
    });
    const ctx = (image: string): ProviderContext => ({ env: api.env, options: { pollMs: 5, image } });
    expect(await kindOf(lambdaMicrovmProvider.create({ ...spec, nativeTemplate: "quota" }, ctx("quota")))).toBe("quota");
    expect(await kindOf(lambdaMicrovmProvider.create({ ...spec, nativeTemplate: "denied" }, ctx("denied")))).toBe("auth");
    expect(await kindOf(lambdaMicrovmProvider.create({ ...spec, nativeTemplate: "slow" }, ctx("slow")))).toBe("rate_limit");
    expect(api.bodies.filter((b) => (b.body as { imageIdentifier?: string } | undefined)?.imageIdentifier === "slow").length).toBe(3);
    const err = await lambdaMicrovmProvider.kill("mv-nope", ctx("x")).catch((e: Error) => e);
    expect(classify(err).kind).toBe("not_found");
    expect(String(err)).toMatch(/TerminateMicrovm: 404 ResourceNotFoundException/);
    // No credentials anywhere, or no region: a configuration problem, not a provider outage.
    const { AWS_ACCESS_KEY_ID: _k, AWS_SECRET_ACCESS_KEY: _s, ...noKeys } = api.env;
    expect(await kindOf(lambdaMicrovmProvider.kill("mv-1", { env: noKeys, options: {} }))).toBe("auth");
    const { AWS_REGION: _r, ...noRegion } = api.env;
    expect(await kindOf(lambdaMicrovmProvider.kill("mv-1", { env: noRegion, options: {} }))).toBe("auth");
    expect(api.problems).toEqual([]);
  });

  it("is configured by the image alone, as before", () => {
    expect(lambdaMicrovmProvider.isConfigured!({ env: {}, options: {} })).toBe(false);
    expect(lambdaMicrovmProvider.isConfigured!({ env: { LAMBDA_MICROVM_IMAGE: "arn" }, options: {} })).toBe(true);
  });
});
