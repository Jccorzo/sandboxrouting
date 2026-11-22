// The version is read from package.json, the one place it is written: sbr --version prints it and
// the MCP server reports it. A mistyped option is the user's error, not a crash with a stack trace.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer, SandboxRouter } from "../src/index.js";
import { packageVersion } from "../src/version.js";

const version = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
const exec = promisify(execFile);
const sbr = (...args: string[]) =>
  exec("node", ["--import", "tsx", "src/cli.ts", ...args], { env: { PATH: process.env["PATH"], SBR_DOCKER: "0" } }).then(
    ({ stdout, stderr }) => ({ stdout, stderr, code: 0 }),
    (e: { stdout: string; stderr: string; code: number }) => ({ stdout: e.stdout, stderr: e.stderr, code: e.code }),
  );

describe("version", () => {
  it("is package.json's", () => {
    expect(packageVersion()).toBe(version);
  });

  it("sbr --version and -v print it", async () => {
    for (const flag of ["--version", "-v"]) {
      const r = await sbr(flag);
      expect(r, flag).toMatchObject({ code: 0, stdout: `${version}\n` });
    }
  });

  it("a mistyped option exits 2 with one line, no stack trace", async () => {
    const r = await sbr("--yes.");
    expect(r.code).toBe(2);
    expect(r.stderr.trim()).toBe("sbr: Unknown option '--yes.'; see sbr --help");
  });

  it("the MCP server reports it", async () => {
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createMcpServer(new SandboxRouter({ providers: [] })).connect(a);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(b);
    expect(client.getServerVersion()?.version).toBe(version);
    await client.close();
  });
});
