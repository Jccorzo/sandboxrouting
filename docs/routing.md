# Routing and job continuation

This is the design for two things on top of the existing router:

1. **Switchable routing.** The algorithm that picks a provider is a named, swappable
   *strategy*. You can change it in config, per request, or register your own. The
   hard rules (keys, capabilities, `allowPaid`, budgets) stay outside the strategies,
   so no strategy can route around them.
2. **Jobs that move between boxes.** A *job* is ordered work (steps) plus a working
   directory. When its box dies, its provider refuses, or a limit is about to end the
   box (lifetime cap, free credit), the job continues on another box from its last
   checkpoint.

Status: implemented in `src/core/routing/`, `src/core/health.ts` and `src/core/jobs/`.
Everything here is covered by tests against fake providers, a local-shell provider and
real Docker. Live provider runs still depend on keys (`sbr check`).

---

## 1. What a routing decision can use

### Hard filters (the same for every strategy)

A provider that fails any of these is skipped, with the reason recorded in `plan.skipped`.

| # | Filter | Source |
|---|---|---|
| 1 | Disabled in config | `providers.<id>.enabled` |
| 2 | Not in the request's `providers`, or in `exclude` | request |
| 3 | Self-hosted when `selfHosted: "never"` | config |
| 4 | Keys missing | `info.env`, `isConfigured` |
| 5 | Lacks a capability in `needs` | `info.capabilities` |
| 6 | Can't run the `image` (no `customImage`, no native template) | request + info |
| 7 | `timeoutSec` over the provider's maximum | `info.maxTimeoutSec` |
| 8 | Longest command (`execTimeoutSec`) over the provider's per-command cap | `info.maxExecSec` (exe.dev: 30 s) |
| 9 | Isolation weaker than `minIsolation` (or unknown) | `info.isolation`, config override |
| 10 | Rate-limit or auth mark in force | ledger marks |
| 11 | Circuit open (repeated infrastructure failures), or half-open with its one probe in flight | ledger health samples |
| 12 | Neither free usage nor paid usage can take it | free status, lifetime cap, free concurrency, `allowPaid`, `maxPaidUsdPerMonth` |

Filter 12 also decides the *billing* of every surviving candidate: `free` (a free tier
covers it), `self-hosted` (your hardware) or `paid`.

Money is **reserved**, not just checked. Every live sandbox holds what it can still
spend: a running one until its deadline, a creating one for the timeout it asked for. The
amount is priced at that box's own size and recorded with how it is billed.

- A free tier takes a request only if what's left, after those holds, covers the **whole**
  request: its full timeout, priced at the size the provider will actually create (the
  provider's default where the request leaves it unset). Hours tiers count sandbox-seconds.
- With `maxPaidUsdPerMonth` set, paid usage takes a request only if the budget left, after
  this month's spend and every live paid sandbox's hold, covers its full timeout.

So with `allowPaid: false` a sandbox can't run past its free tier, and a budget is a hard
cap. The price of the guarantee is a sliver of free credit at the end of each tier, too
small for one more whole request.

When a reservation is re-checked under the ledger lock, the billing must still be possible
as planned. A request planned as free never silently becomes paid because a parallel request
took the last free slot or the last of the credit. It moves to the next candidate instead.

### Signals strategies rank by

Every surviving provider becomes a `Candidate` carrying these facts, computed once:

| Signal | Meaning |
|---|---|
| `free` | Free status: remaining credit or hours, share left, reset time |
| `freeUsable`, `paidAllowed` | Whether free usage, or paid usage, can take this whole request after what live sandboxes hold |
| `freeCoverage` | Free headroom: how many more requests like this one the free usage left could take, out of 10 (0..1) |
| `ratePerSecondUsd` | Price at the requested size |
| `health.successRate` | Time-decayed share of recent creates that worked (prior 0.9 with no data) |
| `health.createP50Ms` | Median create latency, from history |
| `live`, `cap` | Live sandboxes and the free concurrency cap |
| `recentCreates` | Sandboxes created on it in the last hour |
| `priority` | `providers.<id>.priority` (lower first) |
| `preferenceIndex` | Position in the request's `providers` list |
| `preferred`, `avoided` | Soft hints: `prefer` (warm cache, same template) and `avoid` (just failed this job) |

### Not built yet (and why)

- **Region and caller latency**: only a few adapters take a region, and none reports
  latency, so `region` stays a pass-through hint.
- **Native snapshots across boxes**: snapshot APIs are per provider (E2B, Morph, Runloop,
  Freestyle…) and can't cross providers. A same-provider fast path (snapshot, then boot the
  next box from it, installed packages included) is the next step for jobs. It needs an
  optional `snapshot()` call on adapters.
- **Live process migration**: no provider exposes CRIU or similar. Jobs move at step
  boundaries.

---

## 2. Strategies

A strategy is an object with a `name`, a `description` and a pure `rank(candidates, ctx)`
that returns the order (and may leave candidates out, with a reason). The router then
re-checks billing on every entry: a `paid` entry needs `paidAllowed`, a free one needs
`freeUsable`.

| Name | What it does |
|---|---|
| `free-first` (default) | The existing behaviour, unchanged. Lanes: monthly free, by most at risk per day left; one-time credit, by largest share left; your hardware; paid, cheapest first. |
| `cheapest` | The existing `policy: "cheapest"`: any free usage first by price, then your hardware, then paid by price. |
| `balanced` | The same lanes as `free-first`. Within a free lane, a weighted score of free value (use it or lose it), health, speed, free headroom (`coverage`) and load. The weights are in config. In the paid lane, price comes first. |
| `fastest` | Unbilled first (free and your hardware), then paid. Within each, the shortest expected time to a ready box: median create latency ÷ success rate. It is the one strategy that pays more for speed when paid usage is on. |
| `spread` | The same lanes as `free-first`. Within a free lane, the most free headroom first (lowest live/cap, fewest recent creates). For fan-out, so no single provider gets rate limited. In the paid lane, price comes first. |

Every built-in breaks ties in the same order: lane, then `avoided` last, then config
`priority`, then `preferred` first, then the request's `providers` order, then the
strategy's score, then price, then name.

A provider never tried has no latency yet. `balanced` and `fastest` assume it is as fast as
the fastest one seen, so it gets one try and a median of its own. Assumed slow, it would
never be tried. A provider that has only failed gets the slow default, divided by its poor
success rate.

### Comparing strategies

`npm run simulate` runs every strategy through the real router on a simulated month: the
same seeded workload, providers modelled on the built-ins' terms, latencies and failure
rates. Scenarios are `steady`, `flaky`, `outage`, `tight` and `external-usage`. For each
strategy it reports:

- requests served and unserved, and failovers;
- paid spend;
- free credit used, and monthly credit left to expire;
- time to ready (mean and p95);
- each provider's share.

Your own strategy runs next to the built-ins with `simulate({ strategies: [mine] })`. Change
a strategy, run it, and compare the tables before you switch.

### Choosing one

```jsonc
{
  "routing": {
    "strategy": "balanced",
    "weights": { "freeValue": 1, "health": 1, "speed": 0.5, "coverage": 0.5, "load": 0.25 },
    "circuitBreaker": { "failures": 3, "cooldownSec": 120, "maxCooldownSec": 1800 }
  }
}
```

- Per request: `router.create({ strategy: "fastest" })`, `sbr route --strategy fastest`, or
  `"strategy"` in the REST/MCP body.
- Compare them: `sbr route --compare` prints the plan under every strategy.
- Your own: `router.registerStrategy({ name, description, rank })`, then use its name.
- `policy` still works as an alias for `routing.strategy`.

### Health and the circuit breaker

The router keeps the last 50 infrastructure outcomes per provider in the ledger: creates
that worked (with latency), creates that failed for a transient reason (network, 5xx,
timeouts), and boxes lost before their deadline. Quota, rate-limit and auth refusals keep
their own marks and don't count here. Everything else is computed when it is read:

- **Success rate**: time-decayed (half-life 1 h), smoothed toward 0.9 when there are few samples.
- **Circuit**: after `failures` consecutive failures it is *open* for `cooldownSec`,
  doubling for each further failure up to `maxCooldownSec`. Then it is *half-open*: one
  create may probe it (a second waits while that probe is still `creating`). A success
  closes it.

Nothing stores "open" or "closed", so there is no flag to forget to clear.

---

## 3. Jobs: continuing work on another box

### The model

```ts
await router.jobs.run({
  sandbox: { image: "python:3.12-slim", timeoutSec: 1800 },  // same request as router.create
  workdir: "work",                       // relative → $HOME/work on each box
  files: { "main.py": "print('hi')" },   // initial workspace
  setup: [{ run: "pip install -q requests" }],   // re-run on every new box
  steps: [
    { run: "python main.py > out.txt" },
    { run: "curl -X POST https://hooks.example/done", idempotent: false },
  ],
});
```

- The **workdir** is everything carried between boxes. After each step the runner tars it
  on the box, downloads it and stores it (`~/.sandboxrouting/checkpoints/<job>/`, written
  whole and checked by SHA-256). It is the job's durable state.
- **Setup** steps prepare a box (install tools) and run on every new box before the
  workspace is restored.
- A **step** is the unit of retry. Re-running a step means restoring the workspace from
  before it and running it again. `idempotent: false` marks steps with outside effects:
  when such a step's outcome is unknown (the box or the runner died mid-step), the job
  fails instead of running it twice.

### Lifecycle (one transition function, `jobs/state.ts`)

```
queued ──claim──▶ placing ──placed──▶ preparing ──prepared──▶ running ──succeed──▶ succeeded
                    ▲                     │                    │  ▲
                    │                  migrate              stepStarted / stepSucceeded /
                    └───left─── migrating ◀──────migrate──────┘  stepRetry / checkpointed
any non-terminal ──fail──▶ failed      any non-terminal ──cancel──▶ cancelled
```

- `placing`: asking the router for a box. Sandboxes made for a job carry
  `metadata["sandboxrouting.job"]`, so a takeover can find and kill one a crash orphaned.
- `preparing`: the box is attached. Setup runs, then the last checkpoint is restored (or
  the initial `files` are written). This is idempotent.
- `running`: steps execute. `inFlight` names the step that is executing.
- `migrating`: leaving the box. It is killed (best effort; the sweep reaps it), then back to `placing`.

Ownership is a **lease** (`owner`, `until`) renewed every `leaseSec/3` by the process
driving the job. Every write checks the lease holder under the ledger lock, so a runner
that lost its lease gets a conflict and stops, without killing a box someone else now
uses. Destructive work (killing a box, wiping the workdir for a restore, pruning
checkpoints) renews the lease under the lock first. A runner that stalled past its lease
and woke after a takeover stops there, before it touches anything. A job whose lease lapsed reads as **`orphaned`**. That state is computed on read,
never stored. `sbr job resume <id>` (or `sbr serve`'s sweep) claims it and continues from
its recorded state:

| Recorded state | What the new owner does |
|---|---|
| `queued` | place |
| `placing` | kill any live sandbox tagged with this job that isn't recorded, then place |
| `preparing` | redo setup and restore on the box, or migrate if it's gone |
| `running`, nothing in flight | continue (or migrate if the box is gone) |
| `running`, step in flight | Outcome unknown, and a copy may still be running on the old box. If the step is idempotent, retire that box (`orphaned`; this doesn't count against the provider) and re-run the step on a new one from the checkpoint before it. Otherwise, fail. |
| `migrating` | kill the old box, then place |

### When a job moves, and where to

Checked at every step boundary (planned, nothing lost):

| Trigger | Action |
|---|---|
| The box's remaining life < next step's timeout + `deadlineMarginSec` | Extend it if the provider can and the total stays within its (free) lifetime cap. Otherwise move: `deadline`. |
| On a free tier that is used up, or won't cover the next step | Move if another candidate is better: `free-credit` |
| A quota or auth mark landed on the box's provider | Move: `provider-refused` |
| The box's provider circuit opened | Move: `circuit-open` |
| Running on paid while a free candidate exists (`rebalance: true`) | Move: `rebalance` |

During a step (reactive):

| What happened | Action |
|---|---|
| Box gone (`not_found`) before its deadline | Health sample; move: `lost`; re-run the step |
| Box answers with an exit code but is dead (Docker: 137 when the container is removed) | A failed step is followed by a `true` probe. A dead box is `lost`, not the step's failure. |
| Box stopped, killed or paused outside the job | Move: `stopped`. This isn't the provider's fault, so it isn't avoided. |
| Quota or auth refusal | Mark the provider; move: `provider-refused` |
| Rate limited | Back off, retry on the same box |
| Transient error in the step's command | The command may still be running there. Move (`unhealthy`) and re-run on a new box if idempotent; otherwise fail. Never run beside itself. |
| Transient error in setup, restore or a checkpoint | Retry on the same box twice with backoff, then move: `unhealthy` |
| The checkpoint can't be saved locally (disk full) | Record the step's success, then fail the job and kill the box |
| Exit 137 with `growMemoryOnOom` | Move to a box with twice the memory (up to `maxMemoryMiB`): `oom` |
| Non-zero exit | `retries` left: restore and re-run; else the job fails (it's the job's own failure) |
| No provider can take it now | Every skip says when its reason lapses: a mark's expiry, the circuit's reopening, the monthly reset, or "any moment" for a full free tier (a slot frees when a box is killed). The job waits for the first one, polling every 5–15 s, if it comes within `maxWaitSec`. Otherwise it fails at once with every provider's reason. Permanent reasons (no key, no `gpu`, paid off) never cause a wait. |

The next box comes from the router with:

- the job's request;
- `avoid` set to providers that failed this job: lost, unhealthy, refused, circuit, setup
  failed, or out of free credit;
- a timeout that covers setup plus the longest remaining step (plus the margin);
- `execTimeoutSec` set to the longest single command.

Avoiding demotes a provider within its lane but doesn't drop it, so a job never pays to
avoid a free provider. A `deadline`, `stopped` or `orphaned` move may land on the same
provider: a new box gets a new lifetime. The limits are `maxMigrations` per job and
`maxStepAttempts` per step. Replaying steps that had succeeded (after a rewind) doesn't
count toward a step's attempts. Growing memory after an out-of-memory kill does, so with
the defaults a step's memory doubles at most twice.

### Checkpoint modes

- `every-step` (default): checkpoint after every step, unless the step has `noCheckpoint`.
  An unplanned loss re-runs only the step in flight.
- `on-migrate`: checkpoint only before a planned move. An unplanned loss rewinds to the
  last checkpoint and replays the steps since. All of those must be idempotent, or the
  job fails rather than replay one that isn't. A retry after a non-zero exit runs on the
  workspace the failed attempt left, since no archive of the state before the step exists.

### Surfaces

- SDK: `router.jobs.run | submit | resume | get | list | cancel | sweep`, and `router.move(id)`
  for an interactive sandbox (copy the workdir to a new box, kill the old one).
- CLI: `sbr job run --step … [--setup …] [--workdir …]`, `sbr job ls|status|resume|cancel|download`, `sbr move <id>`.
- REST: `POST /v1/jobs` (202 with the id once claimed; `?wait=1` for the end), `GET /v1/jobs[/{id}]`,
  `POST /v1/jobs/{id}/resume|cancel`, `GET /v1/jobs/{id}/workspace`, `GET /v1/strategies`, `POST /v1/route?compare=1`.
- MCP: `run_job` (waits up to `waitSec`, then returns the id to poll), `job_status`, `list_jobs`, `resume_job`,
  `cancel_job`, `move_sandbox`, `list_strategies`.

---

## 4. Configuration reference

```jsonc
{
  "routing": {
    "strategy": "free-first",        // free-first | cheapest | balanced | fastest | spread | yours
    "weights": { "freeValue": 1, "health": 1, "speed": 0.5, "coverage": 0.5, "load": 0.25 },
    "circuitBreaker": { "failures": 3, "cooldownSec": 120, "maxCooldownSec": 1800 },
    "healthSamples": 50
  },
  "jobs": {
    "checkpoint": "every-step",      // or "on-migrate"
    "maxMigrations": 5,
    "maxStepAttempts": 3,
    "defaultStepTimeoutSec": 600,
    "deadlineMarginSec": 60,
    "leaseSec": 60,
    "maxWaitSec": 300,
    "rebalance": false,
    "growMemoryOnOom": false,
    "maxMemoryMiB": 16384,
    "maxCheckpointBytes": 268435456
  },
  "providers": { "docker": { "isolation": "gvisor" } }   // e.g. when Docker runs runsc
}
```
