// How each MCP client starts the server. The command is the package's own bin
// (`sandboxrouting mcp`, the same as `sbr mcp`); only the clients' config formats differ.
//
// Each entry was checked against the client's own docs on 2026-11-23. Several clients start a
// server with only the variables they're given (Codex, Gemini CLI), so every snippet names the
// provider keys explicitly: a CLI's env flag, or the config's env block.

export interface McpClient {
  id: string;
  name: string;
  /** Where the snippet goes: a terminal, or the file and how to open it. */
  where: string;
  lang: "bash" | "json" | "toml" | "yaml";
  snippet: (server: string) => string;
}

export const MCP_COMMAND = { command: "npx", args: ["-y", "sandboxrouting", "mcp"] } as const;
export const MCP_ONE_LINE = "npx -y sandboxrouting mcp";

const json = (v: unknown) => JSON.stringify(v, null, 2);
const ENV_EXAMPLE = { MODAL_TOKEN_ID: "…", MODAL_TOKEN_SECRET: "…", E2B_API_KEY: "…" };
/** One key in a CLI's env flag; the page says to repeat it for each provider. */
const KEY = "E2B_API_KEY=…";

/** The shape most clients share: `mcpServers`, then command, args and env. */
const mcpServers = (s: string, extra: Record<string, unknown> = {}) => json({ mcpServers: { [s]: { ...extra, ...MCP_COMMAND, env: ENV_EXAMPLE } } });

const claudeCode = (s: string) => `claude mcp add --env ${KEY} --scope user ${s} -- ${MCP_ONE_LINE}`;
const codex = (s: string) => `codex mcp add ${s} --env ${KEY} -- ${MCP_ONE_LINE}`;

export const MCP_CLIENTS: McpClient[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    where: "In a terminal. It's added for every project, not just this one",
    lang: "bash",
    snippet: claudeCode,
  },
  {
    id: "cursor",
    name: "Cursor",
    where: "~/.cursor/mcp.json, or .cursor/mcp.json in a project",
    lang: "json",
    snippet: (s) => mcpServers(s, { type: "stdio" }),
  },
  {
    id: "codex",
    name: "Codex",
    where: "In a terminal. The Codex CLI, IDE extension and ChatGPT desktop app share it (~/.codex/config.toml)",
    lang: "bash",
    snippet: codex,
  },
  {
    id: "vscode",
    name: "VS Code",
    where: "~/.copilot/mcp-config.json for every workspace, or .mcp.json at a workspace's root",
    lang: "json",
    snippet: (s) => mcpServers(s, { type: "stdio" }),
  },
  {
    id: "t3code",
    name: "T3 Code",
    where: "T3 Code uses the MCP servers of the agent it runs: add it to that agent, then restart the session",
    lang: "bash",
    snippet: (s) => ["# Claude Code sessions", claudeCode(s), "", "# Codex sessions", codex(s)].join("\n"),
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    where: "In a terminal. It's added for every project, not just this one",
    lang: "bash",
    snippet: (s) => `gemini mcp add -s user -e ${KEY} ${s} ${MCP_ONE_LINE}`,
  },
  {
    id: "copilot-cli",
    name: "Copilot CLI",
    where: "In a terminal (saved to ~/.copilot/mcp-config.json, which VS Code reads too)",
    lang: "bash",
    snippet: (s) => `copilot mcp add ${s} --env ${KEY} -- ${MCP_ONE_LINE}`,
  },
  {
    id: "claude-desktop",
    name: "Claude Desktop",
    where: "Settings, Developer, Edit Config (claude_desktop_config.json), then restart the app",
    lang: "json",
    snippet: (s) => mcpServers(s),
  },
  {
    id: "antigravity",
    name: "Antigravity",
    where: "~/.gemini/config/mcp_config.json, or .agents/mcp_config.json in a workspace",
    lang: "json",
    snippet: (s) => mcpServers(s),
  },
  {
    id: "windsurf",
    name: "Windsurf (Devin Desktop)",
    where: "~/.config/devin/mcp_config.json, or .devin/mcp_config.json in a project",
    lang: "json",
    snippet: (s) => mcpServers(s),
  },
  {
    id: "zed",
    name: "Zed",
    where: "Your settings file (zed: open settings file)",
    lang: "json",
    snippet: (s) => json({ context_servers: { [s]: { ...MCP_COMMAND, env: ENV_EXAMPLE } } }),
  },
  {
    id: "opencode",
    name: "opencode",
    where: "~/.config/opencode/opencode.json, or opencode.json in a project",
    lang: "json",
    snippet: (s) =>
      json({ $schema: "https://opencode.ai/config.json", mcp: { servers: { [s]: { type: "local", command: ["npx", ...MCP_COMMAND.args], environment: ENV_EXAMPLE } } } }),
  },
  {
    id: "cline",
    name: "Cline",
    where: "MCP Servers, Configure, Configure MCP Servers (cline_mcp_settings.json)",
    lang: "json",
    snippet: (s) => mcpServers(s),
  },
  {
    id: "roo-code",
    name: "Roo Code",
    where: ".roo/mcp.json in a project, or Roo's global MCP settings",
    lang: "json",
    snippet: (s) => mcpServers(s),
  },
  {
    id: "kiro",
    name: "Kiro",
    where: "~/.kiro/settings/mcp.json, or .kiro/settings/mcp.json in a workspace",
    lang: "json",
    snippet: (s) => mcpServers(s),
  },
  {
    id: "amp",
    name: "Amp",
    where: "~/.config/amp/settings.json",
    lang: "json",
    snippet: (s) => json({ "amp.mcpServers": { [s]: { ...MCP_COMMAND, env: ENV_EXAMPLE } } }),
  },
  {
    id: "junie",
    name: "Junie (JetBrains)",
    where: "~/.junie/mcp/mcp.json, or .junie/mcp/mcp.json in a project",
    lang: "json",
    snippet: (s) => mcpServers(s),
  },
  {
    id: "warp",
    name: "Warp",
    where: "Settings, Agents, MCP servers, + Add, and paste it (or ~/.warp/.mcp.json)",
    lang: "json",
    snippet: (s) => mcpServers(s),
  },
  {
    id: "goose",
    name: "Goose",
    where: "~/.config/goose/config.yaml, or goose configure, Add Extension, Command-line Extension",
    lang: "yaml",
    snippet: (s) =>
      [
        "extensions:",
        `  ${s}:`,
        `    name: ${s}`,
        "    type: stdio",
        "    cmd: npx",
        '    args: ["-y", "sandboxrouting", "mcp"]',
        "    envs:",
        ...Object.keys(ENV_EXAMPLE).map((k) => `      ${k}: "…"`),
        "    enabled: true",
        "    timeout: 300",
      ].join("\n"),
  },
  {
    id: "droid",
    name: "Factory Droid",
    where: "In a terminal (saved to ~/.factory/mcp.json)",
    lang: "bash",
    snippet: (s) => `droid mcp add ${s} "${MCP_ONE_LINE}" --env ${KEY}`,
  },
  {
    id: "qwen",
    name: "Qwen Code",
    where: "In a terminal (saved to ~/.qwen/settings.json)",
    lang: "bash",
    snippet: (s) => `qwen mcp add -e ${KEY} ${s} ${MCP_ONE_LINE}`,
  },
  {
    id: "crush",
    name: "Crush",
    where: "A line in ~/.config/crush/crushrc, or .crushrc in a project",
    lang: "bash",
    snippet: (s) => `mcp add ${s} --command npx --args -y --args sandboxrouting --args mcp --env E2B_API_KEY …`,
  },
  {
    id: "continue",
    name: "Continue",
    where: "config.yaml (agent mode)",
    lang: "yaml",
    snippet: (s) =>
      [
        "mcpServers:",
        `  - name: ${s}`,
        "    type: stdio",
        "    command: npx",
        '    args: ["-y", "sandboxrouting", "mcp"]',
        "    env:",
        ...Object.keys(ENV_EXAMPLE).map((k) => `      ${k}: "…"`),
      ].join("\n"),
  },
];

/** The ones the install box offers, most used first; the MCP page lists them all. */
export const FEATURED_CLIENTS = ["claude-code", "cursor", "codex", "vscode", "t3code", "gemini"];
