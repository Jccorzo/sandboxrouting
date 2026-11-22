// Celesto over HTTP: the calls @celestoai/sdk 0.1.6 makes to https://api.celesto.ai/v1/computers,
// against a local server that runs each command in a real shell, so quoting, cwd and env are
// exercised for real. Not run against the real service.
import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mock, routerFor } from "./restmock.js";
import { classify } from "../src/core/errors.js";
import { celestoProvider } from "../src/providers/celesto.js";

async function celestoMock() {
  const computers = new Map<string, { status: string; ports: number[] }>();
  const bodies: { route: string; body: unknown }[] = [];
  let n = 0;
  const server = await mock((r) => {
    if (r.headers.authorization !== "Bearer cel_k") return { status: 401, json: { detail: "Invalid API key" } };
    const body = r.body.length ? r.json() : undefined;
    bodies.push({ route: `${r.method} ${r.path}`, body });
    const dto = (id: string) => ({ id, name: id, status: computers.get(id)!.status, vcpus: body?.vcpus ?? 1, ram_mb: body?.ram_mb ?? 2048 });
    if (r.method === "POST" && r.path === "/v1/computers") {
      const id = `cmp_${++n}`;
      computers.set(id, { status: "running", ports: [] });
      return { status: 201, json: dto(id) };
    }
    if (r.method === "GET" && r.path === "/v1/computers") return { json: { computers: [...computers.keys()].map(dto), count: computers.size } };
    const m = /^\/v1\/computers\/([^/]+)(\/[a-z-]+)?$/.exec(r.path);
    const c = m && computers.get(m[1]!);
    if (!m || !c) return { status: 404, json: { detail: "Computer not found" } };
    if (r.method === "DELETE") return (c.status = "deleted"), { json: dto(m[1]!) };
    if (m[2] === "/exec") {
      const run = spawnSync("sh", ["-c", body.command], { encoding: "utf8" });
      return { json: { exit_code: run.status, stdout: run.stdout, stderr: run.stderr, command_id: "c1" } };
    }
    if (m[2] === "/stop") return (c.status = "stopped"), { json: dto(m[1]!) };
    if (m[2] === "/start") return (c.status = "running"), { json: dto(m[1]!) };
    if (m[2] === "/published-ports") return { status: 201, json: { computer_id: m[1], port: body.port, url: `https://${body.port}-${m[1]}.celesto.run`, status: "active" } };
    return undefined;
  });
  return { ...server, computers, bodies };
}

const env = (url: string) => ({ CELESTO_API_KEY: "cel_k", CELESTO_BASE_URL: url });

describe("celesto over HTTP", () => {
  it("loads no SDK", () => {
    expect(celestoProvider.info.sdkPackage).toBeUndefined();
    expect(readFileSync(new URL("../src/providers/celesto.ts", import.meta.url), "utf8")).not.toMatch(/loadSdk|import\(/);
  });

  it("creates, runs with create-time env, cwd and quoting intact, then deletes", async () => {
    const api = await celestoMock();
    const { router } = routerFor(celestoProvider, env(api.url));
    const sbx = await router.create({ timeoutSec: 60, cpu: 2, memoryMiB: 4096, env: { FROM_CREATE: "yes" } });
    expect(api.bodies[0]).toEqual({ route: "POST /v1/computers", body: { vcpus: 2, ram_mb: 4096 } });
    const tmp = execFileSync("mktemp", ["-d"], { encoding: "utf8" }).trim();
    const out = await sbx.commands.run(`echo "it's $X $FROM_CREATE" && pwd && echo oops >&2 && exit 3`, { cwd: tmp, env: { X: "a b" } });
    expect(out.stdout.split("\n")[0]).toBe("it's a b yes");
    expect(out.stdout).toContain(tmp.split("/").pop()!);
    expect(out.stderr.trim()).toBe("oops");
    expect(out.exitCode).toBe(3);
    // No timeout asked for: the SDK's default, 30 s.
    expect(api.bodies.find((b) => b.route.endsWith("/exec"))!.body).toMatchObject({ timeout: 30 });
    await sbx.kill();
    expect(api.computers.get(sbx.providerSandboxId)!.status).toBe("deleted");
  });

  it("publishes ports, stops and starts, and lists what is alive", async () => {
    const api = await celestoMock();
    const ctx = { env: env(api.url), options: {} };
    const a = await celestoProvider.create({ cpu: 1, memoryMiB: 2048, timeoutSec: 60, env: {}, metadata: {} }, ctx);
    const b = await celestoProvider.create({ cpu: 1, memoryMiB: 2048, timeoutSec: 60, env: {}, metadata: {} }, ctx);
    expect(await celestoProvider.getUrl!(a.providerSandboxId, 8080, ctx)).toBe(`https://8080-${a.providerSandboxId}.celesto.run`);
    await celestoProvider.pause!(a.providerSandboxId, ctx);
    expect(api.computers.get(a.providerSandboxId)!.status).toBe("stopped");
    await celestoProvider.resume!(a.providerSandboxId, ctx);
    expect(api.computers.get(a.providerSandboxId)!.status).toBe("running");
    await celestoProvider.kill(b.providerSandboxId, ctx);
    expect(await celestoProvider.listAlive!(ctx)).toEqual([a.providerSandboxId]);
    await celestoProvider.exec(a.providerSandboxId, "true", { timeoutSec: 5 }, ctx);
    expect(api.bodies.filter((x) => x.route.endsWith("/exec")).at(-1)!.body).toMatchObject({ timeout: 5 });
  });

  it("keeps the refusals the router reads", async () => {
    const api = await celestoMock();
    const kind = (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => classify(e).kind);
    expect(await kind(celestoProvider.create({ cpu: 1, memoryMiB: 2048, timeoutSec: 60, env: {}, metadata: {} }, { env: { ...env(api.url), CELESTO_API_KEY: "x" }, options: {} }))).toBe("auth");
    expect(await kind(celestoProvider.kill("missing", { env: env(api.url), options: {} }))).toBe("not_found");
    const broke = await mock(() => ({ status: 402, json: { detail: "Insufficient credits" } }));
    expect(await kind(celestoProvider.create({ cpu: 1, memoryMiB: 2048, timeoutSec: 60, env: {}, metadata: {} }, { env: env(broke.url), options: {} }))).toBe("quota");
  });
});
