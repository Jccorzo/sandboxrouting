// MCP server: the router as tools an AI agent can call, over stdio (`sbr mcp`). The same
// tool set the providers' own MCP servers offer (create, run, files, url, kill), but one
// server for every provider, with free tiers used first.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SandboxRouter } from "../core/router.js";
import { classify } from "../core/errors.js";

const text = (value: unknown) => ({
  content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});

async function guarded<T>(fn: () => Promise<T>) {
  try {
    return text(await fn());
  } catch (raw) {
    const err = classify(raw);
    return { ...text(`${err.kind}: ${err.message}`), isError: true };
  }
}

export function createMcpServer(router: SandboxRouter, version = "0.1.0"): McpServer {
  const server = new McpServer({ name: "sandboxrouting", version });

  server.registerTool(
    "list_providers",
    {
      description: "List sandbox providers with their free-tier status (remaining credit, resets), availability and capabilities.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () => guarded(() => router.status({ refreshUsage: true })),
  );

  server.registerTool(
    "create_sandbox",
    {
      description:
        "Create a cloud sandbox. The router picks the provider, using free tiers first, and fails over if one refuses. Returns its id and the routing decision.",
      inputSchema: {
        image: z.string().optional().describe("OCI image, e.g. python:3.12-slim (only providers that run custom images)"),
        timeoutSec: z.number().int().positive().optional().describe("Lifetime in seconds (default 300)"),
        cpu: z.number().positive().optional(),
        memoryMiB: z.number().int().positive().optional(),
        env: z.record(z.string()).optional(),
        needs: z.array(z.enum(["ports", "pause", "customImage", "gpu", "snapshot", "fileList", "extendTimeout"])).optional(),
        providers: z.array(z.string()).optional().describe("Only these provider ids"),
      },
    },
    (spec) =>
      guarded(async () => {
        const sbx = await router.create(spec);
        return { id: sbx.id, provider: sbx.provider, route: sbx.route, sandbox: await sbx.info() };
      }),
  );

  server.registerTool(
    "run_command",
    {
      description: "Run a shell command in a sandbox and return stdout, stderr and the exit code.",
      inputSchema: {
        id: z.string().describe("Sandbox id from create_sandbox"),
        command: z.string(),
        cwd: z.string().optional(),
        env: z.record(z.string()).optional(),
        timeoutSec: z.number().int().positive().optional(),
      },
    },
    ({ id, command, ...opts }) => guarded(async () => (await router.connect(id)).commands.run(command, opts)),
  );

  server.registerTool(
    "read_file",
    { description: "Read a text file from a sandbox.", inputSchema: { id: z.string(), path: z.string() }, annotations: { readOnlyHint: true } },
    ({ id, path }) => guarded(async () => (await router.connect(id)).files.read(path)),
  );

  server.registerTool(
    "write_file",
    { description: "Write a text file in a sandbox (parent directories are created).", inputSchema: { id: z.string(), path: z.string(), content: z.string() } },
    ({ id, path, content }) =>
      guarded(async () => {
        await (await router.connect(id)).files.write(path, content);
        return `wrote ${path}`;
      }),
  );

  server.registerTool(
    "list_files",
    { description: "List a directory in a sandbox.", inputSchema: { id: z.string(), path: z.string().default(".") }, annotations: { readOnlyHint: true } },
    ({ id, path }) => guarded(async () => (await router.connect(id)).files.list(path)),
  );

  server.registerTool(
    "get_url",
    { description: "Public URL for a port inside a sandbox.", inputSchema: { id: z.string(), port: z.number().int().positive() } },
    ({ id, port }) => guarded(async () => (await router.connect(id)).getUrl(port)),
  );

  server.registerTool(
    "set_timeout",
    { description: "Keep a sandbox alive for timeoutSec more seconds from now.", inputSchema: { id: z.string(), timeoutSec: z.number().int().positive() } },
    ({ id, timeoutSec }) =>
      guarded(async () => {
        const sbx = await router.connect(id);
        await sbx.setTimeout(timeoutSec);
        return sbx.info();
      }),
  );

  server.registerTool(
    "list_sandboxes",
    {
      description: "List sandboxes the router created (live ones, or all with all=true), with provider and cost so far.",
      inputSchema: { all: z.boolean().optional() },
      annotations: { readOnlyHint: true },
    },
    ({ all }) => guarded(() => router.list({ all })),
  );

  server.registerTool(
    "kill_sandbox",
    { description: "Stop and delete a sandbox.", inputSchema: { id: z.string() }, annotations: { destructiveHint: true } },
    ({ id }) =>
      guarded(async () => {
        await router.kill(id);
        return `killed ${id}`;
      }),
  );

  return server;
}

export async function serveMcpStdio(router: SandboxRouter): Promise<void> {
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  await createMcpServer(router).connect(new StdioServerTransport());
}
