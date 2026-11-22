// Server-only: where back is, and the session cookie. The browser never sees the API key: it
// lives in an httpOnly cookie, and the dashboard's own routes (app/api/) add it to calls to back.
import "server-only";
import type { AuthConfig } from "@sandboxrouting/back/api";

export const SESSION_COOKIE = "sbr_session";

/** BACK_URL: back's address as this server reaches it, e.g. http://back:8787 in Docker. */
export function backUrl(): string {
  const url = process.env["BACK_URL"];
  if (!url) throw new Error("BACK_URL is not set");
  return url.replace(/\/+$/, "");
}

/**
 * Calls back with a key or session token ("" for back's public routes). Never throws for HTTP
 * errors; a network failure surfaces as status 502.
 */
export async function callBack(path: string, token: string, init: { method?: string; body?: string } = {}): Promise<{ status: number; body: string }> {
  try {
    const res = await fetch(`${backUrl()}${path}`, {
      method: init.method ?? "GET",
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.body ? { "content-type": "application/json" } : {}) },
      ...(init.body ? { body: init.body } : {}),
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    return { status: res.status, body: await res.text() };
  } catch (err) {
    const why = err instanceof Error && err.name === "TimeoutError" ? "back didn't answer in time" : "back can't be reached";
    return { status: 502, body: JSON.stringify({ error: { code: "back_unreachable", message: why } }) };
  }
}

export function cookieOptions(secure: boolean) {
  return { httpOnly: true, sameSite: "strict" as const, secure, path: "/", maxAge: 60 * 60 * 24 * 30 };
}

/** How back signs people in, or undefined when back can't be reached. */
export async function authConfig(): Promise<AuthConfig | undefined> {
  const res = await callBack("/v1/auth/config", "");
  if (res.status !== 200) return undefined;
  try {
    return JSON.parse(res.body) as AuthConfig;
  } catch {
    return undefined;
  }
}

/** A session token (GitHub sign-in), as opposed to an admin API key. */
export const isSessionToken = (token: string) => token.startsWith("sbrs_");

/**
 * The dashboard's own address as the browser sees it: DASHBOARD_PUBLIC_URL, else the forwarded
 * protocol and host (Cloud Run and most proxies set them), else the request's own.
 */
export function publicOrigin(req: { headers: Headers; nextUrl: URL }): string {
  const set = process.env["DASHBOARD_PUBLIC_URL"];
  if (set) return set.replace(/\/+$/, "");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  const proto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  return host && proto ? `${proto}://${host}` : req.nextUrl.origin;
}
