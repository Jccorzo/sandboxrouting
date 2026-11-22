// GitHub OAuth, the server half. The dashboard sends the person to GitHub with a state and a PKCE
// challenge and brings back the code; back, which alone holds the client secret, exchanges the
// code (with the PKCE verifier) for a token, reads who that is, and throws the token away. No
// GitHub scope is asked for: the public profile (id, login) is all back keeps.

export interface GitHubConfig {
  clientId: string;
  clientSecret: string;
  /** For tests. */
  fetch?: typeof fetch;
  /** For tests or GitHub Enterprise: default https://github.com and https://api.github.com. */
  webBase?: string;
  apiBase?: string;
}

export class GitHubError extends Error {
  override name = "GitHubError";
  constructor(
    readonly code: "bad_code" | "github_unavailable",
    message: string,
  ) {
    super(message);
  }
}

export interface GitHubUser {
  githubId: number;
  login: string;
  githubCreatedAt?: string;
}

const TIMEOUT_MS = 10_000;

export async function exchangeCode(cfg: GitHubConfig, code: string, verifier: string, redirectUri: string): Promise<GitHubUser> {
  const f = cfg.fetch ?? fetch;
  const web = (cfg.webBase ?? "https://github.com").replace(/\/+$/, "");
  const api = (cfg.apiBase ?? "https://api.github.com").replace(/\/+$/, "");

  let tokenRes: Response;
  try {
    tokenRes = await f(`${web}/login/oauth/access_token`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ client_id: cfg.clientId, client_secret: cfg.clientSecret, code, code_verifier: verifier, redirect_uri: redirectUri }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new GitHubError("github_unavailable", "GitHub didn't answer. Try again.");
  }
  if (tokenRes.status >= 500) throw new GitHubError("github_unavailable", `GitHub answered ${tokenRes.status}. Try again.`);
  // GitHub answers 200 with { error } for a bad, used or expired code.
  const tok = (await tokenRes.json().catch(() => ({}))) as { access_token?: unknown; error?: unknown };
  if (typeof tok.access_token !== "string" || !tok.access_token) throw new GitHubError("bad_code", "GitHub didn't accept that sign-in (it may have expired). Sign in again.");

  let userRes: Response;
  try {
    userRes = await f(`${api}/user`, {
      headers: { accept: "application/vnd.github+json", authorization: `Bearer ${tok.access_token}`, "user-agent": "sandboxrouting" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new GitHubError("github_unavailable", "GitHub didn't answer. Try again.");
  }
  if (!userRes.ok) throw new GitHubError(userRes.status >= 500 ? "github_unavailable" : "bad_code", `GitHub answered ${userRes.status} for the profile.`);
  const u = (await userRes.json().catch(() => ({}))) as { id?: unknown; login?: unknown; created_at?: unknown };
  if (!Number.isSafeInteger(u.id) || (u.id as number) <= 0 || typeof u.login !== "string" || !u.login) {
    throw new GitHubError("github_unavailable", "GitHub's profile answer had no id or login.");
  }
  return { githubId: u.id as number, login: u.login, ...(typeof u.created_at === "string" ? { githubCreatedAt: u.created_at } : {}) };
}
