#!/usr/bin/env node
// sbr: the router from a terminal. Same operations as the SDK, REST API and MCP server.

import { parseArgs } from "node:util";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRouter, type SandboxRouter } from "./core/router.js";
import { strategyNameFor } from "./core/config.js";
import { NoProviderAvailableError, SandboxRouterError, classify } from "./core/errors.js";
import { checkJobSpec } from "./core/jobs/state.js";
import type { JobManagerApi, JobRunOptions, JobSpec, JobView, RunnerEvent, StepSpec } from "./core/jobs/types.js";
import type { FreeStatus } from "./core/metering.js";
import type { Plan } from "./core/policy.js";
import type { ProviderHealth } from "./core/routing/types.js";
import type { Capability, Isolation, SandboxSpec } from "./core/types.js";

const HELP = `sbr: one router for every sandbox provider, free tiers first

Usage:
  sbr providers [--refresh]          free-tier status, health and availability of every provider
  sbr strategies                     routing strategies; * marks the configured one
  sbr route [spec flags]             which provider a new sandbox would go to, and why
  sbr route --compare [spec flags]   the plan under every strategy
  sbr create [spec flags]            create a sandbox; prints its id
  sbr run [spec flags] -- <command>  create, run one command, kill (exit code passes through)
  sbr exec <id> -- <command>         run a command in a sandbox
  sbr move <id> [--workdir <dir>]    copy its workdir (default $HOME/work) to a new box routed by
                                     the spec flags, then kill the old one; prints the new id
  sbr ls [--all]                     sandboxes the router created
  sbr read <id> <path> [--out file]  read a file
  sbr write <id> <path> [--in file]  write a file (stdin if --in is omitted)
  sbr files <id> [path]              list a directory
  sbr url <id> <port>                public URL for a port
  sbr extend <id> <seconds>          keep it alive this long from now
  sbr pause|resume|kill <id>
  sbr job run [job flags]            run a job here, moving to another box when one dies or runs
                                     out; exit 0 only if it succeeded
  sbr job submit [job flags]         record a job without running it; prints its id
  sbr job ls [--all]                 unfinished jobs (all of them with --all)
  sbr job status <id>                state, steps, boxes and recent history of a job
  sbr job resume <id>                take over a queued or orphaned job and drive it here
  sbr job cancel <id>                stop a job and kill its box
  sbr job download <id> [--out f]    its latest workspace archive (default <id>.tgz)
  sbr check [--provider <id>]        live end-to-end check (create, exec, files, kill) on every
                                     configured provider; paid-only ones only when named
  sbr sweep                          reconcile with providers (close what's gone) and reap boxes
                                     left behind by jobs
  sbr reset <provider>               clear quota/rate-limit/auth marks on a provider
  sbr serve [--port 8787]            REST API; every 5 minutes it also resumes orphaned jobs
  sbr mcp                            MCP server over stdio

Spec flags:
  --provider <id>   (repeatable) only these    --exclude <id>  (repeatable)
  --prefer <id>     (repeatable) first in its lane
  --avoid <id>      (repeatable) last in its lane
  --image <ref>     OCI image                  --template <provider>=<name>
  --cpu <n>  --memory <MiB>  --timeout <sec>   --env KEY=VALUE (repeatable)
  --needs <cap>     ports|pause|customImage|gpu|snapshot|fileList|extendTimeout
  --strategy <name> how to rank providers (see sbr strategies)
  --min-isolation <level>  container|gvisor|microvm|vm; weaker or unknown is skipped
  --exec-timeout <sec>     longest single command; providers that cut off sooner are skipped
  --json            machine-readable output (job run: the final job, with step output on stderr)

Job flags (spec flags choose the job's boxes):
  --step <cmd>      (repeatable) a step; steps run in order
  --setup <cmd>     (repeatable) runs on every new box before the workspace is restored
  --workdir <dir>   carried from box to box (default work, under $HOME)
  --name <name>     shown by sbr job ls
  --file <job.json> a JobSpec to start from: --step and --setup add to its lists, spec flags
                    set its sandbox fields

Paid usage is off unless sandboxrouting.json sets "allowPaid": true (or SBR_ALLOW_PAID=1).`;

const argv = process.argv.slice(2);
const dash = argv.indexOf("--");
const before = dash >= 0 ? argv.slice(0, dash) : argv;
const after = dash >= 0 ? argv.slice(dash + 1) : [];

const { values, positionals } = parseArgs({
  args: before,
  allowPositionals: true,
  options: {
    provider: { type: "string", multiple: true },
    exclude: { type: "string", multiple: true },
    prefer: { type: "string", multiple: true },
    avoid: { type: "string", multiple: true },
    image: { type: "string" },
    template: { type: "string", multiple: true },
    cpu: { type: "string" },
    memory: { type: "string" },
    timeout: { type: "string" },
    env: { type: "string", multiple: true },
    needs: { type: "string", multiple: true },
    strategy: { type: "string" },
    "min-isolation": { type: "string" },
    "exec-timeout": { type: "string" },
    compare: { type: "boolean" },
    workdir: { type: "string" },
    step: { type: "string", multiple: true },
    setup: { type: "string", multiple: true },
    name: { type: "string" },
    file: { type: "string" },
    json: { type: "boolean" },
    all: { type: "boolean" },
    refresh: { type: "boolean" },
    out: { type: "string" },
    in: { type: "string" },
    port: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

const out = (v: unknown) => console.log(typeof v === "string" ? v : JSON.stringify(v, null, 2));

function spec(): SandboxSpec {
  const kv = (list: string[] | undefined) =>
    Object.fromEntries(
      (list ?? []).map((s) => {
        const i = s.indexOf("=");
        if (i < 1) throw new Error(`expected KEY=VALUE, got "${s}"`);
        return [s.slice(0, i), s.slice(i + 1)];
      }),
    );
  return {
    providers: values.provider,
    exclude: values.exclude,
    image: values.image,
    template: values.template ? kv(values.template) : undefined,
    cpu: values.cpu ? Number(values.cpu) : undefined,
    memoryMiB: values.memory ? Number(values.memory) : undefined,
    timeoutSec: values.timeout ? Number(values.timeout) : undefined,
    env: values.env ? kv(values.env) : undefined,
    needs: values.needs as Capability[] | undefined,
    strategy: values.strategy,
    avoid: values.avoid,
    prefer: values.prefer,
    // The router refuses a level it doesn't know.
    minIsolation: values["min-isolation"] as Isolation | undefined,
    execTimeoutSec: values["exec-timeout"] ? Number(values["exec-timeout"]) : undefined,
  };
}

function freeText(f: FreeStatus): string {
  switch (f.state) {
    case "unlimited":
      return "unlimited (your hardware)";
    case "none":
      return "no free tier";
    case "exhausted":
      return `used up${f.resetsAt ? ` until ${new Date(f.resetsAt).toISOString().slice(0, 10)}` : ""}`;
    case "available": {
      const left = f.unit === "usd" ? `$${f.remaining.toFixed(2)}` : `${f.remaining.toFixed(1)} h`;
      const reset = f.resetsAt ? `, resets ${new Date(f.resetsAt).toISOString().slice(0, 10)}` : ", one-time";
      return `${left} left (${Math.round(f.fraction * 100)}%${reset})`;
    }
  }
}

function healthText(h: ProviderHealth): string {
  if (h.circuit !== "closed") return h.circuit;
  return h.samples ? `${Math.round(h.successRate * 100)}%` : "-";
}

function table(rows: string[][]): string {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
  return rows.map((r) => r.map((c, i) => c.padEnd(widths[i]!)).join("  ").trimEnd()).join("\n");
}

const need = (v: string | undefined, what: string): string => {
  if (!v) throw new Error(`missing ${what}; see sbr --help`);
  return v;
};

/** The plan for one request under every strategy the router knows, by strategy name. */
async function comparePlans(router: SandboxRouter, s: SandboxSpec): Promise<Record<string, Plan>> {
  const plans = await Promise.all(router.strategies().map((st) => router.plan({ ...s, strategy: st.name })));
  return Object.fromEntries(plans.map((p) => [p.strategy, p]));
}

async function main(router: SandboxRouter): Promise<number> {
  const [cmd, a1, a2] = positionals;
  switch (cmd) {
    case "providers": {
      const status = await router.status({ refreshUsage: values.refresh });
      if (values.json) return out(status), 0;
      const rows = [["PROVIDER", "READY", "FREE TIER", "HEALTH", "LIVE", "NOTE"]];
      for (const s of status) {
        const ready = !s.enabled ? "disabled" : !s.configured ? "no key" : !s.availability.ok ? s.availability.kind : "yes";
        const note = !s.configured ? `set ${s.missingEnv.join(", ")}` : s.freeTierNotes ?? "";
        rows.push([s.id, ready, freeText(s.free), healthText(s.health), `${s.live}${s.concurrency ? `/${s.concurrency}` : ""}`, note]);
      }
      out(table(rows));
      out(`\npaid usage: ${router.config.allowPaid ? "allowed" : "off (free tiers only)"} · strategy: ${strategyNameFor(router.config)}`);
      return 0;
    }
    case "strategies": {
      const active = strategyNameFor(router.config);
      const list = router.strategies().map((s) => ({ name: s.name, description: s.description, active: s.name === active }));
      if (values.json) return out(list), 0;
      const width = Math.max(...list.map((s) => s.name.length));
      for (const s of list) out(`${s.active ? "*" : " "} ${s.name.padEnd(width)}  ${s.description}`);
      if (!list.some((s) => s.active)) console.error(`sbr: the config names strategy "${active}", which isn't registered`);
      return 0;
    }
    case "route": {
      const s = spec();
      if (values.compare) {
        const mine = router.strategyFor(s).name;
        const plans = await comparePlans(router, s);
        if (values.json) return out(plans), 0;
        const width = Math.max(...Object.keys(plans).map((n) => n.length));
        for (const [name, p] of Object.entries(plans)) {
          const first = p.ordered.slice(0, 4).map((e) => `${e.provider} [${e.lane}]`);
          const more = p.ordered.length > 4 ? `, +${p.ordered.length - 4} more` : "";
          out(`${name === mine ? "*" : " "} ${name.padEnd(width)}  ${first.length ? first.join(", ") + more : "no provider can take this request"}`);
        }
        return plans[mine]!.ordered.length ? 0 : 1;
      }
      const p = await router.plan(s);
      if (values.json) return out(p), 0;
      out(`strategy: ${p.strategy}`);
      p.ordered.forEach((e, i) => {
        out(`${i + 1}. ${e.provider}  [${e.lane}]  ${freeText(e.free)}  ~$${(e.ratePerSecondUsd * 3600).toFixed(4)}/h`);
        // The lane is already in brackets; the rest is the strategy's own reasoning.
        const why = (e.why ?? []).filter((w) => w !== e.lane);
        if (why.length) out(`   ${why.join(" · ")}`);
      });
      if (!p.ordered.length) out("no provider can take this request");
      for (const sk of p.skipped) out(`   - ${sk.provider}: ${sk.reason}`);
      return p.ordered.length ? 0 : 1;
    }
    case "create": {
      const sbx = await router.create(spec());
      if (values.json) return out({ ...(await sbx.info()), route: sbx.route }), 0;
      out(sbx.id);
      console.error(`created on ${sbx.provider} (${sbx.providerSandboxId})`);
      return 0;
    }
    case "move": {
      const sbx = await router.move(need(a1, "sandbox id"), { workdir: values.workdir, spec: spec() });
      if (values.json) return out({ ...(await sbx.info()), route: sbx.route }), 0;
      out(sbx.id);
      console.error(`moved to ${sbx.provider} (${sbx.providerSandboxId})`);
      return 0;
    }
    case "run": {
      if (!after.length) throw new Error("usage: sbr run [spec flags] -- <command>");
      const sbx = await router.create(spec());
      console.error(`[sbr] ${sbx.provider} ${sbx.id}`);
      try {
        const r = await sbx.commands.run(after.join(" "), {
          onStdout: (s) => process.stdout.write(s),
          onStderr: (s) => process.stderr.write(s),
        });
        return r.exitCode;
      } finally {
        await sbx.kill().catch((e) => console.error(`[sbr] kill failed: ${(e as Error).message}`));
      }
    }
    case "exec": {
      if (!after.length) throw new Error("usage: sbr exec <id> -- <command>");
      const sbx = await router.connect(need(a1, "sandbox id"));
      const r = await sbx.commands.run(after.join(" "), {
        onStdout: (s) => process.stdout.write(s),
        onStderr: (s) => process.stderr.write(s),
      });
      return r.exitCode;
    }
    case "ls": {
      const list = await router.list({ all: values.all });
      if (values.json) return out(list), 0;
      const rows = [["ID", "PROVIDER", "STATE", "CREATED", "COST"]];
      for (const s of list) rows.push([s.id, s.provider, s.state, s.createdAt.slice(0, 19), `$${s.costUsd.toFixed(4)}`]);
      out(list.length ? table(rows) : "no sandboxes");
      return 0;
    }
    case "read": {
      const data = await (await router.connect(need(a1, "sandbox id"))).files.readBytes(need(a2, "path"));
      if (values.out) await writeFile(values.out, data);
      else process.stdout.write(data);
      return 0;
    }
    case "write": {
      const data = values.in ? await readFile(values.in) : await readStdin();
      await (await router.connect(need(a1, "sandbox id"))).files.write(need(a2, "path"), new Uint8Array(data));
      return 0;
    }
    case "files": {
      const items = await (await router.connect(need(a1, "sandbox id"))).files.list(a2 ?? ".");
      if (values.json) return out(items), 0;
      for (const f of items) out(`${f.isDir ? "d" : "-"} ${f.name}${f.isDir ? "/" : ""}`);
      return 0;
    }
    case "url":
      out(await (await router.connect(need(a1, "sandbox id"))).getUrl(Number(need(a2, "port"))));
      return 0;
    case "extend":
      await (await router.connect(need(a1, "sandbox id"))).setTimeout(Number(need(a2, "seconds")));
      return 0;
    case "pause":
      await (await router.connect(need(a1, "sandbox id"))).pause();
      return 0;
    case "resume":
      await (await router.connect(need(a1, "sandbox id"))).resume();
      return 0;
    case "kill":
      await router.kill(need(a1, "sandbox id"));
      return 0;
    case "job":
      return job(router, a1, a2);
    case "check": {
      const status = await router.status();
      const named = values.provider ?? [];
      const targets = status.filter((s) =>
        named.length ? named.includes(s.id) : s.configured && s.enabled && (s.free.state === "available" || s.free.state === "unlimited"),
      );
      if (!targets.length) {
        out("no configured provider to check (set its keys; see `sbr providers`)");
        return 1;
      }
      let failures = 0;
      for (const t of targets) {
        const started = Date.now();
        let sbx: Awaited<ReturnType<typeof router.create>> | undefined;
        try {
          // Naming a provider is consent to use it, paid or not, for this one small check.
          if (named.includes(t.id)) router.config.providers[t.id] = { ...router.config.providers[t.id], allowPaid: true };
          sbx = await router.create({ providers: [t.id], timeoutSec: 300 });
          const r = await sbx.commands.run("echo sbr-check && uname -s");
          if (r.exitCode !== 0 || !r.stdout.includes("sbr-check")) throw new Error(`exec gave exit ${r.exitCode}: ${r.stdout}${r.stderr}`);
          const payload = `sbr ${Date.now()}`;
          await sbx.files.write("/tmp/sbr-check/probe.txt", payload);
          const back = await sbx.files.read("/tmp/sbr-check/probe.txt");
          if (back !== payload) throw new Error(`file round trip returned ${JSON.stringify(back)}`);
          const listed = (await sbx.files.list("/tmp/sbr-check")).map((f) => f.name);
          if (!listed.includes("probe.txt")) throw new Error(`list did not show probe.txt: ${listed.join(", ")}`);
          await sbx.kill();
          out(`ok    ${t.id.padEnd(11)} ${((Date.now() - started) / 1000).toFixed(1)}s  create, exec, write, read, list, kill`);
        } catch (raw) {
          failures++;
          const err = raw instanceof NoProviderAvailableError ? raw : classify(raw, t.id);
          out(`FAIL  ${t.id.padEnd(11)} ${err.message.split("\n").slice(0, 3).join(" | ")}`);
          await sbx?.kill().catch(() => undefined);
        }
      }
      return failures ? 1 : 0;
    }
    case "sweep": {
      const sandboxes = await router.sweep({ remote: true });
      // Not resumeOrphans: this process exits right away, so it can't drive them.
      out({ sandboxes, jobs: await router.jobs.sweep() });
      return 0;
    }
    case "reset":
      await router.clearMarks(need(a1, "provider id"));
      return 0;
    case "serve": {
      const { createServer } = await import("./server/http.js");
      const port = Number(values.port ?? process.env["PORT"] ?? 8787);
      const server = createServer(router);
      server.listen(port, "127.0.0.1", () => console.error(`sbr REST API on http://127.0.0.1:${port}/v1`));
      // Every 5 minutes: reconcile with providers so crashed clients' sandboxes converge, and
      // take over jobs whose runner died (this process lives on, so it can drive them).
      const sweep = async () => {
        await router.sweep({ remote: true }).catch((e) => console.error(`[sbr] sweep: ${(e as Error).message}`));
        await router.jobs.sweep({ resumeOrphans: true }).catch((e) => console.error(`[sbr] job sweep: ${(e as Error).message}`));
      };
      const timer = setInterval(() => void sweep(), 5 * 60_000);
      timer.unref();
      await new Promise(() => undefined);
      return 0;
    }
    case "mcp": {
      const { serveMcpStdio } = await import("./mcp/server.js");
      await serveMcpStdio(router);
      await new Promise(() => undefined);
      return 0;
    }
    default:
      out(HELP);
      return cmd && cmd !== "help" ? 2 : 0;
  }
}

// ------------------------------------------------------------------ jobs

async function job(router: SandboxRouter, sub: string | undefined, id: string | undefined): Promise<number> {
  const jobs: JobManagerApi = router.jobs;
  switch (sub) {
    case "run":
    case "submit": {
      const request = await jobSpec();
      const problem = checkJobSpec(request);
      if (problem) throw new SandboxRouterError("invalid", `${problem}; see sbr --help`);
      if (sub === "run") return drive(jobs, (opts) => jobs.run(request as JobSpec, opts));
      const submitted = await jobs.submit(request as JobSpec);
      return out(values.json ? submitted : submitted.id), 0;
    }
    case "resume": {
      const jobId = need(id, "job id");
      return drive(jobs, (opts) => jobs.resume(jobId, opts), jobId);
    }
    case "ls": {
      const list = await jobs.list({ all: values.all });
      if (values.json) return out(list), 0;
      const rows = [["ID", "STATE", "STEPS", "PROVIDER", "MOVES", "UPDATED", "NAME"]];
      for (const j of list) rows.push([j.id, j.state, `${j.cursor}/${j.steps}`, j.provider ?? "", String(j.migrations), at(j.updatedAt), j.name ?? ""]);
      out(list.length ? table(rows) : "no jobs");
      return 0;
    }
    case "status": {
      const jobId = need(id, "job id");
      const view = await jobs.get(jobId);
      if (!view) throw new SandboxRouterError("not_found", `no job ${jobId}`);
      out(values.json ? view : jobText(view));
      return 0;
    }
    case "cancel": {
      const view = await jobs.cancel(need(id, "job id"));
      if (values.json) out(view);
      // A job that already ended stays as it ended; say so rather than "cancelled".
      else out(view.state === "cancelled" ? `job ${view.id} cancelled` : `job ${view.id} already ${view.state}; nothing to cancel`);
      return view.state === "cancelled" ? 0 : 1;
    }
    case "download": {
      const jobId = need(id, "job id");
      const data = await jobs.workspace(jobId);
      if (!data) {
        console.error(`sbr: job ${jobId} has no workspace archive yet (none is kept until a step finishes)`);
        return 1;
      }
      const path = values.out ?? `${jobId}.tgz`;
      // Whole or not at all: a temp file beside it, then a rename.
      const tmp = `${path}.${process.pid}.tmp`;
      try {
        await writeFile(tmp, data);
        await rename(tmp, path);
      } catch (err) {
        await rm(tmp, { force: true });
        throw err;
      }
      console.error(`wrote ${path} (${data.byteLength} bytes)`);
      return 0;
    }
    default:
      out(HELP);
      return 2;
  }
}

/** The job request: --file as the base, then --step/--setup appended and spec flags set on `sandbox`. */
async function jobSpec(): Promise<unknown> {
  let base: Record<string, unknown> = {};
  if (values.file) {
    const raw = await readFile(values.file, "utf8");
    try {
      base = JSON.parse(raw);
    } catch (err) {
      throw new SandboxRouterError("invalid", `${values.file} is not JSON: ${(err as Error).message}`);
    }
    // Not an object: leave it to checkJobSpec to say so.
    if (!base || typeof base !== "object" || Array.isArray(base)) return base;
  }
  const defined = (o: object) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
  const flags = defined(spec());
  // Flags fill in an object (or nothing); anything else stays as it is.
  const box = base["sandbox"];
  const sandbox = Object.keys(flags).length && (box === undefined || (typeof box === "object" && box && !Array.isArray(box))) ? { ...box, ...flags } : box;
  // Appends to a list (or nothing); anything else stays as it is, for checkJobSpec to report.
  const add = (list: unknown, cmds: string[] | undefined) =>
    cmds && (list === undefined || Array.isArray(list)) ? [...((list as StepSpec[] | undefined) ?? []), ...cmds.map((run) => ({ run }))] : list;
  return defined({
    ...base,
    name: values.name ?? base["name"],
    workdir: values.workdir ?? base["workdir"],
    sandbox,
    setup: add(base["setup"], values.setup),
    steps: add(base["steps"], values.step),
  });
}

function runOptions(): JobRunOptions {
  // With --json, stdout carries only the final job.
  const stdout = values.json ? process.stderr : process.stdout;
  return {
    onStdout: (s) => stdout.write(s),
    onStderr: (s) => process.stderr.write(s),
    onEvent: (e) => {
      const line = eventText(e);
      if (line) console.error(`[sbr] ${line}`);
    },
  };
}

/** Drives a job here, naming it once this process holds it. When another runner owns it, re-reads it and shows where it stands. */
async function drive(jobs: JobManagerApi, go: (opts: JobRunOptions) => Promise<JobView>, known?: string): Promise<number> {
  let id = known;
  let view: JobView;
  try {
    view = await go({
      ...runOptions(),
      onClaimed: (job) => {
        id = job.id;
        // Before any box exists, so it can be watched, cancelled or resumed from elsewhere.
        console.error(`[sbr] job ${job.id}`);
      },
    });
  } catch (raw) {
    const err = classify(raw);
    if (err.kind !== "conflict" || !id) throw raw;
    console.error(`sbr: conflict: ${err.message}`);
    const now = await jobs.get(id);
    if (now) console.error(jobText(now));
    return 1;
  }
  if (values.json) out(view);
  const moves = view.migrations ? `, ${view.migrations} move${view.migrations === 1 ? "" : "s"}` : "";
  console.error(`[sbr] job ${view.id} ${view.state} (${view.cursor}/${view.steps} steps done${moves})${view.error ? `: ${view.error}` : ""}`);
  return view.state === "succeeded" ? 0 : 1;
}

function eventText(e: RunnerEvent): string | undefined {
  switch (e.type) {
    case "placed":
      return `on ${e.provider} ${e.sandboxId}${e.lane ? ` (${e.lane})` : ""}`;
    case "prepared":
      return e.restored ? `workspace restored; continuing at step ${e.fromStep}` : `box ready; starting at step ${e.fromStep}`;
    case "stepStarted":
      return `step ${e.step}${e.name ? ` (${e.name})` : ""}${e.attempt > 1 ? `, attempt ${e.attempt}` : ""}`;
    case "stepFinished":
      return `step ${e.step} exited ${e.exitCode} after ${(e.durationMs / 1000).toFixed(1)}s`;
    case "checkpointed":
      return `saved the workspace after step ${e.step} (${e.bytes} bytes)`;
    case "extended":
      return `extended ${e.sandboxId} to ${e.timeoutSec}s`;
    case "migrating":
      return `leaving ${e.from}: ${e.reason}${e.detail ? ` (${e.detail})` : ""}`;
    case "retrying":
      return `retrying step ${e.step}: ${e.reason}`;
    case "waiting":
      return `waiting ${Math.round(e.delayMs / 1000)}s for a provider: ${e.reason}`;
    default:
      // succeeded, failed, cancelled: the last line reports the state the job recorded.
      return undefined;
  }
}

const at = (iso: string | undefined) => (iso ? iso.slice(0, 19).replace("T", " ") : "");

function jobText(v: JobView): string {
  const lines = [`${v.id}${v.name ? `  ${v.name}` : ""}`, `state     ${v.state}`, `steps     ${v.cursor}/${v.steps} done`];
  if (v.provider) lines.push(`box       ${v.provider} ${v.sandboxId}`);
  if (v.error) lines.push(`error     ${v.error}`);
  if (v.result) {
    const r = v.result;
    lines.push(`output    of step ${r.step} on ${r.provider}, exit ${r.exitCode} (last lines)`);
    for (const [name, tail] of [["stdout", r.stdoutTail], ["stderr", r.stderrTail]] as const) {
      if (!tail.trim()) continue;
      tail.trimEnd().split("\n").slice(-10).forEach((l, i) => lines.push(`${i ? " ".repeat(10) : `  ${name}  `}${l}`));
    }
  }
  if (v.placements.length) {
    lines.push(`boxes     ${v.placements.length} (${v.migrations} move${v.migrations === 1 ? "" : "s"})`);
    const rows = v.placements.map((p) => ["", p.provider, p.sandboxId, p.lane ?? "", at(p.placedAt), p.endedAt ? `→ ${at(p.endedAt)}` : "", p.endReason ?? "current"]);
    lines.push(table(rows));
  }
  const recent = v.history.slice(-10);
  lines.push(`history   last ${recent.length} of ${v.history.length}`);
  for (const h of recent) lines.push(`  ${at(h.at)}  ${h.type}${h.detail ? `  ${h.detail}` : ""}`);
  return lines.join("\n");
}

async function readStdin(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

if (values.help) {
  out(HELP);
} else {
  createRouter()
    .then(main)
    .then((code) => {
      process.exitCode = code;
    })
    .catch((raw) => {
      if (raw instanceof NoProviderAvailableError) console.error(raw.message);
      else {
        const err = classify(raw);
        console.error(`sbr: ${err.kind}: ${err.message}`);
      }
      process.exitCode = 1;
    });
}
