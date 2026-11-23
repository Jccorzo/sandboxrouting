// REST API: one HTTP front for every provider, shaped like the providers' own sandbox APIs
// (and openci's). JSON in and out; bearer token when `serverToken` is set.
//
//   GET    /v1/providers                     free-tier status, availability, health, capabilities
//   GET    /v1/strategies                    [{name, description, active}]
//   POST   /v1/route[?compare=1]             dry run: the ranked plan for a spec (+ `strategy`);
//                                            compare=1: {[strategy]: plan} under every strategy
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
//   POST   /v1/sandboxes/{id}/move           {workdir?, spec?} → 201, the new sandbox (+ route); the old one is killed
//   POST   /v1/jobs[?wait=1]                 JobSpec → 202 and the job once this server has claimed it (it
//                                            drives it on); wait=1: 200 and the job once it has ended
//   GET    /v1/jobs[?all=1]                  unfinished jobs (all with all=1)
//   GET    /v1/jobs/{id}                     one
//   POST   /v1/jobs/{id}/resume              202 once claimed and driven here; 409 and the job while another
//                                            runner holds it; 200 and the job if it already ended
//   POST   /v1/jobs/{id}/cancel              the job after cancelling (one that already ended, as it ended)
//   GET    /v1/jobs/{id}/workspace           latest workspace archive (application/gzip)
//   POST   /v1/sweep                         reconcile with providers and jobs → {sandboxes, jobs}

import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { SandboxRouter } from "../core/router.js";
import { strategyNameFor } from "../core/config.js";
import { classify, NoProviderAvailableError, type ErrorKind } from "../core/errors.js";
import type { JobManagerApi, JobRunOptions, JobSpec, JobView } from "../core/jobs/types.js";
import type { SandboxSpec } from "../core/types.js";

const STATUS: Record<ErrorKind, number> = {
  quota: 402,
  rate_limit: 429,
  auth: 502, // a provider's credentials are wrong: the router's problem, not the caller's
  not_found: 404,
  unsupported: 501,
  invalid: 400,
  conflict: 409,
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

type Started = { claimed: JobView } | { ended: JobView };

/**
 * Starts driving a job in this process. `first` settles as soon as this process holds the job,
 * or with how it ended when there was nothing to claim, or with whatever stopped it before a
 * claim (an invalid request, an unknown job, another runner's live lease). `done` is the drive.
 */
function start(go: (opts: JobRunOptions) => Promise<JobView>): { first: Promise<Started>; done: Promise<JobView> } {
  let done!: Promise<JobView>;
  const first = new Promise<Started>((resolve, reject) => {
    done = go({ onClaimed: (job) => resolve({ claimed: job }) });
    done.then((job) => resolve({ ended: job }), reject);
  });
  return { first, done };
}

/** The drive goes on after the answer; nobody waits for it, so its failures go to stderr. */
function inBackground(id: string, done: Promise<JobView>): void {
  done.catch((raw) => console.error(`[sbr] job ${id}: ${classify(raw).message}`));
}

/** Another runner holds the job: 409 with where it stands now. Anything else goes to the error handler. */
async function conflictOr(res: ServerResponse, jobs: JobManagerApi, id: string, raw: unknown): Promise<void> {
  const err = classify(raw);
  if (err.kind !== "conflict") throw raw;
  send(res, 409, { error: err.message, kind: err.kind, job: await jobs.get(id) });
}

export interface HandleOptions {
  /**
   * Jobs keep driving after the request that started them returns, so they need a process that
   * lives on. false: /v1/jobs answers 404 and /v1/sweep leaves jobs alone (the hosted router,
   * which builds a router per request). Default true.
   */
  jobs?: boolean;
}

export function createServer(router: SandboxRouter): Server {
  return createHttpServer(async (req, res) => {
    if (!authorized(req, router.config.serverToken)) return send(res, 401, { error: "unauthorized" });
    await handleRequest(router, req, res);
  });
}

/**
 * Answers one REST request with `router`. The caller has already decided who may call: the local
 * server checks `serverToken`; the hosted router checks the account's key and builds its router.
 */
export async function handleRequest(router: SandboxRouter, req: IncomingMessage, res: ServerResponse, opts: HandleOptions = {}): Promise<void> {
  const withJobs = opts.jobs !== false;
  const jobs = (): JobManagerApi => router.jobs;
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const method = req.method ?? "GET";
    if (parts[0] !== "v1") return send(res, 404, { error: "not found" });
    const [, resource, id, sub, subsub] = parts;

    if (resource === "health") return send(res, 200, { ok: true });
    if (resource === "providers" && method === "GET") {
      return send(res, 200, await router.status({ refreshUsage: url.searchParams.get("refresh") === "1" }));
    }
    if (resource === "strategies" && method === "GET") {
      const active = strategyNameFor(router.config);
      return send(res, 200, router.strategies().map((s) => ({ name: s.name, description: s.description, active: s.name === active })));
    }
    if (resource === "route" && method === "POST") {
      const spec = await json<SandboxSpec>(req);
      if (url.searchParams.get("compare") !== "1") return send(res, 200, await router.plan(spec));
      // The same request under every strategy, so the request's own `strategy` doesn't matter.
      const plans = await Promise.all(router.strategies().map((s) => router.plan({ ...spec, strategy: s.name })));
      return send(res, 200, Object.fromEntries(plans.map((p) => [p.strategy, p])));
    }
    if (resource === "sweep" && method === "POST") {
      const sandboxes = await router.sweep({ remote: true });
      if (!withJobs) return send(res, 200, { sandboxes });
      // This server lives on, so it can drive orphaned jobs itself.
      return send(res, 200, { sandboxes, jobs: await jobs().sweep({ resumeOrphans: true }) });
    }

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
        // Before connect: move connects itself, and connecting twice to a provider:id would adopt it twice.
        if (sub === "move" && method === "POST") {
          const b = await json<{ workdir?: string; spec?: SandboxSpec }>(req);
          if (b.workdir !== undefined && typeof b.workdir !== "string") return send(res, 400, { error: "workdir must be a path" });
          const sbx = await router.move(id, { workdir: b.workdir, spec: b.spec });
          return send(res, 201, { ...(await sbx.info()), route: sbx.route });
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
          res.end(data);
          return;
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

    if (resource === "jobs" && !withJobs) return send(res, 404, { error: "jobs aren't available here" });
    if (resource === "jobs") {
      const jobsApi = jobs();
      if (!id) {
        if (method === "POST") {
          const spec = await json<JobSpec>(req);
          // run() checks the request (checkJobSpec): an invalid one rejects before the claim, as a 400.
          const { first, done } = start((opts) => jobsApi.run(spec, opts));
          const started = await first;
          if ("ended" in started) return send(res, 200, started.ended);
          const jobId = started.claimed.id;
          if (url.searchParams.get("wait") !== "1") {
            inBackground(jobId, done);
            return send(res, 202, started.claimed);
          }
          try {
            return send(res, 200, await done);
          } catch (raw) {
            // Awaited, so anything but a conflict reaches the error handler below.
            return await conflictOr(res, jobsApi, jobId, raw);
          }
        }
        if (method === "GET") return send(res, 200, await jobsApi.list({ all: url.searchParams.get("all") === "1" }));
      } else {
        if (!sub && method === "GET") {
          const view = await jobsApi.get(id);
          return view ? send(res, 200, view) : send(res, 404, { error: `no job ${id}` });
        }
        if (sub === "resume" && method === "POST") {
          // Decided by the claim itself, never by a read before it.
          const { first, done } = start((opts) => jobsApi.resume(id, opts));
          let started: Started;
          try {
            started = await first;
          } catch (raw) {
            // A runner here or elsewhere holds its lease: 409. An unknown job: 404 from the handler below.
            return await conflictOr(res, jobsApi, id, raw);
          }
          // Already over: nothing was claimed, and the job says how it ended.
          if ("ended" in started) return send(res, 200, started.ended);
          inBackground(id, done);
          return send(res, 202, started.claimed);
        }
        if (sub === "cancel" && method === "POST") return send(res, 200, await jobsApi.cancel(id));
        if (sub === "workspace" && method === "GET") {
          const data = await jobsApi.workspace(id);
          if (!data) return send(res, 404, { error: `job ${id} has no workspace archive yet` });
          res.writeHead(200, { "content-type": "application/gzip", "content-length": data.byteLength });
          res.end(data);
          return;
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
}
