// HTTP-only adapters driven through the router against local servers that speak their wire
// formats: the Cloudflare bridge contract (templates/cloudflare-worker) and the Sprites API.
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { SandboxRouter, MemoryLedger, cloudflareProvider, spritesProvider } from "../src/index.js";
import { decodeExecFrames } from "../src/providers/sprites.js";

const servers: Server[] = [];
afterEach(() => servers.splice(0).forEach((s) => s.close()));

async function listen(handler: (req: IncomingMessage, body: Buffer, url: URL) => { status?: number; json?: unknown; raw?: Buffer | Buffer[] }) {
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const out = handler(req, Buffer.concat(chunks), new URL(req.url ?? "/", "http://x"));
    if (Array.isArray(out.raw)) {
      // Write each frame as its own chunk, as the Sprites server does.
      res.writeHead(out.status ?? 200, { "content-type": "application/octet-stream" });
      for (const frame of out.raw) {
        res.write(frame);
        await new Promise((r) => setTimeout(r, 5));
      }
      return res.end();
    }
    res.writeHead(out.status ?? 200, { "content-type": out.raw ? "application/octet-stream" : "application/json" });
    res.end(out.raw ?? JSON.stringify(out.json ?? {}));
  });
  servers.push(server.listen(0, "127.0.0.1"));
  await new Promise((ok) => server.once("listening", ok));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("cloudflare bridge adapter", () => {
  it("create → exec → files → extend → kill over the bridge contract, with auth", async () => {
    const live = new Set<string>();
    const files = new Map<string, Buffer>();
    const seen: string[] = [];
    const url = await listen((req, body, u) => {
      seen.push(`${req.method} ${u.pathname}`);
      if (req.headers.authorization !== "Bearer t0k") return { status: 401, json: { error: "unauthorized" } };
      const [, , id, sub, subsub] = u.pathname.split("/");
      if (u.pathname === "/sandboxes" && req.method === "POST") {
        const b = JSON.parse(body.toString());
        live.add(b.id);
        return { status: 201, json: { id: b.id } };
      }
      if (u.pathname === "/sandboxes" && req.method === "GET") return { json: [...live].map((id) => ({ id })) };
      if (sub === "exec") {
        const b = JSON.parse(body.toString());
        return { json: { stdout: `ran ${b.command} in ${b.cwd ?? "/"}`, stderr: "", exitCode: 0 } };
      }
      if (sub === "files" && subsub === "list") return { json: [{ name: "a.txt", type: "file" }, { name: "d", type: "directory" }] };
      if (sub === "files" && req.method === "PUT") return files.set(u.searchParams.get("path")!, body), { json: { ok: true } };
      if (sub === "files") return { raw: files.get(u.searchParams.get("path")!) ?? Buffer.alloc(0) };
      if (sub === "timeout") return { json: { ok: true } };
      if (req.method === "DELETE") return live.delete(id!), { json: { ok: true } };
      return { status: 404, json: {} };
    });

    const router = new SandboxRouter({
      providers: [cloudflareProvider],
      ledger: new MemoryLedger(),
      env: { CLOUDFLARE_SANDBOX_URL: url, CLOUDFLARE_SANDBOX_TOKEN: "t0k" },
    });
    const sbx = await router.create({ timeoutSec: 120 });
    expect(sbx.provider).toBe("cloudflare");
    expect((await sbx.commands.run("ls", { cwd: "/w" })).stdout).toBe("ran ls in /w");
    await sbx.files.write("/w/a.txt", new Uint8Array([0, 255, 7]));
    expect([...(await sbx.files.readBytes("/w/a.txt"))]).toEqual([0, 255, 7]);
    expect((await sbx.files.list("/w")).map((f) => [f.name, f.isDir])).toEqual([["a.txt", false], ["d", true]]);
    await sbx.setTimeout(600);
    await sbx.kill();
    expect(live.size).toBe(0);
    expect(seen).toContain("POST /sandboxes");
  });

  it("is not configured without the bridge URL and token", async () => {
    const router = new SandboxRouter({ providers: [cloudflareProvider], ledger: new MemoryLedger(), env: {} });
    expect((await router.plan()).skipped[0]!.reason).toMatch(/CLOUDFLARE_SANDBOX_URL/);
  });
});

describe("sprites adapter", () => {
  it("decodes exec frames, including an exit frame glued to the last read", async () => {
    async function* chunks() {
      yield Uint8Array.from([1, ...Buffer.from("out")]);
      yield Uint8Array.from([2, ...Buffer.from("err")]);
      yield Uint8Array.from([1, ...Buffer.from("more"), 3, 7]); // exit glued on
    }
    const r = await decodeExecFrames(chunks());
    expect([r.stdout.toString(), r.stderr.toString(), r.exitCode]).toEqual(["outmore", "err", 7]);
  });

  it("refuses a body with no exit frame", async () => {
    async function* chunks() {
      yield Uint8Array.from([1, ...Buffer.from("x")]);
    }
    await expect(decodeExecFrames(chunks())).rejects.toThrow(/no exit frame/);
  });

  it("is deleted by the router at the deadline, since Sprites have no TTL", async () => {
    let t = Date.UTC(2026, 10, 11, 12);
    const alive = new Set<string>();
    const deleted: string[] = [];
    const url = await listen((req, body, u) => {
      const parts = u.pathname.split("/"); // ["", "v1", "sprites", name?, sub?]
      if (u.pathname === "/v1/sprites" && req.method === "POST") {
        alive.add(JSON.parse(body.toString()).name);
        return { status: 201, json: {} };
      }
      if (u.pathname === "/v1/sprites" && req.method === "GET") return { json: { sprites: [...alive].map((name) => ({ name })) } };
      if (parts[4] === "exec") {
        return { raw: [Buffer.from([1, ...Buffer.from(`${u.searchParams.getAll("cmd").join(" ")}\n`)]), Buffer.from([3, 0])] };
      }
      if (req.method === "DELETE") {
        alive.delete(parts[3]!);
        deleted.push(parts[3]!);
        return { status: 204, json: {} };
      }
      return { status: 404, json: {} };
    });
    const router = new SandboxRouter({
      providers: [spritesProvider],
      ledger: new MemoryLedger(),
      env: { SPRITES_TOKEN: "x", SPRITES_BASE_URL: url },
      config: { allowPaid: true },
      now: () => t,
    });
    const sbx = await router.create({ timeoutSec: 60 });
    expect((await sbx.commands.run("echo hi")).stdout).toBe("sh -c echo hi\n");
    t += 61_000;
    const swept = await router.sweep();
    expect(swept.reaped).toBe(1);
    expect(deleted).toEqual([sbx.providerSandboxId]);
    expect((await sbx.info())!.state).toBe("stopped");
  });
});
