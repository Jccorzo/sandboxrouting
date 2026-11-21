// Fixes to code every adapter shares, found while adding the 2026-11-21 providers: a 410 means
// gone, a provider's misleading refusal status is declared once, and a long command's single
// response isn't cut off by fetch's own 300-second wait for headers.

import { describe, expect, it } from "vitest";
import { mock } from "./restmock.js";
import { classify } from "../src/core/errors.js";
import { dispatcherFor, http, HttpError, refusals } from "../src/providers/util.js";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { zipboxProvider } from "../src/providers/zipbox.js";

describe("classify", () => {
  it("reads 410 Gone as not_found, like 404, not as a transient failure", () => {
    expect(classify(new HttpError(410, "DELETE /v1/sandboxes/sb_1: 410 {\"error\":\"sandbox_deleted\"}")).kind).toBe("not_found");
    expect(classify({ status: 410, message: "gone" }).kind).toBe("not_found");
  });
});

describe("refusals whose status misleads", () => {
  it("turns a declared status and body into the kind it means, and leaves the rest alone", () => {
    const refused = refusals("acme", [
      { status: 409, body: /insufficient_balance/, kind: "quota", why: "no balance left" },
      { status: 429, kind: "rate_limit" },
    ]);
    const money = refused(new HttpError(409, 'POST /v1/boxes: 409 {"error":"insufficient_balance"}'));
    expect(classify(money, "acme")).toMatchObject({ kind: "quota", provider: "acme" });
    expect((money as Error).message).toMatch(/^acme: no balance left: POST/);
    expect(classify(refused(new HttpError(429, "POST /v1/boxes: 429 Quota exceeded"))).kind).toBe("rate_limit");
    const other = new HttpError(409, 'POST /v1/boxes: 409 {"error":"name_taken"}');
    expect(refused(other)).toBe(other);
    const notHttp = new Error("socket hang up");
    expect(refused(notHttp)).toBe(notHttp);
  });

  it("zipbox: 403 machine_limit_reached is the account's permanent 250-name cap, a quota, not a bad key", async () => {
    // Body as zipbox.ai/docs/machine-limit.md documents it.
    const { url } = await mock(() => ({
      status: 403,
      json: { error: { code: "machine_limit_reached", message: "You've reached this account's limit of 250 machines.", retryable: false, retryAfterMs: null } },
    }));
    const err = await zipboxProvider
      .create({ cpu: 2, memoryMiB: 4096, timeoutSec: 60, env: {}, metadata: {} }, { env: { ZIPBOX_API_KEY: "zb_k", ZIPBOX_API_URL: url }, options: { pollMs: 1 } })
      .then(() => undefined, (e: unknown) => e);
    expect(classify(err, "zipbox").kind).toBe("quota");
  });
});

describe("http and long requests", () => {
  // The dispatcher Node's own fetch uses (undici's global one, under a versioned registry symbol).
  const builtinUndiciMajor = Number(process.versions["undici"]?.split(".")[0] ?? 0);
  const globalDispatcher = Symbol.for(`undici.globalDispatcher.${builtinUndiciMajor >= 8 ? 2 : 1}`);
  type Dispatch = { dispatch(opts: Record<string, unknown>, handler: unknown): boolean };

  it("lets the request's own timeoutMs govern how long it waits for headers and body, not fetch's 300 s", async () => {
    const { url } = await mock(() => ({ json: { ok: true } }));
    await http(url); // loads Node's fetch, which installs its global dispatcher
    const g = globalThis as unknown as Record<symbol, Dispatch>;
    const original = g[globalDispatcher]!;
    const seen: Record<string, unknown>[] = [];
    g[globalDispatcher] = { dispatch: (opts, handler) => (seen.push(opts), original.dispatch(opts, handler)) };
    try {
      await http(url, { timeoutMs: 600_000 });
    } finally {
      g[globalDispatcher] = original;
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]!["headersTimeout"]).toBeGreaterThanOrEqual(600_000);
    expect(seen[0]!["bodyTimeout"]).toBeGreaterThanOrEqual(600_000);
  });

  it("passes those timeouts on in a way Node's fetch obeys (proved with a short one)", async () => {
    // Headers come after 1.5 s. A 300 ms headers timeout must cut the request off, though its
    // signal allows 10 s; a 3 s one must not. So the per-request setting really reaches undici.
    const server = createServer((_req, res) => setTimeout(() => res.end("late"), 1500));
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    const get = (headersMs: number) =>
      fetch(url, { signal: AbortSignal.timeout(10_000), dispatcher: dispatcherFor(headersMs) as unknown as RequestInit["dispatcher"] });
    try {
      const cut = await get(300).then(() => undefined, (e: unknown) => e as Error & { cause?: { code?: string } });
      expect(cut?.cause?.code).toBe("UND_ERR_HEADERS_TIMEOUT");
      expect(await (await get(3000)).text()).toBe("late");
    } finally {
      server.close();
    }
  });
});
