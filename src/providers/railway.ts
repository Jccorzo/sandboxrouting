// Railway Sandboxes: isolated Linux VMs inside a Railway environment (Ubuntu with git and Node).
// Billed per second for the CPU actually used and the memory in use: $0.00001929 per
// vCPU-second and per GB-second, plus $0.05 per GB out. Free Trial: a one-time $5 credit for
// 30 days without a card, 10 running per environment, 2 vCPU / 2 GB at most, and an idle
// timeout of 5 minutes at most (Hobby and Pro: 1 to 120 minutes).
// There is no lifetime limit, only that idle timeout, so the router deletes a sandbox at its
// deadline and the sweep catches any it missed.
// API: Railway's public GraphQL API, https://backboard.railway.com/graphql/v2. A project
// token goes in `Project-Access-Token` and names its environment; an account or workspace
// token goes in `Authorization: Bearer` and needs RAILWAY_ENVIRONMENT_ID. Errors come back in
// a 200 with `errors`. `sandboxExec` runs a command in one request: 10 minutes at most, each
// stream cut at 16,000 bytes. Files and streamed exec use a WebSocket, so files go through the
// router's exec fallback. No idempotency key on `sandboxCreate`.
// Docs: https://docs.railway.com/sandboxes.md, https://railway.com/pricing; the operations are
// taken from the official SDK, npm `railway` 3.17.0 (dist/index.js: RailwaySandboxCreate,
// RailwaySandboxExec, RailwaySandboxDestroy, RailwaySandboxes, RailwayProjectToken).

import { defineProvider, http, HttpError } from "./util.js";
import { inline, pollMs, sleep } from "./rest-helpers.js";
import type { ProviderContext } from "../core/types.js";

const EXEC_LIMIT_SEC = 600;
const FIELDS = "id status environmentId region idleTimeoutMinutes";

const endpoint = (ctx: ProviderContext) => String(ctx.env["RAILWAY_GRAPHQL_ENDPOINT"] ?? "https://backboard.railway.com/graphql/v2");
const projectToken = (ctx: ProviderContext) => ctx.env["RAILWAY_TOKEN"];
const auth = (ctx: ProviderContext): Record<string, string> =>
  projectToken(ctx) ? { "project-access-token": String(projectToken(ctx)) } : { authorization: `Bearer ${ctx.env["RAILWAY_API_TOKEN"]}` };

/** A GraphQL error has no status of its own; this gives the router one it can classify. */
function statusFor(message: string, code?: string): number | undefined {
  if (/UNAUTHENTICATED|FORBIDDEN/.test(code ?? "") || /not authori[sz]ed|unauthenticated|invalid token/i.test(message)) return 401;
  if (/rate.?limit|too many requests/i.test(message)) return 429;
  if (/not found|does not exist/i.test(message)) return 404;
  return undefined;
}

async function gql<T>(ctx: ProviderContext, query: string, variables: Record<string, unknown>, timeoutMs?: number): Promise<T> {
  const res = await http(endpoint(ctx), { method: "POST", headers: { ...auth(ctx), accept: "application/json" }, body: { query, variables }, timeoutMs });
  const body = (await res.json()) as { data?: T; errors?: { message: string; extensions?: { code?: string } }[] };
  const err = body.errors?.[0];
  if (err) {
    const message = `railway: ${err.message}`;
    const status = statusFor(err.message, err.extensions?.code);
    throw status ? new HttpError(status, message) : new Error(message);
  }
  if (!body.data) throw new Error("railway: the response had no data");
  return body.data;
}

/** Project tokens are scoped to one environment, which Railway reports; others name it in env. */
const environments = new Map<string, Promise<string>>();
async function environmentId(ctx: ProviderContext): Promise<string> {
  const named = ctx.env["RAILWAY_ENVIRONMENT_ID"];
  if (named) return named;
  const token = projectToken(ctx);
  if (!token) throw new Error("railway: an account token needs RAILWAY_ENVIRONMENT_ID");
  const key = `${endpoint(ctx)}\n${token}`;
  let hit = environments.get(key);
  if (!hit) {
    hit = gql<{ projectToken: { environmentId?: string } | null }>(ctx, "query RailwayProjectToken { projectToken { projectId environmentId } }", {}).then((d) => {
      if (!d.projectToken?.environmentId) throw new Error("railway: the project token names no environment");
      return d.projectToken.environmentId;
    });
    hit.catch(() => environments.delete(key));
    environments.set(key, hit);
  }
  return hit;
}

/** Destroys a sandbox; one that is already gone counts as destroyed. */
async function destroy(ctx: ProviderContext, id: string): Promise<void> {
  try {
    await gql(ctx, `mutation RailwaySandboxDestroy($id: String!, $environmentId: String!) { sandboxDestroy(id: $id, environmentId: $environmentId) { ${FIELDS} } }`, {
      id,
      environmentId: await environmentId(ctx),
    });
  } catch (err) {
    if (!(err instanceof HttpError && err.status === 404)) throw err;
  }
}

interface Sandbox {
  id: string;
  status: string;
}
const DEAD = ["FAILED", "DESTROYING", "DESTROYED"];

export const railwayProvider = defineProvider({
  info: {
    id: "railway",
    name: "Railway Sandboxes",
    homepage: "https://railway.com/sandboxes",
    env: ["RAILWAY_TOKEN"],
    capabilities: [],
    isolation: "vm",
    maxExecSec: EXEC_LIMIT_SEC,
    enforcesTimeout: false,
    freeTier: {
      tier: { kind: "one-time-credit", usd: 5 },
      concurrency: 10,
      requiresCard: false,
      notes: "Free Trial: $5 once, valid 30 days, no card. 10 running per environment, 2 vCPU / 2 GB at most, idle timeout 5 min at most. Usage draws from the plan's included credit.",
      source: "https://railway.com/pricing",
      checked: "2026-11-21",
    },
    pricing: { billing: "active-cpu", vcpuSecondUsd: 0.00001929, gibSecondUsd: 0.00001929, defaultCpu: 2, defaultMemoryMiB: 2048, source: "https://docs.railway.com/sandboxes.md" },
    surfaces: { rest: "https://backboard.railway.com/graphql/v2 (GraphQL)", sdk: ["railway (npm)"], cli: "railway sandbox" },
  },

  isConfigured: (ctx) => Boolean(projectToken(ctx) || (ctx.env["RAILWAY_API_TOKEN"] && ctx.env["RAILWAY_ENVIRONMENT_ID"])),

  async create(spec, ctx) {
    const env = await environmentId(ctx);
    const input: Record<string, unknown> = {
      environmentId: env,
      // The idle timer stands in for a lifetime. Trial and Free allow 5 minutes at most;
      // `options.idleTimeoutMinutes` sets it outright.
      idleTimeoutMinutes: Number(ctx.options["idleTimeoutMinutes"] ?? Math.min(120, Math.max(1, Math.ceil(spec.timeoutSec / 60)))),
      resources: { cpu: spec.cpu, memoryGB: Math.round((spec.memoryMiB / 1024) * 100) / 100 },
      variables: spec.env,
      ...(spec.region ? { region: spec.region } : {}),
      ...(spec.nativeTemplate ? { template: { name: spec.nativeTemplate } } : {}),
    };
    let sbx = (await gql<{ sandboxCreate: Sandbox }>(ctx, `mutation RailwaySandboxCreate($input: SandboxCreateInput!) { sandboxCreate(input: $input) { ${FIELDS} } }`, { input })).sandboxCreate;
    try {
      for (let i = 0; i < 300 && sbx.status !== "RUNNING"; i++) {
        if (DEAD.includes(sbx.status)) throw new Error(`railway sandbox ${sbx.id} is ${sbx.status}`);
        await sleep(pollMs(ctx, 1000));
        const cur = (await gql<{ sandbox: Sandbox | null }>(ctx, `query RailwaySandbox($environmentId: String!, $id: String!) { sandbox(environmentId: $environmentId, id: $id) { ${FIELDS} } }`, { environmentId: env, id: sbx.id })).sandbox;
        if (!cur) throw new Error(`railway sandbox ${sbx.id} is gone`);
        sbx = cur;
      }
      if (sbx.status !== "RUNNING") throw new Error(`railway sandbox ${sbx.id} did not start`);
    } catch (err) {
      await destroy(ctx, sbx.id).catch(() => undefined);
      throw err;
    }
    return { providerSandboxId: sbx.id, cpu: spec.cpu, memoryMiB: spec.memoryMiB };
  },

  async exec(id, command, o, ctx) {
    const timeoutSec = Math.min(EXEC_LIMIT_SEC, Math.max(1, Math.ceil(o.timeoutSec ?? EXEC_LIMIT_SEC)));
    const r = (
      await gql<{ sandboxExec: { exitCode: number; stdout: string; stderr: string; truncated?: boolean; timedOut?: boolean } }>(
        ctx,
        "mutation RailwaySandboxExec($environmentId: String!, $id: String!, $command: String!, $timeoutSec: Int) { sandboxExec(environmentId: $environmentId, id: $id, command: $command, timeoutSec: $timeoutSec) { exitCode stdout stderr truncated timedOut } }",
        { environmentId: await environmentId(ctx), id, command: inline(command, o), timeoutSec },
        (timeoutSec + 30) * 1000,
      )
    ).sandboxExec;
    if (r.stdout) o.onStdout?.(r.stdout);
    if (r.stderr) o.onStderr?.(r.stderr);
    // A timed-out command reports -1.
    return { stdout: r.stdout, stderr: r.stderr, exitCode: r.timedOut || r.exitCode < 0 ? 124 : r.exitCode };
  },

  async kill(id, ctx) {
    await destroy(ctx, id);
  },

  async listAlive(ctx) {
    const env = await environmentId(ctx);
    const ids: string[] = [];
    let after: string | undefined;
    for (let page = 0; page < 100; page++) {
      const d = await gql<{ sandboxes: { edges: { node: Sandbox }[]; pageInfo: { hasNextPage: boolean; endCursor?: string | null } } }>(
        ctx,
        `query RailwaySandboxes($environmentId: String!, $first: Int, $after: String) { sandboxes(environmentId: $environmentId, first: $first, after: $after) { edges { node { ${FIELDS} } } pageInfo { hasNextPage endCursor } } }`,
        { environmentId: env, first: 100, after },
      );
      for (const { node } of d.sandboxes.edges) if (!DEAD.includes(node.status)) ids.push(node.id);
      if (!d.sandboxes.pageInfo.hasNextPage || !d.sandboxes.pageInfo.endCursor) break;
      after = d.sandboxes.pageInfo.endCursor;
    }
    return ids;
  },
});
