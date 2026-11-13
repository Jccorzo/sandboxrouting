// REST-only adapters driven through the router against local servers that speak each
// provider's wire format (from its OpenAPI spec where published, else its docs).
import { describe, expect, it } from "vitest";
import { deletedAtDeadline, fakeRun, lifecycle, mock, routerFor } from "./restmock.js";
import { quivvoProvider } from "../src/providers/quivvo.js";
import { instaboxProvider } from "../src/providers/instabox.js";
import { dedalusProvider } from "../src/providers/dedalus.js";
import { createosProvider, createosShape } from "../src/providers/createos.js";
import { boatProvider, boatType } from "../src/providers/boat.js";
import { agent37Provider } from "../src/providers/agent37.js";
import { exedevProvider, parseExeNdjson } from "../src/providers/exedev.js";
import { thunderProvider, thunderSshArgs } from "../src/providers/thunder.js";

describe("quivvo", () => {
  it("runs the lifecycle against its OpenAPI shapes", async () => {
    const files = new Map<string, Buffer>();
    const { url, seen } = await mock((r) => {
      if (r.headers.authorization !== "Bearer qvk_test") return { status: 401, json: { error: "unauthorized" } };
      if (r.method === "POST" && r.path === "/machines") {
        expect(r.query.get("wait")).toBe("1");
        expect(r.json().delete_after_minutes).toBe(2);
        return { status: 201, json: { id: "m_1", name: "x", state: "running", vcpus: 1, memory_mib: 2048 } };
      }
      if (r.method === "POST" && r.path === "/machines/m_1/exec") {
        const x = fakeRun(r.json().cmd);
        return { json: { id: "e1", exit_code: x.code, stdout: x.stdout, stderr: x.stderr } };
      }
      if (r.path === "/machines/m_1/files" && r.method === "PUT") return files.set(r.query.get("path")!, r.body), { json: { path: r.query.get("path"), size: r.body.length } };
      if (r.path === "/machines/m_1/files" && r.method === "GET") return { raw: files.get(r.query.get("path")!) ?? "" };
      if (r.method === "DELETE" && r.path === "/machines/m_1") return { json: { deleted: true } };
      return undefined;
    });
    const { router } = routerFor(quivvoProvider, { QUIVVO_API_KEY: "qvk_test", QUIVVO_API_URL: url });
    await lifecycle(router, { files: true });
    expect(seen).toContain("DELETE /machines/m_1");
  });
});

describe("instabox", () => {
  it("polls operations and sends the confirmation headers on delete", async () => {
    let opPolls = 0;
    const { url, seen } = await mock((r) => {
      if (r.headers["x-api-key"] !== "ibk_test") return { status: 401, json: {} };
      if (r.method === "POST" && r.path === "/v1/machines") {
        expect(r.headers["idempotency-key"]).toBeTruthy();
        expect(r.json().deleteAfterSeconds).toBe(120);
        return { status: 202, json: { id: "op_c", state: "queued", type: "create" } };
      }
      if (r.path === "/v1/operations/op_c") return { json: opPolls++ < 1 ? { id: "op_c", state: "running" } : { id: "op_c", state: "succeeded", machineId: "mch_1" } };
      if (r.path === "/v1/operations/op_d") return { json: { id: "op_d", state: "succeeded", machineId: "mch_1" } };
      if (r.method === "POST" && r.path === "/v1/machines/mch_1/exec") {
        const x = fakeRun(r.json().cmd);
        return { json: { stdout: x.stdout, stderr: x.stderr, exitCode: x.code, timedOut: false, truncated: false } };
      }
      if (r.method === "DELETE" && r.path === "/v1/machines/mch_1") {
        expect(r.headers["x-confirm-delete"]).toBe("mch_1");
        expect(r.headers["idempotency-key"]).toBeTruthy();
        return { status: 202, json: { id: "op_d", state: "queued" } };
      }
      return undefined;
    });
    const { router } = routerFor(instaboxProvider, { INSTABOX_API_KEY: "ibk_test", INSTABOX_API_URL: url });
    await lifecycle(router);
    expect(opPolls).toBe(2);
    expect(seen).toContain("DELETE /v1/machines/mch_1");
  });
});

describe("dedalus", () => {
  const server = async () => {
    let n = 0;
    const execs = new Map<string, { code: number; stdout: string; stderr: string; polls: number }>();
    return mock((r) => {
      if (r.headers.authorization !== "Bearer dsk_test") return { status: 401, json: {} };
      if (r.method === "POST" && r.path === "/v1/machines") return { json: { machine_id: `mac-${++n}`, phase: "accepted", vcpu: 1, memory_mib: 2048 } };
      const mm = /^\/v1\/machines\/(mac-\d+)(.*)$/.exec(r.path);
      if (!mm) return undefined;
      const [, id, rest] = mm;
      if (r.method === "GET" && rest === "") return { json: { machine_id: id, status: { phase: "running" } } };
      if (r.method === "DELETE" && rest === "") return { json: { machine_id: id, phase: "destroying" } };
      if (r.method === "POST" && rest === "/executions") {
        expect(r.headers["idempotency-key"]).toBeTruthy();
        const x = fakeRun(r.json().command.join(" "));
        const eid = `ex-${execs.size + 1}`;
        execs.set(eid, { ...x, polls: 0 });
        return { json: { execution_id: eid, status: "queued" } };
      }
      const em = /^\/executions\/(ex-\d+)(\/output)?$/.exec(rest!);
      if (em) {
        const e = execs.get(em[1]!)!;
        if (em[2]) return { json: { execution_id: em[1], stdout: e.stdout, stderr: e.stderr } };
        return { json: e.polls++ < 1 ? { execution_id: em[1], status: "running" } : { execution_id: em[1], status: e.code ? "failed" : "succeeded", exit_code: e.code } };
      }
      return undefined;
    });
  };

  it("creates, polls executions for output and exit code, and kills", async () => {
    const { url } = await server();
    const { router } = routerFor(dedalusProvider, { DEDALUS_API_KEY: "dsk_test", DEDALUS_BASE_URL: url });
    await lifecycle(router);
  });

  it("is deleted by the sweep at the deadline (no TTL)", async () => {
    const { url, seen } = await server();
    const { router, clock } = routerFor(dedalusProvider, { DEDALUS_API_KEY: "dsk_test", DEDALUS_BASE_URL: url });
    await deletedAtDeadline(router, clock, seen, (id) => `DELETE /v1/machines/${id}`);
  });
});

describe("createos", () => {
  const server = async () => {
    let n = 0;
    const files = new Map<string, Buffer>();
    const ok = (data: unknown) => ({ json: { status: "success", data } });
    return mock((r) => {
      if (r.headers["x-api-key"] !== "cos_test") return { status: 401, json: { status: "fail" } };
      if (r.method === "POST" && r.path === "/sandboxes") {
        expect(r.json().shape).toBe("s-1vcpu-1gb");
        return ok({ id: `SB${++n}`, status: "creating" });
      }
      const mm = /^\/sandboxes\/(SB\d+)(.*)$/.exec(r.path);
      if (!mm) return undefined;
      const [, id, rest] = mm;
      if (r.method === "GET" && rest === "") return ok({ id, status: "running" });
      if (r.method === "DELETE" && rest === "") return ok({ id });
      if (rest === "/exec") {
        const b = r.json();
        expect(b.cmd).toBe("sh");
        const x = fakeRun(b.args[1]);
        return ok({ result: { stdout: x.stdout, stderr: x.stderr, exit_code: x.code } });
      }
      if (rest === "/files" && r.method === "PUT") return files.set(r.query.get("path")!, r.body), ok({});
      if (rest === "/files") return { raw: files.get(r.query.get("path")!) ?? "" };
      return undefined;
    });
  };

  it("runs the lifecycle through JSend envelopes", async () => {
    const { url } = await server();
    const { router } = routerFor(createosProvider, { CREATEOS_SANDBOX_API_KEY: "cos_test", CREATEOS_SANDBOX_BASE_URL: url });
    await lifecycle(router, { files: true });
  });

  it("is deleted by the sweep at the deadline (no TTL)", async () => {
    const { url, seen } = await server();
    const { router, clock } = routerFor(createosProvider, { CREATEOS_SANDBOX_API_KEY: "cos_test", CREATEOS_SANDBOX_BASE_URL: url });
    await deletedAtDeadline(router, clock, seen, (id) => `DELETE /sandboxes/${id}`);
  });

  it("picks the smallest shape that fits", () => {
    expect(createosShape(1, 1024).shape).toBe("s-1vcpu-1gb");
    expect(createosShape(2, 2048).shape).toBe("s-2vcpu-4gb");
    expect(createosShape(64, 1).shape).toBe("s-4vcpu-8gb");
  });
});

describe("boat", () => {
  it("waits until ready, runs commands, round-trips files and confirms the delete", async () => {
    let polls = 0;
    const files = new Map<string, string>();
    const { url, seen } = await mock((r) => {
      if (r.headers.authorization !== "Bearer boat_test") return { status: 401, json: {} };
      if (r.method === "POST" && r.path === "/sandboxes") {
        expect(r.json()).toMatchObject({ type: "small", ttlSeconds: 120 });
        return { status: 202, json: { status: "provisioning", sandbox: { id: "bx_1", status: "provisioning" } } };
      }
      if (r.method === "GET" && r.path === "/sandboxes/bx_1") return { json: { sandbox: { id: "bx_1", status: polls++ < 1 ? "provisioning" : "ready" } } };
      if (r.method === "POST" && r.path === "/sandboxes/bx_1/commands") {
        const x = fakeRun(r.json().command);
        return { json: { exitCode: x.code, stdout: x.stdout, stderr: x.stderr, timedOut: false } };
      }
      if (r.method === "PUT" && r.path === "/sandboxes/bx_1/files") {
        const b = r.json();
        files.set(b.path, Buffer.from(b.content, b.encoding).toString());
        return { json: { ok: true } };
      }
      if (r.method === "GET" && r.path === "/sandboxes/bx_1/files") return { json: { content: files.get(r.query.get("path")!), encoding: "utf8" } };
      if (r.method === "DELETE" && r.path === "/sandboxes/bx_1") {
        expect(r.headers["x-ascii-confirm-delete"]).toBe("bx_1");
        return { json: { deleted: true } };
      }
      return undefined;
    });
    const { router } = routerFor(boatProvider, { BOAT_API_KEY: "boat_test", BOAT_API_URL: url });
    await lifecycle(router, { files: true });
    expect(seen).toContain("DELETE /sandboxes/bx_1");
  });

  it("maps vCPUs to Boat sizes", () => {
    expect(boatType(1).type).toBe("small");
    expect(boatType(3).type).toBe("default");
    expect(boatType(12).type).toBe("xlarge");
  });
});

describe("agent37", () => {
  const servers2 = async () => {
    let n = 0;
    const control = await mock((r) => {
      if (r.headers.authorization !== "Bearer sk_live_test") return { status: 401, json: {} };
      if (r.method === "POST" && r.path === "/v1/instances") return { status: 201, json: { id: `inst_${++n}`, status: "running" } };
      if (r.method === "DELETE" && /^\/v1\/instances\/inst_\d+$/.test(r.path)) return { json: { id: r.path.split("/").pop(), deleted: true } };
      return undefined;
    });
    const exec = await mock((r) => {
      if (r.headers["x-agent37-key"] !== "sk_live_test") return { status: 401, json: {} };
      if (r.method === "POST" && /^\/v1\/instances\/inst_\d+\/exec$/.test(r.path)) {
        const x = fakeRun(r.json().command);
        return { json: { exit_code: x.code, stdout: x.stdout, stderr: x.stderr, truncated: false } };
      }
      return undefined;
    });
    return { control, exec, env: { AGENT37_API_KEY: "sk_live_test", AGENT37_API_URL: `${control.url}/v1`, AGENT37_EXEC_URL: exec.url } };
  };

  it("uses the control API for lifecycle and the exec host for commands", async () => {
    const { env, exec } = await servers2();
    const { router } = routerFor(agent37Provider, env);
    await lifecycle(router);
    expect(exec.seen).toContain("POST /v1/instances/inst_1/exec");
  });

  it("is deleted by the sweep at the deadline (no TTL)", async () => {
    const { env, control } = await servers2();
    const { router, clock } = routerFor(agent37Provider, env);
    await deletedAtDeadline(router, clock, control.seen, (id) => `DELETE /v1/instances/${id}`);
  });
});

describe("exe.dev", () => {
  const server = async () => {
    const lines: string[] = [];
    const nd = (out: { stdout?: string; stderr?: string; code: number }) => ({
      raw: [out.stdout && { stdout: Buffer.from(out.stdout).toString("base64") }, out.stderr && { stderr: Buffer.from(out.stderr).toString("base64") }, { exit_code: out.code }]
        .filter(Boolean)
        .map((x) => JSON.stringify(x))
        .join("\n"),
      type: "application/x-ndjson",
    });
    const m = await mock((r) => {
      if (r.headers.authorization !== "Bearer exe1test") return { status: 401, json: {} };
      if (r.method !== "POST" || r.path !== "/exec") return undefined;
      expect(r.headers.accept).toBe("application/x-ndjson");
      const line = r.body.toString();
      lines.push(line);
      if (line.startsWith("new --sandbox --name=sbr-")) return nd({ stdout: "{}", code: 0 });
      if (line.startsWith("rm sbr-")) return nd({ code: 0 });
      if (line.startsWith("ssh sbr-")) return nd({ ...fakeRun(line), code: fakeRun(line).code });
      return nd({ stderr: "unknown command", code: 1 });
    });
    return { ...m, lines };
  };

  it("drives VMs through SSH commands posted to /exec", async () => {
    const { url, lines } = await server();
    const { router } = routerFor(exedevProvider, { EXE_API_TOKEN: "exe1test", EXE_API_URL: `${url}/exec` });
    await lifecycle(router);
    expect(lines.some((l) => l.startsWith("rm sbr-"))).toBe(true);
    // Two quoting layers: the VM's shell gets `sh -c '<command>'`.
    expect(lines.find((l) => l.includes("echo hi"))).toMatch(/^ssh sbr-[0-9a-f]+ 'sh -c '\\''echo hi'\\'''$/);
  });

  it("is deleted by the sweep at the deadline (no TTL)", async () => {
    const { url, lines } = await server();
    const { router, clock } = routerFor(exedevProvider, { EXE_API_TOKEN: "exe1test", EXE_API_URL: `${url}/exec` });
    const sbx = await router.create({ timeoutSec: 60 });
    clock.t += 61_000;
    expect((await router.sweep()).reaped).toBe(1);
    expect(lines).toContain(`rm ${sbx.providerSandboxId}`);
  });

  it("parses the NDJSON stream", () => {
    const text = [{ stdout: Buffer.from("a").toString("base64") }, { stderr: Buffer.from("b").toString("base64") }, { stdout: Buffer.from("c").toString("base64") }, { exit_code: 2 }]
      .map((x) => JSON.stringify(x))
      .join("\n");
    expect(parseExeNdjson(text)).toEqual({ stdout: "ac", stderr: "b", exitCode: 2 });
    expect(() => parseExeNdjson('{"stdout":"YQ=="}')).toThrow(/no exit code/);
  });
});

describe("thunder", () => {
  it("starts with a TTL, waits for ready, and stops (exec is SSH, tested separately)", async () => {
    let polls = 0;
    const { url, seen } = await mock((r) => {
      if (r.headers.authorization !== "Bearer tnr_test") return { status: 401, json: {} };
      if (r.method === "POST" && r.path === "/sandboxes/start") {
        const b = r.json();
        expect(b.lifetime).toMatchObject({ enforce_ttl: true, max_ttl_seconds: 120 });
        expect(b.spec).toMatchObject({ cpu_count: 2, memory_gib: 4 });
        expect(b.network_policy.internet_access).toBe("open");
        return { status: 202, json: { id: "sbx_1", name: "x" } };
      }
      if (r.method === "GET" && r.path === "/sandboxes/sbx_1") {
        return { json: { id: "sbx_1", status: polls++ < 1 ? "created" : "ready", ssh: { host: "h", port: 2222, user: "u" } } };
      }
      if (r.method === "GET" && r.path === "/sandboxes") return { json: { sandboxes: [{ id: "sbx_1", status: "ready" }, { id: "sbx_0", status: "finished" }] } };
      if (r.method === "POST" && r.path === "/sandboxes/sbx_1/stop") return { status: 202, json: { name: "x" } };
      return undefined;
    });
    const env = { TNR_API_TOKEN: "tnr_test", TNR_API_URL: url };
    const { router } = routerFor(thunderProvider, env);
    const sbx = await router.create({ timeoutSec: 120 });
    expect(sbx.providerSandboxId).toBe("sbx_1");
    expect(await thunderProvider.listAlive!({ env, options: {} })).toEqual(["sbx_1"]);
    await sbx.kill();
    expect(seen).toContain("POST /sandboxes/sbx_1/stop");
  });

  it("builds the ssh command with the certificate and a quoted command", () => {
    const args = thunderSshArgs({ keyPath: "/k/k", certPath: "/k/k-cert.pub", knownHosts: "/k/known", host: "h.example", port: 2222, user: "sbx", command: "echo 'hi'" });
    expect(args).toContain("CertificateFile=/k/k-cert.pub");
    expect(args).toContain("StrictHostKeyChecking=accept-new");
    expect(args.slice(-3)).toEqual(["2222", "sbx@h.example", `sh -c 'echo '\\''hi'\\'''`]);
  });
});
