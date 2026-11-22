// The browser's only way to back: the paths the dashboard uses, with the session's key added.
// Writes need the X-Requested-With header the dashboard sends (a cross-site form can't), on top
// of the SameSite=Strict cookie.
import { cookies } from "next/headers";
import { type NextRequest } from "next/server";
import { SESSION_COOKIE, callBack } from "@/lib/server";

export const dynamic = "force-dynamic";

const READS = /^(me|usage|providers|sandboxes|jobs|refusals|keys)$/;
const WRITES = /^(keys|keys\/[0-9a-f-]{36}\/revoke)$/i;

const json = (status: number, code: string, message: string) => Response.json({ error: { code, message } }, { status, headers: { "cache-control": "no-store" } });

async function forward(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }, method: "GET" | "POST") {
  const path = (await ctx.params).path.join("/");
  if (!(method === "GET" ? READS : WRITES).test(path)) return json(404, "not_found", "no such endpoint");
  if (method === "POST" && req.headers.get("x-requested-with") !== "sbr-dashboard") return json(403, "forbidden", "missing request header");
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return json(401, "unauthorized", "sign in again");
  const query = req.nextUrl.search;
  const res = await callBack(`/v1/${path}${method === "GET" ? query : ""}`, token, method === "POST" ? { method, body: await req.text() } : {});
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

export function GET(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  return forward(req, ctx, "GET");
}

export function POST(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  return forward(req, ctx, "POST");
}
