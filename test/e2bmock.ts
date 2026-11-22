// A local stand-in for a service that speaks E2B's API: the control plane (REST, X-API-KEY) and
// envd inside each sandbox (REST /files and Connect RPC with the JSON codec), on one server.
// Shapes follow https://docs.e2b.dev/openapi-public.yaml, the envd spec in e2b-dev/infra, and what
// the official `e2b` SDK 2.55 sends. Point E2B_API_URL and E2B_SANDBOX_URL at its `url`.
import { fakeRun, mock, type Req, type Reply } from "./restmock.js";

export interface E2bBox {
  files: Map<string, Buffer>;
  paused: boolean;
  timeout: number;
  template: string;
  metadata: Record<string, string>;
  envVars: Record<string, string>;
}

/** One Connect envelope: flags byte, big-endian length, JSON. */
const envelope = (msg: unknown, flags = 0) => {
  const json = Buffer.from(JSON.stringify(msg));
  const head = Buffer.alloc(5);
  head[0] = flags;
  head.writeUInt32BE(json.length, 1);
  return Buffer.concat([head, json]);
};

/** The file part of a multipart/form-data body. */
function formFile(r: Req): Buffer {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(String(r.headers["content-type"]))!;
  const b = `--${boundary[1] ?? boundary[2]}`;
  const text = r.body.toString("latin1");
  const start = text.indexOf("\r\n\r\n", text.indexOf(b)) + 4;
  const end = text.indexOf(`\r\n${b}`, start);
  return Buffer.from(text.slice(start, end), "latin1");
}

export async function e2bMock(opts: { key: string; envdVersion?: string; token?: string; domain?: string; createStatus?: Reply } = { key: "k" }) {
  const boxes = new Map<string, E2bBox>();
  const bodies: { route: string; body: unknown; headers: Req["headers"]; query: URLSearchParams }[] = [];
  let n = 0;
  const sandbox = (id: string) => ({ sandboxID: id, envdVersion: opts.envdVersion ?? "0.5.8", envdAccessToken: opts.token ?? "tok", domain: opts.domain ?? "e2b.test" });
  const server = await mock((r) => {
    const json = r.body.length && String(r.headers["content-type"]).includes("json") && !String(r.headers["content-type"]).includes("connect") ? r.json() : undefined;
    bodies.push({ route: `${r.method} ${r.path}`, body: json, headers: r.headers, query: r.query });
    const envd = r.path.startsWith("/files") || r.path.startsWith("/process.") || r.path.startsWith("/filesystem.");
    if (envd) {
      const box = boxes.get(String(r.headers["e2b-sandbox-id"]));
      if (!box || box.paused) return { status: 502, raw: "The sandbox was not found", type: "text/plain" };
      if (r.headers["x-access-token"] !== (opts.token ?? "tok")) return { status: 401, json: { code: 401, message: "unauthorized" } };
      if (r.method === "GET" && r.path === "/files") {
        const f = box.files.get(r.query.get("path")!);
        return f ? { raw: f } : { status: 404, json: { code: 404, message: "file not found" } };
      }
      if (r.method === "POST" && r.path === "/files") {
        box.files.set(r.query.get("path")!, formFile(r));
        return { json: [{ name: r.query.get("path"), type: "file", path: r.query.get("path") }] };
      }
      if (r.path === "/process.Process/Start") {
        const len = r.body.readUInt32BE(1);
        const req = JSON.parse(r.body.subarray(5, 5 + len).toString()) as { process: { cmd: string; args: string[] } };
        const out = fakeRun(req.process.args.at(-1)!);
        const parts = [envelope({ event: { start: { pid: 7 } } }), envelope({ event: { keepalive: {} } })];
        if (out.stdout) parts.push(envelope({ event: { data: { stdout: Buffer.from(out.stdout).toString("base64") } } }));
        if (out.stderr) parts.push(envelope({ event: { data: { stderr: Buffer.from(out.stderr).toString("base64") } } }));
        // proto3 JSON leaves a zero exit code out.
        parts.push(envelope({ event: { end: { ...(out.code ? { exitCode: out.code } : {}), exited: true, status: `exit status ${out.code}` } } }));
        parts.push(envelope({}, 0x02));
        return { raw: Buffer.concat(parts), type: "application/connect+json" };
      }
      if (r.path === "/filesystem.Filesystem/ListDir") {
        return { json: { entries: [{ name: "a.txt", path: "/tmp/a.txt", type: "FILE_TYPE_FILE", size: "5" }, { name: "d", path: "/tmp/d", type: "FILE_TYPE_DIRECTORY", size: "0" }] } };
      }
      return undefined;
    }
    if (r.headers["x-api-key"] !== opts.key) return { status: 401, json: { code: 401, message: "Invalid API key" } };
    if (r.method === "POST" && r.path === "/v2/sandboxes") {
      if (opts.createStatus) return opts.createStatus;
      const b = r.json();
      const id = `sbx-${++n}`;
      boxes.set(id, { files: new Map(), paused: false, timeout: b.timeout, template: b.templateID, metadata: b.metadata ?? {}, envVars: b.envVars ?? {} });
      return { status: 201, json: sandbox(id) };
    }
    let m = /^\/v2\/sandboxes\/([^/]+)\/connect$/.exec(r.path);
    if (m && r.method === "POST") {
      const box = boxes.get(m[1]!);
      if (!box) return { status: 404, json: { code: 404, message: `sandbox ${m[1]} not found` } };
      box.paused = false;
      return { json: sandbox(m[1]!) };
    }
    m = /^\/sandboxes\/([^/]+)(\/timeout|\/pause)?$/.exec(r.path);
    if (m) {
      const box = boxes.get(m[1]!);
      if (!box) return { status: 404, json: { code: 404, message: "not found" } };
      if (r.method === "DELETE" && !m[2]) return boxes.delete(m[1]!), { status: 204, raw: "" };
      if (m[2] === "/timeout") return (box.timeout = r.json().timeout), { status: 204, raw: "" };
      if (m[2] === "/pause") {
        if (box.paused) return { status: 409, json: { code: 409, message: "already paused" } };
        return (box.paused = true), { status: 204, raw: "" };
      }
    }
    if (r.method === "GET" && r.path === "/v2/sandboxes") {
      const states = (r.query.get("state") ?? "").split(",");
      const want = new URLSearchParams(r.query.get("metadata") ?? "");
      const all = [...boxes].filter(([, b]) => states.includes(b.paused ? "paused" : "running") && [...want].every(([k, v]) => b.metadata[decodeURIComponent(k)] === decodeURIComponent(v)));
      // Pages of one, to exercise x-next-token.
      const from = Number(r.query.get("nextToken") ?? 0);
      const page = all.slice(from, from + 1).map(([id]) => ({ sandboxID: id, state: "running" }));
      return { json: page, headers: from + 1 < all.length ? { "x-next-token": String(from + 1) } : {} };
    }
    return undefined;
  });
  return { ...server, boxes, bodies };
}
