import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, createMcpServer, FileLedger } from "../src/index.js";
import { fakeProvider, router } from "./fake.js";

describe("FileLedger", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "sbr-ledger-"));
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it("loses no update when many writers race (lock + whole-file writes)", async () => {
    // Separate instances, like separate processes sharing one file.
    const ledgers = Array.from({ length: 8 }, () => new FileLedger(join(dir, "ledger.json")));
    await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        ledgers[i % ledgers.length]!.update((d) => {
          d.marks.push({ provider: `p${i}`, kind: "rate_limit", at: "2026-01-01T00:00:00Z", until: "2099-01-01T00:00:00Z" });
        }),
      ),
    );
    expect((await ledgers[0]!.read()).marks).toHaveLength(40);
  });

  it("refuses a ledger whose records break the lifecycle invariants", async () => {
    const path = join(dir, "bad.json");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        marks: [],
        archivedUsd: {},
        sandboxes: { s: { id: "s", provider: "p", state: "running", cpu: 1, memoryMiB: 1, createdAt: "x", metadata: {}, providerSandboxId: "y", expiresAt: "2026-01-01T00:00:00Z", segments: [] } },
      }),
    );
    await expect(new FileLedger(path).read()).rejects.toThrow(/exactly one open segment/);
  });
});

describe("REST API", () => {
  it("creates, execs, reads/writes files and kills through HTTP", async () => {
    const p = fakeProvider({ id: "free", tier: { kind: "monthly-credit", usd: 30 } });
    const { router: r } = router([p], { serverToken: "s3cret" });
    const server = createServer(r).listen(0);
    await new Promise((ok) => server.once("listening", ok));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    const h = { authorization: "Bearer s3cret", "content-type": "application/json" };
    try {
      expect((await fetch(`${base}/providers`)).status).toBe(401);
      const providers = await (await fetch(`${base}/providers`, { headers: h })).json();
      expect(providers[0].free.state).toBe("available");

      const created = await (await fetch(`${base}/sandboxes`, { method: "POST", headers: h, body: JSON.stringify({ timeoutSec: 60 }) })).json();
      expect(created.provider).toBe("free");
      expect(created.route.at(-1).outcome).toBe("created");

      const run = await (await fetch(`${base}/sandboxes/${created.id}/exec`, { method: "POST", headers: h, body: JSON.stringify({ command: "exit 3" }) })).json();
      expect(run.exitCode).toBe(3);

      await fetch(`${base}/sandboxes/${created.id}/files?path=/a.txt`, { method: "PUT", headers: { authorization: h.authorization }, body: "hello" });
      expect(await (await fetch(`${base}/sandboxes/${created.id}/files?path=/a.txt`, { headers: h })).text()).toBe("hello");

      const killed = await (await fetch(`${base}/sandboxes/${created.id}`, { method: "DELETE", headers: h })).json();
      expect(killed.state).toBe("stopped");

      const none = await fetch(`${base}/sandboxes`, { method: "POST", headers: h, body: JSON.stringify({ providers: ["nope"] }) });
      expect(none.status).toBe(503);
    } finally {
      server.close();
    }
  });
});

describe("MCP server", () => {
  it("exposes create/run/kill as tools", async () => {
    const p = fakeProvider({ id: "free", tier: { kind: "monthly-credit", usd: 30 } });
    const { router: r } = router([p]);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createMcpServer(r).connect(a);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(b);

    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).toEqual(expect.arrayContaining(["create_sandbox", "run_command", "read_file", "write_file", "kill_sandbox", "list_providers"]));

    const created = await client.callTool({ name: "create_sandbox", arguments: { timeoutSec: 60 } });
    const { id } = JSON.parse((created.content as { text: string }[])[0]!.text);
    const run = await client.callTool({ name: "run_command", arguments: { id, command: "echo hi" } });
    expect(JSON.parse((run.content as { text: string }[])[0]!.text).stdout).toContain("echo hi");
    await client.callTool({ name: "kill_sandbox", arguments: { id } });
    expect(p.killed).toHaveLength(1);

    const bad = await client.callTool({ name: "run_command", arguments: { id: "sbr_missing", command: "x" } });
    expect(bad.isError).toBe(true);
  });
});

describe("CLI", () => {
  it("lists providers with free-tier status and refuses paid routing by default", async () => {
    const home = await mkdtemp(join(tmpdir(), "sbr-cli-"));
    const run = promisify(execFile);
    const env = { PATH: process.env["PATH"], HOME: home, SBR_HOME: home, SBR_DOCKER: "0", SBR_CONFIG: join(home, "none.json") };
    const { writeFile } = await import("node:fs/promises");
    await writeFile(env.SBR_CONFIG, JSON.stringify({ providers: { fly: { enabled: false } } }));
    try {
      const { stdout } = await run("node", ["--import", "tsx", "src/cli.ts", "providers"], { env });
      expect(stdout).toMatch(/e2b\s+no key\s+\$100\.00 left \(100%, one-time\)/);
      expect(stdout).toMatch(/modal\s+no key\s+\$30\.00 left \(100%, resets/);
      expect(stdout).toMatch(/fly\s+disabled/);
      expect(stdout).toMatch(/paid usage: off/);
      const route = await run("node", ["--import", "tsx", "src/cli.ts", "route"], { env }).catch((e: { stdout: string; code: number }) => e);
      expect(route.stdout).toMatch(/no provider can take this request/);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }, 30_000);
});
