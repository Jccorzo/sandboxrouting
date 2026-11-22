// Koyeb, which used to load `@koyeb/sandbox-sdk` and now speaks Koyeb's REST API and the sandbox
// executor with fetch. It runs against a local server that answers like Koyeb does, per the API
// reference and the calls the SDK (1.1.0) makes. None of this has been run against the real service.
import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeRun, lifecycle, mock, routerFor, type Reply, type Req } from "./restmock.js";
import { classify } from "../src/core/errors.js";
import { koyebProvider } from "../src/providers/koyeb.js";
import type { ProviderAdapter, ProviderContext } from "../src/index.js";

const spec = { cpu: 2, memoryMiB: 2048, timeoutSec: 120, env: { A: "1" }, metadata: { "sandboxrouting.id": "sbr_1" } };
const kindOf = async (p: Promise<unknown>) => classify(await p.then(() => undefined, (e: unknown) => e)).kind;

interface Opts {
  /** Deployment polls that answer STARTING before HEALTHY. */
  starting?: number;
  /** A status the deployment ends in instead of HEALTHY. */
  terminal?: string;
  /** Whether the deployment's metadata names the executor's address (else the app's domain is used). */
  address?: boolean;
  /** Run commands through a real `sh` instead of `fakeRun`. */
  sh?: boolean;
  /** The create reply leaves out latest_deployment_id, so readiness asks the service. */
  noLatest?: boolean;
  /** Replies to send before the real one, per route ("POST /v1/apps"). */
  fail?: Record<string, Reply[]>;
  /** Raw SSE body for /run_streaming. */
  stream?: string;
}

const ev = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/** One Koyeb account: the REST API under /v1 and every sandbox's executor under /edge. */
async function koyebMock(o: Opts = {}) {
  const services = new Map<string, { id: string; app_id: string; name: string; active_deployment_id?: string; latest_deployment_id?: string }>();
  const deployments = new Map<string, { status: string; polls: number; definition: { env: { key: string; value: string }[] } }>();
  const apps = new Set<string>();
  const files = new Map<string, string>();
  const reqs: Req[] = [];
  const fail = Object.fromEntries(Object.entries(o.fail ?? {}).map(([k, v]) => [k, [...v]]));
  let base = "";
  const secretOf = (depId: string) => deployments.get(depId)?.definition.env.find((e) => e.key === "SANDBOX_SECRET")?.value;

  const api = await mock((r) => {
    reqs.push(r);
    const route = `${r.method} ${r.path.replace(/\/(app|svc|dep)-[\w-]+/, "/:id")}`;
    const queued = fail[route]?.shift();
    if (queued) return queued;
    if (r.path.startsWith("/v1/") && r.headers.authorization !== "Bearer k") return { status: 401, json: { status: 401, code: "unauthorized", message: "Unauthorized" } };
    let m: RegExpExecArray | null;
    if (route === "POST /v1/apps") {
      const id = `app-${apps.size + 1}`;
      apps.add(id);
      return { json: { app: { id, name: r.json().name } } };
    }
    if (route === "POST /v1/services") {
      const b = r.json();
      const n = services.size + 1;
      const svc = { id: `svc-${n}`, app_id: b.app_id, name: b.definition.name, latest_deployment_id: `dep-${n}` };
      services.set(svc.id, svc);
      deployments.set(svc.latest_deployment_id, { status: "STARTING", polls: 0, definition: { env: b.definition.env } });
      return { json: { service: o.noLatest ? { ...svc, latest_deployment_id: undefined } : svc } };
    }
    if ((m = /^\/v1\/services\/([\w-]+)$/.exec(r.path)) && r.method === "GET") {
      const svc = services.get(m[1]!);
      return svc ? { json: { service: svc } } : { status: 404, json: { status: 404, code: "not_found", message: "Service not found" } };
    }
    if ((m = /^\/v1\/deployments\/([\w-]+)$/.exec(r.path))) {
      const d = deployments.get(m[1]!);
      if (!d) return { status: 404, json: { message: "Deployment not found" } };
      d.polls++;
      if (d.status === "STARTING" && d.polls > (o.starting ?? 0)) d.status = o.terminal ?? "HEALTHY";
      const metadata = o.address === false ? {} : { sandbox: { public_url: `${base}/edge`, routing_key: "rk-1" } };
      return { json: { deployment: { id: m[1], status: d.status, definition: d.definition, metadata } } };
    }
    if ((m = /^\/v1\/apps\/([\w-]+)$/.exec(r.path))) {
      if (!apps.has(m[1]!)) return { status: 404, json: { message: "App not found" } };
      if (r.method === "GET") return { json: { app: { id: m[1], domains: [{ name: "app-x.koyeb.app" }] } } };
      apps.delete(m[1]!);
      for (const [id, s] of services) if (s.app_id === m[1]) services.delete(id);
      return { json: { app: { id: m[1] } } };
    }
    // The executor: the secret of any live deployment, and the routing key when the address came from metadata.
    if (r.path.startsWith("/edge/koyeb-sandbox/")) {
      const secrets = [...deployments.keys()].map(secretOf);
      if (!secrets.includes(String(r.headers.authorization).replace(/^Bearer /, ""))) return { status: 401, raw: "invalid secret", type: "text/plain" };
      if (o.address !== false && r.headers["x-routing-key"] !== "rk-1") return { status: 404, raw: "no route", type: "text/plain" };
      const op = r.path.slice("/edge/koyeb-sandbox".length);
      if (op === "/health") return { json: { status: "ok" } };
      if (op === "/run_streaming") {
        if (o.stream !== undefined) return { raw: o.stream, type: "text/event-stream" };
        const { cmd, cwd, env } = r.json() as { cmd: string; cwd?: string; env?: Record<string, string> };
        const res = o.sh ? spawnSync("sh", ["-c", cmd], { cwd, env: { ...process.env, ...env }, encoding: "utf8" }) : undefined;
        const run = res ? { stdout: res.stdout, stderr: res.stderr, code: res.status ?? 1 } : fakeRun(cmd);
        // Output arrives line by line, as the executor streams it.
        const lines = (s: string, stream: string) => s.split(/(?<=\n)/).filter(Boolean).map((data) => ev("output", { stream, data }));
        return { raw: [...lines(run.stdout, "stdout"), ...lines(run.stderr, "stderr"), ev("complete", { code: run.code, error: "" })].join(""), type: "text/event-stream" };
      }
      if (op === "/write_file") {
        const { path, content } = r.json() as { path: string; content: string };
        if (path.startsWith("/nope/")) return { json: { error: `open ${path}: no such file or directory` } };
        files.set(path, content);
        return { json: {} };
      }
      if (op === "/bind_port" || op === "/unbind_port") return { json: { success: true } };
    }
    return undefined;
  });
  base = api.url;
  const bodies = (route: string) => reqs.filter((r) => `${r.method} ${r.path}` === route);
  return { ...api, services, deployments, apps, files, reqs, bodies, secretOf };
}

const ctxFor = (url: string, env: Record<string, string> = {}): ProviderContext => ({ env: { KOYEB_API_TOKEN: "k", KOYEB_API_HOST: url, ...env }, options: { pollMs: 1 } });

describe("koyeb over HTTP", () => {
  it("names no SDK and loads none", () => {
    expect((koyebProvider as ProviderAdapter).info.sdkPackage).toBeUndefined();
    expect(readFileSync(new URL("../src/providers/koyeb.ts", import.meta.url), "utf8")).not.toMatch(/loadSdk|import\(/);
  });

  it("gets through the router's lifecycle: create, exec, kill", async () => {
    const api = await koyebMock();
    const { router } = routerFor(koyebProvider, { KOYEB_API_TOKEN: "k", KOYEB_API_HOST: api.url });
    await lifecycle(router);
    expect(api.seen).toContain("DELETE /v1/apps/app-1");
    expect(api.apps.size).toBe(0);
  });

  it("creates an app and a SANDBOX service with the SDK's definition, then waits until the executor answers", async () => {
    const api = await koyebMock({ starting: 2 });
    const r = await koyebProvider.create(spec, ctxFor(api.url));
    expect(r).toEqual({ providerSandboxId: "svc-1", cpu: 2, memoryMiB: 2048 });

    const [app] = api.bodies("POST /v1/apps");
    expect(app!.headers.authorization).toBe("Bearer k");
    expect(app!.json()).toEqual({ name: expect.stringMatching(/^sandbox-app-sbr-sbr1-\d+$/), life_cycle: { delete_when_empty: true } });

    const svc = api.bodies("POST /v1/services")[0]!.json();
    const secret = svc.definition.env[0].value as string;
    expect(secret).toMatch(/^[-_0-9A-Za-z]{32}$/);
    expect(svc).toEqual({
      app_id: "app-1",
      definition: {
        name: "sbr-sbr1",
        type: "SANDBOX",
        docker: { image: "koyeb/sandbox" },
        instance_types: [{ type: "medium" }],
        regions: ["was"],
        ports: [
          { port: 3030, protocol: "http" },
          { port: 3031, protocol: "http" },
        ],
        routes: [
          { port: 3030, path: "/koyeb-sandbox/" },
          { port: 3031, path: "/" },
        ],
        env: [
          { key: "SANDBOX_SECRET", value: secret },
          { key: "A", value: "1" },
        ],
        mesh: "DEPLOYMENT_MESH_AUTO",
        scalings: [{ min: 0, max: 1, targets: [{ sleep_idle_delay: { deep_sleep_value: 300 } }] }],
      },
      life_cycle: { delete_after_create: 120 },
    });

    // Polled the deployment the create reply named until healthy, then the executor's health.
    expect(api.seen.filter((s) => s === "GET /v1/deployments/dep-1")).toHaveLength(3);
    const health = api.bodies("GET /edge/koyeb-sandbox/health")[0]!;
    expect(health.headers.authorization).toBe(`Bearer ${secret}`);
    expect(health.headers["x-routing-key"]).toBe("rk-1");
  });

  it("sizes, image and region follow the spec; the TTL is capped at a day", async () => {
    const api = await koyebMock();
    const r = await koyebProvider.create({ ...spec, cpu: 0.25, image: "python:3.12", region: "fra", timeoutSec: 3 * 86400 }, ctxFor(api.url));
    expect(r).toMatchObject({ cpu: 0.25, memoryMiB: 256 });
    const svc = api.bodies("POST /v1/services")[0]!.json();
    expect(svc.definition).toMatchObject({ docker: { image: "python:3.12" }, instance_types: [{ type: "nano" }], regions: ["fra"] });
    expect(svc.life_cycle).toEqual({ delete_after_create: 86400 });
  });

  it("asks the service for its deployment when the create reply names none", async () => {
    const api = await koyebMock({ noLatest: true });
    await koyebProvider.create(spec, ctxFor(api.url));
    expect(api.seen).toContain("GET /v1/services/svc-1");
  });

  it("runs the command in a real shell with its cwd and env, keeping quotes, streams apart and the exit code", async () => {
    const api = await koyebMock({ sh: true });
    const ctx = ctxFor(api.url);
    const { providerSandboxId: id } = await koyebProvider.create(spec, ctx);
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "koyeb-")));
    const r = await koyebProvider.exec(id, `echo "it's $X"; pwd; echo oops >&2; exit 4`, { cwd: dir, env: { X: "a b" }, timeoutSec: 20 }, ctx);
    expect(r).toEqual({ stdout: `it's a b\n${dir}\n`, stderr: "oops\n", exitCode: 4 });

    const run = api.bodies("POST /edge/koyeb-sandbox/run_streaming")[0]!;
    expect(run.json()).toEqual({ cmd: `echo "it's $X"; pwd; echo oops >&2; exit 4`, cwd: dir, env: { X: "a b" } });
    expect(run.headers.authorization).toBe(`Bearer ${api.secretOf("dep-1")}`);
    expect(run.headers["x-routing-key"]).toBe("rk-1");
    expect(run.headers["content-type"]).toBe("application/json");
    // Reconnects by id as get_from_id does: the service, then its deployment for the secret.
    expect(api.seen.slice(-3)).toEqual(["GET /v1/services/svc-1", "GET /v1/deployments/dep-1", "POST /edge/koyeb-sandbox/run_streaming"]);

    // No cwd or env: neither is sent.
    await koyebProvider.exec(id, "true", {}, ctx);
    expect(api.bodies("POST /edge/koyeb-sandbox/run_streaming")[1]!.json()).toEqual({ cmd: "true" });
  });

  it("hands output to the callbacks as it streams and still returns all of it", async () => {
    const api = await koyebMock({ sh: true });
    const ctx = ctxFor(api.url);
    const { providerSandboxId: id } = await koyebProvider.create(spec, ctx);
    const out: string[] = [];
    const err: string[] = [];
    const r = await koyebProvider.exec(id, "echo a; echo b; echo c >&2", { onStdout: (c) => out.push(c), onStderr: (c) => err.push(c) }, ctx);
    expect(out).toEqual(["a\n", "b\n"]);
    expect(err).toEqual(["c\n"]);
    expect(r).toEqual({ stdout: "a\nb\n", stderr: "c\n", exitCode: 0 });
    // A stdout callback alone loses nothing from stderr (the SDK dropped both streams here).
    const only = await koyebProvider.exec(id, "echo a; echo c >&2; exit 2", { onStdout: () => undefined }, ctx);
    expect(only).toEqual({ stdout: "a\n", stderr: "c\n", exitCode: 2 });
  });

  it("a command that fails to start discards its output and exits 1", async () => {
    const api = await koyebMock({ stream: ev("output", { stream: "stdout", data: "partial" }) + ev("error", { error: "exec: \"nope\": executable file not found" }) });
    const ctx = ctxFor(api.url);
    const { providerSandboxId: id } = await koyebProvider.create(spec, ctx);
    expect(await koyebProvider.exec(id, "nope", {}, ctx)).toEqual({ stdout: "", stderr: 'exec: "nope": executable file not found', exitCode: 1 });
  });

  it("reads events split across CRLF lines and an unterminated last event; a malformed one is a failure", async () => {
    const crlf = (s: string) => s.replace(/\n/g, "\r\n");
    const api = await koyebMock({ stream: crlf(ev("output", { stream: "stdout", data: "x\n" })) + `event: complete\ndata: {"code":7}` });
    const ctx = ctxFor(api.url);
    const { providerSandboxId: id } = await koyebProvider.create(spec, ctx);
    expect(await koyebProvider.exec(id, "x", {}, ctx)).toEqual({ stdout: "x\n", stderr: "", exitCode: 7 });

    const bad = await koyebMock({ stream: `event: output\ndata: not json\n\n` + ev("complete", {}) });
    const ctx2 = ctxFor(bad.url);
    const { providerSandboxId: id2 } = await koyebProvider.create(spec, ctx2);
    expect(await koyebProvider.exec(id2, "x", {}, ctx2)).toEqual({ stdout: "", stderr: "Failed to parse event data: not json", exitCode: 1 });
  });

  describe("the command timeout bounds silence, not the whole run", () => {
    const held: { close: () => void }[] = [];
    afterEach(() => held.splice(0).forEach((s) => s.close()));

    /** An executor whose /run_streaming sends `chunks` events `everyMs` apart, then completes, or hangs when `hang`. */
    async function slowExecutor(chunks: number, everyMs: number, hang = false) {
      const server = createServer((req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        let n = 0;
        const t = setInterval(() => {
          if (n < chunks) res.write(ev("output", { stream: "stdout", data: `${n++}\n` }));
          else {
            clearInterval(t);
            if (!hang) res.end(ev("complete", { code: 0 }));
          }
        }, everyMs);
        req.on("close", () => clearInterval(t));
      });
      server.listen(0, "127.0.0.1");
      await new Promise((ok) => server.once("listening", ok));
      held.push({ close: () => server.close() });
      held.push({ close: () => server.closeAllConnections() });
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    }

    /** A sandbox whose deployment metadata points at `executor`. */
    async function sandboxAt(executor: string) {
      const api = await koyebMock();
      const ctx = ctxFor(api.url);
      const { providerSandboxId: id } = await koyebProvider.create(spec, ctx);
      const real = globalThis.fetch;
      // Only the exec goes to the slow executor.
      globalThis.fetch = ((u: string | URL | Request, init?: RequestInit) =>
        real(String(u).replace(`${api.url}/edge/koyeb-sandbox/run_streaming`, `${executor}/koyeb-sandbox/run_streaming`), init)) as typeof fetch;
      held.push({ close: () => (globalThis.fetch = real) });
      return { id, ctx };
    }

    it("keeps running while output keeps coming", async () => {
      const { id, ctx } = await sandboxAt(await slowExecutor(6, 100));
      const r = await koyebProvider.exec(id, "slow", { timeoutSec: 0.4 }, ctx);
      expect(r).toEqual({ stdout: "0\n1\n2\n3\n4\n5\n", stderr: "", exitCode: 0 });
    });

    it("gives up after timeoutSec without output", async () => {
      const { id, ctx } = await sandboxAt(await slowExecutor(1, 50, true));
      const p = koyebProvider.exec(id, "hang", { timeoutSec: 0.3 }, ctx);
      await expect(p).rejects.toThrow(/timed out after 0.3s/);
      expect(await kindOf(p)).toBe("transient");
    });
  });

  it("writes text files through /write_file, retrying 5xx, and leaves binary to the exec fallback", async () => {
    const api = await koyebMock({ fail: { "POST /edge/koyeb-sandbox/write_file": [{ status: 503, raw: "warming up" }, { status: 502, raw: "bad gateway" }] } });
    const ctx = ctxFor(api.url);
    const { providerSandboxId: id } = await koyebProvider.create(spec, ctx);
    await koyebProvider.writeFile!(id, "/tmp/a.txt", new TextEncoder().encode("héllo"), ctx);
    expect(api.files.get("/tmp/a.txt")).toBe("héllo");
    const writes = api.bodies("POST /edge/koyeb-sandbox/write_file");
    expect(writes).toHaveLength(3);
    expect(writes[2]!.json()).toEqual({ path: "/tmp/a.txt", content: "héllo" });
    expect(writes[2]!.headers.authorization).toBe(`Bearer ${api.secretOf("dep-1")}`);

    // The executor reports failures as a 200 carrying `error`.
    await expect(koyebProvider.writeFile!(id, "/nope/x", new TextEncoder().encode("x"), ctx)).rejects.toThrow(/write_file failed: open \/nope\/x: no such file or directory/);
    expect(await kindOf(koyebProvider.writeFile!(id, "/tmp/b", new Uint8Array([0xff, 0xfe]), ctx))).toBe("unsupported");
  });

  it("does not retry a 4xx from the executor, and gives up on 5xx after three retries", async () => {
    const api = await koyebMock({
      fail: {
        "POST /edge/koyeb-sandbox/write_file": [{ status: 400, raw: "bad path" }, ...Array.from({ length: 4 }, () => ({ status: 503, raw: "down" }))],
      },
    });
    const ctx = ctxFor(api.url);
    const { providerSandboxId: id } = await koyebProvider.create(spec, ctx);
    expect(await kindOf(koyebProvider.writeFile!(id, "/tmp/a", new TextEncoder().encode("x"), ctx))).toBe("invalid");
    expect(api.bodies("POST /edge/koyeb-sandbox/write_file")).toHaveLength(1);
    expect(await kindOf(koyebProvider.writeFile!(id, "/tmp/a", new TextEncoder().encode("x"), ctx))).toBe("transient");
    expect(api.bodies("POST /edge/koyeb-sandbox/write_file")).toHaveLength(5);
  });

  it("exposes a port: unbinds, binds, and answers the routed public URL", async () => {
    const api = await koyebMock();
    const ctx = ctxFor(api.url);
    const { providerSandboxId: id } = await koyebProvider.create(spec, ctx);
    expect(await koyebProvider.getUrl!(id, 3000, ctx)).toBe(`${api.url}/edge/r/rk-1/`);
    expect(api.bodies("POST /edge/koyeb-sandbox/unbind_port")[0]!.json()).toEqual({});
    expect(api.bodies("POST /edge/koyeb-sandbox/bind_port")[0]!.json()).toEqual({ port: "3000" });
    expect(api.seen.indexOf("POST /edge/koyeb-sandbox/unbind_port")).toBeLessThan(api.seen.indexOf("POST /edge/koyeb-sandbox/bind_port"));
    expect(await kindOf(koyebProvider.getUrl!(id, 70000, ctx))).toBe("invalid");
  });

  it("falls back to the app's domain when the deployment names no executor address", async () => {
    const api = await koyebMock({ address: false });
    const real = globalThis.fetch;
    globalThis.fetch = ((u: string | URL | Request, init?: RequestInit) => real(String(u).replace("https://app-x.koyeb.app", `${api.url}/edge`), init)) as typeof fetch;
    try {
      const ctx = ctxFor(api.url);
      const { providerSandboxId: id } = await koyebProvider.create(spec, ctx);
      expect(api.seen).toContain("GET /v1/apps/app-1");
      expect(api.bodies("GET /edge/koyeb-sandbox/health")[0]!.headers["x-routing-key"]).toBeUndefined();
      expect((await koyebProvider.exec(id, "echo hi", {}, ctx)).stdout).toBe("ran: echo hi\n");
      expect(await koyebProvider.getUrl!(id, 8080, ctx)).toBe("https://app-x.koyeb.app");
    } finally {
      globalThis.fetch = real;
    }
  });

  it("reconnects to the live deployment, not the latest, and needs its SANDBOX_SECRET", async () => {
    const api = await koyebMock();
    const ctx = ctxFor(api.url);
    const { providerSandboxId: id } = await koyebProvider.create(spec, ctx);
    // A newer deployment rolls out with another secret while dep-1 still serves.
    api.deployments.set("dep-9", { status: "HEALTHY", polls: 0, definition: { env: [{ key: "SANDBOX_SECRET", value: "other" }] } });
    Object.assign(api.services.get(id)!, { active_deployment_id: "dep-1", latest_deployment_id: "dep-9" });
    await koyebProvider.exec(id, "true", {}, ctx);
    expect(api.bodies("POST /edge/koyeb-sandbox/run_streaming")[0]!.headers.authorization).toBe(`Bearer ${api.secretOf("dep-1")}`);

    api.deployments.get("dep-1")!.definition.env = [];
    await expect(koyebProvider.exec(id, "true", {}, ctx)).rejects.toThrow(/no SANDBOX_SECRET/);
  });

  it("kill deletes the app create made, which takes the service with it", async () => {
    const api = await koyebMock();
    const ctx = ctxFor(api.url);
    const { providerSandboxId: id } = await koyebProvider.create(spec, ctx);
    await koyebProvider.kill(id, ctx);
    expect(api.seen.slice(-2)).toEqual(["GET /v1/services/svc-1", "DELETE /v1/apps/app-1"]);
    expect(api.bodies("DELETE /v1/apps/app-1")[0]!.headers.authorization).toBe("Bearer k");
    expect(await kindOf(koyebProvider.kill(id, ctx))).toBe("not_found");
    expect(await kindOf(koyebProvider.exec(id, "true", {}, ctx))).toBe("not_found");
  });

  it("removes the app when the service cannot be created", async () => {
    const api = await koyebMock({ fail: { "POST /v1/services": [{ status: 422, json: { message: "invalid instance type" } }] } });
    expect(await kindOf(koyebProvider.create(spec, ctxFor(api.url)))).toBe("invalid");
    expect(api.seen).toContain("DELETE /v1/apps/app-1");
    expect(api.apps.size).toBe(0);
  });

  it("a deployment that fails is deleted, and says so", async () => {
    const api = await koyebMock({ starting: 1, terminal: "ERROR" });
    const p = koyebProvider.create(spec, ctxFor(api.url));
    await expect(p).rejects.toThrow(/reached status ERROR.*The sandbox was deleted\./);
    expect(api.seen).toContain("DELETE /v1/apps/app-1");
    expect(api.seen.filter((s) => s.includes("/edge/"))).toEqual([]);
  });

  it("keeps polling through API errors while the deployment starts", async () => {
    const api = await koyebMock({ fail: { "GET /v1/deployments/:id": [{ status: 503, raw: "unavailable" }, { status: 500, raw: "oops" }] } });
    expect((await koyebProvider.create(spec, ctxFor(api.url))).providerSandboxId).toBe("svc-1");
  });

  it("classifies refusals by status", async () => {
    const refuse = (status: number, message: string) => koyebMock({ fail: { "POST /v1/apps": [{ status, json: { status, message } }] } });
    expect(await kindOf(koyebProvider.create(spec, ctxFor((await refuse(402, "Payment required")).url)))).toBe("quota");
    expect(await kindOf(koyebProvider.create(spec, ctxFor((await refuse(429, "Too many requests")).url)))).toBe("rate_limit");
    expect(await kindOf(koyebProvider.create(spec, ctxFor((await refuse(403, "Forbidden")).url)))).toBe("auth");
    const api = await koyebMock();
    expect(await kindOf(koyebProvider.create(spec, ctxFor(api.url, { KOYEB_API_TOKEN: "wrong" })))).toBe("auth");
    // No token: refused before any request, as the SDK does.
    expect(await kindOf(koyebProvider.create(spec, { env: { KOYEB_API_HOST: api.url }, options: {} }))).toBe("auth");
    expect(api.seen).toEqual(["POST /v1/apps"]);
  });

  it("keeps the executor's status on a refused command", async () => {
    const api = await koyebMock({ fail: { "POST /edge/koyeb-sandbox/run_streaming": [{ status: 401, raw: "invalid secret" }, { status: 503, raw: "down" }] } });
    const ctx = ctxFor(api.url);
    const { providerSandboxId: id } = await koyebProvider.create(spec, ctx);
    expect(await kindOf(koyebProvider.exec(id, "true", {}, ctx))).toBe("auth");
    // Exec is one request, as in the SDK: a 5xx is not retried.
    expect(await kindOf(koyebProvider.exec(id, "true", {}, ctx))).toBe("transient");
    expect(api.bodies("POST /edge/koyeb-sandbox/run_streaming")).toHaveLength(2);
  });
});
