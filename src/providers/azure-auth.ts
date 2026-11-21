// Microsoft Entra tokens without @azure/identity, for the Azure Container Apps adapter.
//   AZURE_ACCESS_TOKEN                                  a token you minted for the resource
//                                                       (`az account get-access-token --resource <resource>`)
//   AZURE_TENANT_ID + AZURE_CLIENT_ID + AZURE_CLIENT_SECRET   a service principal: client credentials
//                                                       at {AZURE_AUTHORITY_HOST}/{tenant}/oauth2/v2.0/token
// https://learn.microsoft.com/entra/identity-platform/v2-oauth2-client-creds-grant-flow

import { SandboxRouterError } from "../core/errors.js";
import type { ProviderContext } from "../core/types.js";
import { HttpError, httpJson } from "./util.js";

export function hasAzureCredentials(ctx: ProviderContext): boolean {
  return Boolean(ctx.env["AZURE_ACCESS_TOKEN"] || (ctx.env["AZURE_TENANT_ID"] && ctx.env["AZURE_CLIENT_ID"] && ctx.env["AZURE_CLIENT_SECRET"]));
}

const held = new Map<string, { token: string; until: number }>();

/** A bearer token whose audience is `resource` (e.g. `https://dynamicsessions.io`). */
export async function azureToken(ctx: ProviderContext, provider: string, resource: string): Promise<string> {
  const given = ctx.env["AZURE_ACCESS_TOKEN"];
  if (given) return given;
  const tenant = ctx.env["AZURE_TENANT_ID"];
  const clientId = ctx.env["AZURE_CLIENT_ID"];
  const secret = ctx.env["AZURE_CLIENT_SECRET"];
  if (!tenant || !clientId || !secret) {
    throw new SandboxRouterError("auth", `${provider} needs AZURE_ACCESS_TOKEN or AZURE_TENANT_ID, AZURE_CLIENT_ID and AZURE_CLIENT_SECRET`, provider);
  }
  const key = `${tenant} ${clientId} ${resource}`;
  const hit = held.get(key);
  if (hit && hit.until > Date.now()) return hit.token;
  const authority = String(ctx.env["AZURE_AUTHORITY_HOST"] ?? "https://login.microsoftonline.com").replace(/\/+$/, "");
  let r: { access_token: string; expires_in?: number | string };
  try {
    r = await httpJson(`${authority}/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      raw: new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: secret, scope: `${resource}/.default` }).toString(),
    });
  } catch (err) {
    // Entra answers a bad secret or unknown client with 400/401.
    if (err instanceof HttpError && err.status < 500) throw new SandboxRouterError("auth", `${provider}: Entra token endpoint: ${err.message}`, provider, { cause: err });
    throw err;
  }
  held.set(key, { token: r.access_token, until: Date.now() + (Number(r.expires_in ?? 3600) - 60) * 1000 });
  return r.access_token;
}
