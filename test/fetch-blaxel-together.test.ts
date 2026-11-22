// Blaxel and Together over HTTP: the calls `@blaxel/core` 0.3.37 and `together-sandbox` 4.1.1 make,
// against local servers that run each command in a real shell, so quoting, cwd and env are
// exercised for real. Not run against the real services.
import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mock, routerFor, type Req } from "./restmock.js";
import { classify } from "../src/core/errors.js";
import { blaxelProvider } from "../src/providers/blaxel.js";
import { togetherProvider } from "../src/providers/together.js";
import type { ProviderContext, SandboxRouter } from "../src/index.js";

const spec = { cpu: 2, memoryMiB: 2048, timeoutSec: 120, env: { A: "1" }, metadata: { "sandboxrouting.id": "sbr_1" } };
const kindOf = async (p: Promise<unknown>) => classify(await p.then(() => undefined, (e: unknown) => e)).kind;
const tmpdir = () => execFileSync("mktemp", ["-d"], { encoding: "utf8" }).trim();
const sh = (command: string, cwd?: string, env?: Record<string, string>) => spawnSync("sh", ["-c", command], { cwd, env: { ...process.env, ...env }, encoding: "utf8" });

/** create → exec (ok and non-zero) → files → kill through the router, with commands run by a real sh. */
async function lifecycle(router: SandboxRouter) {
  const sbx = await router.create({ timeoutSec: 120 });
  expect((await sbx.commands.run("echo hi")).stdout).toBe("hi\n");
  expect((await sbx.commands.run("exit 3")).exitCode).toBe(3);
  await sbx.files.write("/tmp/a.txt", "hello");
  expect(await sbx.files.read("/tmp/a.txt")).toBe("hello");
  await sbx.kill();
  expect((await sbx.info())!.state).toBe("stopped");
}

/** The parts of a multipart/form-data body, by field name. */
function formParts(r: Req): Map<string, { filename?: string; body: Buffer }> {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/.exec(String(r.headers["content-type"]))!;
  const b = `--${m[1] ?? m[2]}`;
  const out = new Map<string, { filename?: string; body: Buffer }>();
  for (const part of r.body.toString("latin1").split(b).slice(1, -1)) {
    const [head, ...body] = part.split("\r\n\r\n");
    out.set(/name="([^"]+)"/.exec(head!)![1]!, { filename: /filename="([^"]+)"/.exec(head!)?.[1], body: Buffer.from(body.join("\r\n\r\n").replace(/\r\n$/, ""), "latin1") });
  }
  return out;
}

describe("no SDK to install", () => {
  it("Blaxel and Together name no SDK package and load none", () => {
    for (const [p, f] of [
      [blaxelProvider, "blaxel"],
      [togetherProvider, "together"],
    ] as const) {
      expect(p.info.sdkPackage, f).toBeUndefined();
      expect(readFileSync(new URL(`../src/providers/${f}.ts`, import.meta.url), "utf8")).not.toMatch(/loadSdk|import\(/);
    }
  });
});

// ---------------------------------------------------------------- Blaxel

async function blaxelMock(opts: { createFailures?: { status: number; json: unknown }[]; gatewayFailures?: number } = {}) {
  const boxes = new Map<string, { record: Record<string, unknown>; deleted?: boolean; previews: Map<string, unknown> }>();
  const files = new Map<string, Buffer>();
  const seen: { route: string; headers: Req["headers"]; body: Buffer; query: URLSearchParams }[] = [];
  const createFailures = [...(opts.createFailures ?? [])];
  let gatewayFailures = opts.gatewayFailures ?? 0;
  const parts = new Map<string, Map<number, Buffer>>();
  let url = "";
  const server = await mock((r) => {
    seen.push({ route: `${r.method} ${r.path}`, headers: r.headers, body: r.body, query: r.query });
    if (r.headers["x-blaxel-authorization"] !== "Bearer bl_k" || r.headers["x-blaxel-workspace"] !== "ws") return { status: 401, json: { code: 401, error: "Unauthorized" } };
    if (r.method === "POST" && r.path === "/v0/sandboxes") {
      const f = createFailures.shift();
      const body = r.json();
      const name = body.metadata.name as string;
      boxes.set(name, { record: { ...body, metadata: { ...body.metadata, url: `${url}/sbx/${name}` }, status: f?.status === 504 ? "DEPLOYING" : "DEPLOYED" }, previews: new Map() });
      if (f) return { status: f.status, json: f.json };
      return { json: boxes.get(name)!.record };
    }
    const cp = /^\/v0\/sandboxes\/([^/]+)(?:\/previews(?:\/([^/]+))?)?$/.exec(r.path);
    if (cp) {
      const box = boxes.get(cp[1]!);
      if (!box || box.deleted) return { status: 404, json: { code: 404, error: "Sandbox not found" } };
      if (r.path.includes("/previews")) {
        if (r.method === "GET") return box.previews.has(cp[2]!) ? { json: box.previews.get(cp[2]!) } : { status: 404, json: { code: 404, error: "not found" } };
        const p = { ...r.json(), spec: { ...r.json().spec, url: `https://${r.json().metadata.name}-${cp[1]}.preview.bl.run` } };
        box.previews.set(p.metadata.name, p);
        return { json: p };
      }
      if (r.method === "GET") {
        // The record lags behind a create the edge cut off, then deploys.
        if (box.record["status"] === "DEPLOYING") return (box.record["status"] = "DEPLOYED"), { status: 404, json: { code: 404 } };
        return { json: box.record };
      }
      if (r.method === "PUT") return (box.record = r.json()), { json: box.record };
      if (r.method === "DELETE") return (box.deleted = true), { json: box.record };
    }
    const sb = /^\/sbx\/([^/]+)(\/.*)$/.exec(r.path);
    if (!sb) return undefined;
    const rest = sb[2]!;
    if (r.method === "POST" && rest === "/process") {
      const b = r.json();
      const run = sh(b.command, b.workingDir, b.env);
      return { json: { pid: "1", name: "p", command: b.command, status: run.status ? "failed" : "completed", exitCode: run.status, stdout: run.stdout, stderr: run.stderr, logs: run.stdout + run.stderr } };
    }
    if (rest.startsWith("/filesystem/")) {
      if (gatewayFailures > 0) return gatewayFailures--, { status: 503, raw: "<html>edge</html>", type: "text/html" };
      if (r.method === "PUT") {
        // The SDK puts the path into the URL unencoded.
        const f = formParts(r);
        files.set(decodeURIComponent(rest.slice("/filesystem/".length)), f.get("file")!.body);
        return { json: { message: "ok", path: f.get("path")!.body.toString() } };
      }
      const path = decodeURIComponent(rest.slice("/filesystem/".length));
      if (r.headers.accept === "application/octet-stream") return files.has(path) ? { raw: files.get(path)! } : { status: 404, json: { error: "not found" } };
      const kids = [...files.keys()].filter((k) => k.startsWith(`${path}/`)).map((k) => k.slice(path.length + 1));
      return {
        json: {
          name: path.split("/").pop(),
          path,
          files: kids.filter((k) => !k.includes("/")).map((k) => ({ name: k, path: `${path}/${k}`, size: files.get(`${path}/${k}`)!.length })),
          subdirectories: [...new Set(kids.filter((k) => k.includes("/")).map((k) => k.split("/")[0]!))].map((d) => ({ name: d, path: `${path}/${d}` })),
        },
      };
    }
    const mp = /^\/filesystem-multipart\/(?:initiate\/(.+)|([^/]+)\/(part|complete|abort))$/.exec(rest);
    if (mp?.[1]) return parts.set("u1", new Map()), files.set(`pending:u1`, Buffer.from(decodeURIComponent(mp[1]))), { json: { uploadId: "u1", path: decodeURIComponent(mp[1]) } };
    if (mp?.[3] === "part") {
      const n = Number(r.query.get("partNumber"));
      parts.get(mp[2]!)!.set(n, formParts(r).get("file")!.body);
      return { json: { partNumber: n, etag: `e${n}`, size: parts.get(mp[2]!)!.get(n)!.length } };
    }
    if (mp?.[3] === "complete") {
      const order = (r.json().parts as { partNumber: number }[]).map((p) => p.partNumber);
      files.set(files.get("pending:u1")!.toString(), Buffer.concat(order.map((n) => parts.get(mp[2]!)!.get(n)!)));
      return { json: { message: "ok" } };
    }
    return undefined;
  });
  url = server.url;
  return { ...server, boxes, files, seen };
}

const blEnv = (url: string) => ({ BL_API_KEY: "bl_k", BL_WORKSPACE: "ws", BL_API_URL: `${url}/v0` });

describe("blaxel over HTTP", () => {
  it("creates with the SDK's payload and headers, runs, moves files and deletes", async () => {
    const api = await blaxelMock();
    const { router } = routerFor(blaxelProvider, { ...blEnv(api.url), BL_REGION: "us-pdx-1" });
    await lifecycle(router);
    const create = api.seen.find((s) => s.route === "POST /v0/sandboxes")!;
    expect(create.headers).toMatchObject({ "x-blaxel-authorization": "Bearer bl_k", "x-blaxel-workspace": "ws", "blaxel-version": "2026-09-22" });
    const body = JSON.parse(create.body.toString());
    expect(body).toEqual({
      metadata: { name: expect.stringMatching(/^sbr-[0-9a-f]{16}$/) },
      spec: { region: "us-pdx-1", runtime: { image: "blaxel/base-image:latest", memory: expect.any(Number), generation: "mk3", ttl: "2m" } },
    });
    // The sandbox API is reached at the record's metadata.url, with the same headers.
    const exec = api.seen.find((s) => s.route === `POST /sbx/${body.metadata.name}/process`)!;
    expect(exec.headers["x-blaxel-authorization"]).toBe("Bearer bl_k");
    expect(api.seen.some((s) => s.route === `DELETE /v0/sandboxes/${body.metadata.name}`)).toBe(true);
  });

  it("sends envs, ports and the TTL, runs with cwd, env and quoting intact, and keeps stderr apart", async () => {
    const api = await blaxelMock();
    const ctx: ProviderContext = { env: blEnv(api.url), options: { ports: [3000], pollMs: 1 } };
    const { providerSandboxId: id } = await blaxelProvider.create({ ...spec, timeoutSec: 3601, nativeTemplate: "my/img:1" }, ctx);
    const runtime = JSON.parse(api.seen[0]!.body.toString()).spec.runtime;
    expect(runtime).toMatchObject({ image: "my/img:1", memory: 2048, envs: [{ name: "A", value: "1" }], ports: [{ target: 3000, protocol: "HTTP" }], ttl: "61m" });
    const tmp = tmpdir();
    const out: string[] = [];
    const err: string[] = [];
    const r = await blaxelProvider.exec(id, `echo "it's $X" && pwd && echo oops >&2 && exit 3`, { cwd: tmp, env: { X: "a b" }, timeoutSec: 30, onStdout: (c) => out.push(c), onStderr: (c) => err.push(c) }, ctx);
    expect(r.stdout.split("\n")[0]).toBe("it's a b");
    expect(r.stdout).toContain(tmp.split("/").pop()!);
    expect(r.stderr.trim()).toBe("oops");
    expect(r.exitCode).toBe(3);
    expect(out.join("")).toBe(r.stdout);
    expect(err.join("")).toBe(r.stderr);
    const body = JSON.parse(api.seen.find((s) => s.route.endsWith("/process"))!.body.toString());
    expect(body).toMatchObject({ workingDir: tmp, env: { X: "a b" }, waitForCompletion: true, timeout: 30 });
  });

  it("writes through the unencoded URL, reads and lists through the encoded one, and uploads big files in parts", async () => {
    const api = await blaxelMock();
    const ctx: ProviderContext = { env: blEnv(api.url), options: { pollMs: 1 } };
    const { providerSandboxId: id } = await blaxelProvider.create(spec, ctx);
    await blaxelProvider.writeFile!(id, "/w/d/bin.dat", new Uint8Array([0, 1, 255]), ctx);
    await blaxelProvider.writeFile!(id, "/w/a.txt", new TextEncoder().encode("hello"), ctx);
    const put = api.seen.find((s) => s.route.startsWith("PUT /sbx/"))!;
    expect(put.route).toBe(`PUT /sbx/${id}/filesystem//w/d/bin.dat`);
    expect([...(await blaxelProvider.readFile!(id, "/w/d/bin.dat", ctx))]).toEqual([0, 1, 255]);
    expect(api.seen.some((s) => s.route === `GET /sbx/${id}/filesystem/%2Fw%2Fd%2Fbin.dat`)).toBe(true);
    expect(await blaxelProvider.listFiles!(id, "/w", ctx)).toEqual([
      { name: "d", path: "/w/d", isDir: true },
      { name: "a.txt", path: "/w/a.txt", isDir: false, size: 5 },
    ]);
    const big = new Uint8Array(11 * 1024 * 1024).map((_, i) => i % 251);
    await blaxelProvider.writeFile!(id, "/w/big.bin", big, ctx);
    expect(api.seen.filter((s) => s.route.endsWith("/part")).length).toBe(3);
    expect(Buffer.compare(api.files.get("/w/big.bin")!, Buffer.from(big))).toBe(0);
  });

  it("retries an edge gateway error on idempotent calls", async () => {
    const api = await blaxelMock({ gatewayFailures: 2 });
    const ctx: ProviderContext = { env: blEnv(api.url), options: { pollMs: 1 } };
    const { providerSandboxId: id } = await blaxelProvider.create(spec, ctx);
    await blaxelProvider.writeFile!(id, "/x", new TextEncoder().encode("x"), ctx);
    expect(api.seen.filter((s) => s.route.startsWith("PUT")).length).toBe(3);
  });

  it("makes a public preview once per port, extends the TTL by rewriting the record, and kills", async () => {
    const api = await blaxelMock();
    const ctx: ProviderContext = { env: blEnv(api.url), options: { pollMs: 1 } };
    const { providerSandboxId: id } = await blaxelProvider.create(spec, ctx);
    expect(await blaxelProvider.getUrl!(id, 8080, ctx)).toBe(`https://p8080-${id}.preview.bl.run`);
    expect(await blaxelProvider.getUrl!(id, 8080, ctx)).toBe(`https://p8080-${id}.preview.bl.run`);
    expect(api.seen.filter((s) => s.route === `POST /v0/sandboxes/${id}/previews`).length).toBe(1);
    expect(JSON.parse(api.seen.find((s) => s.route.endsWith("/previews") && s.route.startsWith("POST"))!.body.toString())).toEqual({ metadata: { name: "p8080" }, spec: { port: 8080, public: true } });
    await blaxelProvider.setTimeout!(id, 7200, ctx);
    const record = api.boxes.get(id)!.record as { spec: { runtime: Record<string, unknown> }; metadata: { name: string } };
    expect(record.spec.runtime).toMatchObject({ ttl: "120m", image: "blaxel/base-image:latest", generation: "mk3" });
    expect(record.metadata.name).toBe(id);
    await blaxelProvider.kill(id, ctx);
    expect(api.boxes.get(id)!.deleted).toBe(true);
    expect(await kindOf(blaxelProvider.kill(id, ctx))).toBe("not_found");
  });

  it("waits out a create the edge cut off with 504, and retries a passing credential failure", async () => {
    const api = await blaxelMock({
      createFailures: [
        { status: 403, json: { code: "UNAUTHORIZED", message: "Authorization failed" } },
        { status: 504, json: {} },
      ],
    });
    const ctx: ProviderContext = { env: blEnv(api.url), options: { pollMs: 1 } };
    const { providerSandboxId: id } = await blaxelProvider.create({ ...spec, metadata: { "sandboxrouting.id": "sbr_504" } }, ctx);
    expect(api.seen.filter((s) => s.route === "POST /v0/sandboxes").length).toBe(2);
    expect(api.seen.filter((s) => s.route === `GET /v0/sandboxes/${id}`).length).toBe(2);
    expect((await blaxelProvider.exec(id, "echo ok", {}, ctx)).stdout).toBe("ok\n");
  });

  it("classifies refusals", async () => {
    const ctx = (url: string, key = "bl_k"): ProviderContext => ({ env: { ...blEnv(url), BL_API_KEY: key }, options: { pollMs: 1 } });
    const bad = await blaxelMock();
    expect(await kindOf(blaxelProvider.create(spec, ctx(bad.url, "wrong")))).toBe("auth");
    const auth = await blaxelMock({ createFailures: [0, 1, 2].map(() => ({ status: 403, json: { code: "UNAUTHORIZED", message: "Authorization failed" } })) });
    expect(await kindOf(blaxelProvider.create(spec, ctx(auth.url)))).toBe("auth");
    expect(auth.seen.length).toBe(3);
    const quota = await blaxelMock({ createFailures: [{ status: 402, json: { error: "payment required" } }] });
    expect(await kindOf(blaxelProvider.create(spec, ctx(quota.url)))).toBe("quota");
    const rate = await blaxelMock({ createFailures: [{ status: 429, json: { error: "too many sandboxes" } }] });
    expect(await kindOf(blaxelProvider.create(spec, ctx(rate.url)))).toBe("rate_limit");
    expect(await kindOf(blaxelProvider.exec("sbr-nope", "true", {}, ctx(rate.url)))).toBe("not_found");
  });
});

// ---------------------------------------------------------------- Together

interface TgBox {
  status: string;
  body: Record<string, unknown>;
}

async function togetherMock(opts: { startAs?: string; buildError?: string; rateLimit?: number; dropStreamAfter?: number; agentUrl?: string } = {}) {
  const boxes = new Map<string, TgBox>();
  const files = new Map<string, Buffer>();
  const execs = new Map<string, { type: "stdout" | "stderr"; output: string; exitCode?: number }[]>();
  const seen: { route: string; headers: Req["headers"]; body: Buffer; query: URLSearchParams }[] = [];
  let logsCalls = 0;
  let rateLimit = opts.rateLimit ?? 0;
  let drop = opts.dropStreamAfter;
  let n = 0;
  let url = "";
  const dto = (id: string) => {
    const b = boxes.get(id)!;
    const running = b.status === "running";
    return { id, status: b.status, status_reason: b.status === "failed_to_start" ? "out_of_capacity" : null, agent: { version: "1", url: running ? (opts.agentUrl ?? `${url}/agent/${id}`) : null, token: running ? `tok-${id}` : null } };
  };
  const sseBody = (events: { id: string; data: unknown }[]) => events.map((e) => `id: ${e.id}\ndata: ${JSON.stringify(e.data)}\n\n`).join("");
  const server = await mock((r) => {
    seen.push({ route: `${r.method} ${r.path}`, headers: r.headers, body: r.body, query: r.query });
    const ag = /^\/agent\/([^/]+)(\/.*)$/.exec(r.path);
    if (ag) {
      if (r.headers.authorization !== `Bearer tok-${ag[1]}`) return { status: 401, json: { code: 401, message: "bad token" } };
      const rest = ag[2]!;
      if (r.method === "POST" && rest === "/api/v1/execs") {
        const b = r.json();
        const run = spawnSync(b.command, b.args, { cwd: b.cwd, env: { ...process.env, ...b.env }, encoding: "utf8" });
        const id = `e${++n}`;
        execs.set(id, [
          { type: "stdout", output: run.stdout },
          { type: "stderr", output: run.stderr },
          { type: "stdout", output: "", exitCode: run.status ?? 1 },
        ]);
        return { status: 201, json: { id, command: b.command, args: b.args, status: "running", pid: 1, pty: false, exitCode: 0 } };
      }
      const st = /^\/api\/v1\/stream\/execs\/([^/]+)\/io$/.exec(rest);
      if (st) {
        const all = execs.get(st[1]!)!.map((data, i) => ({ id: String(i + 1), data: { ...data, sequence: i + 1 } }));
        const from = Number(r.headers["last-event-id"] ?? 0);
        let evs = all.slice(from);
        if (drop !== undefined) {
          evs = evs.slice(0, drop);
          drop = undefined;
        }
        return { raw: sseBody(evs), type: "text/event-stream" };
      }
      const f = /^\/api\/v1\/(files|directories)\/(.+)$/.exec(rest);
      if (f) {
        const path = decodeURIComponent(f[2]!);
        if (f[1] === "files" && r.method === "POST") return files.set(path, r.body), { status: 201, json: { path, content: r.body.toString(), encoding: "utf-8" } };
        if (f[1] === "files") {
          const data = files.get(path);
          if (!data) return { status: 404, json: { code: 404, message: "no such file" } };
          const text = new TextDecoder("utf-8", { fatal: false }).decode(data);
          const binary = Buffer.compare(Buffer.from(text), data) !== 0;
          return { json: { path, content: binary ? data.toString("base64") : text, encoding: binary ? "base64" : "utf-8" } };
        }
        const kids = [...files.keys()].filter((k) => k.startsWith(`${path}/`));
        return { json: { path, files: kids.map((k) => ({ name: k.slice(path.length + 1), path: k, isDir: false, size: files.get(k)!.length, modTime: "" })) } };
      }
      return undefined;
    }
    if (r.path.startsWith("/builds")) {
      if (r.headers.authorization !== "Bearer tg_k") return { status: 401, json: { error: "bad key" } };
      if (r.method === "POST" && r.path === "/builds") return { json: { build_id: "b1" } };
      if (r.path === "/builds/b1/logs") {
        logsCalls++;
        // The build pod isn't up yet, then a stream that closes early, then the end.
        if (logsCalls === 1) return { status: 404, json: { error: "no pod" } };
        if (logsCalls === 2) return { raw: "data: step 1/1 FROM\n\n", type: "text/event-stream" };
        return { raw: `data: pushing\n\ndata: ${JSON.stringify(opts.buildError ? { error: opts.buildError } : { done: true })}\n\n`, type: "text/event-stream" };
      }
      if (r.path === "/builds/b1") return { json: { image_ref: "registry.example/ns/image-x:tag" } };
      return undefined;
    }
    if (r.headers.authorization !== "Bearer tg_k") return { status: 401, json: { code: "unauthorized", message: "Invalid API key", errors: [] } };
    if (r.method === "POST" && r.path === "/v1/snapshots") return { status: 201, json: { id: "snap-1" } };
    if (r.method === "POST" && r.path === "/v1/snapshots/snap-1/aliases") return { status: 201, json: {} };
    if (r.method === "POST" && r.path === "/v1/sandboxes") {
      if (rateLimit > 0) return rateLimit--, { status: 429, json: { code: "rate_limited", message: "Too many requests", errors: [] } };
      const id = `tg-${++n}`;
      boxes.set(id, { status: "starting", body: r.json() });
      return { status: 201, json: dto(id) };
    }
    if (r.method === "GET" && r.path === "/v1/sandboxes") {
      const all = [...boxes.keys()];
      const page = r.query.get("cursor") ? all.slice(1) : all.slice(0, 1);
      return { json: { data: page.map(dto), next_cursor: r.query.get("cursor") || all.length < 2 ? null : "c2" } };
    }
    const m = /^\/v1\/sandboxes\/([^/]+)(\/terminate|\/wait)?$/.exec(r.path);
    const box = m && boxes.get(m[1]!);
    if (!m || !box) return { status: 404, json: { code: "not_found", message: "Sandbox not found", errors: [] } };
    if (m[2] === "/terminate") return (box.status = "terminating"), { json: dto(m[1]!) };
    if (m[2] === "/wait") {
      box.status = box.status === "terminating" ? "terminated" : (opts.startAs ?? "running");
      return { json: dto(m[1]!) };
    }
    return { json: dto(m[1]!) };
  });
  url = server.url;
  return { ...server, boxes, files, seen };
}

const tgEnv = (url: string) => ({ TOGETHER_API_KEY: "tg_k", TOGETHER_BASE_URL: url });

describe("together over HTTP", () => {
  it("builds a snapshot from the image through the image builder, then creates, runs and terminates", async () => {
    const api = await togetherMock();
    const { router } = routerFor(togetherProvider, tgEnv(api.url));
    await lifecycle(router);
    const routes = api.seen.map((s) => s.route);
    expect(routes.slice(0, 8)).toEqual([
      "POST /builds",
      "GET /builds/b1/logs",
      "GET /builds/b1/logs",
      "GET /builds/b1/logs",
      "GET /builds/b1",
      "POST /v1/snapshots",
      "POST /v1/snapshots/snap-1/aliases",
      "POST /v1/sandboxes",
    ]);
    // The build context is a gzipped tar holding one Dockerfile: FROM <image>.
    const form = formParts(api.seen[0]!);
    expect(form.get("image_name")!.body.toString()).toMatch(/^image-[0-9a-f-]{36}:[0-9a-f-]{36}$/);
    expect(form.get("dockerfile")!.body.toString()).toBe("Dockerfile");
    expect(form.get("build_args")!.body.toString()).toBe("{}");
    expect(form.get("nydus_convert")!.body.toString()).toBe("true");
    expect(form.get("context")!.filename).toBe("context.tar.gz");
    const tar = gunzipSync(form.get("context")!.body);
    expect(tar.subarray(0, 10).toString()).toBe("Dockerfile");
    expect(tar.toString()).toContain("FROM python:3.12-slim\n");
    expect(JSON.parse(api.seen[5]!.body.toString())).toEqual({ image: "registry.example/ns/image-x:tag", architecture: "amd64" });
    expect(JSON.parse(api.seen[6]!.body.toString())).toEqual({ alias: expect.stringMatching(/^sbr-[0-9a-f]{12}$/) });
    expect(JSON.parse(api.seen[7]!.body.toString())).toMatchObject({ snapshot_id: "snap-1", cpu: expect.any(Number), memory_bytes: expect.any(Number), ttl: 120, tags: expect.any(Object) });
    // Created as starting: the SDK waits until it runs before handing it back.
    expect(routes[8]).toBe("POST /v1/sandboxes/tg-1/wait");
    expect(routes).toContain("POST /v1/sandboxes/tg-1/terminate");
  });

  it("boots from a snapshot alias, runs sh -c with cwd, env and quoting intact, and merges output", async () => {
    const api = await togetherMock();
    const ctx: ProviderContext = { env: tgEnv(api.url), options: { pollMs: 1 } };
    const { providerSandboxId: id } = await togetherProvider.create({ ...spec, memoryMiB: 512, nativeTemplate: "my-snap" }, ctx);
    expect(JSON.parse(api.seen[0]!.body.toString())).toEqual({ snapshot_alias: "my-snap", cpu: 2, memory_bytes: 1024 * 1024 * 1024, ttl: 120, tags: { "sandboxrouting.id": "sbr_1" } });
    const tmp = tmpdir();
    const chunks: string[] = [];
    const r = await togetherProvider.exec(id, `echo "it's $X" && pwd && echo oops >&2 && exit 3`, { cwd: tmp, env: { X: "a b" }, onStdout: (c) => chunks.push(c) }, ctx);
    expect(r.stdout.split("\n")[0]).toBe("it's a b");
    expect(r.stdout).toContain(tmp.split("/").pop()!);
    expect(r.stdout).toContain("oops");
    expect(r).toMatchObject({ stderr: "", exitCode: 3 });
    expect(chunks.join("")).toBe(r.stdout);
    const exec = api.seen.find((s) => s.route === `POST /agent/${id}/api/v1/execs`)!;
    expect(exec.headers.authorization).toBe(`Bearer tok-${id}`);
    expect(JSON.parse(exec.body.toString())).toEqual({ cwd: tmp, env: { X: "a b" }, command: "sh", args: ["-c", expect.any(String)], autostart: true });
  });

  it("resumes a stream that drops mid-way from the last event id, and fails one that ends without an exit code", async () => {
    // An agent whose first stream breaks off after one event.
    const lastIds: (string | undefined)[] = [];
    const ev = (id: number, data: object) => `id: ${id}\ndata: ${JSON.stringify(data)}\n\n`;
    const agent = createServer((req, res) => {
      if (req.method === "POST") return void res.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify({ id: "e1" }));
      lastIds.push(req.headers["last-event-id"] as string | undefined);
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (lastIds.length === 1) return void res.write(ev(1, { type: "stdout", output: "a\n", sequence: 1 }), () => setTimeout(() => res.socket!.destroy(), 20));
      res.end(ev(2, { type: "stderr", output: "b\n", sequence: 2 }) + ev(3, { type: "stdout", output: "", sequence: 3, exitCode: 0 }));
    });
    agent.listen(0, "127.0.0.1");
    await new Promise((ok) => agent.once("listening", ok));
    try {
      const api = await togetherMock({ agentUrl: `http://127.0.0.1:${(agent.address() as AddressInfo).port}` });
      const ctx: ProviderContext = { env: tgEnv(api.url), options: { pollMs: 1 } };
      const { providerSandboxId: id } = await togetherProvider.create({ ...spec, nativeTemplate: "s" }, ctx);
      expect(await togetherProvider.exec(id, "echo a; echo b >&2", {}, ctx)).toEqual({ stdout: "a\nb\n", stderr: "", exitCode: 0 });
      expect(lastIds).toEqual([undefined, "1"]);
    } finally {
      agent.close();
    }
    const api = await togetherMock({ dropStreamAfter: 1 });
    const ctx: ProviderContext = { env: tgEnv(api.url), options: { pollMs: 1 } };
    const { providerSandboxId: id } = await togetherProvider.create({ ...spec, nativeTemplate: "s" }, ctx);
    await expect(togetherProvider.exec(id, "echo a", {}, ctx)).rejects.toThrow(/stream ended without an exit code/);
  });

  it("reads text and base64 files, writes text, refuses binary writes, lists, and reconnects from another process", async () => {
    const api = await togetherMock();
    const ctx: ProviderContext = { env: tgEnv(api.url), options: { pollMs: 1 } };
    const { providerSandboxId: id } = await togetherProvider.create({ ...spec, nativeTemplate: "s" }, ctx);
    await togetherProvider.writeFile!(id, "/w/a.txt", new TextEncoder().encode("héllo"), ctx);
    const post = api.seen.find((s) => s.route.startsWith(`POST /agent/${id}/api/v1/files/`))!;
    expect(post.route).toBe(`POST /agent/${id}/api/v1/files/%2Fw%2Fa.txt`);
    expect(post.headers["content-type"]).toBe("application/octet-stream");
    expect(new TextDecoder().decode(await togetherProvider.readFile!(id, "/w/a.txt", ctx))).toBe("héllo");
    expect(await kindOf(togetherProvider.writeFile!(id, "/w/b.bin", new Uint8Array([0, 255]), ctx))).toBe("unsupported");
    api.files.set("/w/b.bin", Buffer.from([0, 1, 255]));
    expect([...(await togetherProvider.readFile!(id, "/w/b.bin", ctx))]).toEqual([0, 1, 255]);
    expect(await togetherProvider.listFiles!(id, "/w", ctx)).toEqual([
      { name: "a.txt", path: "/w/a.txt", isDir: false, size: 6 },
      { name: "b.bin", path: "/w/b.bin", isDir: false, size: 3 },
    ]);
    // A sandbox this process didn't create: looked up once, then reached through its agent.
    api.boxes.set("tg-ext", { status: "running", body: {} });
    expect((await togetherProvider.exec("tg-ext", "echo ext", {}, ctx)).stdout).toBe("ext\n");
    expect((await togetherProvider.exec("tg-ext", "echo again", {}, ctx)).stdout).toBe("again\n");
    expect(api.seen.filter((s) => s.route === "GET /v1/sandboxes/tg-ext").length).toBe(1);
  });

  it("lists every page and terminates, waiting until terminated", async () => {
    const api = await togetherMock();
    const ctx: ProviderContext = { env: tgEnv(api.url), options: { pollMs: 1 } };
    const a = await togetherProvider.create({ ...spec, nativeTemplate: "s" }, ctx);
    const b = await togetherProvider.create({ ...spec, nativeTemplate: "s" }, ctx);
    expect(await togetherProvider.listAlive!(ctx)).toEqual([a.providerSandboxId, b.providerSandboxId]);
    expect(api.seen.filter((s) => s.route === "GET /v1/sandboxes").map((s) => s.query.toString())).toEqual(["limit=100", "limit=100&cursor=c2"]);
    await togetherProvider.kill(a.providerSandboxId, ctx);
    expect(api.boxes.get(a.providerSandboxId)!.status).toBe("terminated");
    expect(JSON.parse(api.seen.find((s) => s.route.endsWith("/terminate"))!.body.toString())).toEqual({});
    // After kill the agent is forgotten: a later call asks the API, which says it isn't running.
    await expect(togetherProvider.exec(a.providerSandboxId, "true", {}, ctx)).rejects.toThrow(/terminated.*expected 'running'/);
  });

  it("fails a sandbox that doesn't start, and a build that fails", async () => {
    const api = await togetherMock({ startAs: "failed_to_start" });
    const ctx: ProviderContext = { env: tgEnv(api.url), options: { pollMs: 1 } };
    await expect(togetherProvider.create({ ...spec, nativeTemplate: "s" }, ctx)).rejects.toThrow(/failed_to_start \(status_reason: 'out_of_capacity'\)/);
    const bad = await togetherMock({ buildError: "manifest unknown" });
    const bctx: ProviderContext = { env: tgEnv(bad.url), options: { pollMs: 1 } };
    await expect(togetherProvider.create({ ...spec, image: "nope:latest" }, bctx)).rejects.toThrow(/Build b1 failed: manifest unknown/);
    // A failed build isn't kept: the next create builds again.
    await expect(togetherProvider.create({ ...spec, image: "nope:latest" }, bctx)).rejects.toThrow(/Build b1 failed/);
    expect(bad.seen.filter((s) => s.route === "POST /builds").length).toBe(2);
  });

  it("retries a rate limit as the SDK does, and classifies refusals", async () => {
    const busy = await togetherMock({ rateLimit: 2 });
    const ctx = (url: string, key = "tg_k"): ProviderContext => ({ env: { ...tgEnv(url), TOGETHER_API_KEY: key }, options: { pollMs: 1 } });
    await togetherProvider.create({ ...spec, nativeTemplate: "s" }, ctx(busy.url));
    expect(busy.seen.filter((s) => s.route === "POST /v1/sandboxes").length).toBe(3);
    const limited = await togetherMock({ rateLimit: 3 });
    expect(await kindOf(togetherProvider.create({ ...spec, nativeTemplate: "s" }, ctx(limited.url)))).toBe("rate_limit");
    expect(await kindOf(togetherProvider.create({ ...spec, nativeTemplate: "s" }, ctx(limited.url, "wrong")))).toBe("auth");
    expect(await kindOf(togetherProvider.exec("tg-nope", "true", {}, ctx(limited.url)))).toBe("not_found");
    expect(await kindOf(togetherProvider.listAlive!(ctx(limited.url, "wrong")))).toBe("auth");
  });
});
