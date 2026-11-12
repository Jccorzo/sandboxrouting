// MCP server: the router as tools an AI agent can call, over stdio (`sbr mcp`). The same
// tool set the providers' own MCP servers offer (create, run, files, url, kill), but one
// server for every provider, with free tiers used first. Jobs (run_job) carry their workdir
// to another box when one dies or runs out.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SandboxRouter } from "../core/router.js";
import { strategyNameFor } from "../core/config.js";
import { classify, SandboxRouterError } from "../core/errors.js";
import type { JobManagerApi, JobRunOptions, JobSpec, JobView } from "../core/jobs/types.js";

const text = (value: unknown) => ({
  content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});

const failure = (raw: unknown) => {
  const err = classify(raw);
  return { ...text(`${err.kind}: ${err.message}`), isError: true };
};

async function guarded<T>(fn: () => Promise<T>) {
  try {
    return text(await fn());
  } catch (raw) {
    return failure(raw);
  }
}

/** Where a sandbox goes. create_sandbox takes these, and so does run_job's `sandbox`. */
const sandboxSpec = {
  image: z.string().optional().describe("OCI image, e.g. python:3.12-slim (only providers that run custom images)"),
  timeoutSec: z.number().int().positive().optional().describe("Lifetime in seconds (default 300)"),
  cpu: z.number().positive().optional(),
  memoryMiB: z.number().int().positive().optional(),
  env: z.record(z.string()).optional(),
  needs: z.array(z.enum(["ports", "pause", "customImage", "gpu", "snapshot", "fileList", "extendTimeout"])).optional(),
  providers: z.array(z.string()).optional().describe("Only these provider ids"),
  strategy: z.string().optional().describe("Routing strategy from list_strategies (default: the configured one)"),
  minIsolation: z
    .enum(["container", "gvisor", "microvm", "vm"])
    .optional()
    .describe("Weakest isolation to accept (container < gvisor < microvm = vm); weaker or unknown providers are skipped"),
  prefer: z.array(z.string()).optional().describe("Provider ids to rank first within their lane"),
  avoid: z.array(z.string()).optional().describe("Provider ids to rank last within their lane"),
  execTimeoutSec: z.number().positive().optional().describe("Longest single command, in seconds; providers that cut commands off sooner are skipped"),
};

// Only the shape here: the rules (non-empty commands, positive timeouts…) are checkJobSpec's, run by the job manager.
const step = z.object({
  run: z.string().describe("Shell command, run in the workdir"),
  timeoutSec: z.number().optional().describe("Seconds (default: the config's jobs.defaultStepTimeoutSec, 600)"),
  idempotent: z.boolean().optional().describe("false when running it twice would repeat an outside effect (deploy, payment, message)"),
  retries: z.number().optional().describe("Extra attempts when it exits non-zero (default 0)"),
  noCheckpoint: z.boolean().optional().describe("Skip saving the workspace after it (read-only steps such as tests)"),
});

/** What an agent needs from a job: where it stands, where it ran, and the output of its last step. */
function jobSummary(v: JobView) {
  const last = v.results.at(-1);
  const failed = v.result;
  return {
    id: v.id,
    name: v.name,
    state: v.state,
    stepsDone: v.cursor,
    steps: v.steps,
    provider: v.provider,
    providers: [...new Set(v.placements.map((p) => p.provider))],
    migrations: v.migrations,
    placements: v.placements.map((p) => ({ provider: p.provider, sandboxId: p.sandboxId, endReason: p.endReason })),
    lastResult: last && { step: last.step, exitCode: last.exitCode, provider: last.provider, stdoutTail: last.stdoutTail, stderrTail: last.stderrTail },
    error: v.error,
    /** The step that failed the job, when one did. */
    failedStep: failed && { step: failed.step, exitCode: failed.exitCode, provider: failed.provider, stdoutTail: failed.stdoutTail, stderrTail: failed.stderrTail },
  };
}

/** Another runner holds the job: say so, with where it stands now. Anything else is a plain failure. */
async function conflictOrFailure(jobs: JobManagerApi, id: string, raw: unknown) {
  const err = classify(raw);
  if (err.kind !== "conflict") return failure(err);
  const now = await jobs.get(id).catch(() => undefined);
  return { ...text({ error: `conflict: ${err.message}`, job: now && jobSummary(now) }), isError: true };
}

const DEFAULT_WAIT_SEC = 45;
const waitSec = z
  .number()
  .min(0)
  .max(600)
  .optional()
  .describe(`Seconds to wait for the job to end before answering (default ${DEFAULT_WAIT_SEC}, at most 600). A job still running then goes on; poll job_status.`);

/**
 * Drives a job in this process and answers when it ends or after `wait` seconds, whichever comes
 * first. A job still running then goes on here. `known` is the job's id when the caller has one.
 */
async function follow(jobs: JobManagerApi, go: (opts: JobRunOptions) => Promise<JobView>, wait: number, known?: string) {
  let done!: Promise<JobView>;
  // Settles once this process holds the job, or with how it ended when there was nothing to claim.
  const first = new Promise<{ claimed: JobView } | { ended: JobView }>((resolve, reject) => {
    done = go({ onClaimed: (job) => resolve({ claimed: job }) });
    done.then((job) => resolve({ ended: job }), reject);
  });
  let started: { claimed: JobView } | { ended: JobView };
  try {
    started = await first;
  } catch (raw) {
    return known ? conflictOrFailure(jobs, known, raw) : failure(raw);
  }
  if ("ended" in started) return text(jobSummary(started.ended));

  const id = started.claimed.id;
  let timer: NodeJS.Timeout | undefined;
  const waited = new Promise<"waiting">((ok) => (timer = setTimeout(() => ok("waiting"), wait * 1000)));
  let outcome: JobView | "waiting";
  try {
    outcome = await Promise.race([done, waited]);
  } catch (raw) {
    return conflictOrFailure(jobs, id, raw);
  } finally {
    clearTimeout(timer);
  }
  if (outcome !== "waiting") return text(jobSummary(outcome));
  // Nobody waits for the drive any more, so its failures go to stderr (stdout is the protocol).
  done.catch((raw) => console.error(`[sbr] job ${id}: ${classify(raw).message}`));
  const now = (await jobs.get(id)) ?? started.claimed;
  return text({ ...jobSummary(now), note: `Still running after ${wait} s; it goes on in the background. Poll job_status with id ${id}.` });
}

export function createMcpServer(router: SandboxRouter, version = "0.1.0"): McpServer {
  const server = new McpServer({ name: "sandboxrouting", version });
  const jobs: JobManagerApi = router.jobs;

  server.registerTool(
    "list_providers",
    {
      description: "List sandbox providers with their free-tier status (remaining credit, resets), availability and capabilities.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () => guarded(() => router.status({ refreshUsage: true })),
  );

  server.registerTool(
    "list_strategies",
    {
      description:
        "List the routing strategies (how the router orders providers) and which one is configured. Pass a name as `strategy` to create_sandbox or run_job.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () =>
      guarded(async () => {
        const active = strategyNameFor(router.config);
        return router.strategies().map((s) => ({ name: s.name, description: s.description, active: s.name === active }));
      }),
  );

  server.registerTool(
    "create_sandbox",
    {
      description:
        "Create a cloud sandbox. The router picks the provider, using free tiers first, and fails over if one refuses. Returns its id and the routing decision.",
      inputSchema: sandboxSpec,
    },
    (spec) =>
      guarded(async () => {
        const sbx = await router.create(spec);
        return { id: sbx.id, provider: sbx.provider, route: sbx.route, sandbox: await sbx.info() };
      }),
  );

  server.registerTool(
    "run_command",
    {
      description: "Run a shell command in a sandbox and return stdout, stderr and the exit code.",
      inputSchema: {
        id: z.string().describe("Sandbox id from create_sandbox"),
        command: z.string(),
        cwd: z.string().optional(),
        env: z.record(z.string()).optional(),
        timeoutSec: z.number().int().positive().optional(),
      },
    },
    ({ id, command, ...opts }) => guarded(async () => (await router.connect(id)).commands.run(command, opts)),
  );

  server.registerTool(
    "read_file",
    { description: "Read a text file from a sandbox.", inputSchema: { id: z.string(), path: z.string() }, annotations: { readOnlyHint: true } },
    ({ id, path }) => guarded(async () => (await router.connect(id)).files.read(path)),
  );

  server.registerTool(
    "write_file",
    { description: "Write a text file in a sandbox (parent directories are created).", inputSchema: { id: z.string(), path: z.string(), content: z.string() } },
    ({ id, path, content }) =>
      guarded(async () => {
        await (await router.connect(id)).files.write(path, content);
        return `wrote ${path}`;
      }),
  );

  server.registerTool(
    "list_files",
    { description: "List a directory in a sandbox.", inputSchema: { id: z.string(), path: z.string().default(".") }, annotations: { readOnlyHint: true } },
    ({ id, path }) => guarded(async () => (await router.connect(id)).files.list(path)),
  );

  server.registerTool(
    "get_url",
    { description: "Public URL for a port inside a sandbox.", inputSchema: { id: z.string(), port: z.number().int().positive() } },
    ({ id, port }) => guarded(async () => (await router.connect(id)).getUrl(port)),
  );

  server.registerTool(
    "set_timeout",
    { description: "Keep a sandbox alive for timeoutSec more seconds from now.", inputSchema: { id: z.string(), timeoutSec: z.number().int().positive() } },
    ({ id, timeoutSec }) =>
      guarded(async () => {
        const sbx = await router.connect(id);
        await sbx.setTimeout(timeoutSec);
        return sbx.info();
      }),
  );

  server.registerTool(
    "list_sandboxes",
    {
      description: "List sandboxes the router created (live ones, or all with all=true), with provider and cost so far.",
      inputSchema: { all: z.boolean().optional() },
      annotations: { readOnlyHint: true },
    },
    ({ all }) => guarded(() => router.list({ all })),
  );

  server.registerTool(
    "kill_sandbox",
    { description: "Stop and delete a sandbox.", inputSchema: { id: z.string() }, annotations: { destructiveHint: true } },
    ({ id }) =>
      guarded(async () => {
        await router.kill(id);
        return `killed ${id}`;
      }),
  );

  server.registerTool(
    "move_sandbox",
    {
      description:
        "Move a running sandbox to a new box: its workdir is copied over, then the old box is killed. Returns the new sandbox (a new id).",
      inputSchema: {
        id: z.string(),
        workdir: z.string().optional().describe('Directory to carry over; relative paths are under $HOME (default "work")'),
      },
      annotations: { destructiveHint: true },
    },
    ({ id, workdir }) =>
      guarded(async () => {
        const sbx = await router.move(id, { workdir });
        return { id: sbx.id, provider: sbx.provider, route: sbx.route, sandbox: await sbx.info() };
      }),
  );

  server.registerTool(
    "run_job",
    {
      description:
        "Run shell steps in a sandbox. The workdir is saved after each step; when the box dies, its provider refuses, or it runs out of time or free credit, the job continues on another box from the last saved step. Waits up to waitSec for the end, then returns the state, where it ran, how often it moved, and the output of the last step that succeeded and of the step that failed it, if one did. A job still running then goes on: poll job_status with its id.",
      inputSchema: {
        name: z.string().optional(),
        sandbox: z.object(sandboxSpec).optional().describe("Where the boxes go (same fields as create_sandbox)"),
        workdir: z.string().optional().describe('Carried from box to box; relative paths are under $HOME (default "work")'),
        files: z.record(z.string()).optional().describe("Initial workspace: path under the workdir → UTF-8 content"),
        setup: z.array(step).optional().describe("Run on every new box before the workspace is restored (installs); must be safe to repeat"),
        steps: z.array(step).describe("Run in order; a step is the unit of retry"),
        waitSec,
      },
    },
    ({ waitSec: wait, ...spec }) => follow(jobs, (opts) => jobs.run(spec as JobSpec, opts), wait ?? DEFAULT_WAIT_SEC),
  );

  server.registerTool(
    "list_jobs",
    {
      description: "List jobs (unfinished ones, or all with all=true): state, steps done, current provider and moves.",
      inputSchema: { all: z.boolean().optional() },
      annotations: { readOnlyHint: true },
    },
    ({ all }) =>
      guarded(async () =>
        (await jobs.list({ all })).map((v) => ({
          id: v.id,
          name: v.name,
          state: v.state,
          stepsDone: v.cursor,
          steps: v.steps,
          provider: v.provider,
          migrations: v.migrations,
          error: v.error,
          updatedAt: v.updatedAt,
        })),
      ),
  );

  server.registerTool(
    "job_status",
    {
      description: "Where a job stands: state, steps done, its boxes and why each ended, recent history, and the output of the last step that succeeded and of the step that failed it, if one did.",
      inputSchema: { id: z.string() },
      annotations: { readOnlyHint: true },
    },
    ({ id }) =>
      guarded(async () => {
        const view = await jobs.get(id);
        if (!view) throw new SandboxRouterError("not_found", `no job ${id}`);
        return { ...jobSummary(view), history: view.history.slice(-10) };
      }),
  );

  server.registerTool(
    "resume_job",
    {
      description:
        "Take over a queued or orphaned job (its runner died) and drive it on from where it was recorded. Waits up to waitSec like run_job. A job that already ended is returned as it ended.",
      inputSchema: { id: z.string(), waitSec },
    },
    ({ id, waitSec: wait }) => follow(jobs, (opts) => jobs.resume(id, opts), wait ?? DEFAULT_WAIT_SEC, id),
  );

  server.registerTool(
    "cancel_job",
    {
      description: "Cancel a job and kill its box. A job that already ended is returned as it ended.",
      inputSchema: { id: z.string() },
      annotations: { destructiveHint: true },
    },
    ({ id }) => guarded(async () => jobSummary(await jobs.cancel(id))),
  );

  return server;
}

export async function serveMcpStdio(router: SandboxRouter): Promise<void> {
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  await createMcpServer(router).connect(new StdioServerTransport());
}
