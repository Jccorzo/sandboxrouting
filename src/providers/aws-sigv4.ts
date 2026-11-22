// AWS Signature Version 4 for header-signed requests, and the credentials and region the AWS
// SDK's default chain would find in the environment or the shared config files. Spec:
// https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html
// Checked against AWS's SigV4 test suite (test/aws-sigv4.test.ts).

import { createHash, createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface SigV4Request {
  method: string;
  host: string;
  /** The path as it appears on the request line; the signer encodes it once more (non-S3 rule). */
  path: string;
  /** The query as it appears on the request line, without `?`. */
  query?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
}

export interface SigV4Options {
  region: string;
  service: string;
  credentials: AwsCredentials;
  date?: Date;
  /** Send and sign `x-amz-content-sha256`, as the AWS SDK does for most services. */
  signBody?: boolean;
}

/** Headers the AWS SDK never signs: proxies and the HTTP stack may change them. */
const UNSIGNABLE = new Set(["authorization", "cache-control", "connection", "expect", "from", "keep-alive", "max-forwards", "pragma", "referer", "te", "trailer", "transfer-encoding", "upgrade", "user-agent", "x-amzn-trace-id"]);

const sha256Hex = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const hmac = (key: string | Buffer, data: string) => createHmac("sha256", key).update(data).digest();

/** RFC 3986 encoding: everything but A-Z a-z 0-9 - . _ ~ is percent-encoded. */
export const rfc3986 = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

function canonicalPath(path: string): string {
  // Dot segments and empty segments go, then the path is encoded again, keeping the slashes.
  const segments: string[] = [];
  for (const s of path.split("/")) {
    if (s === "" || s === ".") continue;
    if (s === "..") segments.pop();
    else segments.push(s);
  }
  const normalized = `/${segments.join("/")}${segments.length && path.endsWith("/") ? "/" : ""}`;
  return rfc3986(normalized).replace(/%2F/g, "/");
}

function canonicalQuery(query: string): string {
  const pairs = query
    .split("&")
    .filter(Boolean)
    .map((p) => {
      const i = p.indexOf("=");
      const [k, v] = i < 0 ? [p, ""] : [p.slice(0, i), p.slice(i + 1)];
      return [rfc3986(decode(k)), rfc3986(decode(v))] as const;
    });
  pairs.sort(([ak, av], [bk, bv]) => (ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0));
  return pairs.map(([k, v]) => `${k}=${v}`).join("&");
}

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

const amzDate = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

/**
 * Signs a request; returns the headers to send: the caller's plus x-amz-date, the session token,
 * the payload hash when `signBody`, and authorization. `host` is signed but not returned, since
 * fetch sets it from the URL.
 */
export function signV4(req: SigV4Request, opts: SigV4Options): Record<string, string> {
  const longDate = amzDate(opts.date ?? new Date());
  const shortDate = longDate.slice(0, 8);
  const payloadHash = sha256Hex(req.body ?? "");
  // Headers the signer sets replace the caller's, whatever their case.
  const generated = new Set(["x-amz-date", "x-amz-security-token", "x-amz-content-sha256", "authorization", "host"]);
  const out: Record<string, string> = Object.fromEntries(Object.entries(req.headers ?? {}).filter(([k]) => !generated.has(k.toLowerCase())));
  out["x-amz-date"] = longDate;
  if (opts.credentials.sessionToken) out["x-amz-security-token"] = opts.credentials.sessionToken;
  if (opts.signBody) out["x-amz-content-sha256"] = payloadHash;

  const canonical = new Map<string, string[]>([["host", [req.host]]]);
  for (const [name, value] of Object.entries(out)) {
    const key = name.toLowerCase();
    if (UNSIGNABLE.has(key) || key.startsWith("proxy-") || key.startsWith("sec-")) continue;
    canonical.set(key, [...(canonical.get(key) ?? []), value.replace(/\s+/g, " ").trim()]);
  }
  const names = [...canonical.keys()].sort();
  const signedHeaders = names.join(";");
  const canonicalRequest = [
    req.method.toUpperCase(),
    canonicalPath(req.path),
    canonicalQuery(req.query ?? ""),
    ...names.map((n) => `${n}:${canonical.get(n)!.join(",")}`),
    "",
    signedHeaders,
    payloadHash,
  ].join("\n");
  const scope = `${shortDate}/${opts.region}/${opts.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", longDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${opts.credentials.secretAccessKey}`, shortDate), opts.region), opts.service), "aws4_request");
  const signature = createHmac("sha256", key).update(stringToSign).digest("hex");
  out["authorization"] = `AWS4-HMAC-SHA256 Credential=${opts.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return out;
}

type Env = Record<string, string | undefined>;
type Ini = Record<string, Record<string, string>>;

/** Parses an AWS shared config or credentials file; a missing file reads as empty. */
async function readIni(path: string): Promise<Ini> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return {};
  }
  const out: Ini = {};
  let section: Record<string, string> | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const head = /^\[([^\]]+)\]/.exec(line);
    if (head) {
      section = out[head[1]!.trim().replace(/\s+/g, " ")] ??= {};
      continue;
    }
    const eq = line.indexOf("=");
    if (section && eq > 0) section[line.slice(0, eq).trim().toLowerCase()] = line.slice(eq + 1).trim();
  }
  return out;
}

/** The profile's settings: the config file's `[profile x]` (or `[default]`), overlaid by the credentials file's `[x]`. */
async function profileSettings(env: Env): Promise<{ name: string; settings: Record<string, string>; config: Record<string, string> }> {
  const name = env["AWS_PROFILE"] || "default";
  const home = env["HOME"] || env["USERPROFILE"] || homedir();
  const [config, credentials] = await Promise.all([
    readIni(env["AWS_CONFIG_FILE"] || join(home, ".aws", "config")),
    readIni(env["AWS_SHARED_CREDENTIALS_FILE"] || join(home, ".aws", "credentials")),
  ]);
  const fromConfig = name === "default" ? (config["default"] ?? config["profile default"]) : config[`profile ${name}`];
  return { name, settings: { ...fromConfig, ...credentials[name] }, config: { ...fromConfig } };
}

/**
 * Credentials as the AWS SDK's default chain finds them, limited to static keys: the
 * AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (/ AWS_SESSION_TOKEN) variables, skipped when
 * AWS_PROFILE is set as the SDK does, then the profile's keys in the shared files. A profile that
 * needs SSO, a role, a process or web identity, and container or instance roles, are not supported.
 */
export async function awsCredentials(env: Env): Promise<AwsCredentials | { missing: string }> {
  const accessKeyId = env["AWS_ACCESS_KEY_ID"];
  const secretAccessKey = env["AWS_SECRET_ACCESS_KEY"];
  if (!env["AWS_PROFILE"] && accessKeyId && secretAccessKey) {
    return { accessKeyId, secretAccessKey, ...(env["AWS_SESSION_TOKEN"] ? { sessionToken: env["AWS_SESSION_TOKEN"] } : {}) };
  }
  const { name, settings } = await profileSettings(env);
  const needs = ["role_arn", "sso_session", "sso_start_url", "credential_process", "web_identity_token_file"].find((k) => settings[k]);
  if (needs) return { missing: `AWS profile "${name}" uses ${needs}, which sandboxrouting does not resolve; set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY` };
  if (settings["aws_access_key_id"] && settings["aws_secret_access_key"]) {
    const token = settings["aws_session_token"];
    return { accessKeyId: settings["aws_access_key_id"], secretAccessKey: settings["aws_secret_access_key"], ...(token ? { sessionToken: token } : {}) };
  }
  return { missing: `no AWS credentials: set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, or keys for profile "${name}" in ~/.aws/credentials` };
}

/** AWS_REGION, then AWS_DEFAULT_REGION, then the profile's `region` in the shared config file. */
export async function awsRegion(env: Env): Promise<string | undefined> {
  return env["AWS_REGION"] || env["AWS_DEFAULT_REGION"] || (await profileSettings(env)).config["region"] || undefined;
}
