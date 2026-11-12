// REST API: one HTTP front for every provider, shaped like the providers' own sandbox APIs
// (and openci's). JSON in and out; bearer token when `serverToken` is set.
//
//   GET    /v1/providers                     free-tier status, availability, capabilities
//   POST   /v1/route                         dry run: the ranked plan for a spec
//   POST   /v1/sandboxes                     SandboxSpec → sandbox (+ route)
//   GET    /v1/sandboxes[?all=1]             list
//   GET    /v1/sandboxes/{id}                one
//   DELETE /v1/sandboxes/{id}                kill
//   POST   /v1/sandboxes/{id}/exec           {command, cwd?, env?, timeoutSec?} → {stdout, stderr, exitCode}
//   GET    /v1/sandboxes/{id}/files?path=    file bytes
//   PUT    /v1/sandboxes/{id}/files?path=    write bytes
//   GET    /v1/sandboxes/{id}/files/list?path=
//   GET    /v1/sandboxes/{id}/url?port=      {url}
//   POST   /v1/sandboxes/{id}/timeout        {timeoutSec}
//   POST   /v1/sandboxes/{id}/pause | /resume
//   POST   /v1/sweep                         reconcile with providers

import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { SandboxRouter } from "../core/router.js";
import { classify, NoProviderAvailableError, type ErrorKind } from "../core/errors.js";
import type { SandboxSpec } from "../core/types.js";

const STATUS: Record<ErrorKind, number> = {
  quota: 402,
  rate_limit: 429,
  auth: 502, // a provider's credentials are wrong: the router's problem, not the caller's
  not_found: 404,
  unsupported: 501,
  invalid: 400,
  transient: 502,
};

async function body(req: IncomingMessage, limit = 64 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw Object.assign(new Error("body too large"), { status: 413 });
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

async function json<T>(req: IncomingMessage): Promise<T> {
  const raw = await body(req);
  if (!raw.length) return {} as T;
  try {
    return JSON.parse(raw.toString("utf8")) as T;
  } catch {
    throw Object.assign(new Error("body is not JSON"), { status: 400 });
  }
}

function send(res: ServerResponse, status: number, payload: unknown) {
  const text = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

function authorized(req: IncomingMessage, token: string | undefined): boolean {
  if (!token) return true;
  const header = req.headers.authorization ?? "";
  const given = Buffer.from(header.startsWith("Bearer ") ? header.slice(7) : "");
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}

export function createServer(router: SandboxRouter): Server {
  return createHttpServer(async (req, res) => {
    try {
      if (!authorized(req, router.config.serverToken)) return send(res, 401, { error: "unauthorized" });
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      const method = req.method ?? "GET";
      if (parts[0] !== "v1") return send(res, 404, { error: "not found" });
      const [, resource, id, sub, subsub] = parts;

      if (resource === "health") return send(res, 200, { ok: true });
      if (resource === "providers" && method === "GET") {
        return send(res, 200, await router.status({ refreshUsage: url.searchParams.get("refresh") === "1" }));
      }
      if (resource === "route" && method === "POST") return send(res, 200, await router.plan(await json<SandboxSpec>(req)));
      if (resource === "sweep" && method === "POST") return send(res, 200, await router.sweep({ remote: true }));

      if (resource === "sandboxes") {
        if (!id) {
          if (method === "POST") {
            const sbx = await router.create(await json<SandboxSpec>(req));
            return send(res, 201, { ...(await sbx.info()), route: sbx.route });
          }
          if (method === "GET") return send(res, 200, await router.list({ all: url.searchParams.get("all") === "1" }));
        } else {
          if (!sub && method === "GET") {
            const view = await router.get(id);
            return view ? send(res, 200, view) : send(res, 404, { error: `no sandbox ${id}` });
          }
          if (!sub && method === "DELETE") {
            await router.kill(id);
            return send(res, 200, await router.get(id));
          }
          const sbx = await router.connect(id);
          const path = url.searchParams.get("path") ?? ".";
          if (sub === "exec" && method === "POST") {
            const b = await json<{ command: string; cwd?: string; env?: Record<string, string>; timeoutSec?: number }>(req);
            if (typeof b.command !== "string") return send(res, 400, { error: "command is required" });
            return send(res, 200, await sbx.commands.run(b.command, b));
          }
          if (sub === "files" && subsub === "list" && method === "GET") return send(res, 200, await sbx.files.list(path));
          if (sub === "files" && !subsub && method === "GET") {
            const data = await sbx.files.readBytes(path);
            res.writeHead(200, { "content-type": "application/octet-stream", "content-length": data.length });
            return res.end(data);
          }
          if (sub === "files" && !subsub && method === "PUT") {
            await sbx.files.write(path, new Uint8Array(await body(req)));
            return send(res, 200, { ok: true });
          }
          if (sub === "url" && method === "GET") return send(res, 200, { url: await sbx.getUrl(Number(url.searchParams.get("port"))) });
          if (sub === "timeout" && method === "POST") {
            await sbx.setTimeout((await json<{ timeoutSec: number }>(req)).timeoutSec);
            return send(res, 200, await sbx.info());
          }
          if (sub === "pause" && method === "POST") {
            await sbx.pause();
            return send(res, 200, await sbx.info());
          }
          if (sub === "resume" && method === "POST") {
            await sbx.resume();
            return send(res, 200, await sbx.info());
          }
        }
      }
      send(res, 404, { error: "not found" });
    } catch (raw) {
      const status = (raw as { status?: number }).status;
      if (status === 400 || status === 413) return send(res, status, { error: (raw as Error).message });
      if (raw instanceof NoProviderAvailableError) return send(res, 503, { error: raw.message, attempts: raw.attempts });
      const err = classify(raw);
      send(res, STATUS[err.kind], { error: err.message, kind: err.kind, provider: err.provider });
    }
  });
}
