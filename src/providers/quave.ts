// Quave ONE Agent Sandboxes: gVisor containers on Kubernetes. No free tier for sandboxes;
// billed per allocated zCloud (0.5 vCPU + 512 MB) at $0.03125/h. Sandboxes are switched on
// per account by Quave, and the region needs the Agent Sandbox add-on.
// Image, size and timeouts live on a template revision, not on the create call, so this
// adapter needs an app and a template you made beforehand, and cannot size per request.
// The revision's idle timeout and hard lifetime (7 days at most) are fixed, so the router
// deletes the sandbox at the deadline itself (enforcesTimeout: false).
// REST: https://api.quave.cloud/api/public/v1, `Authorization: <user token>` with no
// "Bearer". Files go through a per-sandbox gateway session and only reach /workspace.
// No SDK. CLI `quaveone`; MCP https://mcp.quave.cloud/.

import { randomUUID } from "node:crypto";
import { defineProvider, http, httpJson, HttpError } from "./util.js";
import { grantCache, insideRoots, pollMs, sleep } from "./rest-helpers.js";
import type { ProviderContext } from "../core/types.js";

const base = (ctx: ProviderContext) => String(ctx.env["QUAVEONE_API_URL"] ?? "https://api.quave.cloud/api/public/v1").replace(/\/+$/, "");
const auth = (ctx: ProviderContext) => ({ authorization: String(ctx.env["QUAVEONE_USER_TOKEN"]) });
const account = (ctx: ProviderContext) => String(ctx.env["QUAVEONE_ACCOUNT_ID"]);
const ROOTS = ["/workspace"];
const EXEC_LIMIT_SEC = 900;

interface Sandbox {
  sandboxId?: string;
  id?: string;
  _id?: string;
  status: string;
  errorCode?: string;
}
const idOf = (x: Sandbox) => String(x.sandboxId ?? x.id ?? x._id);
const unb64 = (s?: string) => (s ? Buffer.from(s, "base64").toString("utf8") : "");

interface Gateway {
  url: (path: string, q: Record<string, string>) => string;
  headers: { authorization: string };
}
const grants = grantCache<Gateway>();

/** A short-lived grant to the sandbox's gateway, which serves its files. */
const gateway = (ctx: ProviderContext, id: string) =>
  grants.get(`${base(ctx)}|${id}`, async () => {
    const r = await httpJson<{ endpoint?: string; token?: string; expiresAt?: string; session?: { endpoint: string; token: string; expiresAt?: string } }>(`${base(ctx)}/sandbox/session`, {
      headers: auth(ctx),
      body: { accountId: account(ctx), sandboxId: id, scopes: ["file"] },
    });
    const s = r.session ?? (r as { endpoint: string; token: string; expiresAt?: string });
    const expires = Date.parse(s.expiresAt ?? "");
    return {
      value: { url: (path, q) => `${s.endpoint.replace(/\/+$/, "")}${path}?${new URLSearchParams(q)}`, headers: { authorization: `Bearer ${s.token}` } },
      // Without a stated expiry the grant is used once.
      expiresAt: Number.isFinite(expires) ? expires : 0,
    };
  });

export const quaveProvider = defineProvider({
  info: {
    id: "quave",
    name: "Quave ONE",
    homepage: "https://quave.one",
    env: ["QUAVEONE_USER_TOKEN", "QUAVEONE_ACCOUNT_ID", "QUAVEONE_APP_ID", "QUAVEONE_SANDBOX_TEMPLATE_ID"],
    capabilities: ["fileList"],
    isolation: "gvisor",
    enforcesTimeout: false,
    maxTimeoutSec: 604_800,
    maxExecSec: EXEC_LIMIT_SEC,
    freeTier: {
      tier: { kind: "none" },
      notes: "Enabled per account by Quave; billed by allocation, not while suspended. 200 active sandboxes per account.",
      source: "https://docs.quave.one/billing/pricing-details",
      checked: "2026-11-12",
    },
    // One zCloud is 0.5 vCPU with 512 MB at $0.03125/h; memory comes bundled with the CPU.
    pricing: { vcpuSecondUsd: 0.0625 / 3600, gibSecondUsd: 0, defaultCpu: 0.5, defaultMemoryMiB: 512, source: "https://docs.quave.one/billing/pricing-details" },
    surfaces: { rest: "https://api.quave.cloud/api/public/v1", cli: "quaveone", mcp: "https://mcp.quave.cloud/" },
  },

  async create(spec, ctx) {
    const key = spec.metadata["sandboxrouting.id"] ?? randomUUID();
    const made = await httpJson<{ sandbox: Sandbox }>(`${base(ctx)}/sandbox/create`, {
      headers: auth(ctx),
      body: {
        accountId: account(ctx),
        appId: ctx.env["QUAVEONE_APP_ID"],
        templateId: spec.nativeTemplate ?? ctx.env["QUAVEONE_SANDBOX_TEMPLATE_ID"],
        // The owner kind has to match the profile; these two are the pair for an outside caller.
        workloadProfile: String(ctx.options["workloadProfile"] ?? "CODE_INTERPRETER_TURN"),
        ownerKind: String(ctx.options["ownerKind"] ?? "EXTERNAL_SESSION"),
        ownerId: key,
        region: spec.region ?? String(ctx.options["region"] ?? ctx.env["QUAVEONE_REGION"] ?? "us-5"),
        idempotencyKey: key,
      },
    });
    const id = idOf(made.sandbox);
    let cur = made.sandbox;
    try {
      // The pool may have to add a node, which takes minutes. The get long-polls.
      for (let i = 0; i < 40 && cur.status !== "READY" && cur.status !== "BUSY"; i++) {
        if (["FAILED", "TERMINATING", "TERMINATED"].includes(cur.status)) throw new Error(`quave sandbox ${id} is ${cur.status}${cur.errorCode ? ` (${cur.errorCode})` : ""}`);
        const waitSeconds = ctx.options["pollMs"] === undefined ? "25" : "0";
        if (waitSeconds === "0") await sleep(pollMs(ctx, 1000));
        const got = await httpJson<{ sandbox: Sandbox }>(`${base(ctx)}/sandbox?${new URLSearchParams({ accountId: account(ctx), sandboxId: id, waitSeconds })}`, {
          headers: auth(ctx),
          timeoutMs: 60_000,
        });
        cur = got.sandbox;
      }
      if (cur.status !== "READY" && cur.status !== "BUSY") throw new Error(`quave sandbox ${id} did not become ready`);
    } catch (err) {
      await this.kill(id, ctx).catch(() => undefined);
      throw err;
    }
    return { providerSandboxId: id };
  },

  async exec(id, command, o, ctx) {
    const timeoutSeconds = Math.min(EXEC_LIMIT_SEC, Math.max(1, Math.ceil(o.timeoutSec ?? 120)));
    const body = { accountId: account(ctx), sandboxId: id, command: ["sh", "-c", command], cwd: o.cwd, envVars: o.env, timeoutSeconds };
    for (let attempt = 0; ; attempt++) {
      try {
        const { result: r } = await httpJson<{ result: { exitCode: number; stdout?: string; stderr?: string } }>(`${base(ctx)}/sandbox/execute`, {
          headers: auth(ctx),
          body,
          timeoutMs: (timeoutSeconds + 30) * 1000,
        });
        const stdout = unb64(r.stdout);
        const stderr = unb64(r.stderr);
        if (stdout) o.onStdout?.(stdout);
        if (stderr) o.onStderr?.(stderr);
        return { stdout, stderr, exitCode: r.exitCode };
      } catch (err) {
        // 409 while the sandbox is starting or resuming: the command did not run, so try again.
        if (!(err instanceof HttpError) || err.status !== 409 || attempt >= 30) throw err;
        await sleep(pollMs(ctx, 2000));
      }
    }
  },

  async readFile(id, path, ctx) {
    insideRoots("quave", path, ROOTS);
    const g = await gateway(ctx, id);
    return new Uint8Array(await (await http(g.url("/v1/files/read", { path }), { headers: g.headers })).arrayBuffer());
  },

  async writeFile(id, path, data, ctx) {
    insideRoots("quave", path, ROOTS);
    const g = await gateway(ctx, id);
    const dir = path.slice(0, path.lastIndexOf("/"));
    if (dir && dir !== "/workspace") await http(g.url("/v1/files/mkdir", { path: dir, parents: "true" }), { method: "POST", headers: g.headers });
    await http(g.url("/v1/files/write", { path }), { method: "PUT", headers: { ...g.headers, "content-type": "application/octet-stream" }, raw: data });
  },

  async listFiles(id, path, ctx) {
    insideRoots("quave", path, ROOTS);
    const g = await gateway(ctx, id);
    const r = await httpJson<{ entries?: { name: string; path?: string; type?: string; size?: number }[] }>(g.url("/v1/files/list", { path }), { headers: g.headers });
    const dir = path.endsWith("/") ? path : `${path}/`;
    return (r.entries ?? []).map((e) => ({ name: e.name, path: e.path ?? `${dir}${e.name}`, isDir: /dir/i.test(e.type ?? ""), size: e.size }));
  },

  async kill(id, ctx) {
    grants.drop(`${base(ctx)}|${id}`);
    await http(`${base(ctx)}/sandbox/terminate`, { headers: auth(ctx), body: { accountId: account(ctx), sandboxId: id } });
  },

  async listAlive(ctx) {
    const ids: string[] = [];
    for (let page = 1; ; page++) {
      const q = new URLSearchParams({
        accountId: account(ctx),
        appId: String(ctx.env["QUAVEONE_APP_ID"]),
        status: "REQUESTED,ALLOCATING,STARTING,READY,BUSY,SUSPENDING,SUSPENDED,RESUMING",
        limit: "100",
        page: String(page),
      });
      const r = await httpJson<{ sandboxes?: Sandbox[]; totalCount?: number }>(`${base(ctx)}/sandboxes?${q}`, { headers: auth(ctx) });
      const rows = r.sandboxes ?? [];
      ids.push(...rows.map(idOf));
      if (rows.length < 100) return ids;
    }
  },
});
