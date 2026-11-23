// The hosted router's HTTP service. Each request authenticates a router key (or an admin key or
// sign-in), builds that account's router (account.ts), answers, and keeps nothing:
//
//   POST /mcp                      MCP over streamable HTTP, stateless: the router's sandbox tools
//                                  (not jobs) plus list_connections, connect_provider,
//                                  remove_provider, get_config and set_config
//   /v1/…                          the router's REST API (src/server/http.ts), without /v1/jobs
//   POST /internal/sweep           sweep token: reconciles every account with sandboxes that may
//                                  still be running (deadlines the provider doesn't enforce, boxes
//                                  the ledger closed but the provider still runs)
//   GET  /health                   checks the database
//
// Nothing runs between requests: Cloud Scheduler calls the sweep.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Db } from "../db.js";
import { sameSecret } from "../keys.js";
import { resolvePlugins, type BackPlugins, type Principal, type ResolvedPlugins } from "../plugins.js";
import type { SecretBox } from "../secrets.js";
import { AccountCredentials } from "./credentials.js";
import { accountRouter, type AccountRouterDeps } from "./account.js";
import { registerVaultTools } from "./tools.js";
import { createMcpServer, handleRequest, type ProviderAdapter } from "./from-router.js";

export interface HostedOptions {
  db: Db;
  /** Opens (and, for connect_provider, seals) saved provider keys. */
  secrets: SecretBox;
  plugins?: BackPlugins;
  /** Lets Cloud Scheduler call /internal/sweep. Without it, the sweep endpoint is off. */
  sweepToken?: string;
  /** Live sandboxes an account may have at once. Default 10. */
  maxLive?: number;
  /** The providers it runs. Default: the hosted catalog's. */
  adapters?: () => ProviderAdapter[];
  version?: string;
  now?: () => number;
  log?: (msg: string, err?: unknown) => void;
}

const MCP_BODY_LIMIT = 4 * 1024 * 1024;

function send(res: ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}) {
  const text = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text), "cache-control": "no-store", ...headers });
  res.end(text);
}

async function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw Object.assign(new Error(`the body may be at most ${limit} bytes`), { status: 413 });
    chunks.push(c as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return raw ? JSON.parse(raw) : undefined;
  } catch {
    throw Object.assign(new Error("the body is not JSON"), { status: 400 });
  }
}

const bearer = (req: IncomingMessage) => {
  const h = req.headers.authorization ?? "";
  return h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : "";
};

export interface SweepResult {
  accounts: number;
  stopped: number;
  failed: number;
  reaped: number;
  errors: number;
}

export function createHostedHandler(opts: HostedOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const { db } = opts;
  const plugins: ResolvedPlugins = resolvePlugins(opts.plugins);
  const log = opts.log ?? ((msg, err) => console.error(msg, err));
  const version = opts.version ?? "dev";
  const deps: AccountRouterDeps = {
    db,
    plugins,
    credentials: new AccountCredentials(opts.secrets, { log, ...(opts.now ? { now: opts.now } : {}) }),
    maxLive: opts.maxLive ?? 10,
    version,
    log,
    ...(opts.adapters ? { adapters: opts.adapters } : {}),
    ...(opts.now ? { now: opts.now } : {}),
  };

  /** The caller, or an answer saying why not. */
  async function authenticate(req: IncomingMessage, res: ServerResponse): Promise<Principal | undefined> {
    const p = await plugins.auth.authenticate(bearer(req), db);
    if (!p) {
      send(res, 401, { error: "send a router key: Authorization: Bearer sbrk_… (make one on the dashboard's API keys page)" }, { "www-authenticate": 'Bearer realm="sandboxrouting"' });
      return undefined;
    }
    if (p.scope !== "router" && p.scope !== "admin") {
      send(res, 403, { error: `this is an ${p.scope} key; the hosted router takes a router key` });
      return undefined;
    }
    const d = await plugins.entitlements.check(p, "route", { db });
    if (!d.ok) {
      send(res, d.status, { error: d.reason });
      return undefined;
    }
    return p;
  }

  async function mcp(req: IncomingMessage, res: ServerResponse, p: Principal) {
    const body = await readJson(req, MCP_BODY_LIMIT);
    const router = await accountRouter(deps, { principal: p });
    const server = createMcpServer(router, { jobs: false, version });
    registerVaultTools(server, { db, plugins, secrets: opts.secrets, principal: p });
    // Stateless: no session id, a new server and transport per request, answers as plain JSON.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  async function sweepAll(): Promise<SweepResult> {
    // Accounts with something that may still be running, or that changed in the last day (a
    // kill that failed after its stop was recorded leaves a box only the remote sweep reaps).
    const { rows } = await db.query<{ account_id: string }>(
      `SELECT account_id FROM router_ledgers r
       WHERE r.updated_at > now() - interval '1 day'
          OR EXISTS (SELECT 1 FROM jsonb_each(r.data->'sandboxes') s WHERE s.value->>'state' IN ('creating', 'running', 'paused'))
       ORDER BY account_id`,
    );
    const out: SweepResult = { accounts: rows.length, stopped: 0, failed: 0, reaped: 0, errors: 0 };
    for (const { account_id } of rows) {
      try {
        const router = await accountRouter(deps, { sweep: true, accountId: account_id });
        const r = await router.sweep({ remote: true });
        out.stopped += r.stopped;
        out.failed += r.failed;
        out.reaped += r.reaped;
      } catch (err) {
        out.errors++;
        log(`hosted: sweeping account ${account_id} failed`, err);
      }
    }
    return out;
  }

  return async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;
      const method = req.method ?? "GET";

      if (path === "/health" && method === "GET") {
        await db.query("SELECT 1");
        return send(res, 200, { ok: true });
      }
      if (path === "/internal/sweep") {
        if (method !== "POST") return send(res, 405, { error: "POST" }, { allow: "POST" });
        const token = bearer(req);
        if (!opts.sweepToken || !token || !sameSecret(token, opts.sweepToken)) return send(res, 401, { error: "send the sweep token" });
        return send(res, 200, await sweepAll());
      }
      if (path === "/mcp") {
        // Stateless: there is no session to stream to (GET) or to end (DELETE).
        if (method !== "POST") return send(res, 405, { error: "this MCP server is stateless: POST only" }, { allow: "POST" });
        const p = await authenticate(req, res);
        if (!p) return;
        return await mcp(req, res, p);
      }
      if (path === "/v1" || path.startsWith("/v1/")) {
        const p = await authenticate(req, res);
        if (!p) return;
        const router = await accountRouter(deps, { principal: p });
        return await handleRequest(router, req, res, { jobs: false });
      }
      send(res, 404, { error: "not found" });
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 400 || status === 413) return send(res, status, { error: (err as Error).message });
      log(`hosted: ${req.method} ${req.url} failed`, err);
      if (!res.headersSent) send(res, 500, { error: "something went wrong on our side" });
      else res.end();
    }
  };
}

export function createHostedServer(opts: HostedOptions): Server {
  const handler = createHostedHandler(opts);
  return createServer((req, res) => void handler(req, res));
}
