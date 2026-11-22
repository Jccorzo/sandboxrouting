// GitHub sends the person back here. The state must match the cookie the start route left; back
// exchanges the code for a session; the cookie is cleared whatever happens.
import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, callBack, cookieOptions, publicOrigin } from "@/lib/server";
import { CALLBACK_PATH, OAUTH_COOKIE, OAUTH_PATH, checkCallback, exchangeError } from "@/lib/oauth";
import type { SignedIn } from "@sandboxrouting/back/api";

export const dynamic = "force-dynamic";

/**
 * The session cookie is SameSite=Strict, and a browser won't send it on a redirect chain that
 * began at GitHub. So instead of a redirect, a page on our own origin moves on to the dashboard:
 * that navigation is same-site and carries the cookie.
 */
function continuePage(to: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${to}"><title>Signing in…</title></head><body style="font-family:system-ui,sans-serif;padding:2rem"><p>Signing you in… <a href="${to}">Continue</a></p></body></html>`;
}

export async function GET(req: NextRequest) {
  const origin = publicOrigin(req);
  const secure = origin.startsWith("https:");
  const clear = (res: NextResponse) => {
    res.cookies.set(OAUTH_COOKIE, "", { httpOnly: true, sameSite: "lax", secure, path: OAUTH_PATH, maxAge: 0 });
    res.headers.set("cache-control", "no-store");
    return res;
  };
  const toLogin = (error: string) => clear(NextResponse.redirect(`${origin}/login?error=${error}`, 303));

  const step = checkCallback(req.nextUrl.searchParams, req.cookies.get(OAUTH_COOKIE)?.value);
  if (step.kind === "failed") return toLogin(step.error);

  const res = await callBack("/v1/sessions/github", "", {
    method: "POST",
    body: JSON.stringify({ code: step.code, verifier: step.verifier, redirectUri: `${origin}${CALLBACK_PATH}` }),
  });
  if (res.status !== 201) {
    let code: string | undefined;
    try {
      code = (JSON.parse(res.body) as { error?: { code?: string } }).error?.code;
    } catch {
      code = undefined;
    }
    return toLogin(exchangeError(res.status, code));
  }
  const signed = JSON.parse(res.body) as SignedIn;
  // A new account starts on the keys page, where its first ingest key is made.
  const out = clear(new NextResponse(continuePage(signed.created ? "/keys?welcome=1" : "/"), { headers: { "content-type": "text/html; charset=utf-8" } }));
  out.cookies.set(SESSION_COOKIE, signed.token, cookieOptions(secure));
  return out;
}
