// The hosted router's egress guard: no fetch from it reaches an internal address, by IP or by a
// name that resolves to one, through Node's fetch or the dispatcher adapters pass themselves.
// (Its own file: installing the guard changes this process's fetch.)
import { afterAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { guardedAgent, guardedLookup, installEgressGuard, isBlockedAddress } from "../src/hosted-router/egress.js";
import { http } from "../../src/providers/util.js";

const servers: Server[] = [];
afterAll(() => servers.forEach((s) => s.close()));

async function local(): Promise<number> {
  const s = createServer((_req, res) => res.end("internal"));
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return (s.address() as AddressInfo).port;
}

const refusal = (p: Promise<unknown>) =>
  p.then(
    () => "answered",
    (e: unknown) => String((e as { cause?: unknown }).cause ?? e),
  );

describe("which addresses are blocked", () => {
  it("private, loopback, link-local, CGNAT, multicast and their IPv6 forms; not public ones", () => {
    for (const a of ["127.0.0.1", "10.1.2.3", "172.16.0.9", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "::1", "::", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:a9fe:a9fe", "64:ff9b::a9fe:a9fe", "[::1]", "not-an-ip"]) {
      expect(isBlockedAddress(a), a).toBe(true);
    }
    for (const a of ["8.8.8.8", "34.120.1.1", "2606:4700::6810:84e5", "::ffff:8.8.8.8"]) expect(isBlockedAddress(a), a).toBe(false);
  });

  it("refuses a name that resolves to a blocked address", async () => {
    const err = await new Promise<Error | null>((r) => guardedLookup("localhost", {}, (e) => r(e)));
    expect(String(err)).toMatch(/refused to connect to localhost/);
  });
});

describe("the guarded dispatcher", () => {
  it("refuses loopback by IP and by name, which answer without it", async () => {
    const port = await local();
    expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe("internal");
    const agent = guardedAgent();
    expect(await refusal(fetch(`http://127.0.0.1:${port}/`, { dispatcher: agent } as unknown as RequestInit))).toMatch(/refused to connect to 127\.0\.0\.1/);
    expect(await refusal(fetch(`http://localhost:${port}/`, { dispatcher: agent } as unknown as RequestInit))).toMatch(/refused to connect to localhost/);
    expect(await refusal(fetch("http://169.254.169.254/computeMetadata/v1/", { dispatcher: agent } as unknown as RequestInit))).toMatch(/refused/);
  });

  it("once installed, holds for Node's fetch and for the dispatcher adapters pass (dispatcherFor)", async () => {
    const port = await local();
    installEgressGuard();
    expect(await refusal(fetch(`http://127.0.0.1:${port}/`))).toMatch(/refused/);
    expect(await refusal(http(`http://127.0.0.1:${port}/`, { timeoutMs: 2000 }))).toMatch(/refused/);
    expect(await refusal(fetch(`http://[::1]:${port}/`))).toMatch(/refused/);
  });
});
