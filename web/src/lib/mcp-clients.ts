// How each MCP client starts the server. The command is the package's own bin
// (`sandboxrouting mcp`, the same as `sbr mcp`); only the clients' config formats differ.

export interface McpClient {
  id: string;
  name: string;
  /** Where the snippet goes, when it is a file. */
  where: string;
  lang: "bash" | "json" | "toml";
  snippet: (server: string) => string;
}

export const MCP_COMMAND = { command: "npx", args: ["-y", "sandboxrouting", "mcp"] } as const;
export const MCP_ONE_LINE = "npx -y sandboxrouting mcp";

const json = (v: unknown) => JSON.stringify(v, null, 2);
const ENV_EXAMPLE = { MODAL_TOKEN_ID: "…", MODAL_TOKEN_SECRET: "…", E2B_API_KEY: "…" };

export const MCP_CLIENTS: McpClient[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    where: "In a terminal",
    lang: "bash",
    snippet: (s) => `claude mcp add ${s} -- ${MCP_ONE_LINE}`,
  },
  {
    id: "cursor",
    name: "Cursor",
    where: "~/.cursor/mcp.json, or .cursor/mcp.json in a project",
    lang: "json",
    snippet: (s) => json({ mcpServers: { [s]: { ...MCP_COMMAND, env: ENV_EXAMPLE } } }),
  },
  {
    id: "claude-desktop",
    name: "Claude Desktop",
    where: "Settings, Developer, Edit Config (claude_desktop_config.json)",
    lang: "json",
    snippet: (s) => json({ mcpServers: { [s]: { ...MCP_COMMAND, env: ENV_EXAMPLE } } }),
  },
  {
    id: "vscode",
    name: "VS Code",
    where: ".vscode/mcp.json in the workspace",
    lang: "json",
    snippet: (s) => json({ servers: { [s]: { type: "stdio", ...MCP_COMMAND, env: ENV_EXAMPLE } } }),
  },
  {
    id: "windsurf",
    name: "Windsurf",
    where: "~/.codeium/windsurf/mcp_config.json",
    lang: "json",
    snippet: (s) => json({ mcpServers: { [s]: { ...MCP_COMMAND, env: ENV_EXAMPLE } } }),
  },
  {
    id: "codex",
    name: "Codex CLI",
    where: "~/.codex/config.toml",
    lang: "toml",
    snippet: (s) =>
      [`[mcp_servers.${s}]`, `command = "npx"`, `args = ["-y", "sandboxrouting", "mcp"]`, "", `[mcp_servers.${s}.env]`, `E2B_API_KEY = "…"`].join("\n"),
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    where: "~/.gemini/settings.json",
    lang: "json",
    snippet: (s) => json({ mcpServers: { [s]: { ...MCP_COMMAND, env: ENV_EXAMPLE } } }),
  },
];
