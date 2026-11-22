// GitHub sign-in's browser half: the callback only goes on with a code whose state matches the
// cookie the start route left, and the login page shows its own messages, never URL text.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { authorizeUrl, checkCallback, decodePending, encodePending, exchangeError, loginErrorMessage, newPending } from "@/lib/oauth";

const params = (o: Record<string, string>) => new URLSearchParams(o);

describe("oauth", () => {
  it("round-trips the pending sign-in through its cookie, and refuses a malformed one", () => {
    const p = newPending();
    expect(decodePending(encodePending(p))).toEqual(p);
    expect(decodePending(undefined)).toBeUndefined();
    expect(decodePending("short.x")).toBeUndefined();
    expect(decodePending(`${p.state}.${p.verifier}.extra`)).toBeUndefined();
  });

  it("asks GitHub for no scope, with an S256 challenge of the verifier", () => {
    const p = newPending();
    const u = new URL(authorizeUrl("cid", "https://app.example/api/auth/github/callback", p));
    expect(u.origin + u.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(u.searchParams.get("code_challenge")).toBe(createHash("sha256").update(p.verifier).digest("base64url"));
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("state")).toBe(p.state);
    expect(u.searchParams.has("scope")).toBe(false);
  });

  it("goes on only with a code and the state the cookie holds", () => {
    const p = newPending();
    const cookie = encodePending(p);
    expect(checkCallback(params({ code: "c", state: p.state }), cookie)).toEqual({ kind: "exchange", code: "c", verifier: p.verifier });
    expect(checkCallback(params({ code: "c", state: newPending().state }), cookie)).toEqual({ kind: "failed", error: "expired" });
    expect(checkCallback(params({ code: "c", state: p.state }), undefined)).toEqual({ kind: "failed", error: "expired" });
    expect(checkCallback(params({ state: p.state }), cookie)).toEqual({ kind: "failed", error: "expired" });
    expect(checkCallback(params({ error: "access_denied", state: p.state }), cookie)).toEqual({ kind: "failed", error: "github_denied" });
  });

  it("shows a known message for each error code and nothing for anything else", () => {
    expect(loginErrorMessage("expired")).toMatch(/took too long/);
    expect(loginErrorMessage("<script>")).toBeUndefined();
    expect(loginErrorMessage(["expired"])).toBeUndefined();
    expect(exchangeError(401, "bad_code")).toBe("bad_code");
    expect(exchangeError(502, undefined)).toBe("back_unreachable");
    expect(exchangeError(500, "weird")).toBe("github_failed");
  });
});
