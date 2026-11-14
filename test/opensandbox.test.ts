// The OpenSandbox adapter, driven through the router against a local server that speaks its
// lifecycle API and, under /execd/<id>, the execd API inside each sandbox: written from
// specs/sandbox-lifecycle.yml, specs/execd-api.yaml and the requests its JS SDK sends.
// It has not been run against a real OpenSandbox server.
import { describe, expect, it } from "vitest";
import { fakeRun, lifecycle, mock, routerFor, type Req, type Reply } from "./restmock.js";
import { EXECD_PORT, opensandboxBase, opensandboxProvider } from "../src/providers/opensandbox.js";

const KEY = "osb-key";
const TOKEN = "execd-token";

/** One multipart upload: the `metadata` part's JSON and the `file` part's bytes. */
function upload(r: Req): { path: string; data: Buffer } {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(String(r.headers["content-type"]))!;
  const sep = Buffer.from(`--${boundary[1] ?? boundary[2]}`);
  const parts: Buffer[] = [];
  for (let at = r.body.indexOf(sep); at >= 0; ) {
    const next = r.body.indexOf(sep, at + sep.length);
    if (next < 0) break;
    parts.push(r.body.subarray(at + sep.length + 2, next - 2));
    at = next;
  }
  const byName = (name: string) => {
    const p = parts.find((x) => x.toString("latin1").includes(`name="${name}"`))!;
    return p.subarray(p.indexOf("\r\n\r\n") + 4);
  };
  return { path: JSON.parse(byName("metadata").toString()).path, data: byName("file") };
}

/** Frames as SSE (`data: …`) or as one JSON object per line. */
const stream = (events: unknown[], ndjson = false): Reply => ({
  type: ndjson ? "application/x-ndjson" : "text/event-stream",
  raw: events.map((e) => (ndjson ? `${JSON.stringify(e)}\n` : `data: ${JSON.stringify(e)}\n\n`)).join(""),
});

/** What execd streams for a command: output, then completion or an error with the exit code. */
function run(cmd: string, ndjson = false): Reply {
  const x = fakeRun(cmd);
  const out = [{ type: "init", text: "cmd-1" }, ...(x.stdout ? [{ type: "stdout", text: x.stdout }] : []), ...(x.stderr ? [{ type: "stderr", text: x.stderr }] : [])];
  const end = x.code === 0 ? { type: "execution_complete", execution_time: 3 } : { type: "error", error: { ename: "CommandExecError", evalue: String(x.code), exit_code: x.code } };
  return stream([...out, end], ndjson);
}

describe("opensandbox", () => {
  it("creates from an image, then runs commands and moves files through execd with its token", async () => {
    const files = new Map<string, Buffer>();
    let host = "";
    const { url, seen } = await mock((r) => {
      if (r.path.startsWith("/execd/")) {
        if (r.headers["x-execd-access-token"] !== TOKEN) return { status: 401, json: {} };
        const at = r.path.replace(/^\/execd\/[^/]+/, "");
        if (at === "/ping") return { json: {} };
        if (r.method === "POST" && at === "/command") {
          const b = r.json();
          expect(b.envs).toBeUndefined();
          return run(b.command);
        }
        if (r.method === "POST" && at === "/files/upload") {
          const u = upload(r);
          return files.set(u.path, u.data), { json: {} };
        }
        if (at === "/files/download") return { raw: files.get(r.query.get("path")!) ?? "" };
        return undefined;
      }
      if (r.headers["open-sandbox-api-key"] !== KEY) return { status: 401, json: {} };
      if (r.method === "POST" && r.path === "/v1/sandboxes") {
        const b = r.json();
        expect(b).toMatchObject({ image: { uri: "python:3.12-slim" }, entrypoint: ["tail", "-f", "/dev/null"], resourceLimits: { cpu: "1", memory: "2048Mi" } });
        // The shared helpers ask for 120 s and 60 s; the server's minimum is 60 s.
        expect([120, 60]).toContain(b.timeout);
        expect(b.metadata["sandboxrouting.id"]).toBeTruthy();
        return { status: 202, json: { id: `os${seen.filter((s) => s === "POST /v1/sandboxes").length}`, status: { state: "Running" }, createdAt: "x", entrypoint: [] } };
      }
      const ep = /^\/v1\/sandboxes\/([^/]+)\/endpoints\/(\d+)$/.exec(r.path);
      if (ep) {
        expect(Number(ep[2])).toBe(EXECD_PORT);
        // No scheme, as the server sends it.
        return { json: { endpoint: `${host}/execd/${ep[1]}`, headers: { "X-EXECD-ACCESS-TOKEN": TOKEN } } };
      }
      if (r.method === "DELETE" && /^\/v1\/sandboxes\/[^/]+$/.test(r.path)) return { status: 204, raw: "" };
      return undefined;
    });
    host = url.replace("http://", "");
    const { router } = routerFor(opensandboxProvider, { OPEN_SANDBOX_DOMAIN: host, OPEN_SANDBOX_API_KEY: KEY });
    const sbx = await lifecycle(router, { files: true });
    expect(seen).toContain(`DELETE /v1/sandboxes/${sbx.providerSandboxId}`);
    // The endpoint is looked up once per sandbox, not once per call.
    expect(seen.filter((s) => s === `GET /v1/sandboxes/${sbx.providerSandboxId}/endpoints/${EXECD_PORT}`)).toHaveLength(1);
  });

  it("waits out Pending and an execd that is not up yet, and deletes a sandbox that fails to start", async () => {
    let polls = 0;
    let pings = 0;
    const { url, seen } = await mock((r) => {
      if (r.method === "POST" && r.path === "/v1/sandboxes") {
        const failing = r.json().image.uri === "broken";
        return { status: 202, json: { id: failing ? "bad" : "slow", status: { state: "Pending" } } };
      }
      if (r.path === "/v1/sandboxes/slow") return { json: { id: "slow", status: { state: ++polls < 3 ? "Pending" : "Running" } } };
      if (r.method === "GET" && r.path === "/v1/sandboxes/bad") return { json: { id: "bad", status: { state: "Failed", reason: "image_pull", message: "no such image" } } };
      if (r.path.endsWith(`/endpoints/${EXECD_PORT}`)) return { json: { endpoint: `${url}/execd` } };
      if (r.path === "/execd/ping") return ++pings < 3 ? { status: 503, json: {} } : { json: {} };
      if (r.method === "DELETE") return { status: 204, raw: "" };
      return undefined;
    });
    const ctx = { env: { OPEN_SANDBOX_DOMAIN: url }, options: { pollMs: 1 } };
    const spec = { cpu: 0.5, memoryMiB: 512, timeoutSec: 30, env: {}, metadata: {} };
    expect(await opensandboxProvider.create(spec, ctx)).toEqual({ providerSandboxId: "slow" });
    expect([polls, pings]).toEqual([3, 3]);
    // No API key set: none is sent.
    await expect(opensandboxProvider.create({ ...spec, image: "broken" }, ctx)).rejects.toThrow(/Failed: image_pull no such image/);
    expect(seen).toContain("DELETE /v1/sandboxes/bad");
    expect(seen).not.toContain("DELETE /v1/sandboxes/slow");
  });

  it("reads NDJSON output, reports a signal as 137, and throws on an error with no exit code", async () => {
    const { url } = await mock((r) => {
      if (r.path.endsWith(`/endpoints/${EXECD_PORT}`)) return { json: { endpoint: `${url}/execd` } };
      if (r.path !== "/execd/command") return undefined;
      const b = r.json();
      expect(b).toMatchObject({ cwd: "/work", envs: { A: "1" } });
      if (b.command === "sleep 99") {
        expect(b.timeout).toBe(2000);
        return stream([{ type: "error", error: { ename: "CommandExecError", evalue: "-1", exit_code: -1 } }], true);
      }
      if (b.command === "nope") return stream([{ type: "error", error: { ename: "StartError", evalue: "exec: not found" } }]);
      return run(b.command, true);
    });
    const ctx = { env: { OPEN_SANDBOX_DOMAIN: url }, options: {} };
    const opts = { cwd: "/work", env: { A: "1" } };
    const chunks: string[] = [];
    expect(await opensandboxProvider.exec("x1", "echo hi", { ...opts, onStdout: (c) => chunks.push(c) }, ctx)).toEqual({ stdout: "ran: echo hi\n", stderr: "", exitCode: 0 });
    expect(chunks).toEqual(["ran: echo hi\n"]);
    expect((await opensandboxProvider.exec("x1", "exit 3", opts, ctx)).exitCode).toBe(3);
    expect((await opensandboxProvider.exec("x1", "sleep 99", { ...opts, timeoutSec: 2 }, ctx)).exitCode).toBe(137);
    await expect(opensandboxProvider.exec("x1", "nope", opts, ctx)).rejects.toThrow(/StartError: exec: not found/);
  });

  it("lists live sandboxes across pages, renews to an absolute deadline, and pauses until Paused", async () => {
    let state = "Running";
    const { url, seen } = await mock((r) => {
      if (r.method === "GET" && r.path === "/v1/sandboxes") {
        expect(r.query.getAll("state")).toEqual(["Pending", "Running", "Pausing", "Paused", "Resuming"]);
        const page = Number(r.query.get("page"));
        const items = page === 1 ? [{ id: "a", status: { state: "Running" } }, { id: "z", status: { state: "Terminated" } }] : [{ id: "b", status: { state: "Paused" } }];
        return { json: { items, pagination: { page, pageSize: 100, totalItems: 3, totalPages: 2, hasNextPage: page === 1 } } };
      }
      if (r.path === "/v1/sandboxes/a/renew-expiration") {
        const at = Date.parse(r.json().expiresAt) - Date.now();
        expect(at).toBeGreaterThan(590_000);
        expect(at).toBeLessThanOrEqual(600_000);
        return { json: { expiresAt: r.json().expiresAt } };
      }
      if (r.path === "/v1/sandboxes/a/pause") return (state = "Pausing"), { status: 202, raw: "" };
      if (r.path === "/v1/sandboxes/a") {
        const now = state;
        if (state === "Pausing") state = "Paused";
        return { json: { id: "a", status: { state: now } } };
      }
      if (r.path === "/v1/sandboxes/a/endpoints/8080") return { json: { endpoint: "gw.example/sandboxes/a/port/8080" } };
      return undefined;
    });
    const ctx = { env: { OPEN_SANDBOX_DOMAIN: `${url}/v1/` }, options: { pollMs: 1 } };
    expect(await opensandboxProvider.listAlive(ctx)).toEqual(["a", "b"]);
    await opensandboxProvider.setTimeout("a", 600, ctx);
    await opensandboxProvider.pause("a", ctx);
    expect(seen.filter((s) => s === "GET /v1/sandboxes/a")).toHaveLength(2);
    expect(await opensandboxProvider.getUrl("a", 8080, ctx)).toBe("http://gw.example/sandboxes/a/port/8080/");
  });

  it("reads the domain the way its SDK does", () => {
    expect(opensandboxBase("localhost:8080")).toEqual({ origin: "http://localhost:8080", protocol: "http" });
    expect(opensandboxBase("https://osb.example.com/v1/")).toEqual({ origin: "https://osb.example.com", protocol: "https" });
  });
});
