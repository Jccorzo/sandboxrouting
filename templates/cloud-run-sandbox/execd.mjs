// sandboxrouting's execd for Cloud Run sandboxes. It runs in a Cloud Run instance created with
// `sandboxLauncher: true`, starts one detached sandbox with the `sandbox` CLI Cloud Run mounts
// into the container, and runs each command in it with `sandbox exec`. Dependency-free.
// https://docs.cloud.google.com/run/docs/code-execution
// https://docs.cloud.google.com/run/docs/reference/sandbox-cli
//
//   GET  /health  200 once the sandbox runs, 503 while it starts, 500 if it failed to start
//   POST /exec    {command, cwd?, env?, timeoutSec?} → {stdout, stderr, exitCode}
//
// Every request carries x-sbr-token: SBR_TOKEN. At SBR_DEADLINE (epoch seconds) it deletes the
// sandbox and exits; with restartPolicy NEVER the instance then stops and stops billing.

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";

const BIN = process.env.SANDBOX_BINARY || "/usr/local/gcp/bin/sandbox";
const NAME = "sbr";
const TOKEN = process.env.SBR_TOKEN || "";
const DEADLINE = Number(process.env.SBR_DEADLINE || 0) * 1000;
const EGRESS = process.env.SBR_ALLOW_EGRESS !== "0";
const BOX_ENV = JSON.parse(Buffer.from(process.env.SBR_ENV || "e30=", "base64").toString() || "{}");
// The CLI exits 1 for any failing command, so the real status travels in a stderr trailer.
const TRAILER = /<<sbr-exit:(\d+)>>$/;

let state = { ready: false, error: "" };

const envArgs = (env) => Object.entries(env ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]);

function run(args, timeoutMs) {
  return new Promise((resolve) => {
    // The CLI gets env through -e, never the host's env (which holds SBR_TOKEN).
    const child = spawn(BIN, args, { env: { PATH: process.env.PATH, HOME: "/tmp" }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    const timer = timeoutMs ? setTimeout(() => child.kill("SIGKILL"), timeoutMs) : undefined;
    child.on("error", (err) => resolve({ stdout, stderr: stderr + String(err), code: 127 }));
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? (signal ? 137 : 1) });
    });
  });
}

async function start() {
  const r = await run(["run", "--detach", "--write", ...(EGRESS ? ["--allow-egress"] : []), ...envArgs(BOX_ENV), NAME]);
  state = r.code === 0 ? { ready: true, error: "" } : { ready: false, error: (r.stderr || r.stdout || `sandbox run exited ${r.code}`).trim() };
}

async function exec({ command, cwd, env, timeoutSec }) {
  const limit = Number(timeoutSec) > 0 ? Math.ceil(Number(timeoutSec)) : 0;
  // Inside the sandbox `timeout` ends the command itself, not only its client.
  const body = limit ? `if command -v timeout >/dev/null 2>&1; then timeout -k 1 ${limit} /bin/sh -c "$1"; else /bin/sh -c "$1"; fi` : '/bin/sh -c "$1"';
  const script = `${body}; c=$?; printf '<<sbr-exit:%d>>' "$c" >&2; exit $c`;
  const args = ["exec", "--stdin=false", ...envArgs(env), ...(cwd ? ["-w", cwd] : []), NAME, "--", "/bin/sh", "-c", script, "sbr", command];
  const r = await run(args, limit ? (limit + 10) * 1000 : 0);
  const m = TRAILER.exec(r.stderr);
  if (m) return { stdout: r.stdout, stderr: r.stderr.slice(0, m.index), exitCode: Number(m[1]) };
  // No trailer: the CLI itself failed (the sandbox is gone, or it was killed).
  return { stdout: r.stdout, stderr: r.stderr, exitCode: r.code === 0 ? 1 : r.code };
}

function authorized(req) {
  const got = Buffer.from(String(req.headers["x-sbr-token"] ?? ""));
  const want = Buffer.from(TOKEN);
  return TOKEN !== "" && got.length === want.length && timingSafeEqual(got, want);
}

const send = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

createServer(async (req, res) => {
  try {
    if (!authorized(req)) return send(res, 401, { error: "unauthorized" });
    if (req.method === "GET" && req.url === "/health") {
      if (state.error) return send(res, 500, { error: state.error });
      return send(res, state.ready ? 200 : 503, { ready: state.ready });
    }
    if (req.method === "POST" && req.url === "/exec") {
      if (!state.ready) return send(res, 503, { error: state.error || "sandbox is starting" });
      const chunks = [];
      for await (const c of req) chunks.push(c);
      return send(res, 200, await exec(JSON.parse(Buffer.concat(chunks).toString() || "{}")));
    }
    send(res, 404, { error: "not found" });
  } catch (err) {
    send(res, 500, { error: String(err) });
  }
}).listen(Number(process.env.PORT || 8080), "0.0.0.0");

void start();

if (DEADLINE) {
  setTimeout(async () => {
    await run(["delete", "--force", NAME], 30_000);
    process.exit(0);
  }, Math.max(0, DEADLINE - Date.now()));
}
