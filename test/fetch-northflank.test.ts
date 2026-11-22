// Northflank without its SDK: the REST lifecycle, and commands over the command-exec WebSocket the
// JS client (@northflank/js-client 0.9.5) opens, served by a local mock that runs each command in a
// real shell. Not run against the real service.
import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mock, routerFor, type Reply, type Req, type WsConn } from "./restmock.js";
import { classify } from "../src/core/errors.js";
import { northflankProvider } from "../src/providers/northflank.js";

const TOKEN = "nf_token";

async function northflankMock(opts: { refuse?: boolean; dropBeforeResult?: boolean } = {}) {
  const live = new Set<string>();
  const inits: Record<string, unknown>[] = [];
  const bodies: { route: string; body: unknown }[] = [];
  let polls = 0;
  const exec = (r: Req, accept: (p?: string) => WsConn): Reply | undefined => {
    if (!live.has(r.path.split("/").at(-1)!)) return { status: 404, json: { error: { message: "service not found" } } };
    const ws = accept();
    ws.onMessage((data) => {
      const f = JSON.parse(data.toString());
      if (f.type !== "init") return;
      inits.push(f);
      if (f.data.auth.apiToken !== TOKEN) return void ws.send(JSON.stringify({ type: "init", data: { auth: "failed", message: "Invalid token" } }));
      ws.send(JSON.stringify({ type: "init", data: { auth: "successful" } }));
      const [cmd, ...args] = f.data.context.command as string[];
      const run = spawnSync(cmd!, args, { encoding: "utf8" });
      if (run.stdout) ws.send(JSON.stringify({ type: "stdOut", data: run.stdout }));
      if (run.stderr) ws.send(JSON.stringify({ type: "stdErr", data: run.stderr }));
      if (opts.dropBeforeResult) return void ws.close(1011, "proxy restarted");
      ws.send(JSON.stringify({ type: "completion", data: { exitCode: run.status, status: "Success" } }));
      ws.close();
    });
    return undefined;
  };
  const server = await mock((r) => {
    if (r.headers.authorization !== `Bearer ${TOKEN}`) return { status: 401, json: { error: { status: 401, message: "Unauthorized" } } };
    bodies.push({ route: `${r.method} ${r.path}`, body: r.body.length ? r.json() : undefined });
    if (r.method === "POST" && r.path === "/v1/projects/p1/services/deployment") {
      if (opts.refuse) return { status: 429, json: { error: { message: "Too many requests" } } };
      const name = r.json().name;
      live.add(name);
      return { json: { data: { id: name, name } } };
    }
    if (r.method === "GET" && r.path === "/v1/projects/p1/services") return { json: { data: { services: [...live, "other"].map((id) => ({ id })) } } };
    const m = /^\/v1\/projects\/p1\/services\/([^/]+)$/.exec(r.path);
    if (m && !live.has(m[1]!)) return { status: 404, json: { error: { message: "service not found" } } };
    if (m && r.method === "GET") return { json: { data: { id: m[1], status: { deployment: { status: polls++ < 1 ? "IN_PROGRESS" : "COMPLETED" } } } } };
    if (m && r.method === "DELETE") return live.delete(m[1]!), { json: { data: {} } };
    return undefined;
  }, exec);
  return { ...server, live, inits, bodies };
}

const env = (url: string, token = TOKEN) => ({ NORTHFLANK_TOKEN: token, NORTHFLANK_PROJECT: "p1", NORTHFLANK_API_URL: url });

describe("northflank without its SDK", () => {
  it("loads no SDK", () => {
    expect(northflankProvider.info.sdkPackage).toBeUndefined();
    expect(readFileSync(new URL("../src/providers/northflank.ts", import.meta.url), "utf8")).not.toMatch(/loadSdk|import\(/);
  });

  it("creates a deployment service, waits for it, runs commands with quoting, cwd and env, and deletes it", async () => {
    const api = await northflankMock();
    const { router } = routerFor(northflankProvider, env(api.url));
    const sbx = await router.create({ timeoutSec: 120, cpu: 1, env: { A: "1" } });
    expect(sbx.providerSandboxId).toMatch(/^sbr-[0-9a-f]{12}$/);
    expect(api.bodies[0]!.body).toMatchObject({
      name: sbx.providerSandboxId,
      billing: { deploymentPlan: "nf-compute-100-2" },
      deployment: { instances: 1, external: { imagePath: "python:3.12-slim" }, docker: { customCommand: '-c "sleep 120"' } },
      runtimeEnvironment: { A: "1" },
    });
    const tmp = execFileSync("mktemp", ["-d"], { encoding: "utf8" }).trim();
    const out = await sbx.commands.run(`echo "it's $X" && pwd && echo oops >&2 && exit 3`, { cwd: tmp, env: { X: "a b" } });
    expect(out.stdout.split("\n")[0]).toBe("it's a b");
    expect(out.stdout).toContain(tmp.split("/").pop()!);
    expect(out.stderr.trim()).toBe("oops");
    expect(out.exitCode).toBe(3);
    // The token travels in the init frame, with the argv and shell "none", as the JS client sends it.
    expect(api.inits[0]).toMatchObject({ type: "init", data: { auth: { type: "apiToken", apiToken: TOKEN }, context: { shell: "none", command: ["sh", "-c", expect.any(String)] } } });
    expect(api.seen).toContain(`WS /v1/command-exec/projects/p1/services/${sbx.providerSandboxId}`);
    expect(await northflankProvider.listAlive!({ env: env(api.url), options: {} })).toEqual([sbx.providerSandboxId]);
    await sbx.kill();
    expect(api.live.size).toBe(0);
  });

  it("fails a command whose socket closes before the result, and one the exec proxy refuses", async () => {
    const api = await northflankMock({ dropBeforeResult: true });
    const ctx = { env: env(api.url), options: { pollMs: 1 } };
    const { providerSandboxId: id } = await northflankProvider.create({ cpu: 0.5, memoryMiB: 1024, timeoutSec: 60, env: {}, metadata: {} }, ctx);
    await expect(northflankProvider.exec(id, "echo hi", {}, ctx)).rejects.toThrow(/WebSocket closed unexpectedly: 1011 proxy restarted/);
    await expect(northflankProvider.exec(id, "echo hi", {}, { ...ctx, env: env(api.url, "stale") })).rejects.toThrow(/Command initialization failed: Invalid token/);
    const gone = await northflankProvider.exec("sbr-missing", "true", {}, ctx).catch((e: unknown) => e);
    expect(classify(gone).kind).toBe("not_found");
  });

  it("keeps the refusals the router reads", async () => {
    const api = await northflankMock({ refuse: true });
    const kind = (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => classify(e).kind);
    const spec = { cpu: 0.5, memoryMiB: 1024, timeoutSec: 60, env: {}, metadata: {} };
    expect(await kind(northflankProvider.create(spec, { env: env(api.url), options: {} }))).toBe("rate_limit");
    expect(await kind(northflankProvider.create(spec, { env: env(api.url, "bad"), options: {} }))).toBe("auth");
    expect(await kind(northflankProvider.kill("sbr-nope", { env: env(api.url), options: {} }))).toBe("not_found");
  });
});
