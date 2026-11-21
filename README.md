# sandboxrouting

One router for every cloud sandbox provider. You ask for a sandbox; the router picks a
provider that still has free usage left, fails over when one refuses, and keeps track of
what each sandbox costs. The four ways providers expose themselves — an SDK, a REST API, a
CLI and an MCP server — are each here once, for all of them.

```ts
import { createRouter } from "sandboxrouting";

const router = await createRouter();               // config file + keys from the environment
const sbx = await router.create({ timeoutSec: 600 });
const r = await sbx.commands.run("python3 -c 'print(6*7)'");
await sbx.files.write("/work/app.py", "print('hi')");
console.log(sbx.provider, r.stdout);               // e.g. "modal 42"
await sbx.kill();
```

## Providers

55 providers are built in: 52 cloud providers plus your own hardware (openci, OpenSandbox,
local Docker). Terms were checked on 2026-11-11 or 2026-11-12 against each provider's pricing
page, which its adapter links. Terms change, so you can override any of them in config.

The 17 added on 2026-11-12 (`tensorlake`, `buddy`, `boxd`, `maritime`, `promigence`, `zode`,
`boxcompute`, `lizard`, `munito`, `nanite`, `render`, `quave`, `beam`, `mosaic`, `nodus`,
`cathedral`, `dory`) are written from each provider's published API and tested against
local servers that speak it. None has been run against the real service yet. Nor has
`opensandbox` (added 2026-11-14), written from OpenSandbox's OpenAPI specs and its JS SDK, nor
the 6 added on 2026-11-21 (`superserve`, `eqvps`, `solari`, `pilldrops`, `langsmith`, `miosa`),
written from each provider's published API the same way.

### Free every month

| id | Free usage | Free limits | Paid after | Isolation |
|---|---|---|---|---|
| `modal` | $30 / month | 100 concurrent, 24 h | ~$0.19/h (2 vCPU, 2 GiB) | gVisor |
| `northflank` | $20 / month | 2 sandboxes | ~$0.017/vCPU-h | container |
| `freestyle` | 200 vCPU-h + 400 GiB-h (≈ $13) | 10 concurrent | $0.040/vCPU-h | microVM |
| `vercel` | 5 CPU-h + 420 GB-h (≈ $9.5) | 10 concurrent, 45 min | $0.128/CPU-h (active only) | Firecracker |
| `instabox` | one 4 vCPU / 8 GiB machine, always free‡ | 1 machine, 8 h per run | $0.004/vCPU-h | Firecracker |
| `upstash` | 5 CPU-hours | 10 concurrent, 2 vCPU / 4 GB | $0.10/h (2 vCPU) | container |
| `cloudflare` | 375 vCPU-min + 25 GiB-h (≈ $0.68) with Workers Paid ($5/mo) | — | $0.072/vCPU-h (active only) | container |
| `tensorlake` | one 1 vCPU / 1 GB sandbox, always free | 1 sandbox, 1 h (2 h once verified) | $0.07/vCPU-h + $0.015/GB-h | Firecracker |
| `buddy` | $1 / month | — | $0.0144/vCPU-h + $0.0144/GB-h | VM |
| `solari` | $3 / month | 1 sandbox, 1 h | $0.171/h (2 vCPU / 4 GB) | Cloud Hypervisor |
| `langsmith` | 8 LSU / month ($8, ≈ 42 h) | 10 sandboxes | $0.189/h (2 vCPU / 4 GiB) | Firecracker¶ |
| `miosa` | $1 / month | 5 sandboxes | $0.0893/h (2 vCPU / 4 GB) | Firecracker |

### One-time credit

| id | Free usage | Free limits | Paid after | Isolation |
|---|---|---|---|---|
| `daytona` | $200* | 10 vCPU total | $0.050/vCPU-h | container |
| `blaxel` | up to $200* | 10 concurrent, 7 days | $0.041/GB-h (memory only) | microVM |
| `e2b` | $100 | 10 concurrent, 1 h | $0.050/vCPU-h | Firecracker |
| `tenki` | $100 (card required) | 5 concurrent | $0.050/vCPU-h | microVM |
| `boxlite` | $100 when you add a card* | per plan | $0.050/vCPU-h | microVM |
| `runloop` | $50 | 3 running, 48 h | $0.108/vCPU-h | VM |
| `dedalus` | $20 (beta access needed) | — | rates unpublished (estimate $0.05/vCPU-h) | Cloud Hypervisor |
| `createos` | ~$5 (500 credits)* | 1 sandbox, 1 vCPU / 1 GB | $0.036/vCPU-h | Firecracker |
| `quivvo` | $5 (signup queue) | 1 machine | $0.005/vCPU-h (shared) | Firecracker |
| `celesto` | $5, expires after 30 days | 1 sandbox | $0.015/h (1 vCPU / 2 GB) | Firecracker |
| `agent37` | $5 (card required) | 3 awake | $0.0011/vCPU-h | gVisor |
| `boat` | 25 trial hours (≈ $0.45; card required) | 2 concurrent, 2 h | $0.018/h (2 vCPU / 4 GB) | VM |
| `boxd` | €30 (counted as $30; card likely required) | 50 machines | €0.039/vCPU-h + €0.012/GiB-h (in use only) | KVM microVM |
| `maritime` | $20 trial cap, 7 days (card required) | 24 h | $0.022/h (2 vCPU / 4 GB) | Firecracker |
| `promigence` | $10 without a card ($50 with one), 30 days | 20 concurrent, 1 h | $0.166/h (2 vCPU / 4 GiB) | not published§ |
| `zode` | $10 (card check) | 2 running, 55 s per command | $0.0225/h (2 vCPU / 4 GB) | Cloud Hypervisor |
| `boxcompute` | $5, expires after 14 days | 2 running | $0.05/h (0.5 vCPU / 1 GiB) | VM |
| `lizard` | $5, 7-day trial (card required) | 1 Small running, 1 h | $0.0162/h (2 vCPU / 4 GB) | Firecracker |
| `munito` | $0.90, 7-day trial (card required) | 2 concurrent, 2 h | $0.018/h (2 vCPU / 4 GiB) | microVM |
| `pilldrops` | $5 (no card) | 5 concurrent, 4 h, 2 vCPU / 2 GB | $0.13/h (2 vCPU / 2 GB) | container# |

### Paid only

| id | Price | Notes | Isolation |
|---|---|---|---|
| `koyeb` | $0.0144/h (1 vCPU, 1 GB) | | microVM |
| `fly` | ~$0.01/h shared vCPU | needs an app (`FLY_APP`) | Firecracker |
| `sprites` | $0.039/CPU-h; idle Sprites are free | | Firecracker |
| `morph` | $0.05/vCPU-h | free credit disputed† | VM (memory snapshots) |
| `together` | $0.045/vCPU-h | custom plans | Firecracker |
| `depot` | $0.18/vCPU-h (CPU only) | 7-day trial | microVM |
| `namespace` | $0.09/h per vCPU + 2 GB | 3 h max | microVM |
| `lambda-microvm` | $0.10/vCPU-h + $0.013/GB-h | needs the execd image | Firecracker (ARM64) |
| `thunder` | $0.051/vCPU-h | access through sales; exec over SSH | Firecracker (GPUs) |
| `exedev` | $0.105/h (2 vCPU + 4 GiB) on top of a plan | 30 s per command | VM |
| `nanite` | $0.072/vCPU-h + $0.0432/GB-h (in use only) | fixed size; stops after 30 idle seconds | microVM |
| `render` | $0.12/CPU-h (active only) + $0.019/GB-h | beta; no public URLs yet | Firecracker |
| `quave` | $0.03125/h per 0.5 vCPU + 512 MB | enabled per account; size and image come from a template | gVisor |
| `beam` | $0.05/vCPU-h + $0.01/GiB-h | $20/mo plan includes $20 of credit | container |
| `mosaic` | $0.05/h per 2 vCPU / 4 GiB | free while hibernated | Firecracker |
| `nodus` | $0.0357/h (2 vCPU / 4 GiB) | prepaid; no outbound network unless asked | gVisor-style |
| `cathedral` | $0.035/h (2 vCPU / 4 GiB) | prepaid; 24 h max; files under /work | confidential VM, shared‖ |
| `dory` | $0.0288/h (2 shared vCPU / 4 GB) | prepaid; 10 min per command | VM |
| `superserve` | $0.166/h (2 vCPU / 4 GiB) | a free trial of unpublished size, no card | Firecracker |
| `eqvps` | $0.132/h (2 vCPU / 4 GB) | prepaid in crypto; 20 at once, 24 h max | Firecracker |

### Your own hardware

| id | Free usage | Isolation |
|---|---|---|
| `openci` | unlimited, on your workers | Firecracker / gVisor / Hyper-V |
| `opensandbox` | unlimited, on your Docker host or Kubernetes cluster | container (set `isolation` in config if your runtime is stronger) |
| `docker` | unlimited, on this machine | container |

Footnotes:

- \* The provider doesn't say whether the credit recurs, so it's treated as one-time, the safe reading.
- † Morph's own pages disagree (a 300 MCU starting credit vs none). If your account has it, set
  `"morph": { "freeTier": { "kind": "one-time-credit", "usd": 15 } }`.
- ‡ InstaBox's free plan is never billed, but it says its "early allowance" can end. It's
  modelled as a month of hours for one machine.

- § Promigence doesn't say how its sandboxes are isolated, so a request with `minIsolation` skips it.
- ‖ Cathedral's rooms share one AMD SEV-SNP VM and are kept apart by a container runtime it
  doesn't name, so the adapter claims `container`, the weakest.
- ¶ LangSmith documents Firecracker for its self-hosted sandboxes; its cloud pages say only
  "isolated". An LSU is $1; 8 LSU at 0.0576 LSU/vCPU-h + 0.01845 LSU/GiB-h is about 42 hours.
- \# PillDrops' pricing page says each sandbox is a dedicated microVM, but its llms.txt says "a
  microVM (or container)", so the adapter claims `container`, the weaker.
- Superserve gives new accounts a free trial for their first sandbox without saying how much, so
  nothing is counted as free; set `freeTier` in config once you know your account's.
- Runloop is winding down: its docs say transition support ends 2026-11-13. The adapter is
  still here; set `"runloop": { "enabled": false }` once your account stops working.
- boxd bills in euros; its prices are converted at about 1.10 USD per euro.
- Zode's docs ($0.0175/h) and homepage ($0.0225/h) disagree on price, and on the free tier
  ($10 once after a card check, vs 50 free hours a month). The higher price and the docs'
  free tier are used.

### Not built

| Provider | Why |
|---|---|
| AWS Nitro Sandboxes | It has no sandbox API. It's an EC2 feature: Firecracker on a Nitro Enclaves parent instance, or `ISOLATED_SANDBOX` tasks in ECS/EKS. The ECS path (`RunTask` plus ECS Exec) could become an adapter, but AWS doesn't say whether ECS Exec works in sandboxed tasks. |
| Cube | It never had an API (Mac app, web and SSH only), and it is shutting down: new machines blocked since 2026-11-06, all machines deleted 2026-12-20. |

### Keys and access surfaces

| id | Key(s) | How the adapter connects |
|---|---|---|
| `e2b` | `E2B_API_KEY` | SDK `e2b` |
| `daytona` | `DAYTONA_API_KEY` | SDK `@daytona/sdk` |
| `modal` | `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET` | SDK `modal` (gRPC) |
| `vercel` | `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID` (or `VERCEL_OIDC_TOKEN`) | SDK `@vercel/sandbox` |
| `runloop` | `RUNLOOP_API_KEY` | SDK `@runloop/api-client` |
| `freestyle` | `FREESTYLE_API_KEY` | SDK `freestyle` |
| `blaxel` | `BL_API_KEY`, `BL_WORKSPACE` | SDK `@blaxel/core` |
| `northflank` | `NORTHFLANK_TOKEN`, `NORTHFLANK_PROJECT` | SDK `@northflank/js-client` |
| `cloudflare` | `CLOUDFLARE_SANDBOX_URL`, `CLOUDFLARE_SANDBOX_TOKEN` | REST, to the bridge Worker in templates/cloudflare-worker |
| `instabox` | `INSTABOX_API_KEY` | REST api.instabox.sh |
| `upstash` | `UPSTASH_BOX_API_KEY` | SDK `@upstash/box` |
| `tenki` | `TENKI_API_KEY` | SDK `@tenkicloud/sandbox` |
| `boxlite` | `BOXLITE_API_KEY` | SDK `@boxlite-ai/boxlite` (native: macOS arm64, Linux glibc) |
| `dedalus` | `DEDALUS_API_KEY` | REST dcs.dedaluslabs.ai/v1 |
| `createos` | `CREATEOS_SANDBOX_API_KEY` | REST api.sb.createos.sh/v1 |
| `quivvo` | `QUIVVO_API_KEY` | REST tryquivvo.com/api/v1 |
| `celesto` | `CELESTO_API_KEY` | SDK `@celestoai/sdk` |
| `agent37` | `AGENT37_API_KEY` | REST api.agent37.com/v1 + sandbox.agent37.app |
| `boat` | `BOAT_API_KEY` | REST boat.dev/api/v1 |
| `tensorlake` | `TENSORLAKE_API_KEY` | REST api.tensorlake.ai + `<id>.sandbox.tensorlake.ai` |
| `buddy` | `BUDDY_TOKEN`, `BUDDY_WORKSPACE`, `BUDDY_PROJECT` (`BUDDY_REGION` for EU/AS) | REST api.buddy.works |
| `boxd` | `BOXD_API_KEY` | SDK `@boxd-sh/sdk` (gRPC; there is no REST API) |
| `maritime` | `MARITIME_API_KEY` | REST api.maritime.sh + the sandbox's data plane |
| `promigence` | `PROMIGENCE_API_KEY` | REST api.promigence.ai/v1 |
| `zode` | `ZODE_API_KEY` | REST api.zode.dev/v1 |
| `boxcompute` | `BOXCOMPUTE_API_KEY` | REST api.boxcompute.ai/api/v2 |
| `lizard` | `LIZARD_API_KEY`, `LIZARD_PROJECT_ID` | REST lizard.build/api |
| `munito` | `MUNITO_API_KEY` | REST api.munito.ai/sandboxes/v1 |
| `koyeb` | `KOYEB_API_TOKEN` | SDK `@koyeb/sandbox-sdk` |
| `fly` | `FLY_API_TOKEN`, `FLY_APP` | REST api.machines.dev/v1 |
| `sprites` | `SPRITES_TOKEN` | REST api.sprites.dev/v1 (the SDK needs Node 24) |
| `morph` | `MORPH_API_KEY` | SDK `morphcloud` |
| `together` | `TOGETHER_API_KEY` | SDK `together-sandbox` |
| `depot` | `DEPOT_TOKEN` | SDK `@depot/sandbox` |
| `namespace` | `NSC_TOKEN` | SDK `@namespacelabs/sdk` |
| `lambda-microvm` | `LAMBDA_MICROVM_IMAGE` + AWS credentials | SDK `@aws-sdk/client-lambda-microvms`, plus execd (templates/aws-lambda-microvm) |
| `thunder` | `TNR_API_TOKEN` | REST api.thundercompute.com:8443/v1, plus system `ssh` |
| `exedev` | `EXE_API_TOKEN` (minted with `generate-api-key --cmds=new,ssh,rm,ls`) | REST `POST exe.dev/exec` |
| `nanite` | `NANITE_API_KEY` | REST api.nanite.run/v1 |
| `render` | `RENDER_API_KEY`, `RENDER_WORKSPACE_ID` | REST api.render.com/v1 + per-sandbox connect tokens |
| `quave` | `QUAVEONE_USER_TOKEN`, `QUAVEONE_ACCOUNT_ID`, `QUAVEONE_APP_ID`, `QUAVEONE_SANDBOX_TEMPLATE_ID` | REST api.quave.cloud/api/public/v1 |
| `beam` | `BEAM_TOKEN`, `BEAM_WORKSPACE_ID` | SDK `@beamcloud/beam-js` |
| `mosaic` | `MOSAIC_API_TOKEN` | REST sandbox.mosaicos.com/v1 |
| `nodus` | `NODUS_API_KEY`, `NODUS_PROJECT` | REST api.nodus-compute.ai/apis/nodus.dev/v1 |
| `cathedral` | `CATHEDRAL_API_KEY` | REST cathedral.computer/v1 |
| `dory` | `DORY_API_KEY` | REST api.dory.run/v1 + data.dory.run |
| `superserve` | `SUPERSERVE_API_KEY` | REST api.superserve.ai + sandbox.superserve.ai (per-sandbox access token) |
| `eqvps` | `EQVPS_API_KEY` | REST api.eqvps.com/api/v1/eqvps |
| `solari` | `SOLARI_API_KEY` | REST api.getsolari.com (exec and signed file URLs; no WebSocket) |
| `pilldrops` | `PILLDROPS_API_KEY` | REST pilldrops.com/v1 |
| `langsmith` | `LANGSMITH_API_KEY` (`LANGSMITH_ENDPOINT` for EU, `LANGSMITH_WORKSPACE_ID` for org keys) | REST api.smith.langchain.com/api/v2/sandboxes + each sandbox's data plane |
| `miosa` | `MIOSA_API_KEY` | REST api.miosa.ai/api/v1 |
| `openci` | `OPENCI_URL`, `OPENCI_TOKEN` | REST /v1/sandboxes |
| `opensandbox` | `OPEN_SANDBOX_DOMAIN`, optional `OPEN_SANDBOX_API_KEY` | REST /v1/sandboxes + execd in the sandbox |
| `docker` | none (`SBR_DOCKER=0` turns it off) | `docker` CLI |

Provider SDKs are optional peer dependencies, loaded only when that provider is used:
`npm install sandboxrouting e2b modal` installs the router plus two providers. A provider
whose key is set but whose SDK is missing is skipped with an install hint.

## How a provider is chosen

A **routing strategy** makes the choice, and you can switch it. The hard rules come first
and are the same under every strategy, so no strategy can route around them. `sbr route`
prints the ranked plan and why each provider sits where it does. `sbr route --compare`
prints the plan under every strategy. The full design is in [docs/routing.md](docs/routing.md).

| Strategy | Order |
|---|---|
| `free-first` (default) | Lanes: monthly free usage (the most at risk before its reset goes first), one-time credit (the largest share left goes first), your own hardware, then paid (cheapest first). |
| `cheapest` | Any free usage by price, then your hardware, then paid by price. |
| `balanced` | The `free-first` lanes. Within a free lane, a weighted score of free value, health, speed, free headroom and load (weights in config). In the paid lane, price comes first. |
| `fastest` | Unbilled first, then paid. Within each, the shortest expected time to a ready box: median create latency ÷ success rate. A provider never tried gets one try. The one strategy that pays more for speed. |
| `spread` | The `free-first` lanes. Within a free lane, the most free slots first (lowest live/cap, fewest recent creates), so fan-out doesn't trip one provider's rate limit. In the paid lane, price comes first. |

You pick a strategy three ways:

- in config, with `"routing": { "strategy": "balanced" }`;
- per request, with `strategy: "fastest"` (`--strategy`);
- by registering your own with `router.registerStrategy({ name, description, rank })`.

Within a lane, `priority` in config breaks ties first. The lanes keep paid usage **off by
default**: with `allowPaid: false` nothing is ever billed, and a request no free tier can
take fails with the reason for every provider. You can turn paid usage on globally or per
provider. With `maxPaidUsdPerMonth` set, paid routing stops when the month's spend
reaches it. Your own hardware (openci, OpenSandbox, local Docker) goes after the free lanes. With
`selfHosted: "first"` it goes ahead of them, and with `"never"` it's removed.

A provider is left out when:

- it has no key, or it is disabled;
- it lacks a capability in `needs` (`ports`, `pause`, `customImage`, `gpu`, `snapshot`,
  `extendTimeout`, `fileList`);
- it can't run the requested `image`;
- the timeout is over its maximum;
- `execTimeoutSec` is over its per-command cap (exe.dev cuts commands off at 30 s);
- its isolation is weaker than `minIsolation` (`container` < `gvisor` < `microvm`/`vm`);
- its circuit is open (see below);
- neither free nor paid usage can take the request. Free fails when:
  - the tier is used up;
  - what's left won't cover the whole request;
  - its concurrency is full;
  - the timeout is over the free lifetime cap.

  Paid fails when it isn't allowed, or when the month's budget won't cover the whole
  request.

Live sandboxes **reserve** what they can still spend: until their deadline, at their own
size. So a free tier takes a request only if, after those reservations, it covers the full
timeout at the size the provider will create. A paid request needs the same from the
budget. Extending a sandbox (`sbr extend`) or resuming one reserves the time it adds under
the same rule, or is refused. With `allowPaid: false`, no sandbox can run past its free tier,
and `maxPaidUsdPerMonth` is a hard cap.

The router re-checks the provider under the ledger lock when reserving. A request planned
as free that loses the last free slot or credit to a parallel request moves on to the next
provider. It never quietly becomes paid.

If the chosen provider refuses, the router tries the next one, and the refusal changes what
it does next:

| Refusal | What happens next |
|---|---|
| 402 or "out of credit" | The free tier is marked used up until the monthly reset. Other grants are checked again after 1 day, then 2, then 4, then weekly while they keep refusing. When a mark lapses, one request checks whether the tier is back while the others skip it; a free create that works clears the mark. |
| 429 | The provider is cooled down for a minute. |
| 401 or 403 | The provider is skipped for 10 minutes. |
| Network errors and 5xx | The router moves on to the next provider. Three in a row open the provider's **circuit**: it is skipped for 2 minutes. The cooldown doubles with each further failure, up to 30. Then one request probes it. |

`sandbox.route` records every provider tried or skipped and why. `sbr providers` shows each
provider's health: the success rate of recent creates and the circuit state. This health
is computed from the last 50 outcomes whenever it is read, and `sbr reset <provider>`
clears it.

### Metering

No provider has an API that reports remaining free credit, which the research for this
router confirmed. So the router meters locally. Every sandbox's running time is recorded as
billing segments. Pausing closes a segment. A sandbox past its deadline is billed only up to
the deadline. Cost is running time × (vCPU × vCPU price + GiB × GiB price), using the
provider's prices or yours.

Usage outside the router (the provider's console, another tool) isn't seen. For a one-time
credit you have already spent part of, set `usedBeforeUsd`. If a provider refuses for quota
anyway, the mark above catches it. Vercel bills CPU only while it is active, so metering it
by wall clock is conservative: the router stops using Vercel's free tier before Vercel
would.

## Jobs: work that moves between boxes

A sandbox can die, its provider can refuse, or a free tier's limits can end it: a lifetime
cap (E2B's free hour, Vercel's 45 minutes), running out of credit, the provider failing. A
**job** keeps going through all of that. It is ordered steps plus a working directory. The
workdir is checkpointed after each step, so the job continues on another box from where it
stopped.

```ts
const job = await router.jobs.run({
  sandbox: { image: "python:3.12-slim" },          // routed like router.create
  files: { "main.py": "print('hi')" },             // the initial workdir ($HOME/work)
  setup: [{ run: "pip install -q requests" }],     // runs again on every new box
  steps: [
    { run: "python main.py > out.txt" },
    { run: "curl -fsS -X POST https://hooks.example/done", idempotent: false },
  ],
});
console.log(job.state, job.migrations, job.placements.map((p) => `${p.provider}:${p.endReason}`));
```

- **Planned moves.** Before each step the job checks the box. If the box can't fit the next
  step, the job extends it when the provider allows that within the free lifetime cap;
  otherwise it moves. It also moves when the free credit won't cover the step and another
  provider ranks first, when a quota or auth refusal or an open circuit hits the box's
  provider, and, with `rebalance`, off a paid box when a free one is available.
- **Unplanned losses.** If a box vanishes, its provider refuses, or errors repeat, the job
  moves to a new box and restores the last checkpoint. The step that was running runs
  again, but only if it is `idempotent` (the default). Steps with outside effects are
  marked `idempotent: false`, so the job fails rather than run them twice. A non-zero exit
  is the step's own failure unless it has `retries`. Exit 137 can move the job to a box
  with twice the memory (`growMemoryOnOom`).
- **Crashes.** The process driving a job holds a lease. If it dies, the job reads as
  `orphaned` after 60 s, and `sbr job resume <id>` (or `sbr serve`, every 5 minutes)
  continues it from what the ledger recorded.
- **Waiting.** When no provider can take the job now, it waits only if a reason lapses
  within `maxWaitSec`: a rate-limit mark, a circuit, or a full free tier whose next
  sandbox ends soon. Otherwise it fails at once with every provider's reason.

Checkpoints live in `~/.sandboxrouting/checkpoints/` and are checked by SHA-256. When the
job ends, the last one is the result: `sbr job download <id>` saves it.
`router.move(id)` does the same move once for an interactive sandbox: it copies the workdir
to a new box, then kills the old one. The design and every decision table are in
[docs/routing.md](docs/routing.md).

## The four surfaces

All four share one ledger (`~/.sandboxrouting/ledger.json`; `SBR_HOME` moves it). It is
locked for every update and written whole, so the CLI, the REST server and an MCP server
running at once agree on what is live and what is spent.

**SDK:** `create`, `connect(id)`, `list`, `kill`, `status`, `plan`, `sweep`, `move(id)`,
`strategies()`, `registerStrategy(s)`, and `jobs` (`run`, `submit`, `resume`, `get`, `list`,
`cancel`, `workspace`, `sweep`). A sandbox has:

- `commands.run(cmd, {cwd, env, timeoutSec, onStdout, onStderr})`
- `files.read`, `files.readBytes`, `files.write`, `files.list`
- `getUrl(port)`, `setTimeout(sec)`, `pause()`, `resume()`, `kill()`

`connect("e2b:abc123")` adopts a sandbox created outside the router.

**CLI:** `sbr --help`.

```bash
sbr providers                 # free-tier status, health and circuit of every provider
sbr check                     # live create/exec/files/kill on every configured free provider
sbr route --needs ports       # where a sandbox would go, and why the others were skipped
sbr route --compare           # the same request under every strategy
sbr strategies                # the strategies, and which one is active
sbr run -- python3 -c 'print(42)'          # create, run, kill; exit code passes through
id=$(sbr create --image node:22 --timeout 900 --strategy fastest)
sbr exec "$id" -- npm test
sbr move "$id"                # copy its workdir to a new box, kill the old one
sbr kill "$id"
sbr job run --step "make" --step "make test"   # steps that survive losing a box
sbr job status <job-id>       # where it ran, why it moved, how each step ended
sbr job download <job-id>     # the final workdir, as a .tgz
```

**REST API:** `sbr serve --port 8787`. Set `serverToken` in config (or `SBR_SERVER_TOKEN`)
to require `Authorization: Bearer …`. The endpoints are listed at the top of
[src/server/http.ts](src/server/http.ts): `POST /v1/sandboxes`,
`POST /v1/sandboxes/{id}/exec`, `GET|PUT /v1/sandboxes/{id}/files?path=`,
`GET /v1/providers`, `POST /v1/route[?compare=1]`, `GET /v1/strategies`,
`POST /v1/sandboxes/{id}/move`, and the jobs: `POST /v1/jobs` (202 with the job's id; `?wait=1`
to wait for the end), `GET /v1/jobs[/{id}]`, `POST /v1/jobs/{id}/resume|cancel`,
`GET /v1/jobs/{id}/workspace`. Every 5 minutes the server reconciles with the providers,
reaps boxes left behind by finished jobs, and resumes orphaned jobs. `POST /v1/sweep` does it
on demand and returns `{ sandboxes, jobs }`.

**MCP server:** `sbr mcp` (stdio). Its tools are `list_providers`, `list_strategies`,
`create_sandbox`, `run_command`, `read_file`, `write_file`, `list_files`, `get_url`,
`set_timeout`, `move_sandbox`, `list_sandboxes`, `kill_sandbox`, and for jobs `run_job`,
`job_status`, `list_jobs`, `resume_job` and `cancel_job`. `run_job` waits up to `waitSec`,
then returns the job's id to poll with `job_status`. For Claude Code:

```bash
claude mcp add sandboxes -- node /path/to/sandboxrouting/dist/cli.js mcp
```

Once the package is published, `npx sandboxrouting mcp` works the same way.

## Configuration

`./sandboxrouting.json`, else `~/.sandboxrouting/config.json`, or the path in `SBR_CONFIG`.
Every field is optional. See [sandboxrouting.example.json](sandboxrouting.example.json):

```jsonc
{
  "routing": { "strategy": "free-first" },   // cheapest | balanced | fastest | spread | yours
  "allowPaid": false,              // SBR_ALLOW_PAID=1 for one run
  "maxPaidUsdPerMonth": 10,
  "selfHosted": "after-free",      // "first" | "after-free" | "never"
  "defaults": { "timeoutSec": 300 },
  "providers": {
    "e2b": { "usedBeforeUsd": 12.5 },
    "daytona": { "freeTier": { "kind": "monthly-credit", "usd": 200 }, "priority": 10 },
    "modal": { "options": { "ports": [8080] } },
    "docker": { "isolation": "gvisor" },     // when Docker runs with runtime runsc
    "fly": { "enabled": false }
  },
  "jobs": { "maxMigrations": 5, "maxWaitSec": 300, "rebalance": false }
}
```

`routing` also takes `weights` for `balanced` and `circuitBreaker` settings. `jobs` takes
the checkpoint mode, limits and timeouts. Both are documented in
[docs/routing.md](docs/routing.md#4-configuration-reference). `policy` still works as the
old name for `routing.strategy`.

`sbr reset <provider>` clears a provider's quota, rate-limit and auth marks, and its health
history, after you top up or fix a key.

## Adding a provider

A provider is one file. Only `create`, `exec` and `kill` are required. The router
implements file read, write and listing on top of `exec` (base64 in chunks, so binary is
safe), and an adapter that can do better adds the native calls.

```ts
// src/providers/acme.ts
import { defineProvider, httpJson } from "./util.js";

export const acmeProvider = defineProvider({
  info: {
    id: "acme",
    name: "Acme Sandboxes",
    homepage: "https://acme.dev",
    env: ["ACME_API_KEY"],
    capabilities: ["customImage"],
    freeTier: {
      tier: { kind: "monthly-credit", usd: 10 },
      concurrency: 5,
      source: "https://acme.dev/pricing",
      checked: "2026-11-11",
    },
    pricing: { vcpuSecondUsd: 0.00001, gibSecondUsd: 0.000003, defaultCpu: 1, defaultMemoryMiB: 1024 },
  },
  async create(spec, ctx) {
    const s = await httpJson<{ id: string }>("https://api.acme.dev/v1/sandboxes", {
      headers: { authorization: `Bearer ${ctx.env.ACME_API_KEY}` },
      body: { image: spec.image, timeout: spec.timeoutSec, env: spec.env, metadata: spec.metadata },
    });
    return { providerSandboxId: s.id };
  },
  async exec(id, command, opts, ctx) { /* … */ return { stdout: "", stderr: "", exitCode: 0 }; },
  async kill(id, ctx) { /* … */ },
});
```

Then add it to [src/providers/index.ts](src/providers/index.ts), or call
`router.register(acmeProvider)` from your own code. To finish:

- Add `listAlive` so `sbr sweep` can close sandboxes that died behind the router's back.
- If the provider keeps a sandbox alive past the requested timeout, set
  `enforcesTimeout: false` in `info`. The router then deletes it at the deadline.
- Make `create` throw errors with an HTTP `status`, so quota (402) and rate limits (429)
  fail over correctly.
- Run the tests: `test/providers.test.ts` checks that every built-in declares its
  free-tier source and backs each capability it claims.

## Providers with extra setup

- **Cloudflare** has no hosted sandbox API: a sandbox is a Durable Object plus the
  Container it starts, inside your own Worker. Deploy the bridge in
  [templates/cloudflare-worker](templates/cloudflare-worker) (`npm install`, then
  `npx wrangler secret put SANDBOX_TOKEN` and `npx wrangler deploy`). Then set
  `CLOUDFLARE_SANDBOX_URL` to the Worker's URL and `CLOUDFLARE_SANDBOX_TOKEN` to the same
  secret. The bridge uses `@cloudflare/sandbox` 1.x and destroys each container at its
  deadline with a Durable Object alarm. The sandbox size is the `instance_type` in
  `wrangler.jsonc`.
- **No timeout of their own.** These providers don't stop a sandbox at the requested
  timeout:
  - Fly Sprites, Celesto, BoxLite, Dedalus, CreateOS, exe.dev and Agent37 have no TTL.
  - A Northflank service restarts its container when it exits.

  Their adapters declare `enforcesTimeout: false`, so the router deletes the sandbox at
  the deadline itself. `sbr sweep` (run every 5 minutes by `sbr serve`) deletes any it
  missed.
- **AWS Lambda MicroVMs** have no exec API. Build the image in
  [templates/aws-lambda-microvm](templates/aws-lambda-microvm): its dependency-free
  `execd.mjs` runs commands and moves files behind the VM's endpoint. Then set
  `LAMBDA_MICROVM_IMAGE` to the image ARN.
- **Thunder Compute** runs commands over SSH only. The adapter generates a throwaway key,
  gets a certificate from the API, and uses the system `ssh` and `ssh-keygen`. Sandbox
  access is enabled through Thunder's sales team.
- **exe.dev** has one API endpoint, `POST /exec`, which takes SSH command text and cuts
  each call off at 30 seconds. Mint a token that may run `new`, `ssh`, `rm` and `ls`.
- **Access gates:** Dedalus Machines needs beta access (403 until admitted), and Quivvo
  puts new free accounts in a queue.
- **Together and Morph** boot from snapshots. When you give an `image` (or nothing), the
  adapter builds the snapshot once per image or size and reuses it. A `template`
  (`--template together=<alias>`) skips that step.
- **Fly Machines** needs an app you own (`FLY_APP`).
- **Northflank** needs a project (`NORTHFLANK_PROJECT`).

## Checking providers live

Each cloud adapter is type-checked against that provider's real SDK. The HTTP-only adapters
(`cloudflare`, `sprites`) are tested against servers that speak their wire formats. A live
run still needs your keys: set them, then run

```bash
sbr check                      # every configured provider that has free usage left
sbr check --provider koyeb     # a paid-only provider runs only when you name it
```

Each provider gets one small sandbox: it runs a command, writes, reads back and lists a
file, then kills the sandbox. The check prints `ok` or the provider's own error.

## Development

```bash
npm install
npm run lint         # ESLint over the whole repository (each check runs through hushrun)
npm run typecheck    # adapters are checked against the real provider SDK types
npm test             # the Docker ones run real containers when Docker is up
npm run simulate     # compare the routing strategies on a simulated month
npm run build && node dist/cli.js providers
```

CI runs lint, typecheck and the tests through [hushrun](https://hushrun.com), which skips
what this exact code already passed: a test file that passed on the exact files it read
doesn't run again. See [CONTRIBUTING.md](CONTRIBUTING.md) to send a change, and
[SECURITY.md](SECURITY.md) to report a vulnerability.

## Providers' names and terms

sandboxrouting isn't affiliated with or endorsed by any provider it supports. Their names
are trademarks of their owners. Free tiers and prices are as each adapter's `source` page
said on its `checked` date, and they change: check a provider's own terms before you rely
on them, and override them in config (`providers.<id>.freeTier`, `pricing`) when yours
differ.

## License

[MIT](LICENSE)
