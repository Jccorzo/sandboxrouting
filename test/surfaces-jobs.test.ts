// Jobs through the REST API, the MCP server and the CLI. REST and MCP run on a local-shell
// provider (its boxes are temp dirs on this machine), so a step really reads what the step
// before it wrote. The CLI runs in a subprocess, where only a configured provider could run a
// step, so it gets validation, unknown ids and queued jobs, plus jobs this process ran on a
// ledger and checkpoint directory the two share.

import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import type { AddressInfo } from "node:net";
import { runFile } from "./run-file.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, createMcpServer, FileCheckpointStore, FileLedger, JobManager, SandboxRouter, type JobView } from "../src/index.js";
import { router } from "./fake.js";
import { localShellProvider, type LocalShell } from "./localshell.js";

const shells: LocalShell[] = [];
const gates: string[] = [];
afterAll(() => Promise.all([...shells.map((s) => s.cleanup()), ...gates.map((d) => rm(d, { recursive: true, force: true }))]));

/**
 * A step that holds until `release()`. The local shell runs it on this machine, so it can watch
 * a file here; it also gives up when the directory goes, so no loop outlives the tests.
 */
async function gate() {
  const dir = await mkdtemp(join(tmpdir(), "sbr-gate-"));
  gates.push(dir);
  const open = join(dir, "open");
  return {
    step: { run: `until [ -e '${open}' ] || [ ! -d '${dir}' ]; do sleep 0.02; done; echo released`, timeoutSec: 60 },
    release: () => writeFile(open, ""),
  };
}

function shellRouter() {
  const ls = localShellProvider({ id: "ls" });
  shells.push(ls);
  return { ls, r: router([ls]).router };
}

async function serve(r: SandboxRouter) {
  const server = createServer(r).listen(0);
  await new Promise((ok) => server.once("listening", ok));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  const post = (path: string, body?: unknown) =>
    fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const get = (path: string) => fetch(`${base}${path}`);
  return { post, get, close: () => server.close() };
}

/** Polls until `done` holds (a background runner is moving the job). */
async function until<T>(read: () => Promise<T | undefined>, done: (v: T) => boolean): Promise<T> {
  for (let i = 0; i < 250; i++) {
    const v = await read();
    if (v && done(v)) return v;
    await new Promise((ok) => setTimeout(ok, 20));
  }
  throw new Error("timed out waiting for the job");
}

const ended = (v: { state: string }) => ["succeeded", "failed", "cancelled"].includes(v.state);

async function mcp(r: SandboxRouter) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createMcpServer(r).connect(a);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(b);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const body = (res.content as { text: string }[])[0]!.text;
    return { isError: Boolean(res.isError), body, json: () => JSON.parse(body) };
  };
  return { client, call };
}

describe("REST API: jobs", () => {
  it("runs a job to its end with ?wait=1, where step 2 reads what step 1 wrote, and serves its workspace", async () => {
    const { r } = shellRouter();
    const api = await serve(r);
    try {
      const res = await api.post("/jobs?wait=1", {
        name: "upper",
        files: { "in.txt": "hello\n" },
        steps: [{ run: "tr a-z A-Z < in.txt > out.txt" }, { run: "cat out.txt" }],
      });
      expect(res.status).toBe(200);
      const job = (await res.json()) as JobView;
      expect(job.state).toBe("succeeded");
      expect([job.cursor, job.steps]).toEqual([2, 2]);
      expect(job.results[1]!.stdoutTail).toBe("HELLO\n");
      expect(job.placements.map((p) => [p.provider, p.endReason])).toEqual([["ls", "finished"]]);

      const again = (await (await api.get(`/jobs/${job.id}`)).json()) as JobView;
      expect([again.id, again.state, again.name]).toEqual([job.id, "succeeded", "upper"]);
      expect(((await (await api.get("/jobs")).json()) as JobView[]).map((j) => j.id)).not.toContain(job.id);
      expect(((await (await api.get("/jobs?all=1")).json()) as JobView[]).map((j) => j.id)).toContain(job.id);

      const archive = await api.get(`/jobs/${job.id}/workspace`);
      expect(archive.status).toBe(200);
      expect(archive.headers.get("content-type")).toBe("application/gzip");
      const bytes = new Uint8Array(await archive.arrayBuffer());
      expect([bytes[0], bytes[1]]).toEqual([0x1f, 0x8b]);
      const tar = gunzipSync(bytes).toString("latin1");
      expect(tar).toContain("out.txt");
      expect(tar).toContain("HELLO");
    } finally {
      api.close();
    }
  });

  it("answers 400 for an invalid job and 404 for an unknown one", async () => {
    const { r } = shellRouter();
    const api = await serve(r);
    try {
      const noSteps = await api.post("/jobs", { name: "x" });
      expect(noSteps.status).toBe(400);
      expect((await noSteps.json()).error).toBe("steps must be a list");

      const blank = await api.post("/jobs?wait=1", { steps: [{ run: "echo ok" }, { run: "  " }] });
      expect(blank.status).toBe(400);
      expect((await blank.json()).error).toBe("steps[1].run must be a command");
      expect(await r.jobs.list({ all: true })).toEqual([]);

      for (const res of [
        await api.get("/jobs/job_nope"),
        await api.get("/jobs/job_nope/workspace"),
        await api.post("/jobs/job_nope/cancel"),
        await api.post("/jobs/job_nope/resume"),
      ]) {
        expect(res.status).toBe(404);
        expect((await res.json()).error).toMatch(/no job job_nope/);
      }
    } finally {
      api.close();
    }
  });

  it("cancels a running job and kills its box; a finished job stays as it ended", async () => {
    const { r } = shellRouter();
    const api = await serve(r);
    const g = await gate();
    try {
      const accepted = await api.post("/jobs", { steps: [g.step, { run: "echo never" }] });
      expect(accepted.status).toBe(202);
      const { id } = (await accepted.json()) as JobView;
      const running = await until(() => r.jobs.get(id), (v) => v.state === "running");

      const res = await api.post(`/jobs/${id}/cancel`);
      expect(res.status).toBe(200);
      const cancelled = (await res.json()) as JobView;
      expect(cancelled.state).toBe("cancelled");
      expect(cancelled.placements.at(-1)!.endReason).toBe("cancelled");
      expect((await r.get(running.sandboxId!))!.state).toBe("stopped");
      expect(((await (await api.get(`/jobs/${id}`)).json()) as JobView).state).toBe("cancelled");

      const done = (await (await api.post("/jobs?wait=1", { steps: [{ run: "true" }] })).json()) as JobView;
      const late = await api.post(`/jobs/${done.id}/cancel`);
      expect(late.status).toBe(200);
      expect(((await late.json()) as JobView).state).toBe("succeeded");
    } finally {
      await g.release();
      api.close();
    }
  });

  it("answers 202 with the claimed job at once, then drives it while its step is held", async () => {
    const { r } = shellRouter();
    const api = await serve(r);
    const g = await gate();
    try {
      const res = await api.post("/jobs", { name: "held", steps: [g.step] });
      expect(res.status).toBe(202);
      const claimed = (await res.json()) as JobView;
      expect(claimed.id).toMatch(/^job_/);
      // Claimed by this server, before any box exists.
      expect([claimed.state, claimed.placements]).toEqual(["placing", []]);

      // Its step can't end before the release, so this answer came while the drive went on.
      const held = await until(() => r.jobs.get(claimed.id), (v) => v.state === "running");
      expect(held.cursor).toBe(0);
      await g.release();
      const finished = await until(() => r.jobs.get(claimed.id), ended);
      expect(finished.state).toBe("succeeded");
      expect(finished.results[0]!.stdoutTail).toBe("released\n");
    } finally {
      await g.release();
      api.close();
    }
  });

  it("resume answers 202 once it claims the job, 409 with the job while a runner holds it, and 200 once it ended", async () => {
    const { r } = shellRouter();
    const api = await serve(r);
    const g = await gate();
    const other = await gate();
    try {
      const queued = await r.jobs.submit({ steps: [g.step] });
      const res = await api.post(`/jobs/${queued.id}/resume`);
      expect(res.status).toBe(202);
      expect(((await res.json()) as JobView).state).toBe("placing");

      // This server drives it now, so a second resume loses, and sees where it stands.
      await until(() => r.jobs.get(queued.id), (v) => v.state === "running");
      const again = await api.post(`/jobs/${queued.id}/resume`);
      expect(again.status).toBe(409);
      expect(await again.json()).toMatchObject({ kind: "conflict", job: { id: queued.id, state: "running" } });

      // Another process holds this one: its lease check, inside the claim, refuses the takeover.
      const elsewhere = new JobManager(r, { store: r.checkpoints, ownerId: "elsewhere" });
      const theirs = await r.jobs.submit({ steps: [other.step] });
      const driving = elsewhere.resume(theirs.id);
      await until(() => r.jobs.get(theirs.id), (v) => v.state === "running");
      const taken = await api.post(`/jobs/${theirs.id}/resume`);
      expect(taken.status).toBe(409);
      const body = await taken.json();
      expect(body.error).toMatch(/owned by elsewhere/);
      expect(body.job).toMatchObject({ id: theirs.id, state: "running" });

      await Promise.all([g.release(), other.release()]);
      expect((await driving).state).toBe("succeeded");
      expect((await until(() => r.jobs.get(queued.id), ended)).state).toBe("succeeded");
      const over = await api.post(`/jobs/${queued.id}/resume`);
      expect(over.status).toBe(200);
      expect(((await over.json()) as JobView).state).toBe("succeeded");
    } finally {
      await Promise.all([g.release(), other.release()]);
      api.close();
    }
  });
});

describe("MCP server: jobs", () => {
  it("runs a job end to end with run_job, then reports it with job_status", async () => {
    const { r } = shellRouter();
    const { client, call } = await mcp(r);

    const tools = (await client.listTools()).tools;
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(["run_job", "job_status", "list_jobs", "cancel_job", "resume_job", "move_sandbox", "list_strategies"]),
    );
    expect(tools.find((t) => t.name === "list_jobs")?.annotations?.readOnlyHint).toBe(true);

    const run = await call("run_job", {
      name: "mcp",
      sandbox: { strategy: "fastest", timeoutSec: 600 },
      files: { "in.txt": "from the agent\n" },
      setup: [{ run: "test -d . " }],
      steps: [{ run: "cp in.txt out.txt" }, { run: "cat out.txt", noCheckpoint: true }],
    });
    expect(run.isError).toBe(false);
    const job = run.json();
    expect(job).toMatchObject({ name: "mcp", state: "succeeded", stepsDone: 2, steps: 2, providers: ["ls"], migrations: 0 });
    expect(job.placements).toEqual([expect.objectContaining({ provider: "ls", endReason: "finished" })]);
    expect(job.lastResult).toMatchObject({ step: 1, exitCode: 0, stdoutTail: "from the agent\n" });

    const status = (await call("job_status", { id: job.id })).json();
    expect(status.state).toBe("succeeded");
    expect(status.history.at(-1).type).toBe("succeed");

    // Already over: cancel changes nothing and says so.
    expect((await call("cancel_job", { id: job.id })).json().state).toBe("succeeded");

    const failing = (await call("run_job", { steps: [{ run: "echo half; echo oops >&2; exit 3" }] })).json();
    expect(failing.state).toBe("failed");
    expect(failing.error).toMatch(/exited 3/);
    expect(failing.lastResult).toBeUndefined();
    expect(failing.failedStep).toMatchObject({ step: 0, exitCode: 3, provider: "ls", stdoutTail: "half\n", stderrTail: "oops\n" });
    expect((await call("job_status", { id: failing.id })).json().failedStep.exitCode).toBe(3);

    const invalid = await call("run_job", { steps: [{ run: "echo ok", retries: 1.5 }] });
    expect(invalid.isError).toBe(true);
    expect(invalid.body).toBe("invalid: steps[0].retries must be a whole number");

    const missing = await call("job_status", { id: "job_nope" });
    expect(missing.isError).toBe(true);
    expect(missing.body).toMatch(/no job job_nope/);
  });

  it("answers run_job after waitSec with the job still running; job_status and list_jobs follow it to the end", async () => {
    const { r } = shellRouter();
    const { call } = await mcp(r);
    const g = await gate();
    try {
      const started = await call("run_job", { name: "held", steps: [g.step], waitSec: 0.2 });
      expect(started.isError).toBe(false);
      const job = started.json();
      expect(job.id).toMatch(/^job_/);
      expect(["placing", "preparing", "running"]).toContain(job.state);
      expect(job.note).toMatch(/^Still running after 0.2 s/);
      expect((await call("list_jobs")).json()).toEqual([expect.objectContaining({ id: job.id, name: "held", steps: 1 })]);

      // This process drives it, so taking it over again loses and shows where it stands.
      const second = await call("resume_job", { id: job.id, waitSec: 0 });
      expect(second.isError).toBe(true);
      expect(second.json()).toMatchObject({ error: expect.stringMatching(/^conflict: /), job: { id: job.id } });

      await g.release();
      const done = await until(async () => (await call("job_status", { id: job.id })).json(), ended);
      expect(done.state).toBe("succeeded");
      expect(done.lastResult.stdoutTail).toBe("released\n");
      expect((await call("list_jobs")).json()).toEqual([]);
      expect((await call("list_jobs", { all: true })).json().map((j: { id: string }) => j.id)).toEqual([job.id]);
    } finally {
      await g.release();
    }
  });

  it("resume_job takes over a queued job and waits for it like run_job", async () => {
    const { r } = shellRouter();
    const { call } = await mcp(r);
    const queued = await r.jobs.submit({ steps: [{ run: "echo picked up" }] });

    const resumed = (await call("resume_job", { id: queued.id })).json();
    expect(resumed).toMatchObject({ id: queued.id, state: "succeeded", stepsDone: 1 });
    expect(resumed.note).toBeUndefined();
    expect(resumed.lastResult.stdoutTail).toBe("picked up\n");

    // Over: nothing to claim, and it comes back as it ended.
    const over = await call("resume_job", { id: queued.id });
    expect([over.isError, over.json().state]).toEqual([false, "succeeded"]);

    const missing = await call("resume_job", { id: "job_nope" });
    expect(missing.isError).toBe(true);
    expect(missing.body).toBe("not_found: no job job_nope");
  });
});

/** An empty SBR_HOME with no provider configured, and `sbr` run against it. */
async function cliHome(cfg: unknown = {}) {
  const home = await mkdtemp(join(tmpdir(), "sbr-cli-jobs-"));
  const config = join(home, "config.json");
  await writeFile(config, JSON.stringify(cfg));
  const env = { PATH: process.env["PATH"], HOME: home, SBR_HOME: home, SBR_DOCKER: "0", SBR_CONFIG: config };
  const exec = runFile;
  const sbr = (...args: string[]) =>
    exec("node", ["--import", "tsx", "src/cli.ts", ...args], { env }).then(
      ({ stdout, stderr }) => ({ stdout, stderr, code: 0 }),
      (e: { stdout: string; stderr: string; code: number }) => ({ stdout: e.stdout, stderr: e.stderr, code: e.code }),
    );
  return { home, sbr, cleanup: () => rm(home, { recursive: true, force: true }) };
}

describe("CLI: jobs", () => {
  it("validates job input, reports unknown jobs, and submits, lists, shows and cancels a queued one", async () => {
    const { home, sbr, cleanup } = await cliHome();
    try {
      const file = join(home, "job.json");
      await writeFile(file, JSON.stringify({ steps: [{ run: "" }] }));
      const [noSteps, badFile, unknown, noArchive] = await Promise.all([
        sbr("job", "run"),
        sbr("job", "run", "--file", file, "--step", "echo appended"),
        sbr("job", "status", "job_nope"),
        sbr("job", "download", "job_nope"),
      ]);
      expect(noSteps.code).toBe(1);
      expect(noSteps.stderr).toMatch(/^sbr: invalid: steps must be a list/);
      expect(badFile.code).toBe(1);
      expect(badFile.stderr).toMatch(/steps\[0\]\.run must be a command/);
      expect(unknown.code).toBe(1);
      expect(unknown.stderr).toMatch(/not_found: no job job_nope/);
      expect(noArchive.code).toBe(1);
      expect(noArchive.stderr).toMatch(/no job job_nope/);

      // Recording, listing, showing and cancelling a job needs no provider.
      const submitted = await sbr("job", "submit", "--name", "later", "--step", "make", "--step", "make test", "--strategy", "spread");
      expect(submitted.code).toBe(0);
      const id = submitted.stdout.trim();
      expect(id).toMatch(/^job_/);

      const ls = await sbr("job", "ls");
      expect(ls.stdout).toMatch(new RegExp(`^${id}\\s+queued\\s+0/2\\s+0\\s+\\S+ \\S+\\s+later$`, "m"));
      const status = await sbr("job", "status", id);
      expect(status.stdout).toMatch(/^state {5}queued$/m);
      expect(status.stdout).toMatch(/^steps {5}0\/2 done$/m);
      expect(status.stdout).toMatch(/submitted {2}2 steps/);
      const json = JSON.parse((await sbr("job", "status", id, "--json")).stdout) as JobView;
      expect(json.name).toBe("later");

      const cancelled = await sbr("job", "cancel", id);
      expect(cancelled.code).toBe(0);
      expect(cancelled.stdout.trim()).toBe(`job ${id} cancelled`);
      // Resuming a job that ended reports how it ended, and only success exits 0.
      const resumed = await sbr("job", "resume", id);
      expect(resumed.code).toBe(1);
      expect(resumed.stderr).toMatch(new RegExp(`job ${id} cancelled \\(0/2 steps done\\)`));
      expect((await sbr("job", "ls")).stdout.trim()).toBe("no jobs");
    } finally {
      await cleanup();
    }
  }, 60_000);

  it("runs a job no provider can take: names it once claimed, then reports how it ended", async () => {
    // No waiting for capacity, so the job fails at once instead of after five minutes.
    const { sbr, cleanup } = await cliHome({ jobs: { maxWaitSec: 0 } });
    try {
      const run = await sbr("job", "run", "--name", "nowhere", "--step", "echo hi");
      expect(run.code).toBe(1);
      const named = /^\[sbr\] job (job_\S+)$/m.exec(run.stderr);
      expect(named).not.toBeNull();
      const id = named![1]!;
      const end = run.stderr.indexOf(`[sbr] job ${id} failed (0/1 steps done): No sandbox provider could take this request`);
      expect(end).toBeGreaterThan(named!.index);

      const status = await sbr("job", "status", id);
      expect(status.stdout).toMatch(/^state {5}failed$/m);
      expect(status.stdout).toMatch(/^error {5}No sandbox provider could take this request/m);
    } finally {
      await cleanup();
    }
  }, 60_000);

  it("shows a job this process ran, with the output of the step that failed it, and downloads a workspace", async () => {
    const { home, sbr, cleanup } = await cliHome();
    const ls = localShellProvider({ id: "ls" });
    shells.push(ls);
    // The same ledger and checkpoint directory the CLI's router uses under SBR_HOME.
    const r = new SandboxRouter({ providers: [ls], ledger: new FileLedger(join(home, "ledger.json")), checkpoints: new FileCheckpointStore(join(home, "checkpoints")), env: {} });
    try {
      const ok = await r.jobs.run({ name: "builds", files: { "in.txt": "hi\n" }, steps: [{ run: "cp in.txt out.txt" }] });
      const bad = await r.jobs.run({ name: "breaks", steps: [{ run: "echo one" }, { run: "echo half-done; echo boom >&2; exit 3" }] });
      expect([ok.state, bad.state]).toEqual(["succeeded", "failed"]);

      const status = await sbr("job", "status", bad.id);
      expect(status.code).toBe(0);
      expect(status.stdout).toMatch(/^state {5}failed$/m);
      expect(status.stdout).toMatch(/^steps {5}1\/2 done$/m);
      expect(status.stdout).toMatch(/^error {5}step 1 exited 3$/m);
      expect(status.stdout).toMatch(/^output {4}of step 1 on ls, exit 3/m);
      expect(status.stdout).toMatch(/^ {2}stdout {2}half-done$/m);
      expect(status.stdout).toMatch(/^ {2}stderr {2}boom$/m);
      expect(status.stdout).toMatch(/^ {2}ls {2}\S+ .*→ .* failed$/m);

      const out = join(home, "ws.tgz");
      const download = await sbr("job", "download", ok.id, "--out", out);
      expect(download.code).toBe(0);
      const bytes = await readFile(out);
      expect([bytes[0], bytes[1]]).toEqual([0x1f, 0x8b]);
      expect(gunzipSync(bytes).toString("latin1")).toContain("out.txt");

      // Nothing has run yet, so there is nothing to download.
      const queued = await r.jobs.submit({ steps: [{ run: "true" }] });
      const none = await sbr("job", "download", queued.id);
      expect(none.code).toBe(1);
      expect(none.stderr).toMatch(/no workspace archive yet/);
    } finally {
      await cleanup();
    }
  }, 60_000);
});
