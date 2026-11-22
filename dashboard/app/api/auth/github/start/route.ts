// Starts a GitHub sign-in: a fresh state and PKCE verifier in a short-lived cookie, then GitHub.
import { NextResponse, type NextRequest } from "next/server";
import { authConfig, publicOrigin } from "@/lib/server";
import { CALLBACK_PATH, OAUTH_COOKIE, OAUTH_MAX_AGE, OAUTH_PATH, authorizeUrl, encodePending, newPending } from "@/lib/oauth";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const origin = publicOrigin(req);
  const cfg = await authConfig();
  if (!cfg) return NextResponse.redirect(`${origin}/login?error=back_unreachable`, 303);
  if (!cfg.github) return NextResponse.redirect(`${origin}/login?error=github_off`, 303);
  const pending = newPending();
  const res = NextResponse.redirect(authorizeUrl(cfg.github.clientId, `${origin}${CALLBACK_PATH}`, pending), 303);
  // Lax, not Strict: GitHub's redirect back is a cross-site navigation, and it must carry this.
  res.cookies.set(OAUTH_COOKIE, encodePending(pending), {
    httpOnly: true,
    sameSite: "lax",
    secure: origin.startsWith("https:"),
    path: OAUTH_PATH,
    maxAge: OAUTH_MAX_AGE,
  });
  res.headers.set("cache-control", "no-store");
  return res;
}
