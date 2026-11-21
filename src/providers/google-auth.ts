// Google credentials without the Google SDK, shared by the Cloud Run and GKE adapters.
// Three sources, first match wins:
//   GOOGLE_OAUTH_ACCESS_TOKEN             an access token you minted (`gcloud auth print-access-token`)
//   GOOGLE_APPLICATION_CREDENTIALS_JSON   a key file's JSON, inline
//   GOOGLE_APPLICATION_CREDENTIALS        a path to that file
// A key file is a service account (`type: service_account`: a JWT signed with node:crypto,
// RS256, exchanged at its token_uri) or `gcloud auth application-default login`'s
// `authorized_user` (a refresh token). Tokens are kept until a minute before they expire.
// https://developers.google.com/identity/protocols/oauth2/service-account#httprest
// https://cloud.google.com/run/docs/authenticating/service-to-service (ID tokens)

import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { SandboxRouterError } from "../core/errors.js";
import type { ProviderContext } from "../core/types.js";
import { HttpError, httpJson } from "./util.js";

const SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const TOKEN_URI = "https://oauth2.googleapis.com/token";

interface KeyFile {
  type?: string;
  client_email?: string;
  private_key?: string;
  private_key_id?: string;
  token_uri?: string;
  client_id?: string;
  client_secret?: string;
  refresh_token?: string;
}

/** Whether any Google credential is set. */
export function hasGoogleCredentials(ctx: ProviderContext): boolean {
  return Boolean(ctx.env["GOOGLE_OAUTH_ACCESS_TOKEN"] || ctx.env["GOOGLE_APPLICATION_CREDENTIALS_JSON"] || ctx.env["GOOGLE_APPLICATION_CREDENTIALS"]);
}

function keyFile(ctx: ProviderContext, provider: string): KeyFile | undefined {
  const inline = ctx.env["GOOGLE_APPLICATION_CREDENTIALS_JSON"];
  const path = ctx.env["GOOGLE_APPLICATION_CREDENTIALS"];
  if (!inline && !path) return undefined;
  try {
    return JSON.parse(inline ?? readFileSync(path!, "utf8")) as KeyFile;
  } catch (err) {
    throw new SandboxRouterError("auth", `${provider}: can't read the Google key file: ${(err as Error).message}`, provider, { cause: err });
  }
}

const b64url = (s: string | Buffer) => Buffer.from(s).toString("base64url");

/** A service account's signed assertion: `scope` for an access token, `target_audience` for an ID token. */
export function signedAssertion(key: KeyFile, claims: Record<string, string>, nowSec = Math.floor(Date.now() / 1000)): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT", ...(key.private_key_id ? { kid: key.private_key_id } : {}) }));
  const body = b64url(JSON.stringify({ iss: key.client_email, aud: key.token_uri ?? TOKEN_URI, iat: nowSec, exp: nowSec + 3600, ...claims }));
  const signature = createSign("RSA-SHA256").update(`${header}.${body}`).sign(key.private_key!);
  return `${header}.${body}.${b64url(signature)}`;
}

const held = new Map<string, { token: string; until: number }>();

async function exchange(key: KeyFile, form: Record<string, string>, provider: string): Promise<{ access_token?: string; id_token?: string; expires_in?: number }> {
  try {
    return await httpJson(key.token_uri ?? TOKEN_URI, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      raw: new URLSearchParams(form).toString(),
    });
  } catch (err) {
    // A refused key is an auth problem whatever status the token endpoint picks (it uses 400).
    if (err instanceof HttpError && err.status < 500) throw new SandboxRouterError("auth", `${provider}: Google token endpoint: ${err.message}`, provider, { cause: err });
    throw err;
  }
}

async function cached(cacheKey: string, mint: () => Promise<{ token: string; expiresIn: number }>): Promise<string> {
  const hit = held.get(cacheKey);
  if (hit && hit.until > Date.now()) return hit.token;
  const made = await mint();
  held.set(cacheKey, { token: made.token, until: Date.now() + (made.expiresIn - 60) * 1000 });
  return made.token;
}

/** An OAuth access token for the cloud-platform scope. */
export async function googleAccessToken(ctx: ProviderContext, provider: string): Promise<string> {
  const given = ctx.env["GOOGLE_OAUTH_ACCESS_TOKEN"];
  if (given) return given;
  const key = keyFile(ctx, provider);
  if (!key) throw new SandboxRouterError("auth", `${provider} needs GOOGLE_OAUTH_ACCESS_TOKEN or GOOGLE_APPLICATION_CREDENTIALS`, provider);
  if (key.type === "authorized_user") {
    return cached(`user ${key.client_id} ${key.refresh_token?.slice(-12)}`, async () => {
      const r = await exchange(key, { grant_type: "refresh_token", client_id: key.client_id ?? "", client_secret: key.client_secret ?? "", refresh_token: key.refresh_token ?? "" }, provider);
      return { token: String(r.access_token), expiresIn: r.expires_in ?? 3600 };
    });
  }
  if (!key.client_email || !key.private_key) throw new SandboxRouterError("auth", `${provider}: the Google key file is neither a service account nor authorized_user`, provider);
  return cached(`sa ${key.client_email} access`, async () => {
    const assertion = signedAssertion(key, { scope: SCOPE });
    const r = await exchange(key, { grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }, provider);
    return { token: String(r.access_token), expiresIn: r.expires_in ?? 3600 };
  });
}

/**
 * A Google-signed ID token for `audience` (a Cloud Run URL), which only a service account key
 * can mint without the IAM Credentials API.
 */
export async function googleIdToken(ctx: ProviderContext, provider: string, audience: string): Promise<string> {
  const key = keyFile(ctx, provider);
  if (!key?.client_email || !key.private_key) {
    throw new SandboxRouterError("auth", `${provider}: an ID token for an IAM-checked URL needs a service account key (GOOGLE_APPLICATION_CREDENTIALS)`, provider);
  }
  return cached(`sa ${key.client_email} id ${audience}`, async () => {
    const assertion = signedAssertion(key, { target_audience: audience });
    const r = await exchange(key, { grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }, provider);
    // ID tokens last an hour; the response carries no expires_in.
    return { token: String(r.id_token), expiresIn: 3600 };
  });
}
