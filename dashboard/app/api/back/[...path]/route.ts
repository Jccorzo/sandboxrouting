// The browser's only way to back: the paths the dashboard uses, with the session's key added.
// Writes need the X-Requested-With header the dashboard sends (a cross-site form can't), on top
// of the SameSite=Strict cookie.
import { cookies } from "next/headers";
import { type NextRequest } from "next/server";
import { SESSION_COOKIE, callBack } from "@/lib/server";

export const dynamic = "force-dynamic";

const ROUTES: Record<Method, RegExp> = {
  GET: /^(me|usage|providers|sandboxes|jobs|refusals|keys|credentials|config)$/,
  POST: /^(keys|keys\/[0-9a-f-]{36}\/revoke)$/i,
  PUT: /^(config|credentials\/[a-z0-9][a-z0-9-]{0,63})$/,
  DELETE: /^credentials\/[a-z0-9][a-z0-9-]{0,63}$/,
};
type Method = "GET" | "POST" | "PUT" | "DELETE";

const json = (status: number, code: string, message: string) => Response.json({ error: { code, message } }, { status, headers: { "cache-control": "no-store" } });

async function forward(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }, method: Method) {
  const path = (await ctx.params).path.join("/");
  if (!ROUTES[method].test(path)) return json(404, "not_found", "no such endpoint");
  if (method !== "GET" && req.headers.get("x-requested-with") !== "sbr-dashboard") return json(403, "forbidden", "missing request header");
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return json(401, "unauthorized", "sign in again");
  // Queries go with reads and removes (DELETE ?expectedVersion=n); bodies with POST and PUT.
  const query = method === "GET" || method === "DELETE" ? req.nextUrl.search : "";
  const body = method === "POST" || method === "PUT" ? await req.text() : undefined;
  const res = await callBack(`/v1/${path}${query}`, token, { ...(method === "GET" ? {} : { method }), ...(body === undefined ? {} : { body }) });
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

export function GET(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  return forward(req, ctx, "GET");
}

export function POST(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  return forward(req, ctx, "POST");
}

export function PUT(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  return forward(req, ctx, "PUT");
}

export function DELETE(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  return forward(req, ctx, "DELETE");
}
