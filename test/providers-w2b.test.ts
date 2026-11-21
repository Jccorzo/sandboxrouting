// The wave-2 cloud adapters added on 2026-11-21: Alibaba Cloud AgentBay and Railway against
// local servers that speak their wire formats (taken from each official SDK), and Tencent and
// Volcengine, which speak E2B's API, against a stand-in for the `e2b` SDK that records how it
// is called. None has been run against the real service.
import { describe, expect, it, vi } from "vitest";
import { fakeRun, lifecycle, mock, routerFor } from "./restmock.js";
import { NoProviderAvailableError } from "../src/index.js";
import { agentbayProvider } from "../src/providers/agentbay.js";
import { railwayProvider } from "../src/providers/railway.js";
import { tencentProvider } from "../src/providers/tencent.js";
import { volcengineProvider } from "../src/providers/volcengine.js";

/** The kind the router gave the one failed attempt of a create. */
async function refusalKind(p: Promise<unknown>) {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(NoProviderAvailableError);
  return (err as NoProviderAvailableError).attempts[0]?.kind;
}

describe("agentbay", () => {
  const api = (opts: { status?: string[]; refuse?: { Code: string; Message: string; HttpStatusCode: number } } = {}) => {
    const statuses = [...(opts.status ?? ["PENDING", "RUNNING"])];
    let alive = true;
    return mock((r) => {
      if (r.method !== "POST" || r.path !== "/") return undefined;
      const form = new URLSearchParams(r.body.toString());
      const action = r.query.get("Action");
      expect(r.query.get("Version")).toBe("2025-05-06");
      expect(r.query.get("Format")).toBe("json");
      expect(r.query.get("SignatureNonce")).toBeTruthy();
      expect(String(r.headers["content-type"])).toContain("application/x-www-form-urlencoded");
      if (form.get("Authorization") !== "Bearer akm-test") return { status: 400, json: { Code: "InvalidApiKey", Message: "unauthorized: invalid api key", HttpStatusCode: 401, Success: false } };
      if (action === "CreateMcpSession") {
        if (opts.refuse) return { json: { ...opts.refuse, Success: false, RequestId: "r" } };
        expect(form.get("ImageId")).toBe("code_latest");
        expect(JSON.parse(form.get("Labels")!)).toHaveProperty("sandboxrouting.id");
        expect(form.get("MaxRuntime")).toBe("2");
        expect(form.get("Timeout")).toBe("3");
        return { json: { Success: true, Code: "ok", Data: { SessionId: "s-1", Success: true } } };
      }
      if (action === "GetSession") return { json: { Success: true, Data: { SessionId: "s-1", Status: statuses.shift() ?? "RUNNING" } } };
      if (action === "CallMcpTool") {
        expect(form.get("SessionId")).toBe("s-1");
        expect(form.get("Name")).toBe("shell");
        const args = JSON.parse(form.get("Args")!);
        expect(args.timeout_ms).toBeLessThanOrEqual(50_000);
        const run = fakeRun(args.command);
        const text = JSON.stringify({ exit_code: run.code, stdout: run.stdout, stderr: run.stderr });
        return { json: { Success: true, Data: { content: [{ type: "text", text }], isError: run.code !== 0 } } };
      }
      if (action === "DeleteSessionAsync") {
        if (!alive) return { json: { Success: false, Code: "InvalidMcpSession.NotFound", Message: "session not found", HttpStatusCode: 400 } };
        alive = false;
        return { json: { Success: true } };
      }
      if (action === "ListSession") {
        expect(form.get("MaxResults")).toBe("100");
        if (!form.get("NextToken")) return { json: { Success: true, NextToken: "p2", Data: [{ SessionId: "s-1", SessionStatus: "RUNNING" }, { SessionId: "s-0", SessionStatus: "FINISH" }] } };
        return { json: { Success: true, Data: [{ SessionId: "s-2", SessionStatus: "PAUSED" }] } };
      }
      return undefined;
    });
  };
  const env = (url: string) => ({ AGENTBAY_API_KEY: "akm-test", AGENTBAY_API_URL: url });

  it("creates a session, waits for RUNNING, runs shell commands and deletes it", async () => {
    const { url, seen } = await api();
    const { router } = routerFor(agentbayProvider, env(url));
    await lifecycle(router);
    expect(seen.filter((s) => s === "POST /").length).toBeGreaterThanOrEqual(5);
  });

  it("deletes a session that failed to start, and treats a second delete as done", async () => {
    const { url } = await api({ status: ["FINISH"] });
    const ctx = { env: env(url), options: { pollMs: 1 } };
    const spec = { cpu: 2, memoryMiB: 4096, timeoutSec: 120, env: {}, metadata: { "sandboxrouting.id": "x" } };
    await expect(agentbayProvider.create(spec, ctx)).rejects.toThrow(/FINISH/);
    // The failed create already deleted it; a kill now finds it gone and doesn't throw.
    await expect(agentbayProvider.kill("s-1", ctx)).resolves.toBeUndefined();
  });

  it("lists live sessions across pages", async () => {
    const { url } = await api();
    expect(await agentbayProvider.listAlive({ env: env(url), options: {} })).toEqual(["s-1", "s-2"]);
  });

  it("raises a refusal inside a 200 with its own status", async () => {
    const quota = await api({ refuse: { Code: "QuotaExceeded.Session", Message: "concurrent session quota exceeded", HttpStatusCode: 400 } });
    expect(await refusalKind(routerFor(agentbayProvider, env(quota.url)).router.create({ timeoutSec: 60 }))).toBe("quota");
    const { url } = await api();
    expect(await refusalKind(routerFor(agentbayProvider, { ...env(url), AGENTBAY_API_KEY: "akm-wrong" }).router.create({ timeoutSec: 60 }))).toBe("auth");
  });
});

describe("railway", () => {
  const api = (opts: { statuses?: string[]; errors?: { message: string; extensions?: { code: string } }[] } = {}) => {
    const statuses = [...(opts.statuses ?? ["CREATING", "RUNNING"])];
    let alive = true;
    return mock((r) => {
      if (r.method !== "POST" || r.path !== "/graphql/v2") return undefined;
      const { query, variables } = r.json() as { query: string; variables: Record<string, unknown> };
      const tokenOk = r.headers["project-access-token"] === "proj_test" || r.headers.authorization === "Bearer acct_test";
      if (!tokenOk) return { json: { errors: [{ message: "Not Authorized" }] } };
      if (query.includes("projectToken")) return { json: { data: { projectToken: { projectId: "p-1", environmentId: "env-1" } } } };
      if (query.includes("sandboxCreate(")) {
        if (opts.errors) return { json: { errors: opts.errors } };
        expect(variables["input"]).toMatchObject({ environmentId: "env-1", idleTimeoutMinutes: 2, resources: { cpu: 2, memoryGB: 2 } });
        return { json: { data: { sandboxCreate: { id: "sbx_1", status: statuses.shift() } } } };
      }
      if (query.includes("sandbox(")) {
        expect(variables).toMatchObject({ environmentId: "env-1", id: "sbx_1" });
        return { json: { data: { sandbox: { id: "sbx_1", status: statuses.shift() ?? "RUNNING" } } } };
      }
      if (query.includes("sandboxExec(")) {
        expect(variables["timeoutSec"]).toBeLessThanOrEqual(600);
        const run = fakeRun(String(variables["command"]));
        return { json: { data: { sandboxExec: { exitCode: run.code, stdout: run.stdout, stderr: run.stderr, truncated: false, timedOut: false } } } };
      }
      if (query.includes("sandboxDestroy(")) {
        if (!alive) return { json: { errors: [{ message: "Sandbox not found" }] } };
        alive = false;
        return { json: { data: { sandboxDestroy: { id: "sbx_1", status: "DESTROYING" } } } };
      }
      if (query.includes("sandboxes(")) {
        if (!variables["after"]) return { json: { data: { sandboxes: { edges: [{ node: { id: "sbx_1", status: "RUNNING" } }, { node: { id: "sbx_0", status: "DESTROYED" } }], pageInfo: { hasNextPage: true, endCursor: "c1" } } } } };
        return { json: { data: { sandboxes: { edges: [{ node: { id: "sbx_2", status: "RUNNING" } }], pageInfo: { hasNextPage: false, endCursor: null } } } } };
      }
      return undefined;
    });
  };
  const env = (url: string) => ({ RAILWAY_TOKEN: "proj_test", RAILWAY_GRAPHQL_ENDPOINT: `${url}/graphql/v2` });

  it("finds the project token's environment, waits for RUNNING, execs and destroys", async () => {
    const { url } = await api();
    const { router } = routerFor(railwayProvider, env(url));
    await lifecycle(router);
  });

  it("takes an account token with a named environment, and a second destroy is not an error", async () => {
    const { url } = await api();
    const ctx = { env: { RAILWAY_API_TOKEN: "acct_test", RAILWAY_ENVIRONMENT_ID: "env-1", RAILWAY_GRAPHQL_ENDPOINT: `${url}/graphql/v2` }, options: {} };
    expect(railwayProvider.isConfigured!(ctx)).toBe(true);
    expect(railwayProvider.isConfigured!({ env: { RAILWAY_API_TOKEN: "acct_test" }, options: {} })).toBe(false);
    await railwayProvider.kill("sbx_1", ctx);
    await expect(railwayProvider.kill("sbx_1", ctx)).resolves.toBeUndefined();
    expect(await railwayProvider.listAlive!(ctx)).toEqual(["sbx_1", "sbx_2"]);
  });

  it("destroys a sandbox that failed to start", async () => {
    const { url } = await api({ statuses: ["CREATING", "FAILED"] });
    const ctx = { env: env(url), options: { pollMs: 1 } };
    const spec = { cpu: 2, memoryMiB: 2048, timeoutSec: 120, env: {}, metadata: {} };
    await expect(railwayProvider.create(spec, ctx)).rejects.toThrow(/FAILED/);
    // Already destroyed by the failed create.
    await expect(railwayProvider.kill("sbx_1", ctx)).resolves.toBeUndefined();
  });

  it("gives GraphQL refusals a status the router can classify", async () => {
    const { url } = await api();
    expect(await refusalKind(routerFor(railwayProvider, { ...env(url), RAILWAY_TOKEN: "wrong" }).router.create({ timeoutSec: 60 }))).toBe("auth");
    const limit = await api({ errors: [{ message: "You have reached the usage limit for your plan" }] });
    expect(await refusalKind(routerFor(railwayProvider, env(limit.url)).router.create({ timeoutSec: 60 }))).toBe("quota");
  });
});

// A stand-in for the `e2b` SDK: it records every call and keeps sandboxes in memory.
const e2b = vi.hoisted(() => {
  const calls: { op: string; args: unknown[] }[] = [];
  const boxes = new Map<string, Map<string, Uint8Array>>();
  let n = 0;
  class Sandbox {
    constructor(public sandboxId: string) {}
    static async create(...args: unknown[]) {
      calls.push({ op: "create", args });
      const id = `e-${++n}`;
      boxes.set(id, new Map());
      return new Sandbox(id);
    }
    static async connect(id: string, opts: unknown) {
      calls.push({ op: "connect", args: [id, opts] });
      if (!boxes.has(id)) throw Object.assign(new Error(`sandbox ${id} not found`), { status: 404 });
      return new Sandbox(id);
    }
    static async kill(id: string, opts: unknown) {
      calls.push({ op: "kill", args: [id, opts] });
      return boxes.delete(id);
    }
    static list(opts: unknown) {
      calls.push({ op: "list", args: [opts] });
      let done = false;
      return {
        get hasNext() {
          return !done;
        },
        async nextItems() {
          done = true;
          return [...boxes.keys()].map((sandboxId) => ({ sandboxId }));
        },
      };
    }
    commands = {
      run: async (cmd: string) => {
        const r = fakeRun(cmd);
        if (r.code) throw Object.assign(new Error("exit"), { exitCode: r.code, stdout: r.stdout, stderr: r.stderr });
        return { stdout: r.stdout, stderr: r.stderr, exitCode: 0 };
      },
    };
    files = {
      write: async (path: string, data: ArrayBuffer) => void boxes.get(this.sandboxId)!.set(path, new Uint8Array(data)),
      read: async (path: string) => boxes.get(this.sandboxId)!.get(path) ?? new Uint8Array(),
      list: async () => [],
    };
  }
  return { calls, boxes, Sandbox };
});
vi.mock("e2b", () => ({ Sandbox: e2b.Sandbox }));

describe("tencent (E2B API)", () => {
  it("creates from the sandbox tool on the region's tencentags.com domain", async () => {
    e2b.calls.length = 0;
    const { router } = routerFor(tencentProvider, { TENCENT_AGS_API_KEY: "ags_test", TENCENT_AGS_TOOL: "my-tool", TENCENT_AGS_REGION: "ap-shanghai" });
    await lifecycle(router, { files: true });
    const create = e2b.calls.find((c) => c.op === "create")!;
    expect(create.args[0]).toBe("my-tool");
    expect(create.args[1]).toMatchObject({ apiKey: "ags_test", domain: "ap-shanghai.tencentags.com", timeoutMs: 120_000 });
    expect(e2b.calls.find((c) => c.op === "kill")!.args[1]).toMatchObject({ apiKey: "ags_test", domain: "ap-shanghai.tencentags.com" });
  });

  it("reconnects from another process and defaults to Guangzhou", async () => {
    const ctx = { env: { TENCENT_AGS_API_KEY: "ags_test", TENCENT_AGS_TOOL: "my-tool" }, options: {} };
    e2b.boxes.set("other-1", new Map());
    e2b.calls.length = 0;
    expect((await tencentProvider.exec("other-1", "echo hi", {}, ctx)).stdout).toContain("echo hi");
    expect(e2b.calls[0]).toMatchObject({ op: "connect", args: ["other-1", { domain: "ap-guangzhou.tencentags.com" }] });
    expect(tencentProvider.pause).toBeUndefined();
    expect(tencentProvider.listAlive).toBeUndefined();
  });
});

describe("volcengine (E2B API)", () => {
  const env = { VOLCENGINE_E2B_API_KEY: "e2b_apikey_test", VOLCENGINE_E2B_TEMPLATE_ID: "tpl-1", VOLCENGINE_E2B_REGION: "cn-shanghai" };

  it("creates from the template at the region's control plane and lists by template", async () => {
    e2b.calls.length = 0;
    const { router } = routerFor(volcengineProvider, env);
    await lifecycle(router, { files: true });
    const create = e2b.calls.find((c) => c.op === "create")!;
    expect(create.args[0]).toBe("tpl-1");
    expect(create.args[1]).toMatchObject({ apiKey: "e2b_apikey_test", apiUrl: "https://api.vefaas-e2b.sandbox-cn-shanghai.volcapig.com" });
    await volcengineProvider.listAlive!({ env, options: {} });
    expect(e2b.calls.find((c) => c.op === "list")!.args[0]).toMatchObject({ query: { state: ["running", "paused"], metadata: { vefaas_function_id: "tpl-1" } } });
  });

  it("never calls connect, which veFaaS lacks, and offers no pause", async () => {
    e2b.boxes.set("other-2", new Map());
    e2b.calls.length = 0;
    await expect(volcengineProvider.exec("other-2", "echo hi", {}, { env, options: {} })).rejects.toThrow(/only the process that created it/);
    expect(e2b.calls.some((c) => c.op === "connect")).toBe(false);
    expect(volcengineProvider.pause).toBeUndefined();
  });
});
