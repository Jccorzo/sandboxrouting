// Groundbox, driven through the router against a local server that speaks its REST API
// (https://api.groundbox.dev/openapi.json).
import { describe, expect, it } from "vitest";
import { fakeRun, lifecycle, mock, routerFor, type Req, type Reply } from "./restmock.js";
import { classify } from "../src/core/errors.js";
import { groundboxProvider } from "../src/providers/groundbox.js";

const KEY = "gbx_test";

/** A Groundbox API with one team: sandboxes start queued and run after a poll. */
async function server(override?: (r: Req) => Reply | undefined) {
  let n = 0;
  const boxes = new Map<string, { status: string; polls: number; cpus: number; memory_gb: number }>();
  const files = new Map<string, Buffer>();
  const view = (id: string) => ({ id, ...boxes.get(id)! });
  const api = await mock((r) => {
    if (r.headers.authorization !== `Bearer ${KEY}`) return { status: 401, json: { error: { code: "unauthorized", message: "Invalid API key" } } };
    const early = override?.(r);
    if (early) return early;
    if (r.method === "POST" && r.path === "/v1/sandboxes") {
      expect(r.headers["idempotency-key"]).toBeTruthy();
      const b = r.json();
      expect(Number.isInteger(b.cpus) && Number.isInteger(b.memory_gb) && Number.isInteger(b.timeout_minutes)).toBe(true);
      const id = `sbx_${String(++n).padStart(8, "0")}`;
      boxes.set(id, { status: "queued", polls: 0, cpus: b.cpus, memory_gb: b.memory_gb });
      return { json: view(id) };
    }
    if (r.method === "GET" && r.path === "/v1/sandboxes") {
      expect(r.query.get("live")).toBe("true");
      return { json: { data: [...boxes.keys()].filter((id) => boxes.get(id)!.status !== "stopped").map(view), next_cursor: null } };
    }
    const mm = /^\/v1\/sandboxes\/(sbx_\d+)(.*)$/.exec(r.path);
    if (!mm || !boxes.has(mm[1]!)) return undefined;
    const [, id, rest] = mm as unknown as [string, string, string];
    const box = boxes.get(id)!;
    if (r.method === "GET" && rest === "") {
      if (box.status === "queued" && box.polls++ >= 1) box.status = "running";
      if (box.status === "pausing") box.status = "paused";
      if (box.status === "resuming") box.status = "running";
      return { json: view(id) };
    }
    if (r.method === "DELETE" && rest === "") return (box.status = "stopped"), { json: view(id) };
    if (r.method === "PATCH" && rest === "") return { json: view(id) };
    if (r.method === "POST" && rest === "/pause") return (box.status = "pausing"), { json: view(id) };
    if (r.method === "POST" && rest === "/resume") return (box.status = "resuming"), { json: view(id) };
    if (r.method === "POST" && rest === "/exec") {
      const b = r.json();
      expect(b.timeout_s).toBeGreaterThan(0);
      const x = fakeRun(b.cmd);
      return { json: { exit_code: x.code, stdout: x.stdout, stderr: x.stderr, duration_ms: 3, timed_out: false } };
    }
    if (rest === "/files" && r.method === "PUT") return files.set(r.query.get("path")!, r.body), { json: { path: r.query.get("path"), size_bytes: r.body.length } };
    if (rest === "/files" && r.method === "GET" && r.query.get("dir")) {
      const dir = r.query.get("dir")!;
      const entries = [...files.entries()]
        .filter(([p]) => p.startsWith(`${dir}/`))
        .map(([p, b]) => ({ name: p.slice(dir.length + 1), path: p, type: "file", size_bytes: b.length, modified_at: "2026-11-21T00:00:00Z" }));
      return { json: { dir, entries } };
    }
    if (rest === "/files" && r.method === "GET") return files.has(r.query.get("path")!) ? { raw: files.get(r.query.get("path")!)! } : { status: 404, json: {} };
    if (r.method === "POST" && rest === "/previews") return { status: 201, json: { port: r.json().port, url: `https://x-${r.json().port}.groundbox.page/` } };
    return undefined;
  });
  return { ...api, boxes };
}

const env = (url: string) => ({ GROUNDBOX_API_KEY: KEY, GROUNDBOX_API_URL: `${url}/v1` });

describe("groundbox", () => {
  it("waits for a queued sandbox, then runs the lifecycle with native files", async () => {
    const { url, seen, boxes } = await server();
    const { router } = routerFor(groundboxProvider, env(url));
    const sbx = await lifecycle(router, { files: true });
    expect(seen).toContain(`GET /v1/sandboxes/${sbx.providerSandboxId}`);
    expect(seen).toContain(`PUT /v1/sandboxes/${sbx.providerSandboxId}/files`);
    expect(seen).toContain(`DELETE /v1/sandboxes/${sbx.providerSandboxId}`);
    expect(boxes.get(sbx.providerSandboxId)!.status).toBe("stopped");
  });

  it("lists files, gives a preview URL, extends, pauses and resumes", async () => {
    const { url, seen } = await server();
    const ctx = { env: env(url), options: { pollMs: 5 } };
    const spec = { cpu: 2, memoryMiB: 4096, timeoutSec: 600, env: {}, metadata: {} };
    const { providerSandboxId: id, cpu, memoryMiB } = await groundboxProvider.create(spec, ctx);
    expect([cpu, memoryMiB]).toEqual([2, 4096]);
    await groundboxProvider.writeFile!(id, "/work/a.txt", new TextEncoder().encode("hi"), ctx);
    expect(await groundboxProvider.listFiles!(id, "/work", ctx)).toEqual([{ name: "a.txt", path: "/work/a.txt", isDir: false, size: 2 }]);
    expect(await groundboxProvider.getUrl!(id, 3000, ctx)).toBe("https://x-3000.groundbox.page/");
    await groundboxProvider.setTimeout!(id, 900, ctx);
    expect(seen).toContain(`PATCH /v1/sandboxes/${id}`);
    await groundboxProvider.pause!(id, ctx);
    await groundboxProvider.resume!(id, ctx);
    expect(await groundboxProvider.listAlive!(ctx)).toEqual([id]);
    await groundboxProvider.kill(id, ctx);
    expect(await groundboxProvider.listAlive!(ctx)).toEqual([]);
  });

  it("sends whole sizes: memory rounded up to GB and capped at 4 GB per vCPU", async () => {
    let body: { cpus: number; memory_gb: number; timeout_minutes: number } | undefined;
    const { url } = await server((r) => {
      if (r.method === "POST" && r.path === "/v1/sandboxes") body = r.json();
      return undefined;
    });
    const ctx = { env: env(url), options: { pollMs: 5 } };
    await groundboxProvider.create({ cpu: 1.4, memoryMiB: 9000, timeoutSec: 61, env: {}, metadata: {} }, ctx);
    expect(body).toMatchObject({ cpus: 1, memory_gb: 4, timeout_minutes: 2 });
  });

  it("classifies refusals: credit used up is quota, too many live is a rate limit, too big moves on", async () => {
    const refuse = (status: number, code: string, limit?: string) =>
      server((r) => (r.method === "POST" && r.path === "/v1/sandboxes" ? { status, json: { error: { code, message: "refused", details: limit ? { limit } : undefined } } } : undefined));
    const kindOf = async (status: number, code: string, limit?: string) => {
      const { url } = await refuse(status, code, limit);
      const err = await groundboxProvider.create({ cpu: 2, memoryMiB: 4096, timeoutSec: 60, env: {}, metadata: {} }, { env: env(url), options: {} }).catch((e: unknown) => e);
      return classify(err).kind;
    };
    expect(await kindOf(402, "trial_credit_exhausted", "credit")).toBe("quota");
    expect(await kindOf(402, "insufficient_balance")).toBe("quota");
    expect(await kindOf(402, "trial_limit", "live_sandboxes")).toBe("rate_limit");
    expect(await kindOf(402, "trial_limit", "sandbox_size")).toBe("invalid");
    expect(await kindOf(429, "concurrency_limit")).toBe("rate_limit");
    expect(await kindOf(401, "unauthorized")).toBe("auth");
  });

  it("deletes a sandbox that failed to start and says why", async () => {
    const { url, seen } = await server((r) => {
      if (r.method === "GET" && /^\/v1\/sandboxes\/sbx_\d+$/.test(r.path)) return { json: { id: r.path.split("/").pop(), status: "failed", cpus: 2, memory_gb: 4, error: "image not found" } };
      return undefined;
    });
    const ctx = { env: env(url), options: { pollMs: 5 } };
    await expect(groundboxProvider.create({ cpu: 2, memoryMiB: 4096, timeoutSec: 60, env: {}, metadata: {}, image: "nope:1" }, ctx)).rejects.toThrow(/failed: image not found/);
    expect(seen).toContain("DELETE /v1/sandboxes/sbx_00000001");
  });
});
