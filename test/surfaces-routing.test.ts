// Strategies, compared plans and moving a sandbox, through the REST API, the MCP server and
// the CLI. Two free providers that free-first and cheapest order differently show that a
// request's `strategy` reaches the router; two local-shell providers show a move carrying files.

import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, createMcpServer, type RoutingStrategy, type SandboxRouter } from "../src/index.js";
import { fakeProvider, router } from "./fake.js";
import { localShellProvider, type LocalShell } from "./localshell.js";

// free-first: the monthly tier first (use it or lose it). cheapest: every free tier by price, so the cheap one-time credit.
const monthly = () => fakeProvider({ id: "monthly", tier: { kind: "monthly-credit", usd: 30 }, rate: 0.001 });
const credit = () => fakeProvider({ id: "credit", tier: { kind: "one-time-credit", usd: 100 }, rate: 0.00001 });

const byName: RoutingStrategy = {
  name: "by-name",
  description: "Alphabetical, for tests.",
  rank: (candidates) => ({
    ordered: [...candidates]
      .sort((a, b) => a.provider.localeCompare(b.provider))
      .map((c) => ({ provider: c.provider, lane: "free-one-time", billing: "free", free: c.free, ratePerSecondUsd: c.ratePerSecondUsd, score: 0 })),
  }),
};

async function serve(r: SandboxRouter) {
  const server = createServer(r).listen(0, "127.0.0.1");
  await new Promise((ok) => server.once("listening", ok));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { base, post, close: () => server.close() };
}

async function mcp(r: SandboxRouter) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createMcpServer(r).connect(a);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(b);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const body = (res.content as { text: string }[])[0]!.text;
    return { isError: Boolean(res.isError), body, json: () => JSON.parse(body) };
  };
  return { client, call };
}

const shells: LocalShell[] = [];
afterAll(() => Promise.all(shells.map((s) => s.cleanup())));

describe("REST API: strategies, compare, move", () => {
  it("lists strategies with the configured one active, including registered ones", async () => {
    const { router: r } = router([monthly(), credit()], { routing: { strategy: "cheapest" } });
    r.registerStrategy(byName);
    const api = await serve(r);
    try {
      const list = (await (await fetch(`${api.base}/strategies`)).json()) as { name: string; description: string; active: boolean }[];
      expect(list.map((s) => s.name)).toEqual(["free-first", "cheapest", "balanced", "fastest", "spread", "by-name"]);
      expect(list.filter((s) => s.active).map((s) => s.name)).toEqual(["cheapest"]);
      expect(list.every((s) => s.description.length > 0)).toBe(true);
    } finally {
      api.close();
    }
  });

  it("routes with the request's strategy, compares every strategy, and refuses an unknown one", async () => {
    const { router: r } = router([monthly(), credit()]);
    const api = await serve(r);
    try {
      const plain = await (await api.post("/route", {})).json();
      expect(plain.strategy).toBe("free-first");
      expect(plain.ordered.map((e: { provider: string }) => e.provider)).toEqual(["monthly", "credit"]);
      expect(plain.ordered[0].why.length).toBeGreaterThan(0);

      const cheapest = await (await api.post("/route", { strategy: "cheapest" })).json();
      expect(cheapest.strategy).toBe("cheapest");
      expect(cheapest.ordered.map((e: { provider: string }) => e.provider)).toEqual(["credit", "monthly"]);

      const compared = await (await api.post("/route?compare=1", { timeoutSec: 60 })).json();
      expect(Object.keys(compared)).toEqual(["free-first", "cheapest", "balanced", "fastest", "spread"]);
      for (const [name, p] of Object.entries(compared)) expect((p as { strategy: string }).strategy).toBe(name);
      expect(compared["free-first"].ordered[0].provider).toBe("monthly");
      expect(compared.cheapest.ordered[0].provider).toBe("credit");

      const unknown = await api.post("/route", { strategy: "nope" });
      expect(unknown.status).toBe(400);
      expect((await unknown.json()).error).toMatch(/unknown routing strategy "nope"/);
    } finally {
      api.close();
    }
  });

  it("moves a sandbox to another provider with its workdir, and kills the old one", async () => {
    const a = localShellProvider({ id: "ls-a" });
    const b = localShellProvider({ id: "ls-b" });
    shells.push(a, b);
    const { router: r } = router([a, b]);
    const api = await serve(r);
    try {
      const old = await (await api.post("/sandboxes", { providers: ["ls-a"], timeoutSec: 120 })).json();
      expect(old.provider).toBe("ls-a");
      const put = await fetch(`${api.base}/sandboxes/${old.id}/files?path=work/notes.txt`, { method: "PUT", body: "carried over" });
      expect(put.status).toBe(200);

      const badWorkdir = await api.post(`/sandboxes/${old.id}/move`, { workdir: 7 });
      expect(badWorkdir.status).toBe(400);

      const moved = await api.post(`/sandboxes/${old.id}/move`, { spec: { providers: ["ls-b"], timeoutSec: 120 } });
      expect(moved.status).toBe(201);
      const next = await moved.json();
      expect(next.id).not.toBe(old.id);
      expect(next.provider).toBe("ls-b");
      expect(next.metadata["sandboxrouting.movedFrom"]).toBe(old.id);
      expect(next.route.at(-1).outcome).toBe("created");

      expect(await (await fetch(`${api.base}/sandboxes/${next.id}/files?path=work/notes.txt`)).text()).toBe("carried over");
      expect((await (await fetch(`${api.base}/sandboxes/${old.id}`)).json()).state).toBe("stopped");
      expect(a.killed).toHaveLength(1);

      // The old one is gone, so there is nothing left to move.
      expect((await api.post(`/sandboxes/${old.id}/move`, {})).status).toBe(404);
    } finally {
      api.close();
    }
  });
});

describe("MCP server: strategies", () => {
  it("lists strategies and creates with the strategy and isolation the agent asks for", async () => {
    const { router: r } = router([monthly(), credit()]);
    const { client, call } = await mcp(r);

    const tools = (await client.listTools()).tools;
    expect(tools.find((t) => t.name === "list_strategies")?.annotations?.readOnlyHint).toBe(true);
    const create = tools.find((t) => t.name === "create_sandbox")!;
    expect(Object.keys(create.inputSchema.properties ?? {})).toEqual(expect.arrayContaining(["strategy", "minIsolation", "avoid", "prefer", "execTimeoutSec"]));

    const strategies = (await call("list_strategies")).json() as { name: string; active: boolean }[];
    expect(strategies.map((s) => s.name)).toEqual(["free-first", "cheapest", "balanced", "fastest", "spread"]);
    expect(strategies.filter((s) => s.active).map((s) => s.name)).toEqual(["free-first"]);

    expect((await call("create_sandbox", { timeoutSec: 60 })).json().provider).toBe("monthly");
    expect((await call("create_sandbox", { timeoutSec: 60, strategy: "cheapest" })).json().provider).toBe("credit");

    // These fakes don't say how they isolate, so a microVM request can't go anywhere.
    const isolated = await call("create_sandbox", { timeoutSec: 60, minIsolation: "microvm" });
    expect(isolated.isError).toBe(true);
    expect(isolated.body).toMatch(/isolation unknown/);

    const unknown = await call("create_sandbox", { strategy: "nope" });
    expect(unknown.isError).toBe(true);
    expect(unknown.body).toMatch(/unknown routing strategy/);
  });

  it("moves a sandbox with move_sandbox", async () => {
    const a = localShellProvider({ id: "ls-a" });
    const b = localShellProvider({ id: "ls-b" });
    shells.push(a, b);
    const { router: r } = router([a, b]);
    const { call } = await mcp(r);

    // Same lane and price: the name breaks the tie.
    const old = (await call("create_sandbox", { timeoutSec: 120 })).json();
    expect(old.provider).toBe("ls-a");
    await call("write_file", { id: old.id, path: "src/app.txt", content: "v1" });
    // The new box is routed like create_sandbox, so take ls-a out of the running.
    r.config.providers["ls-a"] = { enabled: false };

    const moved = await call("move_sandbox", { id: old.id, workdir: "src" });
    expect(moved.isError).toBe(false);
    const next = moved.json();
    expect(next.provider).toBe("ls-b");
    expect((await call("read_file", { id: next.id, path: "src/app.txt" })).body).toBe("v1");
    expect(a.killed).toHaveLength(1);
  });
});

describe("CLI: strategies and route", () => {
  it("prints strategies, a compared plan and a plan under a named strategy, with no provider configured", async () => {
    const home = await mkdtemp(join(tmpdir(), "sbr-cli-routing-"));
    const config = join(home, "config.json");
    await writeFile(config, "{}");
    const env = { PATH: process.env["PATH"], HOME: home, SBR_HOME: home, SBR_DOCKER: "0", SBR_CONFIG: config };
    const exec = promisify(execFile);
    const sbr = (...args: string[]) =>
      exec("node", ["--import", "tsx", "src/cli.ts", ...args], { env }).then(
        ({ stdout, stderr }) => ({ stdout, stderr, code: 0 }),
        (e: { stdout: string; stderr: string; code: number }) => ({ stdout: e.stdout, stderr: e.stderr, code: e.code }),
      );
    try {
      const [strategies, json, compare, fastest, providers] = await Promise.all([
        sbr("strategies"),
        sbr("strategies", "--json"),
        sbr("route", "--compare"),
        sbr("route", "--strategy", "fastest"),
        sbr("providers"),
      ]);

      expect(strategies.code).toBe(0);
      expect(strategies.stdout).toMatch(/^\* free-first {2}Free usage first/m);
      for (const name of ["cheapest", "balanced", "fastest", "spread"]) expect(strategies.stdout).toMatch(new RegExp(`^  ${name}\\s+\\S`, "m"));

      expect(JSON.parse(json.stdout).filter((s: { active: boolean }) => s.active).map((s: { name: string }) => s.name)).toEqual(["free-first"]);

      // Same exit code as a plain route: nothing can take the request.
      expect(compare.code).toBe(1);
      const lines = compare.stdout.trim().split("\n");
      expect(lines).toHaveLength(5);
      expect(lines[0]).toMatch(/^\* free-first\s+no provider can take this request$/);
      expect(lines.slice(1).every((l) => /^ {2}\S+\s+no provider can take this request$/.test(l))).toBe(true);

      expect(fastest.code).toBe(1);
      expect(fastest.stdout.split("\n")[0]).toBe("strategy: fastest");
      expect(fastest.stdout).toMatch(/no provider can take this request/);
      expect(fastest.stdout).toMatch(/- e2b: not configured/);

      expect(providers.stdout).toMatch(/^PROVIDER\s+READY\s+FREE TIER\s+HEALTH\s+LIVE\s+NOTE$/m);
      expect(providers.stdout).toMatch(/e2b\s+no key\s+\$100\.00 left \(100%, one-time\)\s+-\s+0/);
      expect(providers.stdout).toMatch(/strategy: free-first$/m);

      const unknown = await sbr("route", "--compare", "--strategy", "nope");
      expect(unknown.code).toBe(1);
      expect(unknown.stderr).toMatch(/unknown routing strategy "nope"/);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }, 60_000);
});
