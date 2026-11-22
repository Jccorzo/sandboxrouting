// Sign in with an admin API key (checked against back before the cookie is set) and sign out.
import { cookies } from "next/headers";
import { type NextRequest } from "next/server";
import { SESSION_COOKIE, callBack, cookieOptions } from "@/lib/server";
import type { Me } from "@sandboxrouting/back/api";

export const dynamic = "force-dynamic";

const json = (status: number, body: unknown) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
const secure = (req: NextRequest) => req.nextUrl.protocol === "https:" || req.headers.get("x-forwarded-proto") === "https";

export async function POST(req: NextRequest) {
  if (req.headers.get("x-requested-with") !== "sbr-dashboard") return json(403, { error: { code: "forbidden", message: "missing request header" } });
  const body = (await req.json().catch(() => ({}))) as { token?: unknown };
  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (!token) return json(400, { error: { code: "invalid", message: "Paste an admin API key." } });

  const res = await callBack("/v1/me", token);
  if (res.status === 401) return json(401, { error: { code: "unauthorized", message: "That key isn't valid, or it was revoked." } });
  if (res.status !== 200) return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
  const me = JSON.parse(res.body) as Me;
  if (me.key.scope !== "admin") return json(403, { error: { code: "wrong_scope", message: "That's an ingest key, for routers. The dashboard needs an admin key." } });

  (await cookies()).set(SESSION_COOKIE, token, cookieOptions(secure(req)));
  return json(200, { account: me.account });
}

export async function DELETE(req: NextRequest) {
  if (req.headers.get("x-requested-with") !== "sbr-dashboard") return json(403, { error: { code: "forbidden", message: "missing request header" } });
  (await cookies()).delete(SESSION_COOKIE);
  return json(200, { ok: true });
}
