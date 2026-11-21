// What the REST adapter tests share: a local server that speaks a provider's wire format,
// a router with one adapter, and the lifecycle every provider must get through.
import { afterEach, expect } from "vitest";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { SandboxRouter, MemoryLedger, type ProviderAdapter } from "../src/index.js";

export interface Req {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingMessage["headers"];
  body: Buffer;
  // A mocked request body is whatever the adapter under test sent.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json: () => any;
}
export type Reply = { status?: number; json?: unknown; raw?: Buffer | string; type?: string; headers?: Record<string, string> };

const servers: Server[] = [];
afterEach(() => servers.splice(0).forEach((s) => s.close()));

/** A mock provider API; every request is recorded as "METHOD /path". */
export async function mock(handler: (r: Req) => Reply | undefined) {
  const seen: string[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const u = new URL(req.url ?? "/", "http://x");
    const body = Buffer.concat(chunks);
    seen.push(`${req.method} ${u.pathname}`);
    const out = handler({ method: req.method ?? "GET", path: u.pathname, query: u.searchParams, headers: req.headers, body, json: () => JSON.parse(body.toString() || "{}") }) ?? {
      status: 404,
      json: { error: `no route ${req.method} ${u.pathname}` },
    };
    const payload = out.raw ?? JSON.stringify(out.json ?? {});
    res.writeHead(out.status ?? 200, { "content-type": out.type ?? (out.raw !== undefined ? "application/octet-stream" : "application/json"), ...out.headers });
    res.end(payload);
  });
  // On the address the tests dial. A server on every address (`::`) shares its port number with
  // any other process that binds 127.0.0.1 to it, and macOS sends 127.0.0.1 to that one.
  servers.push(server.listen(0, "127.0.0.1"));
  await new Promise((ok) => server.once("listening", ok));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

/** What every mock's exec does: `exit N` exits N, anything else echoes. */
export const fakeRun = (cmd: string) => {
  const m = /exit (\d+)/.exec(cmd);
  return m ? { stdout: "", stderr: "boom\n", code: Number(m[1]) } : { stdout: `ran: ${cmd}\n`, stderr: "", code: 0 };
};

export function routerFor(adapter: ProviderAdapter, env: Record<string, string>, clock = { t: Date.UTC(2026, 10, 11, 12) }) {
  const router = new SandboxRouter({
    providers: [adapter],
    ledger: new MemoryLedger(),
    env,
    now: () => clock.t,
    config: { allowPaid: true, providers: { [adapter.info.id]: { options: { pollMs: 5 } } } },
  });
  return { router, clock };
}

/** create → exec (ok and non-zero) → optional files → kill, shared by every provider. */
export async function lifecycle(router: SandboxRouter, opts: { files?: boolean } = {}) {
  const sbx = await router.create({ timeoutSec: 120 });
  const ok = await sbx.commands.run("echo hi");
  expect(ok.exitCode).toBe(0);
  expect(ok.stdout).toContain("echo hi");
  const bad = await sbx.commands.run("exit 3");
  expect(bad.exitCode).toBe(3);
  if (opts.files) {
    await sbx.files.write("/tmp/a.txt", "hello");
    expect(await sbx.files.read("/tmp/a.txt")).toBe("hello");
  }
  await sbx.kill();
  expect((await sbx.info())!.state).toBe("stopped");
  return sbx;
}

/** For providers without a TTL: past the deadline, the sweep deletes the sandbox. */
export async function deletedAtDeadline(router: SandboxRouter, clock: { t: number }, seen: string[], deletePath: (id: string) => string) {
  const sbx = await router.create({ timeoutSec: 60 });
  clock.t += 61_000;
  const swept = await router.sweep();
  expect(swept.reaped).toBe(1);
  expect(seen).toContain(deletePath(sbx.providerSandboxId));
}
