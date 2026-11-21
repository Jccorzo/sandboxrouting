// Wave-2 hyperscaler adapters (Cloud Run sandboxes, GKE Agent Sandbox, Azure Container Apps
// Sandboxes), driven against local servers that speak each wire format: Google's and Entra's
// token endpoints, the Cloud Run Admin API plus the execd template, the Kubernetes API plus
// agent-sandbox's router (gRPC-Web), and the ACA Sandboxes data plane. None has been run
// against the real service.
import { describe, expect, it } from "vitest";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { deletedAtDeadline, fakeRun, lifecycle, mock, routerFor } from "./restmock.js";
import { classify } from "../src/core/errors.js";
import type { ProviderContext, ResolvedSpec } from "../src/index.js";
import { cloudRunSize, cloudrunProvider } from "../src/providers/cloudrun.js";
import { encodeExecuteRequest, gkeAgentSandboxProvider, parseGrpcWeb, protoFields } from "../src/providers/gke-agent-sandbox.js";
import { azureSessionsProvider, azureTier } from "../src/providers/azure-sessions.js";
import { signedAssertion } from "../src/providers/google-auth.js";

const spec = (id: string, over: Partial<ResolvedSpec> = {}): ResolvedSpec => ({
  cpu: 2,
  memoryMiB: 4096,
  timeoutSec: 60,
  env: {},
  metadata: { "sandboxrouting.id": id },
  ...over,
});
const ctxOf = (env: Record<string, string>, options: Record<string, unknown> = {}): ProviderContext => ({ env, options: { pollMs: 1, ...options } });
const refusal = async (p: Promise<unknown>) => classify(await p.then(() => new Error("no refusal"), (e: unknown) => e)).kind;

// A service-account key whose token endpoint is the mock.
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const verifies = (jwt: string) => {
  const [h, b, sig] = jwt.split(".");
  return createVerify("RSA-SHA256").update(`${h}.${b}`).verify(publicKey, Buffer.from(sig!, "base64url"));
};

describe("google credentials", () => {
  it("signs an RS256 assertion the key's public half verifies", () => {
    const jwt = signedAssertion({ client_email: "sa@p.iam.gserviceaccount.com", private_key: pem, token_uri: "https://t/token" }, { scope: "s" }, 1000);
    expect(verifies(jwt)).toBe(true);
    const claims = JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString());
    expect(claims).toMatchObject({ iss: "sa@p.iam.gserviceaccount.com", aud: "https://t/token", iat: 1000, exp: 4600, scope: "s" });
  });
});

describe("cloudrun", () => {
  async function cloudRunMock(opts: { fail?: boolean; tokenStatus?: number } = {}) {
    const instances = new Map<string, { body: { containers: { env: { name: string; value: string }[] }[] }; polls: number; health: number }>();
    let tokenCalls = 0;
    const m = await mock((r) => {
      if (r.path === "/token") {
        tokenCalls++;
        const form = new URLSearchParams(r.body.toString());
        if (opts.tokenStatus) return { status: opts.tokenStatus, json: { error: "invalid_grant" } };
        if (!verifies(form.get("assertion") ?? "")) return { status: 400, json: { error: "bad signature" } };
        return { json: { access_token: "ya29.test", expires_in: 3600 } };
      }
      if (r.headers["authorization"] !== "Bearer ya29.test" && r.path.startsWith("/v2/")) return { status: 401, json: { error: { message: "unauthenticated" } } };
      const base = "/v2/projects/p1/locations/us-west1/instances";
      if (r.method === "POST" && r.path === base) {
        const id = r.query.get("instanceId")!;
        if (instances.has(id)) return { status: 409, json: { error: { status: "ALREADY_EXISTS" } } };
        const body = r.json();
        expect(body.containers[0].sandboxLauncher).toBe(true);
        expect(body.restartPolicy).toBe("NEVER");
        instances.set(id, { body, polls: 0, health: 0 });
        return { json: { name: "projects/p1/locations/us-west1/operations/op1", done: false } };
      }
      if (r.method === "GET" && r.path === base) {
        return { json: { instances: [...instances.keys()].map((id) => ({ name: `${base.slice(4)}/${id}`, labels: { sandboxrouting: "sbr" } })) } };
      }
      const im = /^\/v2\/projects\/p1\/locations\/us-west1\/instances\/([^/]+)$/.exec(r.path);
      if (im) {
        const inst = instances.get(im[1]!);
        if (!inst) return { status: 404, json: { error: { status: "NOT_FOUND" } } };
        if (r.method === "DELETE") {
          instances.delete(im[1]!);
          return { json: { name: "op2", done: false } };
        }
        const ready = inst.polls++ > 0;
        return {
          json: {
            name: im[1],
            containers: inst.body.containers,
            urls: ready ? [`${m.url}/i/${im[1]}`] : [],
            terminalCondition: { type: "Ready", state: opts.fail && ready ? "CONDITION_FAILED" : ready ? "CONDITION_SUCCEEDED" : "CONDITION_RECONCILING", reason: opts.fail ? "CONTAINER_MISSING" : undefined },
          },
        };
      }
      const em = /^\/i\/([^/]+)\/(health|exec)$/.exec(r.path);
      if (em) {
        const inst = instances.get(em[1]!);
        if (!inst) return { status: 404, json: { error: "no instance" } };
        const token = inst.body.containers[0]!.env.find((e) => e.name === "SBR_TOKEN")!.value;
        if (r.headers["x-sbr-token"] !== token) return { status: 401, json: { error: "unauthorized" } };
        if (em[2] === "health") return inst.health++ > 0 ? { json: { ready: true } } : { status: 503, json: { ready: false } };
        const run = fakeRun(r.json().command);
        return { json: { stdout: run.stdout, stderr: run.stderr, exitCode: run.code } };
      }
      return undefined;
    });
    const env = {
      CLOUD_RUN_API_URL: m.url,
      GOOGLE_CLOUD_PROJECT: "p1",
      CLOUD_RUN_REGION: "us-west1",
      CLOUD_RUN_SANDBOX_IMAGE: "us-west1-docker.pkg.dev/p1/sbr/cloud-run-sandbox",
      GOOGLE_APPLICATION_CREDENTIALS_JSON: JSON.stringify({ type: "service_account", client_email: `sa-${Math.random()}@p1.iam.gserviceaccount.com`, private_key: pem, token_uri: `${m.url}/token` }),
    };
    return { ...m, env, instances, tokenCalls: () => tokenCalls };
  }

  it("rounds a request to Cloud Run's sizes", () => {
    expect(cloudRunSize(2, 4096)).toEqual({ cpu: 2, memoryMiB: 4096 });
    expect(cloudRunSize(3, 1000)).toEqual({ cpu: 4, memoryMiB: 2048 });
    expect(cloudRunSize(0.5, 100)).toEqual({ cpu: 1, memoryMiB: 512 });
    expect(cloudRunSize(64, 99999)).toEqual({ cpu: 8, memoryMiB: 32768 });
  });

  it("creates an instance, waits for Ready and execd's sandbox, runs commands and deletes it", async () => {
    const m = await cloudRunMock();
    const { router } = routerFor(cloudrunProvider, m.env);
    const sbx = await lifecycle(router);
    expect(m.instances.size).toBe(0);
    expect(m.seen).toContain(`DELETE /v2/projects/p1/locations/us-west1/instances/${sbx.providerSandboxId}`);
    // A service-account token was minted once and reused.
    expect(m.tokenCalls()).toBe(1);
    // Deleting a deleted instance is not an error.
    await expect(cloudrunProvider.kill(sbx.providerSandboxId, ctxOf(m.env))).resolves.toBeUndefined();
  });

  it("adopts the instance a retried create already made", async () => {
    const m = await cloudRunMock();
    const ctx = ctxOf(m.env);
    const a = await cloudrunProvider.create(spec("same"), ctx);
    const b = await cloudrunProvider.create(spec("same"), ctx);
    expect(b.providerSandboxId).toBe(a.providerSandboxId);
    expect(m.instances.size).toBe(1);
  });

  it("deletes an instance whose Ready condition failed, then throws", async () => {
    const m = await cloudRunMock({ fail: true });
    const ctx = ctxOf(m.env);
    await expect(cloudrunProvider.create(spec("fails"), ctx)).rejects.toThrow(/CONTAINER_MISSING/);
    expect(m.instances.size).toBe(0);
    expect(m.seen.filter((s) => s.startsWith("DELETE"))).toHaveLength(1);
  });

  it("is deleted by the sweep at the deadline", async () => {
    const m = await cloudRunMock();
    const { router, clock } = routerFor(cloudrunProvider, m.env);
    await deletedAtDeadline(router, clock, m.seen, (id) => `DELETE /v2/projects/p1/locations/us-west1/instances/${id}`);
  });

  it("reports a refused key as auth", async () => {
    const m = await cloudRunMock({ tokenStatus: 400 });
    expect(await refusal(cloudrunProvider.create(spec("r"), ctxOf(m.env)))).toBe("auth");
  });

  it("needs a credential to count as configured", () => {
    const base = { GOOGLE_CLOUD_PROJECT: "p", CLOUD_RUN_REGION: "us-west1", CLOUD_RUN_SANDBOX_IMAGE: "img" };
    expect(cloudrunProvider.isConfigured!(ctxOf(base))).toBe(false);
    expect(cloudrunProvider.isConfigured!(ctxOf({ ...base, GOOGLE_OAUTH_ACCESS_TOKEN: "t" }))).toBe(true);
  });
});

/** An ExecuteWithLimitsResponse as a gRPC-Web body: one message frame, one trailer frame. */
function grpcWebReply(exitCode: number, stdout: string, stderr: string, status = 0) {
  const varint = (n: bigint) => {
    let v = BigInt.asUintN(64, n);
    const out: number[] = [];
    do {
      let b = Number(v & 0x7fn);
      v >>= 7n;
      if (v) b |= 0x80;
      out.push(b);
    } while (v);
    return out;
  };
  const bytes = (no: number, s: string) => [(no << 3) | 2, ...varint(BigInt(Buffer.byteLength(s))), ...Buffer.from(s)];
  const msg = Buffer.from([8, ...varint(BigInt(exitCode)), ...bytes(2, stdout), ...bytes(3, stderr)]);
  const frame = (flag: number, b: Buffer) => {
    const head = Buffer.alloc(5);
    head[0] = flag;
    head.writeUInt32BE(b.length, 1);
    return Buffer.concat([head, b]);
  };
  const trailer = Buffer.from(`grpc-status: ${status}\r\ngrpc-message: ${status ? "denied%20here" : ""}\r\n`);
  return { type: "application/grpc-web+proto", raw: Buffer.concat(status ? [frame(0x80, trailer)] : [frame(0, msg), frame(0x80, trailer)]) };
}

describe("gke-agent-sandbox", () => {
  it("encodes the exec request and decodes the reply, negative exit codes included", () => {
    const req = protoFields(encodeExecuteRequest(["sh", "-c", "echo hi"], 30));
    const config = protoFields(req.find(([n]) => n === 1)![1] as Uint8Array).map(([, v]) => Buffer.from(v as Uint8Array).toString());
    expect(config).toEqual(["sh", "-c", "echo hi"]);
    expect(protoFields(req.find(([n]) => n === 4)![1] as Uint8Array)).toEqual([[1, 30n]]);
    const reply = grpcWebReply(-1, "out", "err");
    const parsed = parseGrpcWeb(new Uint8Array(reply.raw), new Headers());
    expect(parsed.status).toBe(0);
    const f = new Map(protoFields(parsed.message!));
    expect(BigInt.asIntN(32, f.get(1) as bigint)).toBe(-1n);
    const denied = parseGrpcWeb(new Uint8Array(grpcWebReply(0, "", "", 7).raw), new Headers());
    expect(denied).toMatchObject({ status: 7, detail: "denied here" });
  });

  async function k8sMock(opts: { terminal?: string; execStatus?: number } = {}) {
    const claims = new Map<string, { body: { metadata: { name: string; labels: Record<string, string> }; spec: unknown }; polls: number }>();
    const files = new Map<string, Buffer>();
    const commands: string[] = [];
    const m = await mock((r) => {
      const base = "/apis/extensions.agents.x-k8s.io/v1beta1/namespaces/team/sandboxclaims";
      if (r.path.startsWith("/apis/") && r.headers["authorization"] !== "Bearer k8s-token") return { status: 401, json: { reason: "Unauthorized" } };
      if (r.method === "POST" && r.path === base) {
        const body = r.json();
        if (claims.has(body.metadata.name)) return { status: 409, json: { reason: "AlreadyExists" } };
        claims.set(body.metadata.name, { body, polls: 0 });
        return { status: 201, json: body };
      }
      if (r.method === "GET" && r.path === base) {
        expect(r.query.get("labelSelector")).toBe("app.kubernetes.io/managed-by=sandboxrouting");
        const names = [...claims.keys()];
        const page = r.query.get("continue") ? names.slice(1) : names.slice(0, 1);
        return { json: { items: page.map((n) => claims.get(n)!.body), metadata: { continue: !r.query.get("continue") && names.length > 1 ? "next" : "" } } };
      }
      const cm = /^\/apis\/extensions\.agents\.x-k8s\.io\/v1beta1\/namespaces\/team\/sandboxclaims\/([^/]+)$/.exec(r.path);
      if (cm) {
        const c = claims.get(cm[1]!);
        if (!c) return { status: 404, json: { reason: "NotFound" } };
        if (r.method === "DELETE") {
          claims.delete(cm[1]!);
          return { json: { status: "Success" } };
        }
        if (r.method === "PATCH") {
          expect(r.headers["content-type"]).toBe("application/merge-patch+json");
          return { json: { ...c.body, spec: { ...(c.body.spec as object), ...r.json().spec } } };
        }
        const ready = c.polls++ > 0;
        const status = opts.terminal
          ? { conditions: [{ type: "Ready", status: "False", reason: opts.terminal, message: "no such pool" }] }
          : ready
            ? { conditions: [{ type: "Ready", status: "True" }], sandbox: { name: `pool-${cm[1]}` } }
            : {};
        return { json: { ...c.body, status } };
      }
      // The router: the sandbox named in X-Sandbox-ID must belong to a claim.
      const sandbox = String(r.headers["x-sandbox-id"] ?? "");
      if (!sandbox.startsWith("pool-") || !claims.has(sandbox.slice(5))) return { status: 502, json: { detail: "Could not connect to the backend sandbox" } };
      expect(r.headers["x-sandbox-namespace"]).toBe("team");
      expect(r.headers["x-sandboxd-token"]).toBe("sbd");
      if (r.path === "/v1/health") return { json: { status: "ok" } };
      if (r.path === "/process.v1.ProcessService/ExecuteWithLimits") {
        expect(r.headers["x-sandbox-port"]).toBe("9090");
        expect(r.headers["content-type"]).toBe("application/grpc-web+proto");
        if (opts.execStatus) return grpcWebReply(0, "", "", opts.execStatus);
        const req = protoFields(new Uint8Array(r.body.subarray(5)));
        const argv = protoFields(req.find(([n]) => n === 1)![1] as Uint8Array).map(([, v]) => Buffer.from(v as Uint8Array).toString());
        commands.push(argv[2]!);
        const run = fakeRun(argv[2]!);
        return grpcWebReply(run.code, run.stdout, run.stderr);
      }
      const fm = /^\/v1\/files\/(.*)$/.exec(r.path);
      if (fm) {
        expect(r.headers["x-sandbox-port"]).toBe("8080");
        if (r.method === "PUT") {
          files.set(fm[1]!, r.body);
          return { status: 204, raw: "" };
        }
        if (r.query.get("type") === "directory") return { json: { path: fm[1], entries: [...files.keys()].map((k) => ({ name: k, size: files.get(k)!.length, type: "file" })) } };
        return files.has(fm[1]!) ? { raw: files.get(fm[1]!)! } : { status: 404, json: { error: "missing" } };
      }
      return undefined;
    });
    const env = {
      AGENT_SANDBOX_K8S_API: m.url,
      AGENT_SANDBOX_ROUTER_URL: m.url,
      AGENT_SANDBOX_WARM_POOL: "python-pool",
      AGENT_SANDBOX_NAMESPACE: "team",
      AGENT_SANDBOX_K8S_TOKEN: "k8s-token",
      AGENT_SANDBOX_SANDBOXD_TOKEN: "sbd",
    };
    return { ...m, env, claims, files, commands };
  }

  it("claims a sandbox from the warm pool, runs commands through the router and deletes the claim", async () => {
    const m = await k8sMock();
    const { router } = routerFor(gkeAgentSandboxProvider, m.env);
    const sbx = await lifecycle(router);
    expect(m.claims.size).toBe(0);
    expect(m.seen).toContain(`DELETE /apis/extensions.agents.x-k8s.io/v1beta1/namespaces/team/sandboxclaims/${sbx.providerSandboxId}`);
    await expect(gkeAgentSandboxProvider.kill(sbx.providerSandboxId, ctxOf(m.env))).resolves.toBeUndefined();
  });

  it("sends the warm pool and a shutdown time, keeps env in a file, moves files under the root, extends the deadline", async () => {
    const m = await k8sMock();
    const ctx = ctxOf(m.env);
    const { providerSandboxId: id } = await gkeAgentSandboxProvider.create(spec("files", { env: { TOKEN: "it's" } }), ctx);
    const body = m.claims.get(id)!.body as unknown as { spec: { warmPoolRef: { name: string }; lifecycle: { shutdownPolicy: string; shutdownTime: string } } };
    expect(body.spec.warmPoolRef.name).toBe("python-pool");
    expect(body.spec.lifecycle.shutdownPolicy).toBe("Delete");
    expect(Date.parse(body.spec.lifecycle.shutdownTime)).toBeGreaterThan(Date.now());
    expect(m.commands[0]).toContain("/tmp/.sbr-env");
    await gkeAgentSandboxProvider.exec(id, "echo hi", { cwd: "/tmp" }, ctx);
    expect(m.commands[1]).toMatch(/^\[ -f \/tmp\/\.sbr-env \].*cd '\/tmp' && echo hi$/);
    await gkeAgentSandboxProvider.writeFile!(id, "/workspace/a.txt", new TextEncoder().encode("hello"), ctx);
    expect(new TextDecoder().decode(await gkeAgentSandboxProvider.readFile!(id, "/workspace/a.txt", ctx))).toBe("hello");
    expect(await gkeAgentSandboxProvider.listFiles!(id, "/workspace", ctx)).toEqual([{ name: "a.txt", path: "/workspace/a.txt", isDir: false, size: 5 }]);
    // Outside sandboxd's root the router falls back to exec.
    await expect(gkeAgentSandboxProvider.readFile!(id, "/etc/passwd", ctx)).rejects.toMatchObject({ kind: "unsupported" });
    await gkeAgentSandboxProvider.setTimeout!(id, 600, ctx);
    expect(m.seen).toContain(`PATCH /apis/extensions.agents.x-k8s.io/v1beta1/namespaces/team/sandboxclaims/${id}`);
  });

  it("deletes a claim the controller won't satisfy, then throws", async () => {
    const m = await k8sMock({ terminal: "WarmPoolNotFound" });
    await expect(gkeAgentSandboxProvider.create(spec("t"), ctxOf(m.env))).rejects.toThrow(/WarmPoolNotFound/);
    expect(m.claims.size).toBe(0);
  });

  it("lists live claims across pages, and maps a refused exec and a refused claim", async () => {
    const m = await k8sMock();
    const ctx = ctxOf(m.env);
    const a = await gkeAgentSandboxProvider.create(spec("a"), ctx);
    const b = await gkeAgentSandboxProvider.create(spec("b"), ctx);
    expect((await gkeAgentSandboxProvider.listAlive!(ctx)).sort()).toEqual([a.providerSandboxId, b.providerSandboxId].sort());
    expect(await refusal(gkeAgentSandboxProvider.create(spec("c"), ctxOf({ ...m.env, AGENT_SANDBOX_K8S_TOKEN: "wrong" })))).toBe("auth");
    const denied = await k8sMock({ execStatus: 16 });
    const dctx = ctxOf(denied.env);
    const c = await gkeAgentSandboxProvider.create(spec("d"), dctx);
    expect(await refusal(gkeAgentSandboxProvider.exec(c.providerSandboxId, "echo", {}, dctx))).toBe("auth");
  });
});

describe("azure-sessions", () => {
  async function azureMock(opts: { fail?: boolean; quota?: boolean } = {}) {
    const boxes = new Map<string, { state: string; polls: number; labels: Record<string, string>; files: Map<string, Buffer> }>();
    let tokenCalls = 0;
    let n = 0;
    const m = await mock((r) => {
      if (r.path === "/tenant-1/oauth2/v2.0/token") {
        tokenCalls++;
        const form = new URLSearchParams(r.body.toString());
        expect(form.get("scope")).toBe("https://dynamicsessions.io/.default");
        if (form.get("client_secret") !== "s3cret") return { status: 401, json: { error: "invalid_client" } };
        return { json: { access_token: "entra-token", expires_in: 3600 } };
      }
      if (r.headers["authorization"] !== "Bearer entra-token") return { status: 401, json: { error: { code: "Unauthorized", message: "unauthorized" } } };
      expect(r.query.get("api-version")).toBe("2026-02-01-preview");
      const g = "/subscriptions/sub/resourceGroups/rg/sandboxGroups/grp/sandboxes";
      if (r.method === "PUT" && r.path === g) {
        if (opts.quota) return { status: 429, json: { error: { code: "QuotaExceeded", message: "Sandbox quota exceeded for this subscription" } } };
        const body = r.json();
        expect(body.resources).toEqual({ cpu: "2", memory: "4Gi" });
        expect(body.sourcesRef.diskImage).toEqual({ name: "ubuntu", isPublic: true });
        const id = `sb-${++n}`;
        boxes.set(id, { state: "Creating", polls: 0, labels: body.labels, files: new Map() });
        return { status: 201, json: { id, state: "Creating", labels: body.labels } };
      }
      if (r.method === "GET" && r.path === g) {
        const all = [...boxes.entries()];
        const second = r.query.get("skipToken") === "2";
        const page = second ? all.slice(1) : all.slice(0, 1);
        return { json: { value: page.map(([id, b]) => ({ id, state: b.state, labels: b.labels })), nextLink: !second && all.length > 1 ? `${m.url}${g}?api-version=2026-02-01-preview&skipToken=2` : undefined } };
      }
      const bm = /^\/subscriptions\/sub\/resourceGroups\/rg\/sandboxGroups\/grp\/sandboxes\/([^/]+)(\/.*)?$/.exec(r.path);
      if (bm) {
        const b = boxes.get(bm[1]!);
        if (!b) return { status: 404, json: { error: { code: "NotFound", message: "sandbox not found" } } };
        const sub = bm[2] ?? "";
        if (sub === "" && r.method === "DELETE") {
          boxes.delete(bm[1]!);
          return { status: 204, raw: "" };
        }
        if (sub === "" && r.method === "GET") {
          if (b.polls++ > 0 && b.state === "Creating") b.state = opts.fail ? "StopFailed" : "Running";
          if (b.state === "Stopping") b.state = "Stopped";
          return { json: { id: bm[1], state: b.state, labels: b.labels } };
        }
        if (sub === "/executeShellCommand") {
          const run = fakeRun(r.json().command);
          return { json: { exitCode: run.code, stdout: run.stdout, stderr: run.stderr, executionTimeMs: 3 } };
        }
        if (sub === "/files" && r.method === "PUT") {
          expect(r.query.get("createDirs")).toBe("true");
          b.files.set(r.query.get("path")!, r.body);
          return { status: 201, raw: "" };
        }
        if (sub === "/files") return b.files.has(r.query.get("path")!) ? { raw: b.files.get(r.query.get("path")!)! } : { status: 404, json: {} };
        if (sub === "/files/list") return { json: { path: r.query.get("path"), entries: [...b.files.keys()].map((p) => ({ name: p.split("/").pop(), path: p, size: 5, isDirectory: false })) } };
        if (sub === "/ports/add") return { json: { port: r.json().port, url: `https://${bm[1]}-${r.json().port}.sandboxes.example` } };
        if (sub === "/stop") {
          b.state = "Stopping";
          return { json: { id: "snap-1" } };
        }
        if (sub === "/resume") {
          b.state = "Running";
          return { json: { id: bm[1], state: "Running" } };
        }
      }
      return undefined;
    });
    const env = {
      AZURE_SANDBOX_API_URL: m.url,
      AZURE_AUTHORITY_HOST: m.url,
      AZURE_SUBSCRIPTION_ID: "sub",
      AZURE_RESOURCE_GROUP: "rg",
      AZURE_SANDBOX_GROUP: "grp",
      AZURE_REGION: "eastus2",
      AZURE_TENANT_ID: "tenant-1",
      AZURE_CLIENT_ID: `client-${Math.random()}`,
      AZURE_CLIENT_SECRET: "s3cret",
    };
    return { ...m, env, boxes, tokenCalls: () => tokenCalls };
  }

  it("maps a request to the smallest tier that covers it", () => {
    expect(azureTier(2, 4096)).toMatchObject({ cpu: "2", memory: "4Gi" });
    expect(azureTier(1, 3000)).toMatchObject({ cpu: "2", memory: "4Gi" });
    expect(azureTier(0.25, 256)).toMatchObject({ cpu: "0.25", memory: "0.5Gi" });
    expect(azureTier(64, 1)).toMatchObject({ cpu: "16", memory: "32Gi" });
  });

  it("runs the lifecycle with native files, minting one client-credentials token", async () => {
    const m = await azureMock();
    const { router } = routerFor(azureSessionsProvider, m.env);
    const sbx = await lifecycle(router, { files: true });
    expect(m.boxes.size).toBe(0);
    expect(m.tokenCalls()).toBe(1);
    expect(m.seen).toContain(`DELETE /subscriptions/sub/resourceGroups/rg/sandboxGroups/grp/sandboxes/${sbx.providerSandboxId}`);
    await expect(azureSessionsProvider.kill(sbx.providerSandboxId, ctxOf(m.env))).resolves.toBeUndefined();
  });

  it("pauses, resumes, lists files, opens a port and lists live sandboxes across pages", async () => {
    const m = await azureMock();
    const ctx = ctxOf(m.env);
    const a = await azureSessionsProvider.create(spec("a"), ctx);
    const b = await azureSessionsProvider.create(spec("b"), ctx);
    expect(m.boxes.get(a.providerSandboxId)!.labels).toEqual({ sandboxrouting: "sbr", "sandboxrouting-id": "a" });
    await azureSessionsProvider.writeFile!(a.providerSandboxId, "/home/a.txt", new TextEncoder().encode("hello"), ctx);
    expect(await azureSessionsProvider.listFiles!(a.providerSandboxId, "/home", ctx)).toEqual([{ name: "a.txt", path: "/home/a.txt", isDir: false, size: 5 }]);
    expect(await azureSessionsProvider.getUrl!(a.providerSandboxId, 3000, ctx)).toBe(`https://${a.providerSandboxId}-3000.sandboxes.example`);
    await azureSessionsProvider.pause!(a.providerSandboxId, ctx);
    expect(m.boxes.get(a.providerSandboxId)!.state).toBe("Stopped");
    await azureSessionsProvider.resume!(a.providerSandboxId, ctx);
    expect(m.boxes.get(a.providerSandboxId)!.state).toBe("Running");
    expect((await azureSessionsProvider.listAlive!(ctx)).sort()).toEqual([a.providerSandboxId, b.providerSandboxId].sort());
  });

  it("deletes a sandbox that failed to start, then throws", async () => {
    const m = await azureMock({ fail: true });
    await expect(azureSessionsProvider.create(spec("f"), ctxOf(m.env))).rejects.toThrow(/StopFailed/);
    expect(m.boxes.size).toBe(0);
  });

  it("classifies a quota refusal and a bad secret", async () => {
    const q = await azureMock({ quota: true });
    expect(await refusal(azureSessionsProvider.create(spec("q"), ctxOf(q.env)))).toBe("quota");
    const bad = await azureMock();
    expect(await refusal(azureSessionsProvider.create(spec("x"), ctxOf({ ...bad.env, AZURE_CLIENT_SECRET: "nope" })))).toBe("auth");
  });

  it("is deleted by the sweep at the deadline", async () => {
    const m = await azureMock();
    const { router, clock } = routerFor(azureSessionsProvider, m.env);
    await deletedAtDeadline(router, clock, m.seen, (id) => `DELETE /subscriptions/sub/resourceGroups/rg/sandboxGroups/grp/sandboxes/${id}`);
  });
});
