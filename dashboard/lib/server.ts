// Server-only: where back is, and the session cookie. The browser never sees the API key: it
// lives in an httpOnly cookie, and the dashboard's own routes (app/api/) add it to calls to back.
import "server-only";

export const SESSION_COOKIE = "sbr_session";

/** BACK_URL: back's address as this server reaches it, e.g. http://back:8787 in Docker. */
export function backUrl(): string {
  const url = process.env["BACK_URL"];
  if (!url) throw new Error("BACK_URL is not set");
  return url.replace(/\/+$/, "");
}

/** Calls back with a key. Never throws for HTTP errors; a network failure surfaces as status 502. */
export async function callBack(path: string, token: string, init: { method?: string; body?: string } = {}): Promise<{ status: number; body: string }> {
  try {
    const res = await fetch(`${backUrl()}${path}`, {
      method: init.method ?? "GET",
      headers: { authorization: `Bearer ${token}`, ...(init.body ? { "content-type": "application/json" } : {}) },
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
