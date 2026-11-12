// sandboxrouting bridge for Cloudflare Sandboxes (@cloudflare/sandbox 1.x).
//
// Cloudflare has no hosted sandbox API: a sandbox is a Durable Object plus the Container it
// starts, inside your own Worker. This Worker exposes the small HTTP contract the router's
// `cloudflare` provider speaks. Deploy it with `npx wrangler deploy`, set the secret
// SANDBOX_TOKEN, and give the router CLOUDFLARE_SANDBOX_URL + CLOUDFLARE_SANDBOX_TOKEN.
//
//   POST   /sandboxes                    {id, env?, timeoutSec?, internet?} → {id}
//   POST   /sandboxes/{id}/exec          {command, cwd?, env?} → {stdout, stderr, exitCode}
//   GET    /sandboxes/{id}/files?path=   bytes
//   PUT    /sandboxes/{id}/files?path=   bytes
//   GET    /sandboxes/{id}/files/list?path=  [{name, type}]
//   POST   /sandboxes/{id}/timeout       {timeoutSec}
//   DELETE /sandboxes/{id}
//   GET    /sandboxes                    [{id}] live sandboxes (tracked in a registry object)

import { Files } from "@cloudflare/sandbox";
import { DurableObject } from "cloudflare:workers";

interface Env {
  SANDBOX: DurableObjectNamespace<Sandbox>;
  REGISTRY: DurableObjectNamespace<Registry>;
  SANDBOX_TOKEN: string;
}

const decode = (b: ArrayBuffer | Uint8Array) => new TextDecoder().decode(b);

export class Sandbox extends DurableObject<Env> {
  private get container() {
    const c = this.ctx.container;
    if (!c) throw new Error("the container binding is not configured");
    return c;
  }

  async start(opts: { id: string; env?: Record<string, string>; timeoutSec?: number; internet?: boolean }) {
    const c = this.container;
    if (!c.running) c.start({ env: opts.env, enableInternet: opts.internet ?? true });
    await this.ctx.storage.put("id", opts.id);
    await this.deadline(opts.timeoutSec ?? 300);
    await this.env.REGISTRY.getByName("all").add(opts.id);
  }

  /** The router's timeout: an alarm destroys the container at the deadline. */
  async deadline(timeoutSec: number) {
    await this.ctx.storage.setAlarm(Date.now() + timeoutSec * 1000);
  }

  override async alarm() {
    await this.destroy();
  }

  async exec(command: string, cwd?: string, env?: Record<string, string>) {
    const p = await this.container.exec(["sh", "-c", command], { cwd, env });
    const out = await p.output();
    return { stdout: decode(out.stdout), stderr: decode(out.stderr), exitCode: out.exitCode };
  }

  async readFile(path: string): Promise<ArrayBuffer> {
    return (await new Files(this.container).readFile(path)).arrayBuffer();
  }

  async writeFile(path: string, data: ArrayBuffer) {
    await new Files(this.container).writeFile(path, data);
  }

  async list(path: string) {
    return (await new Files(this.container).readDirectory(path)).map((e) => ({ name: e.name, type: String(e.type) }));
  }

  async destroy() {
    const id = await this.ctx.storage.get<string>("id");
    if (this.ctx.container?.running) await this.ctx.container.destroy();
    await this.ctx.storage.deleteAlarm();
    if (id) await this.env.REGISTRY.getByName("all").remove(id);
  }
}

/** Which sandboxes are live, so the router's sweep can reconcile. */
export class Registry extends DurableObject<Env> {
  async add(id: string) {
    await this.ctx.storage.put(`s:${id}`, Date.now());
  }
  async remove(id: string) {
    await this.ctx.storage.delete(`s:${id}`);
  }
  async list(): Promise<string[]> {
    return [...(await this.ctx.storage.list({ prefix: "s:" })).keys()].map((k) => k.slice(2));
  }
}

function authorized(req: Request, env: Env): boolean {
  const got = req.headers.get("authorization") ?? "";
  const want = `Bearer ${env.SANDBOX_TOKEN}`;
  if (!env.SANDBOX_TOKEN || got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= got.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0;
}

export default {
  async fetch(req, env) {
    if (!authorized(req, env)) return Response.json({ error: "unauthorized" }, { status: 401 });
    const url = new URL(req.url);
    const [resource, id, sub, subsub] = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (resource !== "sandboxes") return Response.json({ error: "not found" }, { status: 404 });
    try {
      if (!id) {
        if (req.method === "GET") return Response.json((await env.REGISTRY.getByName("all").list()).map((x) => ({ id: x })));
        if (req.method === "POST") {
          const body = await req.json<{ id: string; env?: Record<string, string>; timeoutSec?: number; internet?: boolean }>();
          if (!/^[\w.-]{1,64}$/.test(body.id ?? "")) return Response.json({ error: "id is required" }, { status: 400 });
          await env.SANDBOX.getByName(body.id).start(body);
          return Response.json({ id: body.id }, { status: 201 });
        }
      } else {
        const sbx = env.SANDBOX.getByName(id);
        const path = url.searchParams.get("path") ?? ".";
        if (!sub && req.method === "DELETE") {
          await sbx.destroy();
          return Response.json({ ok: true });
        }
        if (sub === "exec" && req.method === "POST") {
          const b = await req.json<{ command: string; cwd?: string; env?: Record<string, string> }>();
          return Response.json(await sbx.exec(b.command, b.cwd, b.env));
        }
        if (sub === "timeout" && req.method === "POST") {
          await sbx.deadline((await req.json<{ timeoutSec: number }>()).timeoutSec);
          return Response.json({ ok: true });
        }
        if (sub === "files" && subsub === "list" && req.method === "GET") return Response.json(await sbx.list(path));
        if (sub === "files" && !subsub && req.method === "GET") return new Response(await sbx.readFile(path));
        if (sub === "files" && !subsub && req.method === "PUT") {
          await sbx.writeFile(path, await req.arrayBuffer());
          return Response.json({ ok: true });
        }
      }
      return Response.json({ error: "not found" }, { status: 404 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = /ENOENT|not found/i.test(message) ? 404 : 500;
      return Response.json({ error: message }, { status });
    }
  },
} satisfies ExportedHandler<Env>;
