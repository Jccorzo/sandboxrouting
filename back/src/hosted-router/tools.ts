// MCP tools for an account's saved provider keys and routing config, on the hosted router: the
// same reads and compare-and-set writes as the dashboard (vault.ts), under the account's lock with
// the caller's key checked again there.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Db } from "../db.js";
import { dbNow } from "../derive.js";
import { underAccountLock } from "../keys.js";
import type { Principal, ResolvedPlugins } from "../plugins.js";
import type { SecretBox } from "../secrets.js";
import { getConfig, listCredentials, removeCredentials, saveConfig, saveCredentials } from "../vault.js";
import { catalogEntry, checkCredentials, checkHostedConfig } from "../hosted.js";

export interface VaultToolsDeps {
  db: Db;
  plugins: ResolvedPlugins;
  secrets: SecretBox;
  principal: Principal;
}

const text = (value: unknown) => ({ content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });
const failure = (message: string, extra?: unknown) => ({ ...text(extra === undefined ? message : { error: message, ...(extra as object) }), isError: true });

const version = z.number().int().min(0).max(2 ** 31 - 2);
const REVOKED = "this key was revoked, or its account disabled, meanwhile";

export function registerVaultTools(server: McpServer, deps: VaultToolsDeps): void {
  const { db, plugins, secrets, principal: p } = deps;
  const now = async () => new Date(await dbNow(db)).toISOString();
  const allowed = async (action: "credentials.manage" | "config.manage") => {
    const d = await plugins.entitlements.check(p, action, { db });
    return d.ok ? undefined : failure(d.reason);
  };

  server.registerTool(
    "list_connections",
    {
      description:
        "List the providers the hosted router runs, the variables each takes, and which ones this account has keys saved for (only the last 4 characters of a key are ever shown). Each has a version: pass it to connect_provider or remove_provider.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const view = await listCredentials(db, p.accountId, await now(), true);
      return text(
        view.providers.map((e) => ({
          id: e.id,
          name: e.name,
          homepage: e.homepage,
          fields: e.fields.map((f) => ({ name: f.name, kind: f.kind, required: f.required, label: f.label, ...(f.help ? { help: f.help } : {}) })),
          connection: e.connection,
        })),
      );
    },
  );

  server.registerTool(
    "connect_provider",
    {
      description:
        "Save this account's API key (and settings) for a provider, replacing what was saved. The hosted router then routes to that provider with this key. Note: a key typed into a chat passes through the AI client and its logs; the dashboard's Provider keys page is the safer place to paste one. expectedVersion is the version list_connections showed (0 if nothing was ever saved); if the keys changed since, nothing is saved and you get how they stand now.",
      inputSchema: {
        provider: z.string().describe("Provider id from list_connections, e.g. e2b"),
        values: z.record(z.string()).describe("Variables, e.g. { E2B_API_KEY: \"…\" }"),
        expectedVersion: version,
      },
      annotations: { destructiveHint: true },
    },
    async ({ provider, values, expectedVersion }) => {
      if (!catalogEntry(provider)) return failure(`${provider} isn't a provider the hosted router runs; see list_connections`);
      const checked = checkCredentials(provider, values);
      if (!checked.ok) return failure(checked.message);
      const refused = await allowed("credentials.manage");
      if (refused) return refused;
      const out = await underAccountLock(db, plugins.auth, p, (q) => saveCredentials(q, secrets, p, provider, checked.values, expectedVersion));
      if ("unauthorized" in out) return failure(REVOKED);
      if (out.value.outcome === "stale") return failure("these keys changed since that version; nothing was saved", { connection: out.value.connection });
      return text({ provider, connection: out.value.connection });
    },
  );

  server.registerTool(
    "remove_provider",
    {
      description: "Forget this account's saved key for a provider. expectedVersion is the version list_connections showed.",
      inputSchema: { provider: z.string(), expectedVersion: version },
      annotations: { destructiveHint: true },
    },
    async ({ provider, expectedVersion }) => {
      if (!catalogEntry(provider)) return failure(`${provider} isn't a provider the hosted router runs; see list_connections`);
      const refused = await allowed("credentials.manage");
      if (refused) return refused;
      const out = await underAccountLock(db, plugins.auth, p, (q) => removeCredentials(q, p, provider, expectedVersion));
      if ("unauthorized" in out) return failure(REVOKED);
      if (out.value.outcome === "stale") return failure("these keys changed (or were removed) since that version; nothing was changed", { connection: out.value.connection });
      return text({ provider, connection: out.value.connection });
    },
  );

  server.registerTool(
    "get_config",
    {
      description:
        "This account's routing config on the hosted router (strategy, paid usage and budgets, per-provider switches), its version, and the strategies there are.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => text(await getConfig(db, p.accountId, await now())),
  );

  server.registerTool(
    "set_config",
    {
      description:
        "Replace this account's routing config: the router's config file format (routing.strategy, allowPaid, budgets.monthlyUsd, providers.<id>.enabled …), without serverToken, report, selfHosted or providers.*.options. expectedVersion is the version get_config showed (0 if never saved); if it changed since, nothing is saved and you get the current one.",
      inputSchema: { config: z.record(z.unknown()), expectedVersion: version },
    },
    async ({ config, expectedVersion }) => {
      const checked = checkHostedConfig(config);
      if (!checked.ok) return failure(checked.message);
      const refused = await allowed("config.manage");
      if (refused) return refused;
      const out = await underAccountLock(db, plugins.auth, p, async (q) => saveConfig(q, p, checked.config, expectedVersion, new Date(await dbNow(q)).toISOString()));
      if ("unauthorized" in out) return failure(REVOKED);
      if (out.value.outcome === "stale") return failure("the config changed since that version; nothing was saved", { config: out.value.view });
      return text(out.value.view);
    },
  );
}
