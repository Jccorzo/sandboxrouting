// GitHub sign-in, the browser half's pieces. The start route keeps a state and a PKCE verifier in
// a short-lived httpOnly cookie scoped to /api/auth/github; the callback checks the state, sends
// the code and verifier to back (which alone holds the client secret), and clears the cookie on
// every outcome. Pure functions, so they're tested without a server.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const OAUTH_COOKIE = "sbr_oauth";
export const OAUTH_PATH = "/api/auth/github";
export const CALLBACK_PATH = `${OAUTH_PATH}/callback`;
/** How long someone has at GitHub before the sign-in has to start over. */
export const OAUTH_MAX_AGE = 600;

export interface Pending {
  state: string;
  verifier: string;
}

export function newPending(): Pending {
  return { state: randomBytes(32).toString("base64url"), verifier: randomBytes(48).toString("base64url") };
}

export const encodePending = (p: Pending) => `${p.state}.${p.verifier}`;

export function decodePending(raw: string | undefined): Pending | undefined {
  const m = raw?.match(/^([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43,128})$/);
  return m ? { state: m[1]!, verifier: m[2]! } : undefined;
}

export function authorizeUrl(clientId: string, redirectUri: string, p: Pending): string {
  const u = new URL("https://github.com/login/oauth/authorize");
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("state", p.state);
  u.searchParams.set("code_challenge", createHash("sha256").update(p.verifier).digest("base64url"));
  u.searchParams.set("code_challenge_method", "S256");
  return u.toString();
}

export function sameState(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export type CallbackStep =
  | { kind: "exchange"; code: string; verifier: string }
  | { kind: "failed"; error: LoginError };

/** What the callback does with what GitHub sent back and the cookie the start route left. */
export function checkCallback(params: URLSearchParams, cookie: string | undefined): CallbackStep {
  if (params.get("error")) return { kind: "failed", error: params.get("error") === "access_denied" ? "github_denied" : "github_failed" };
  const pending = decodePending(cookie);
  const code = params.get("code");
  const state = params.get("state");
  if (!pending || !code || !state) return { kind: "failed", error: "expired" };
  if (!sameState(state, pending.state)) return { kind: "failed", error: "expired" };
  return { kind: "exchange", code, verifier: pending.verifier };
}

/**
 * Why a sign-in didn't work, as a code in the login page's URL. The page shows its own message
 * for each, never text from the URL.
 */
export type LoginError =
  | "github_denied"
  | "github_failed"
  | "expired"
  | "bad_code"
  | "github_unavailable"
  | "not_entitled"
  | "account_disabled"
  | "github_off"
  | "back_unreachable";

const MESSAGES: Record<LoginError, string> = {
  github_denied: "You cancelled the sign-in on GitHub.",
  github_failed: "GitHub couldn't complete the sign-in. Try again.",
  expired: "That sign-in took too long or was already used. Try again.",
  bad_code: "GitHub didn't accept that sign-in (it may have expired). Try again.",
  github_unavailable: "GitHub didn't answer. Try again in a moment.",
  not_entitled: "This GitHub account can't make an account here right now.",
  account_disabled: "This account is disabled.",
  github_off: "GitHub sign-in isn't set up on this server. Sign in with an admin key.",
  back_unreachable: "The dashboard can't reach its server. Try again in a moment.",
};

export function loginErrorMessage(code: string | string[] | undefined): string | undefined {
  return typeof code === "string" && code in MESSAGES ? MESSAGES[code as LoginError] : undefined;
}

/** back's error code for a failed exchange, as a LoginError. */
export function exchangeError(status: number, code: string | undefined): LoginError {
  if (code && code in MESSAGES) return code as LoginError;
  return status === 502 ? "back_unreachable" : "github_failed";
}
