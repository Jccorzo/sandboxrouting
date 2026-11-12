#!/usr/bin/env node
// sandboxrouting exec server for AWS Lambda MicroVMs (and any VM without an exec API).
//
// Lambda MicroVMs can create, suspend and terminate VMs but have no exec API: you reach a
// VM only through its HTTPS endpoint, which proxies to a port inside it. Bake this file into
// the image; the router's `lambda-microvm` provider talks to it through that endpoint.
//
//   POST /run                         lifecycle hook: body is RunMicrovm's runHookPayload,
//                                     {"env": {...}} becomes the env of later commands
//   POST /exec  {command, cwd?, env?, timeoutSec?}  → {stdout, stderr, exitCode}
//   GET  /files?path=                 file bytes
//   PUT  /files?path=                 write bytes (parents created)
//   GET  /files/list?path=            [{name, isDir, size}]
//   GET  /health                      {ok: true}
//
// No dependencies; Node 18+. Listens on $PORT (default 8080). The Lambda endpoint already
// requires an auth token (X-aws-proxy-auth); set SBR_EXECD_TOKEN to also require a bearer.

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const PORT = Number(process.env.PORT ?? 8080);
const TOKEN = process.env.SBR_EXECD_TOKEN ?? "";
const MAX_OUTPUT = 16 * 1024 * 1024;
let runEnv = {};

const send = (res, status, body, type = "application/json") => {
  const data = type === "application/json" ? JSON.stringify(body) : body;
  res.writeHead(status, { "content-type": type, "content-length": Buffer.byteLength(data) });
  res.end(data);
};

async function body(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

function run(command, { cwd, env, timeoutSec }) {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", command], { cwd: cwd || undefined, env: { ...process.env, ...runEnv, ...env } });
    let stdout = "";
    let stderr = "";
    const cap = (s, add) => (s.length < MAX_OUTPUT ? s + add : s);
    child.stdout.on("data", (b) => (stdout = cap(stdout, b.toString())));
    child.stderr.on("data", (b) => (stderr = cap(stderr, b.toString())));
    const timer = timeoutSec ? setTimeout(() => child.kill("SIGKILL"), timeoutSec * 1000) : undefined;
    child.on("error", (err) => resolve({ stdout, stderr: stderr + String(err), exitCode: 127 }));
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? (signal === "SIGKILL" ? 137 : 1) });
    });
  });
}

export const server = createServer(async (req, res) => {
  try {
    if (TOKEN && req.headers.authorization !== `Bearer ${TOKEN}`) return send(res, 401, { error: "unauthorized" });
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.searchParams.get("path") ?? ".";
    if (url.pathname === "/health") return send(res, 200, { ok: true });
    if (url.pathname === "/run" && req.method === "POST") {
      const raw = (await body(req)).toString();
      try {
        const parsed = raw ? JSON.parse(raw) : {};
        if (parsed && typeof parsed.env === "object") runEnv = parsed.env;
      } catch {
        // A payload that isn't ours: keep running.
      }
      return send(res, 200, { ok: true });
    }
    if (url.pathname === "/exec" && req.method === "POST") {
      const b = JSON.parse((await body(req)).toString() || "{}");
      if (typeof b.command !== "string") return send(res, 400, { error: "command is required" });
      return send(res, 200, await run(b.command, b));
    }
    if (url.pathname === "/files/list" && req.method === "GET") {
      const entries = await readdir(path, { withFileTypes: true });
      const out = await Promise.all(
        entries.map(async (e) => ({ name: e.name, isDir: e.isDirectory(), size: e.isFile() ? (await stat(join(path, e.name))).size : undefined })),
      );
      return send(res, 200, out);
    }
    if (url.pathname === "/files" && req.method === "GET") return send(res, 200, await readFile(path), "application/octet-stream");
    if (url.pathname === "/files" && req.method === "PUT") {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, await body(req));
      return send(res, 200, { ok: true });
    }
    send(res, 404, { error: "not found" });
  } catch (err) {
    send(res, err?.code === "ENOENT" ? 404 : 500, { error: String(err?.message ?? err) });
  }
});

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  server.listen(PORT, "0.0.0.0", () => console.error(`sbr execd on :${PORT}`));
}
