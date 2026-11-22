// The reporter (src/report/): what it sends, that every event keeps its id until back takes it,
// that delivery backs off and resumes, that a crash or a second process loses nothing, and that
// routing never waits on back.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clock, fakeProvider } from "./fake.js";
import { localShellProvider } from "./localshell.js";
import { createRouter, FileLedger, MemoryLedger, SandboxRouter, loadConfig, parseConfig, type Ledger, type ProviderAdapter } from "../src/index.js";
import { FileOutbox, MemoryOutbox, type Outbox } from "../src/report/outbox.js";
import { claimBatch, observeInto, providerSnapshots, Reporter, ReportingLedger, reportingLedger, reportSettings, settle } from "../src/report/reporter.js";
import { wireEventSchema, wireSandboxProblem, type IngestResponse, type WireEvent } from "../src/report/wire.js";

const BACK = "https://back.test";

/** A back end in a function: records every batch, answers as told. */
function fakeBack() {
  const batches: { install: string; events: WireEvent[]; auth: string | null }[] = [];
  const state = { down: false, hang: false, status: 200, reject: new Set<string>() };
  const fetchFn = (async (_url: string, init: RequestInit) => {
    if (state.hang) {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "TimeoutError" })));
      });
    }
    if (state.down) throw new TypeError("fetch failed: ECONNREFUSED");
    const body = JSON.parse(String(init.body)) as { install: string; events: WireEvent[] };
    batches.push({ ...body, auth: new Headers(init.headers).get("authorization") });
    if (state.status !== 200) return new Response("no", { status: state.status });
    const res: IngestResponse = {
      results: body.events.map((e) => ({ id: e.id, outcome: state.reject.has(e.type) ? "rejected" : "applied" })),
    };
    return Response.json(res);
  }) as unknown as typeof fetch;
  const events = () => batches.flatMap((b) => b.events);
  return { batches, events, state, fetch: fetchFn };
}

function setup(opts: { outbox?: Outbox; ledger?: Ledger; metadataKeys?: string[]; c?: ReturnType<typeof clock>; providers?: ProviderAdapter[]; sendTimeoutMs?: number } = {}) {
  const c = opts.c ?? clock();
  const back = fakeBack();
  const inner = opts.ledger ?? new MemoryLedger();
  const outbox = opts.outbox ?? new MemoryOutbox();
  const providers = opts.providers ?? [fakeProvider({ id: "a", tier: { kind: "monthly-credit", usd: 10 } }), fakeProvider({ id: "b", tier: { kind: "none" } })];
  const config = parseConfig({ allowPaid: true, providers: { a: { priority: 1 } }, report: { url: BACK, token: "tok_ingest", metadataKeys: opts.metadataKeys ?? [] } });
  const reporter = new Reporter({
    url: BACK,
    token: "tok_ingest",
    metadataKeys: opts.metadataKeys ?? [],
    ledger: inner,
    outbox,
    providers: providerSnapshots(providers, config, {}),
    now: c.now,
    fetch: back.fetch,
    ...(opts.sendTimeoutMs ? { sendTimeoutMs: opts.sendTimeoutMs } : {}),
  });
  const ledger = new ReportingLedger(inner, reporter);
  const router = new SandboxRouter({ providers, config, ledger, env: {}, now: c.now });
  return { router, reporter, back, outbox, clock: c, providers };
}

const sandboxEvents = (events: WireEvent[]) => events.filter((e): e is Extract<WireEvent, { type: "sandbox" }> => e.type === "sandbox");

describe("what the reporter sends", () => {
  it("reports a sandbox's lifecycle with provider, size, billing and segments, each event valid on the wire", async () => {
    const { router, reporter, back, clock: c } = setup();
    const sbx = await router.create({ cpu: 2, memoryMiB: 4096, timeoutSec: 600 });
    await reporter.flush();
    c.advance(60_000);
    await sbx.kill();
    await reporter.flush();

    for (const e of back.events()) expect(wireEventSchema.safeParse(e).success).toBe(true);
    const states = sandboxEvents(back.events()).map((e) => e.sandbox.state);
    expect(states.at(-1)).toBe("stopped");
    const last = sandboxEvents(back.events()).at(-1)!.sandbox;
    expect(last).toMatchObject({ provider: "a", cpu: 2, memoryMiB: 4096, billing: "free", reason: "killed" });
    expect(last.segments).toHaveLength(1);
    expect(last.segments[0]!.end).toBeDefined();
    expect(wireSandboxProblem(last)).toBeUndefined();
    expect(back.events().some((e) => e.type === "provider" && e.provider.id === "a")).toBe(true);
    expect(back.batches.every((b) => b.auth === "Bearer tok_ingest")).toBe(true);
  });

  it("sends only the metadata keys the user opted into, and no error text, env or commands", async () => {
    const { router, reporter, back } = setup({ metadataKeys: ["team"] });
    const sbx = await router.create({ metadata: { team: "infra", secret: "hunter2" }, env: { API_KEY: "sk-live-123" } });
    await sbx.commands.run("echo sk-live-456");
    await reporter.flush();
    const wire = JSON.stringify(back.batches);
    expect(sandboxEvents(back.events())[0]!.sandbox.metadata).toEqual({ team: "infra" });
    for (const leak of ["hunter2", "sk-live-123", "sk-live-456", "API_KEY", "echo"]) expect(wire).not.toContain(leak);
  });

  it("never sends a job's spec (commands, env, files), outputs or lease owner", async () => {
    const shell = localShellProvider({ id: "a", tier: { kind: "unlimited" } });
    const { router, reporter, back } = setup({ providers: [shell] });
    try {
      await router.jobs.run({ steps: [{ run: "echo top-secret-command", env: { TOKEN: "sk-job" } }], files: { "a.txt": "file-content" } });
    } finally {
      await shell.cleanup();
    }
    await reporter.flush();
    const jobs = back.events().filter((e) => e.type === "job");
    expect(jobs.at(-1)).toMatchObject({ job: { state: "succeeded", steps: 1, cursor: 1 } });
    const wire = JSON.stringify(back.batches);
    for (const leak of ["top-secret-command", "sk-job", "file-content", "TOKEN", (router.jobs as unknown as { ownerId: string }).ownerId]) {
      expect(wire).not.toContain(leak);
    }
  });

  it("reports a refusal's mark, the failed create it came with, and the mark's clearing", async () => {
    const c = clock();
    const back = fakeBack();
    const refusing = fakeProvider({ id: "a", tier: { kind: "one-time-credit", usd: 10 }, createErrors: [Object.assign(new Error("402 credit used up"), { status: 402 })] });
    const other = fakeProvider({ id: "b", tier: { kind: "one-time-credit", usd: 10 } });
    const config = parseConfig({ providers: { a: { priority: 1 } } });
    const inner = new MemoryLedger();
    const reporter = new Reporter({ url: BACK, token: "t", metadataKeys: [], ledger: inner, outbox: new MemoryOutbox(), providers: providerSnapshots([refusing, other], config, {}), now: c.now, fetch: back.fetch });
    const router = new SandboxRouter({ providers: [refusing, other], config, ledger: new ReportingLedger(inner, reporter), env: {}, now: c.now });

    expect((await router.create()).provider).toBe("b");
    await reporter.flush();
    const mark = back.events().find((e) => e.type === "mark");
    expect(mark).toMatchObject({ provider: "a", kind: "quota", mark: { refusals: 1 } });
    expect(JSON.stringify(mark)).not.toContain("credit used up");
    expect(sandboxEvents(back.events()).filter((e) => e.sandbox.provider === "a").at(-1)?.sandbox.state).toBe("failed");

    await router.clearMarks("a");
    await reporter.flush();
    expect(back.events().at(-1)).toMatchObject({ type: "mark", provider: "a", kind: "quota", mark: null });
  });

  it("reports each health sample once", async () => {
    const { router, reporter, back } = setup();
    await router.create();
    await router.create();
    await reporter.flush();
    await reporter.flush();
    const samples = back.events().filter((e) => e.type === "health");
    expect(samples).toHaveLength(2);
  });
});

describe("delivery", () => {
  it("keeps each event's id across failed sends and delivers the same ids once back is up", async () => {
    const { router, reporter, back, clock: c } = setup();
    back.state.down = true;
    await router.create();
    let status = await reporter.flush();
    expect(status.delivery.state).toBe("backoff");
    const queued = (await (reporter as unknown as { opts: { outbox: Outbox } }).opts.outbox.read()).pending.map((e) => e.id);
    expect(queued.length).toBeGreaterThan(0);

    // Inside the backoff nothing is sent, even on a new write.
    back.state.down = false;
    await router.list();
    status = await reporter.flush();
    expect(back.batches).toHaveLength(0);

    c.advance(10 * 60_000);
    status = await reporter.flush();
    expect(status).toMatchObject({ pending: 0, delivery: { state: "idle", failures: 0 } });
    expect(back.events().map((e) => e.id)).toEqual(queued);
  });

  it("backs off longer after each failure, and records why", async () => {
    const c = clock();
    const box = (await new MemoryOutbox().read());
    box.pending = [{ id: `${box.installId}:1`, seq: 1, observedAt: new Date(c.now()).toISOString(), type: "health", provider: "a", sample: { at: new Date(c.now()).toISOString(), op: "create", ok: true } }];
    const waits: number[] = [];
    for (let i = 0; i < 4; i++) {
      const claim = claimBatch(box, "me", c.now());
      expect(claim).toBeDefined();
      const until = settle(box, "me", claim!.failures, { ok: false, error: "back answered 503" }, c.now())!;
      waits.push(until - c.now());
      expect(claimBatch(box, "me", c.now())).toBeUndefined();
      c.set(until);
    }
    expect(box.delivery).toMatchObject({ state: "backoff", failures: 4, error: "back answered 503" });
    expect(waits[3]!).toBeGreaterThan(waits[0]!);
    expect(box.pending).toHaveLength(1);
  });

  it("drops events back rejects as invalid, so one bad event can't block the rest", async () => {
    const { router, reporter, back } = setup();
    back.state.reject.add("provider");
    await router.create();
    const status = await reporter.flush();
    expect(status.pending).toBe(0);
    expect(status.dropped).toBeGreaterThan(0);
    expect(status.delivered).toBe(back.events().filter((e) => e.type !== "provider").length);
  });

  it("a send claimed by a process that died is claimable once its lease lapses; the late answer of the dead one changes nothing", async () => {
    const c = clock();
    const box = await new MemoryOutbox().read();
    box.pending = [{ id: `${box.installId}:1`, seq: 1, observedAt: new Date(c.now()).toISOString(), type: "health", provider: "a", sample: { at: new Date(c.now()).toISOString(), op: "create", ok: true } }];
    expect(claimBatch(box, "dead", c.now())).toBeDefined();
    expect(claimBatch(box, "alive", c.now())).toBeUndefined();
    c.advance(31_000);
    const claim = claimBatch(box, "alive", c.now());
    expect(claim?.batch).toHaveLength(1);
    // The dead process's failure doesn't put the live one's send into backoff.
    expect(settle(box, "dead", 0, { ok: false, error: "x" }, c.now())).toBeUndefined();
    expect(box.delivery).toMatchObject({ state: "sending", owner: "alive" });
    settle(box, "alive", 0, { ok: true, results: [{ id: claim!.batch[0]!.id, outcome: "duplicate" }] }, c.now());
    expect(box).toMatchObject({ pending: [], delivery: { state: "idle" } });
  });

  it("routing doesn't wait for a back end that hangs", async () => {
    // Sends hang for a second each; three routing writes that waited on them would take three.
    const { router, reporter, back } = setup({ sendTimeoutMs: 1_000 });
    back.state.hang = true;
    const started = Date.now();
    const sbx = await router.create();
    await sbx.kill();
    expect(Date.now() - started).toBeLessThan(200);
    // The send itself gives up after its timeout and backs off.
    const status = await reporter.flush();
    expect(status.delivery).toMatchObject({ state: "backoff", error: "timed out" });
  });
});

describe("convergence", () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("a write nobody reported (a crash before observing) is reported by the next process at startup", async () => {
    dir = await mkdtemp(join(tmpdir(), "sbr-report-"));
    const ledger = new FileLedger(join(dir, "ledger.json"));
    const c = clock();
    // A router without reporting writes a sandbox, as if the process died before observing.
    const plain = new SandboxRouter({ providers: [fakeProvider({ id: "a", tier: { kind: "unlimited" } })], ledger, env: {}, now: c.now });
    await plain.create();

    const back = fakeBack();
    const config = parseConfig({ report: { url: BACK, token: "t" } });
    const reporting = reportingLedger(ledger, { config, env: {}, home: dir, providers: () => [], now: c.now, fetch: back.fetch }) as ReportingLedger;
    await new Promise((r) => setImmediate(r));
    await reporting.reporter.flush();
    expect(sandboxEvents(back.events()).map((e) => e.sandbox.state)).toEqual(["running"]);
    const onDisk = JSON.parse(await readFile(join(dir, "report", "outbox.json"), "utf8")) as { pending: unknown[] };
    expect(onDisk.pending).toEqual([]);
  });

  it("two processes sharing an outbox hand out increasing sequence numbers and never queue a state twice", async () => {
    dir = await mkdtemp(join(tmpdir(), "sbr-report-"));
    const ledger = new FileLedger(join(dir, "ledger.json"));
    const outboxPath = join(dir, "report", "outbox.json");
    const c = clock();
    const one = setup({ ledger, outbox: new FileOutbox(outboxPath), c });
    const two = setup({ ledger, outbox: new FileOutbox(outboxPath), c });
    one.back.state.down = true;
    two.back.state.down = true;
    await Promise.all([one.router.create(), two.router.create(), one.router.create()]);
    await Promise.all([one.reporter.flush(), two.reporter.flush()]);
    await Promise.all([one.reporter.observe(), two.reporter.observe()]);

    const box = await new FileOutbox(outboxPath).read();
    const seqs = box.pending.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(box.pending.map((e) => e.id)).size).toBe(box.pending.length);
    const sandboxes = sandboxEvents(box.pending).map((e) => e.sandbox.id);
    expect(new Set(sandboxes).size).toBe(sandboxes.length); // newest state only, once
    expect(sandboxes).toHaveLength(3);
  });

  it("a newer state of a sandbox supersedes its pending older one", async () => {
    const box = await new MemoryOutbox().read();
    const c = clock();
    const r = new SandboxRouter({ providers: [fakeProvider({ id: "a", tier: { kind: "unlimited" } })], env: {}, now: c.now });
    const sbx = await r.create();
    observeInto(box, await r.ledger.read(), c.now(), [], () => []);
    const firstId = box.pending[0]!.id;
    c.advance(1000);
    await sbx.kill();
    observeInto(box, await r.ledger.read(), c.now(), [], () => []);
    const left = sandboxEvents(box.pending);
    expect(left).toHaveLength(1);
    expect(left[0]!.sandbox.state).toBe("stopped");
    expect(left[0]!.id).not.toBe(firstId);
    expect(Date.parse(left[0]!.observedAt)).toBeGreaterThan(Date.parse(box.pending.find((e) => e.type === "health")!.observedAt) - 1);
  });

  it("observedAt never goes back, even when the clock does", async () => {
    const box = await new MemoryOutbox().read();
    const c = clock();
    const r = new SandboxRouter({ providers: [fakeProvider({ id: "a", tier: { kind: "unlimited" } })], env: {}, now: c.now });
    const sbx = await r.create();
    observeInto(box, await r.ledger.read(), c.now(), [], () => []);
    c.advance(-60_000);
    await sbx.kill();
    observeInto(box, await r.ledger.read(), c.now(), [], () => []);
    const times = box.pending.map((e) => Date.parse(e.observedAt));
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it("an unreadable outbox is set aside and reporting starts over instead of stopping", async () => {
    dir = await mkdtemp(join(tmpdir(), "sbr-report-"));
    const path = join(dir, "outbox.json");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path, "{not json");
    const box = await new FileOutbox(path).read();
    expect(box.pending).toEqual([]);
    expect(box.installId).toMatch(/^ins_/);
  });
});

describe("turning it on", () => {
  it("is off without a url and token, or with enabled: false", () => {
    expect(reportSettings(parseConfig({}))).toBeUndefined();
    expect(reportSettings(parseConfig({ report: { url: BACK } }))).toBeUndefined();
    expect(reportSettings(parseConfig({ report: { url: BACK, token: "t", enabled: false } }))).toBeUndefined();
    expect(reportSettings(parseConfig({ report: { url: `${BACK}/`, token: "t" } }))).toEqual({ url: BACK, token: "t", metadataKeys: [] });
  });

  it("reads SBR_REPORT_URL and SBR_REPORT_TOKEN, and SBR_REPORT=0 turns it off", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sbr-report-"));
    try {
      const env = { SBR_HOME: dir, SBR_REPORT_URL: BACK, SBR_REPORT_TOKEN: "t" };
      expect(reportSettings(await loadConfig(env, dir))).toMatchObject({ url: BACK, token: "t" });
      expect(reportSettings(await loadConfig({ ...env, SBR_REPORT: "0" }, dir))).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("createRouter reports when configured, and leaves the ledger alone when not", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sbr-report-"));
    try {
      const providers = [fakeProvider({ id: "a", tier: { kind: "unlimited" } })];
      const off = await createRouter({ env: { SBR_HOME: dir }, config: {}, providers });
      expect(off.ledger).toBeInstanceOf(FileLedger);
      const on = await createRouter({ env: { SBR_HOME: dir }, config: { report: { url: "http://127.0.0.1:9", token: "t" } }, providers });
      expect(on.ledger).toBeInstanceOf(ReportingLedger);
      await new Promise((r) => setImmediate(r));
      await (on.ledger as ReportingLedger).reporter.flush();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
