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

108 providers are built in: 105 cloud providers plus your own hardware (openci, OpenSandbox,
local Docker). One of them, `runloop`, is [off by default](#off-by-default). Terms were checked
on 2026-11-11 or 2026-11-12 against each provider's pricing page, which its adapter links, and
those that had changed, or were added since, on 2026-11-21 (each adapter's `checked` date says
which). Terms change, so you can override any of them in config.

The 17 added on 2026-11-12 (`tensorlake`, `buddy`, `boxd`, `maritime`, `promigence`, `zode`,
`boxcompute`, `lizard`, `munito`, `nanite`, `render`, `quave`, `beam`, `mosaic`, `nodus`,
`cathedral`, `dory`) are written from each provider's published API and tested against local
servers that speak it. None has been run against the real service yet. Nor has `opensandbox`
(added 2026-11-14), written from OpenSandbox's OpenAPI specs and its JS SDK, nor the 59 added on
2026-11-21 (`groundbox`, `briq`, `kubi`, `orble`, `runtime`, `digitalocean`, `docker-cloud`,
`novita`, `smol`, `isorun`, `instavm`, `prized`, `zipbox`, `superserve`, `eqvps`, `solari`,
`pilldrops`, `langsmith`, `miosa`, `cloudrun`, `gke-agent-sandbox`, `azure-sandboxes`,
`agentbay`, `tencent`, `volcengine`, `railway`, `vers`, `oblien`, `runta`, `stateset`,
`saas-sandbox`, `sandbox0`, `watasu`, `keln`, `mandala`, `platinum`, `inngest`, `archil`,
`openpond`, `gmi`, `openreward`, `baseten`, `chalk`, `voidrun`, `kosa8`, `primeintellect`,
`sandboxer`, `workpaper`, `rayrun`, `tama`, `tangle`, `nirvana`, `agental`, `cyqle`, `machine0`,
`hyperbrowser`, `lightcone`, `offstage`, `islo`), written the same way from each provider's
docs, OpenAPI spec or official SDK and checked against its pages that day.

Some of those speak another provider's API or reach theirs indirectly. `novita`, `tencent` and
`volcengine` speak E2B's API and share the `e2b` adapter's code; `nirvana` serves OpenSandbox's
API and shares the `opensandbox` adapter's code. `chalk`, and `primeintellect`'s commands, speak
the Connect protocol's JSON form to services whose SDKs speak gRPC; `tama` and
`gke-agent-sandbox`'s commands speak gRPC-Web. `openreward` speaks a session API known only from
its SDK, and `machine0` has no REST API: its adapter calls the tools of machine0's MCP server
over HTTP. The big clouds (`cloudrun`, `gke-agent-sandbox`, `azure-sandboxes`, `agentbay`,
`tencent`, `volcengine`, `railway`) need some console setup first, described in
[docs/providers-iam.md](docs/providers-iam.md).

### Free every month

| id | Free usage | Free limits | Paid after | Isolation |
|---|---|---|---|---|
| `modal` | $30 / month | 100 concurrent, 24 h | ~$0.19/h (2 vCPU, 2 GiB) | gVisor |
| `northflank` | $20 / month | 2 sandboxes | ~$0.017/vCPU-h | container |
| `freestyle` | 200 vCPU-h + 400 GiB-h (≈ $13) | 10 concurrent | $0.040/vCPU-h | microVM |
| `vercel` | 5 CPU-h + 420 GB-h (≈ $9.5) | 10 concurrent, 45 min | $0.128/vCPU-h (active CPU only) + $0.0212/GB-h | Firecracker |
| `instabox` | one 4 vCPU / 8 GiB machine, always free[^1] | 1 machine, 8 h per run | $0.004/vCPU-h | Firecracker |
| `upstash` | 5 CPU-hours | 10 concurrent, 2 vCPU / 4 GB | $0.05/vCPU-h (active CPU only), memory free: $0.10/h for 2 vCPU / 4 GB busy | container |
| `cloudflare` | 375 vCPU-min + 25 GiB-h (≈ $0.68) with Workers Paid ($5/mo) | — | $0.072/vCPU-h (active CPU only) + $0.009/GiB-h; 2 vCPU comes with 8 GiB, ≈ $0.22/h busy | container |
| `tensorlake` | one 1 vCPU / 1 GB sandbox, always free | 1 sandbox, 1 h (2 h once verified) | $0.07/vCPU-h (active CPU only, 20% minimum) + $0.015/GB-h | Firecracker |
| `fly` | $5 / month shared with `sprites` (counted as $2.50 each[^2]; card required) | 3 machines | ~$0.035/h (2 shared vCPU / 4 GB) | Firecracker |
| `sprites` | $5 / month shared with `fly` (counted as $2.50 each[^2]; card required) | 3 Sprites | $0.0385/vCPU-h (active CPU only) + $0.021875/GB-h; idle Sprites are free | Firecracker |
| `solari` | $3 / month | 1 sandbox, 1 h | $0.171/h (2 vCPU / 4 GB) | Cloud Hypervisor |
| `langsmith` | 8 LSU / month ($8, ≈ 42 h) | 10 sandboxes | $0.189/h (2 vCPU / 4 GiB) | Firecracker[^3] |
| `miosa` | $1 / month | 5 sandboxes | $0.0893/h (2 vCPU / 4 GB) | Firecracker |
| `cloudrun` | 240k vCPU-s + 450k GiB-s (≈ $5.22; billing account) | Preview; needs the execd image | $0.158/h (2 vCPU / 4 GiB) | gVisor[^4] |
| `azure-sandboxes` | 180k vCPU-s + 360k GiB-s (≈ $5.40)[^4] | 2 vCPU / 4 GiB is tier L | $0.216/h (2 vCPU / 4 GiB) | microVM |
| `archil` | 1 vCPU-h + 2 GiB-h (≈ $0.095), no card | 5 concurrent, 30 min sessions, egress allowlist | $0.055/vCPU-h + $0.020/GiB-h | Firecracker |
| `agental` | $5 / month (card required) | 2 small at once until the first top-up; tiny and small only | $0.027/h (2 vCPU / 4 GiB) | VM |
| `cyqle` | 60 min a day (counted as 30 h a month), no card[^5] | 1 desktop, 1 vCPU / 1 GB, 60-minute sessions | $0.04/h pay as you go (2 vCPU / 4 GB), or $12/mo per desktop | not published[^6] |
| `islo` | included in a plan from $20/mo (counted as one Machine's month)[^5] | usage limits unpublished | ≈ $0.027/h (the $20 plan over a month) | microVM |

### One-time credit

| id | Free usage | Free limits | Paid after | Isolation |
|---|---|---|---|---|
| `daytona` | $200[^7] | 10 vCPU total | $0.050/vCPU-h | container |
| `blaxel` | up to $200[^7] | 10 concurrent, 7 days | $0.041/GB-h (memory only) | microVM |
| `e2b` | $100 | 10 concurrent, 1 h | $0.050/vCPU-h | Firecracker |
| `tenki` (Luxor Agent Cloud, was Tenki) | $100 when you first add a card | 5 concurrent | $0.050/vCPU-h | microVM |
| `boxlite` | $100 when you add a card[^7] | per plan | $0.050/vCPU-h | microVM |
| `dedalus` | $20 (beta access needed) | — | rates unpublished (estimate $0.05/vCPU-h) | Cloud Hypervisor |
| `createos` | ~$5 (500 credits)[^7] | 1 sandbox, 1 vCPU / 1 GB | $0.036/vCPU-h | Firecracker |
| `quivvo` | $5 (signup queue) | 1 machine | $0.005/vCPU-h (shared) | Firecracker |
| `celesto` | $5, expires after 30 days | 1 sandbox | $0.015/h (1 vCPU / 2 GB) | Firecracker |
| `agent37` | $5 (card required) | 3 awake | $0.0011/vCPU-h | gVisor |
| `boat` | 25 trial hours (≈ $0.45; card required) | 2 concurrent, 2 h | $0.018/h (2 vCPU / 4 GB) | VM |
| `boxd` | €30 (counted as $32.97; card likely required) | 50 machines | €0.039/vCPU-h (active CPU only) + €0.012/GiB-h | KVM microVM |
| `maritime` | $20 trial cap, 7 days (card required) | 24 h | $0.022/h (2 vCPU / 4 GB) | Firecracker |
| `promigence` | $100 (card and expiry not stated) | 20 concurrent, 1 h | $0.166/h (2 vCPU / 4 GiB) | not published[^6] |
| `zode` | $10, no card | 2 running, 55 s per command | $0.0175/h (2 vCPU / 4 GB) | Cloud Hypervisor |
| `boxcompute` | $5, expires after 14 days | 2 running | $0.05/h (0.5 vCPU / 1 GiB) | VM |
| `lizard` | $5, 7-day trial (card required) | 1 Small running, 1 h | $0.0162/h (2 vCPU / 4 GB) | Firecracker |
| `munito` | $0.90, 7-day trial (card required) | 2 concurrent, 2 h | $0.018/h (2 vCPU / 4 GiB) | microVM |
| `buddy` | $5 for 14 days (card required) | — | $0.0144/vCPU-h + $0.0144/GB-h | VM |
| `groundbox` | $5 (no card; 3,000 CI min a month too)[^7] | 2 concurrent, 2 vCPU / 4 GB, 1 h until a card | $0.04/vCPU-h, memory included | Firecracker |
| `briq` | €10 (counted as $10.99; no card) | 5 at once, up to medium (2 vCPU / 4 GB) | €0.03/h (2 shared vCPU / 4 GB); free asleep | Firecracker |
| `runtime` | $5 in a 7-day Pro trial (card required) | 100 vCPUs at once | $0.03/vCPU-h (active CPU only) + $0.008/GB-h; $25/mo plan | Firecracker |
| `docker-cloud` | $250 promotional credit (card required) | 10 concurrent, 24 h | $0.07/vCPU-h, memory included | microVM |
| `novita` | $100 after a short survey, no card | 5 concurrent, 1 h, 2 vCPU / 4 GiB | $0.035/vCPU-h + $0.0115/GiB-h | not published[^6] |
| `smol` | $100, no card | 4 running, 4 vCPU each | $0.05/vCPU-h (active CPU only) + $0.0162/GB-h used + a $0.04/h base | microVM |
| `isorun` | $50, no card | — | $0.025/vCPU-h + $0.015/GiB-h | microVM |
| `instavm` | $50 (card on file) | 5 active | $0.050/vCPU-h + $0.016/GB-h | microVM |
| `prized` | $30, no card | 10 at once, 2 vCPU / 4 GB, 60 min of running | $0.04/vCPU-h + $0.0125/GB-h | Firecracker |
| `zipbox` | $25 for a $5 top-up (counted as $20; card required) | 250 box names ever[^8] | $0.0137/h (2 vCPU / 4 GB) | not published[^6] |
| `pilldrops` | $5 (no card) | 5 concurrent, 4 h, 2 vCPU / 2 GB | $0.13/h (2 vCPU / 2 GB) | container[^9] |
| `railway` | $5, expires after 30 days (no card) | 10 running, 2 vCPU / 2 GB, 5 idle minutes | $0.069/vCPU-h (active CPU only) + $0.069/GB-h | VM |
| `vers` | $5 ($50 more with a card)[^7] | — | $0.04/vCPU-h + $0.01/GiB-h; asleep, only disk is billed | VM |
| `runta` | $50, no card[^7] | 32 vCPU / 64 GiB across runtimes on the trial | $0.0504/vCPU-h + $0.0162/GiB-h | not published[^6] |
| `stateset` | $25 trial (card required) | Hobby: 10 at once, 45 min | $0.0746/h (2 vCPU / 4 GB dedicated, billed at 50% of allocation)[^10] | gVisor |
| `saas-sandbox` (Sandbox as a Service) | $5, no card | 20 at once, 24 h, 10 min per command | $0.09/h (2 vCPU / 4 GB) | VM |
| `sandbox0` | $5 (card required) | 20 running | $0.015/GiB-h (memory only; CPU follows memory) | gVisor |
| `voidrun` | ₹4,600 (counted as $49.64; no card)[^7] | 300 s per command; sleeps after 60 idle seconds | ₹3.71/vCPU-h (active CPU only) + ₹1.19/GB-h (≈ $0.040 + $0.0129) | microVM |
| `workpaper` | one free hour (counted as $0.01, no card) | 4 running; India only; no incoming ports | $0.010/h (2 vCPU / 4 GB) on Pro ($15/mo, all credit); $0.033/h pay as you go | VM |
| `rayrun` | ¥50 (≈ $7.04)[^11] | — | $0.014/h (2 vCPU / 4 GiB, ¥0.10)[^11] | microVM |
| `hyperbrowser` | $5 (5,000 credits), no card | 1 concurrent session | $0.045/vCPU-h + $0.015/GiB-h ($0.15/h at 2 vCPU / 4 GiB) | Firecracker |
| `offstage` | $5, no card (prepaid: each create reserves its timeout) | macOS only (`os: "macos"`), 24 h, 30 min per command | $1.10/h per sandbox | macOS user account[^12] |

### Paid only

| id | Price | Notes | Isolation |
|---|---|---|---|
| `koyeb` | $0.0144/h per vCPU, 1 GB each included ($0.0288/h for 2 vCPU / 2 GB) | | microVM |
| `morph` | $0.05/vCPU-h | free credit disputed[^13] | VM (memory snapshots) |
| `together` | $0.045/vCPU-h | custom plans | Firecracker |
| `depot` | $0.18/vCPU-h (CPU only) | 7-day trial | microVM |
| `namespace` | $0.09/h per vCPU + 2 GB | 3 h max; a 30-day trial (no card) isn't counted | microVM |
| `lambda-microvm` | $0.10/vCPU-h + $0.013/GB-h | needs the execd image | Firecracker (ARM64) |
| `thunder` | $0.051/vCPU-h | access through sales; exec over SSH | Firecracker (GPUs) |
| `exedev` | $0.105/h (2 vCPU + 4 GiB) on top of a plan | 30 s per command | VM |
| `nanite` | $0.072/vCPU-h (active CPU only) + $0.0432/GB-h | fixed size; stops after 30 idle seconds | microVM |
| `render` | $0.12/vCPU-h (active CPU only) + $0.019/GB-h | beta; no public URLs yet | Firecracker |
| `quave` | $0.03125/h per zCloud (0.5 vCPU + 0.5 GB), as many as the larger of CPU or memory needs: $0.25/h for 2 vCPU / 4 GB | enabled per account; size and image come from a template | gVisor |
| `beam` | $0.05/vCPU-h + $0.01/GiB-h | $20/mo plan includes $20 of credit | container |
| `mosaic` | $0.05/h per 2 vCPU / 4 GiB | free while hibernated | Firecracker |
| `nodus` | $0.0357/h (2 vCPU / 4 GiB) | prepaid; no outbound network unless asked | gVisor-style |
| `cathedral` | $0.01/h (2 vCPU / 4 GiB) | prepaid; 24 h max; files under /work; asleep, only disk is billed | confidential VM, shared[^14] |
| `dory` | $0.0288/h (2 shared vCPU / 4 GB) | prepaid; 10 min per command | VM |
| `kubi` | $0.035/h (4 vCPU / 8 GB, the only size) | private beta, accounts approved by hand; credit needs a $20/mo persistent screen first | VM |
| `orble` | $0.015/h (2 vCPU / 4 GiB) | prepaid; 10 min per command; free while suspended | VM |
| `digitalocean` | $0.044/vCPU-h (active CPU only) + $0.0095/GB-h | prepaid; 4 min per command; files only under /workspace | microVM |
| `superserve` | $0.166/h (2 vCPU / 4 GiB) | a free trial of unpublished size, no card | Firecracker |
| `eqvps` | $0.132/h (2 vCPU / 4 GB) | prepaid in crypto; 20 at once, 24 h max | Firecracker |
| `gke-agent-sandbox` | $0.109/h (2 vCPU / 4 GiB, Autopilot pod rate) | your cluster with agent-sandbox, a warm pool and the sandbox-router[^4] | container (the warm pool's runtime) |
| `agentbay` | $0.0992/h (2 vCPU / 4 GB) | free Basic plan, but compute is billed; 50 s per command | not published[^6] |
| `tencent` | $0.13/h (2 vCPU / 4 GiB, 0.94 CNY)[^11] | size set by a sandbox tool made in the console | microVM (Cube) |
| `volcengine` | $0.062/h (2 vCPU / 4 GB, 0.44 CNY)[^11] | size set by an E2B-compatible template; only the creating process reaches a sandbox | microVM |
| `oblien` | $0.03/vCPU-h (active CPU only) + $0.008/GiB-h | prepaid wallet; files move through exec (its file API is text-only) | Firecracker |
| `watasu` | €0.072/vCPU-h + €0.0144/GiB-h (≈ $0.22/h for 2 vCPU / 4 GiB) | prepaid balance needed to start; size from the template on the free Basic plan | not published[^6] |
| `keln` | $0.0504/vCPU-h + $0.0162/GiB-h ($0.166/h for 2 vCPU / 4 GiB) | prepaid; 3 running until the first top-up, 24 h max | microVM |
| `mandala` | $0.03/vCPU-h + $0.015/GB-h ($0.12/h for 2 vCPU / 4 GB), pay as you go | whole desktops; a plan or prepaid credits needed; ends 10 min at the earliest | VM |
| `platinum` | $0.0324/vCPU-h + $0.0108/GiB-h ($0.108/h for 2 vCPU / 4 GiB) | prepaid; new orgs capped at 2 vCPU / 2 GiB a sandbox; no TTL | Cloud Hypervisor |
| `inngest` | $0.0396/vCPU-h + $0.0108/GB-h ($0.1224/h for 2 vCPU / 4 GB) | beta, Pro plan and up; 1 h of runtime a sandbox, 5 min per command; REST taken from the SDK | microVM |
| `openpond` | $0.072/vCPU-h + $0.0234/GiB-h + disk ($0.24/h for 2 vCPU / 4 GiB) | free plan's monthly usage unpublished, not counted; one combined output stream | not published[^6] |
| `gmi` | $0.17/h (2 vCPU / 4 GiB; $0.0861 1 / 2, $0.34 4 / 8) | early access; size and image set by a template | not published[^6] |
| `openreward` | $0.0504/vCPU-h + $0.0162/GiB-h ($0.1656/h for 2 vCPU / 4 GiB) | runs in an environment workspace made on openreward.ai; an idle session is reaped after about 15 min | container |
| `baseten` | $0.0655/vCPU-h + $0.0211/GiB-h ($0.2154/h for 2 vCPU / 4 GiB) | 10 at once; idle sandboxes go on standby (storage only) | not published[^6] |
| `chalk` | $0.0249/vCPU-h + $0.008/GiB-h preemptible ($0.082/h for 2 vCPU / 4 GiB) | preemptible by default; runs on the K8S compute class[^15] | container[^15] |
| `kosa8` | $0.15/h (2 vCPU / 4 GB), counted by vCPU | a plan first (from $29/mo with 100 sandbox-hours); hours past it in $15 packs | microVM |
| `primeintellect` | $0.02/vCPU-h + $0.0125/GiB-h ($0.09/h for 2 vCPU / 4 GiB; launch rates until 2026-12-22) | prepaid; first use of an image converts it to a VM image | microVM |
| `sandboxer` | $0.018/h (2 vCPU / 4 GB) | a plan first (from $20/mo, its dollars come back as machine time); 600 s per command | Cloud Hypervisor |
| `tama` | $0.0454/h (2 vCPU / 4 GB) | prepaid credit; GPU machines too; gRPC-Web API | VM |
| `tangle` | $0.049/h (2 vCPU / 4 GB), never below $0.04/h | prepaid credit; size set by the template | container (Docker or Firecracker, its choice) |
| `nirvana` | $0.048/h (2 vCPU / 4 GB) | you pay for the sandbox cluster's nodes, idle or not; needs a cluster made first | container (on per-customer VM nodes) |
| `machine0` | $0.052/h (2 vCPU / 4 GB) | prepaid; bills while stopped too, so pause suspends (image storage only); 5 min per command; MCP API only | VM |
| `lightcone` | $0.38/vCPU-h (active CPU only, 6.25% minimum) + $0.095/GiB-h | computer-use desktops; screenshots and clicks aren't exposed through the router | VM |

### Your own hardware

| id | Free usage | Isolation |
|---|---|---|
| `openci` | unlimited, on your workers | Firecracker / gVisor / Hyper-V |
| `opensandbox` | unlimited, on your Docker host or Kubernetes cluster | container (set `isolation` in config if your runtime is stronger) |
| `docker` | unlimited, on this machine | container |

### Off by default

`runloop` is built in but off: a `RUNLOOP_API_KEY` alone doesn't route there. Runloop is
winding down. Its docs say transition support for existing customers ended 2026-11-13, and on
2026-11-21 `api.runloop.ai` no longer resolved and platform.runloop.ai answered 503. If your
account still works, turn it on with `"runloop": { "enabled": true }`. Its terms when it was
last checked: $50 of one-time credit, 3 running, 48 h each, then $0.108/vCPU-h, VM isolation.

[^1]: InstaBox's free plan is never billed, but it says its "early allowance" can end. It's
    modelled as a month of hours for one machine.
[^2]: Fly's Free plan has one $5 a month for Machines and Sprites together, and the router
    meters each provider apart, so each counts $2.50: with both on, the two can't spend more
    than the $5. If you use only one, give it all: `"fly": { "freeTier": { "kind":
    "monthly-credit", "usd": 5 } }`.
[^3]: LangSmith documents Firecracker for its self-hosted sandboxes; its cloud pages say only
    "isolated". An LSU is $1; 8 LSU at 0.0576 LSU/vCPU-h + 0.01845 LSU/GiB-h is about 42 hours.
[^4]: Cloud Run sandboxes start only from inside a Cloud Run container, so each router sandbox
    is one Cloud Run instance (Preview) running
    [templates/cloud-run-sandbox](templates/cloud-run-sandbox), which runs commands in a sandbox
    with `sandbox exec`. Cloud Run claims gVisor, the weaker of its two generations. Azure says
    Container Apps Sandboxes bill like the Consumption plan but lists no sandbox meter, so its
    Consumption rates and free grant are used; Azure deletes a sandbox a day after it stops,
    paused ones included. `gke-agent-sandbox` runs in your own cluster: it's priced at GKE
    Autopilot's pod rate. On a cluster whose nodes you already pay for, set
    `"gke-agent-sandbox": { "pricing": { "vcpuSecondUsd": 0, "gibSecondUsd": 0 } }`.
[^5]: Cyqle and Islo sell plans. Cyqle's free plan gives one desktop 60 minutes a day; a paid
    desktop ($6 to $45 a month) has unlimited session time, so model it as usage included in the
    plan: `"cyqle": { "freeTier": { "tier": { "kind": "monthly-hours", "hours": 744 },
    "concurrency": 1 }, "options": { "slotId": "<slot>", "plan": "standard" } }`. Islo has no
    hourly rate: Machines are unlimited on every plan within usage limits it doesn't publish, so
    a plan is counted as one Machine's month of hours, and the paid rate is the $20 Engineer
    plan spread over that month.
[^6]: Promigence, Novita, Zipbox, AgentBay, Runta, Watasu, OpenPond, GMI Agentbox, Baseten and
    Cyqle don't say how their sandboxes are isolated, so a request with `minIsolation` skips
    them.
[^7]: The provider doesn't say whether the credit recurs, so it's treated as one-time, the safe
    reading.
[^8]: Zipbox names are permanent and an account may ever create 250, so its adapter reuses a
    pool of names (`options.pool`, default 32). Its docs don't pair tiers with sizes; `xs` to
    `l` are taken to be Tiny to Large.
[^9]: PillDrops' pricing page says each sandbox is a dedicated microVM, but its llms.txt says "a
    microVM (or container)", so the adapter claims `container`, the weaker.
[^10]: StateSet bills dedicated compute ($0.128/vCPU-h + $0.0106/GB-h on Hobby and Pro) at 50%
    of what is allocated, its estimate of average use, so the router counts half those rates.
    The Hobby plan's monthly allowance (5 vCPU-hours, 420 GB-hours) isn't counted as free usage.
[^11]: Tencent, Volcengine and Rayrun bill in yuan; their prices are converted at 7.1 CNY per
    USD, kept in `src/providers/currency.ts`.
[^12]: offstage cloud runs each sandbox as a macOS user account on a shared Mac Studio, wiped
    when it closes; other accounts' processes and localhost servers are visible, so the adapter
    claims `container`, the weakest level. It's the only macOS provider: only requests with `os:
    "macos"` go to it, and no other request does.
[^13]: Morph's own pages disagree (a 300 MCU starting credit vs none). If your account has it,
    set `"morph": { "freeTier": { "kind": "one-time-credit", "usd": 15 } }`.
[^14]: Cathedral's rooms share one AMD SEV-SNP VM and are kept apart by a container runtime it
    doesn't name, so the adapter claims `container`, the weakest.
[^15]: Chalk's SDK runs a command on its default host compute class only over a bidirectional
    stream, which fetch can't open, and on the K8S class through one unary call, so the adapter
    creates K8S-class sandboxes; one docs page says those don't support exec, which only a live
    run will settle. Chalk documents gVisor for its sandboxes but not for that class, so the
    adapter claims `container`. Non-preemptible work costs $0.0747/vCPU-h + $0.024/GiB-h.

Notes:

- boxd, briq and Watasu bill in euros. Their prices and free credit are converted at one rate,
  1.099 USD per euro (the ECB reference rate on 2026-11-20). VoidRun bills in rupees, converted
  at the ECB rates of that day (≈ 92.67 INR per USD). Both rates are kept in
  `src/providers/currency.ts`.
- A vCPU rate marked "active CPU only" is billed only while the CPUs are busy; memory is billed
  for every second the box runs. smol also bills a $0.04/h wall-clock base, which rides on its
  memory rate ($0.01 per GiB-hour over the default 4 GiB). See [Active-CPU
  billing](docs/routing.md#active-cpu-billing) for how the router ranks and meters them.
- Groundbox's pricing page says its CI minutes reset each month but not that the $5 does, so the
  $5 is treated as one-time. Its free credit can be exhausted by CI minutes as well.
- Superserve gives new accounts a free trial for their first sandbox without saying how much, so
  nothing is counted as free; set `freeTier` in config once you know your account's.
- Tenki is now Luxor Agent Cloud (tenki.cloud redirects to luxor.ai). The id stays `tenki`; the
  adapter reads `LUXOR_API_KEY` / `LUXOR_AUTH_TOKEN` / `LUXOR_API_ENDPOINT` as the SDK does, and
  the old `TENKI_*` names still work.
- Runta, Watasu, Archil and Northflank run commands only over a WebSocket. Their adapters speak
  it themselves (src/providers/websocket.ts, a small RFC 6455 client, so Node 20 works too),
  with the frames each official SDK uses, and use REST for everything else. Reaching
  a Watasu sandbox's data plane resets its deadline, so the adapter passes the time it has left
  and the router also deletes it at its deadline.
- Vers's newer docs create computers through a v2 operation API whose exec and file routes
  aren't documented; the adapter uses the v1 API its generated SDKs speak, which has no TTL, so
  the router deletes a Vers VM at its deadline.
- Inngest documents its sandboxes through its TypeScript SDK; the `inngest` adapter speaks the
  REST calls that SDK makes (read from `inngest` 4.26.2), which Inngest says may change during
  the beta. OpenPond likewise names `openpond-sdk` as the contract, and its adapter speaks that
  SDK's calls.
- Mandala, Platinum, Archil, Inngest and OpenPond stop or pause a sandbox at its deadline
  instead of deleting it (Platinum has no deadline at all), so the router deletes those at the
  deadline.

### Not built

| Provider | Why |
|---|---|
| AWS Nitro Sandboxes | It has no sandbox API. It's an EC2 feature: Firecracker on a Nitro Enclaves parent instance, or `ISOLATED_SANDBOX` tasks in ECS/EKS. The ECS path (`RunTask` plus ECS Exec) could become an adapter, but AWS doesn't say whether ECS Exec works in sandboxed tasks. |
| OpenAI hosted containers | Checked 2026-11-21. The Containers API creates, lists and deletes containers and moves files, but has no call that runs a command: commands run only when a model issues a shell or code-interpreter call through the Responses API. |
| Cube | It never had an API (Mac app, web and SSH only), and it is shutting down: new machines blocked since 2026-11-06, all machines deleted 2026-12-20. |
| Jilebi | Checked 2026-11-21. Machines are made in its web console and reached over SSH and routed subdomains; it publishes no API to create a machine or run a command (its blog lists "programmability" as future work). $0.009/vCPU-h + $0.009/GB-h. |
| Cloudish | Checked 2026-11-21. A container host for web apps: its API deploys an image as a project and starts replicas reached over HTTP through its proxy, with no call that runs a command or moves a file. A sandbox would need our own exec server deployed as a private project (as `cloudrun` does), but Cloudish doesn't restrict traffic between tenants' pods, and a replica loses everything when it idles out. $0.1007/h at 2 CPU / 4 GB, $0.10 credit with no card. |
| microsandbox cloud | The cloud is a private beta (access on request). Its REST API creates, starts, stops and deletes sandboxes but has no exec or file route: commands ride an undocumented "sandbox command channel" that only the SDK speaks, and the npm SDK is a native binding. Checked 2026-11-21. |

### Keys and access surfaces

| id | Key(s) | How the adapter connects |
|---|---|---|
| `e2b` | `E2B_API_KEY` | REST api.e2b.app + envd in the sandbox (HTTP and Connect RPC, no SDK) |
| `daytona` | `DAYTONA_API_KEY` | REST app.daytona.io/api + the sandbox's toolbox API (no SDK) |
| `modal` | `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET` | SDK `modal` (gRPC) |
| `vercel` | `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID` (or `VERCEL_OIDC_TOKEN`) | REST vercel.com/api/v2/sandboxes (no SDK) |
| `runloop` | `RUNLOOP_API_KEY` | REST api.runloop.ai/v1/devboxes (no SDK) |
| `freestyle` | `FREESTYLE_API_KEY` | REST api.freestyle.sh/v5 (no SDK) |
| `blaxel` | `BL_API_KEY`, `BL_WORKSPACE` | REST api.blaxel.ai/v0 + each sandbox's API (no SDK) |
| `northflank` | `NORTHFLANK_TOKEN`, `NORTHFLANK_PROJECT` | REST api.northflank.com/v1 + the command-exec WebSocket (no SDK) |
| `cloudflare` | `CLOUDFLARE_SANDBOX_URL`, `CLOUDFLARE_SANDBOX_TOKEN` | REST, to the bridge Worker in templates/cloudflare-worker |
| `instabox` | `INSTABOX_API_KEY` | REST api.instabox.sh |
| `upstash` | `UPSTASH_BOX_API_KEY` | REST us-east-1.box.upstash.com/v2 (no SDK) |
| `tenki` | `LUXOR_API_KEY` or `LUXOR_AUTH_TOKEN` (the old `TENKI_API_KEY` / `TENKI_AUTH_TOKEN` still work) | Connect at api.luxor.ai + gRPC to each session's data plane (no SDK) |
| `boxlite` | `BOXLITE_API_KEY` | SDK `@boxlite-ai/boxlite` (native: macOS arm64, Linux glibc) |
| `dedalus` | `DEDALUS_API_KEY` | REST dcs.dedaluslabs.ai/v1 |
| `createos` | `CREATEOS_SANDBOX_API_KEY` | REST api.sb.createos.sh/v1 |
| `quivvo` | `QUIVVO_API_KEY` | REST tryquivvo.com/api/v1 |
| `celesto` | `CELESTO_API_KEY` | REST api.celesto.ai/v1/computers (no SDK) |
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
| `novita` | `NOVITA_API_KEY` (`NOVITA_DOMAIN` for another region) | E2B's API (the `e2b` adapter's code), at us-phx-1.sandbox.novita.ai |
| `smol` | `SMOL_CLOUD_TOKEN` | REST api.smolmachines.com/v1 |
| `isorun` | `ISORUN_API_KEY` | REST run-<region>.isorun.ai/v1 (region from the key) |
| `instavm` | `INSTAVM_API_KEY` | REST api.instavm.io |
| `prized` | `PRIZED_API_KEY` | REST api.prized.dev/api/v1 + the sandbox's edge |
| `zipbox` | `ZIPBOX_API_KEY` | REST api.tribes.xyz + the box's own API |
| `koyeb` | `KOYEB_API_TOKEN` | REST app.koyeb.com/v1 + the sandbox executor (no SDK) |
| `fly` | `FLY_API_TOKEN`, `FLY_APP` | REST api.machines.dev/v1 |
| `sprites` | `SPRITES_TOKEN` | REST api.sprites.dev/v1 (the SDK needs Node 24) |
| `morph` | `MORPH_API_KEY` | REST cloud.morph.so/api (no SDK) |
| `together` | `TOGETHER_API_KEY` | REST api.bartender.codesandbox.io/v1 + the sandbox agent (no SDK) |
| `depot` | `DEPOT_TOKEN` | Connect at api.depot.dev (no SDK) |
| `namespace` | `NSC_TOKEN` | Connect at {us,eu}.compute.namespaceapis.com (no SDK) |
| `lambda-microvm` | `LAMBDA_MICROVM_IMAGE` + AWS credentials | REST lambda.&lt;region&gt;.amazonaws.com, SigV4-signed (no SDK), plus execd (templates/aws-lambda-microvm) |
| `thunder` | `TNR_API_TOKEN` | REST api.thundercompute.com:8443/v1, plus system `ssh` |
| `exedev` | `EXE_API_TOKEN` (minted with `generate-api-key --cmds=new,ssh,rm,ls`) | REST `POST exe.dev/exec` |
| `nanite` | `NANITE_API_KEY` | REST api.nanite.run/v1 |
| `render` | `RENDER_API_KEY`, `RENDER_WORKSPACE_ID` | REST api.render.com/v1 + per-sandbox connect tokens |
| `quave` | `QUAVEONE_USER_TOKEN`, `QUAVEONE_ACCOUNT_ID`, `QUAVEONE_APP_ID`, `QUAVEONE_SANDBOX_TEMPLATE_ID` | REST api.quave.cloud/api/public/v1 |
| `beam` | `BEAM_TOKEN`, `BEAM_WORKSPACE_ID` | SDK `@beamcloud/beam-js` |
| `mosaic` | `MOSAIC_API_TOKEN` | REST sandbox.mosaicos.com/v1 |
| `nodus` | `NODUS_API_KEY`, `NODUS_PROJECT` | REST api.nodus-compute.ai/apis/nodus.dev/v1 |
| `cathedral` | `CATHEDRAL_API_KEY` | REST cathedral.computer/v1 |
| `keln` | `KELN_API_KEY` | REST sandbox.keln.ai/v1 (commands stream as SSE) |
| `mandala` | `MANDALA_API_KEY` | REST app.mandala.computer/api/v1 |
| `platinum` | `PT_TOKEN` (`PT_API_URL` for a self-hosted control plane) | REST api.platinum.dev/v1 |
| `inngest` | `INNGEST_SIGNING_KEY` (`INNGEST_ENV` for a branch environment) | REST api.inngest.com/v2/sandboxes, the calls the `inngest` SDK makes |
| `archil` | `ARCHIL_API_KEY` (`ARCHIL_REGION`, default `aws-us-east-1`) | REST control.&lt;region&gt;.archil.com/api, commands over its process WebSocket (no SDK) |
| `openpond` | `OPENPOND_API_KEY` | REST api.openpond.ai/v1/sandboxes, the calls `openpond-sdk` makes |
| `gmi` | `GMI_SANDBOX_API_KEY`, `GMI_SANDBOX_TEMPLATE` (an Agent template id or name) | REST console.gmicloud.ai/api/v2 + the sandbox's data plane |
| `dory` | `DORY_API_KEY` | REST api.dory.run/v1 + data.dory.run |
| `groundbox` | `GROUNDBOX_API_KEY` | REST api.groundbox.dev/v1 |
| `briq` | `BRIQ_API_KEY` | REST api.briq.cloud/v1 |
| `kubi` | `KUBI_API_KEY` | REST api.trykubi.com/v1 |
| `orble` | `ORBLE_API_KEY` | REST orble.tech/v1 |
| `runtime` | `RUNTIME_API_KEY` | REST api.withruntime.com/v2 |
| `digitalocean` | `DIGITALOCEAN_TOKEN` | REST api.digitalocean.com/v2/harness-runtime |
| `docker-cloud` | `DOCKER_ID`, `DOCKER_PAT` (with Cloud Sandboxes access) | REST connect.docker.com/sandboxes/v1 + the sandbox's endpoint |
| `superserve` | `SUPERSERVE_API_KEY` | REST api.superserve.ai + sandbox.superserve.ai (per-sandbox access token) |
| `eqvps` | `EQVPS_API_KEY` | REST api.eqvps.com/api/v1/eqvps |
| `solari` | `SOLARI_API_KEY` | REST api.getsolari.com (exec and signed file URLs; no WebSocket) |
| `pilldrops` | `PILLDROPS_API_KEY` | REST pilldrops.com/v1 |
| `vers` | `VERS_API_KEY` | REST api.vers.sh/api/v1 |
| `oblien` | `OBLIEN_CLIENT_ID`, `OBLIEN_CLIENT_SECRET` | REST api.oblien.com/v1 + the vm.oblien.com runtime gateway (short-lived JWT) |
| `runta` | `RUNTA_API_KEY` | REST api.runta.com/v2, exec over its WebSocket (no SDK) |
| `stateset` | `STATESET_API_KEY` | REST api.sandbox.stateset.app/api/v1 |
| `saas-sandbox` | `AAS_API_KEY` | REST sandbox-as-a-service.com/v1 |
| `sandbox0` | `SANDBOX0_TOKEN` | REST api.sandbox0.ai/api/v1 |
| `watasu` | `WATASU_API_KEY` (`options.team` for a shared team) | REST api.watasu.io/v1, exec over its data-plane WebSocket (no SDK) |
| `langsmith` | `LANGSMITH_API_KEY` (`LANGSMITH_ENDPOINT` for EU, `LANGSMITH_WORKSPACE_ID` for org keys) | REST api.smith.langchain.com/api/v2/sandboxes + each sandbox's data plane |
| `miosa` | `MIOSA_API_KEY` | REST api.miosa.ai/api/v1 |
| `railway` | `RAILWAY_TOKEN` (project token), or `RAILWAY_API_TOKEN` + `RAILWAY_ENVIRONMENT_ID` | GraphQL backboard.railway.com/graphql/v2 |
| `agentbay` | `AGENTBAY_API_KEY` (`AGENTBAY_REGION`, `AGENTBAY_IMAGE_ID` optional) | REST (OpenAPI RPC) agentbay.&lt;region&gt;.aliyuncs.com |
| `tencent` | `TENCENT_AGS_API_KEY`, `TENCENT_AGS_TOOL` (`TENCENT_AGS_REGION` optional) | E2B's API (the `e2b` adapter's code), at &lt;region&gt;.tencentags.com |
| `workpaper` | `WORKPAPER_API_KEY` (from `workpaper keys create`) | REST api.workpaper.co/v1/computers |
| `rayrun` | `RAYRUN_TOKEN` (console API token) | REST api.rayrunos.com/v1 |
| `tama` | `TAMA_TOKEN` | gRPC-Web gateway.tama.computer (api.v1.ApiService), hand-encoded protobuf |
| `tangle` | `TANGLE_API_KEY` | REST sandbox.tangle.tools/e2b (its plain-HTTP routes) |
| `nirvana` | `NIRVANA_API_KEY` (`sandbox` edit permission), `NIRVANA_SANDBOX_CLUSTER_ID` (a `ready` cluster) | REST api.nirvanalabs.io/v1/sandboxes (OpenSandbox) + execd through the cluster's gateway |
| `agental` | `AGENTAL_API_KEY` | REST agental.io/v1 |
| `volcengine` | `VOLCENGINE_E2B_API_KEY`, `VOLCENGINE_E2B_TEMPLATE_ID` (`VOLCENGINE_E2B_REGION` optional) | E2B's API (the `e2b` adapter's code), at api.vefaas-e2b.sandbox-&lt;region&gt;.volcapig.com |
| `openreward` | `OPENREWARD_API_KEY`, `OPENREWARD_ENVIRONMENT` (an environment you made, `user/env`) | session API at sessions.openreward.ai (server-sent events), as the `openreward` SDK speaks it |
| `baseten` | `BASETEN_API_KEY` (`BASETEN_TEAM_ID` optional) | REST api.baseten.co/v1/sandboxes with a 2 h sandbox token from /v1/token, + each sandbox's runtime API |
| `chalk` | `CHALK_CLIENT_ID`, `CHALK_CLIENT_SECRET` (`CHALK_ENVIRONMENT`, `CHALK_API_SERVER` optional) | Connect (JSON) chalk.sandbox.v2 services at api.chalk.ai, token from /v1/oauth/token |
| `voidrun` | `VOIDRUN_API_KEY` | REST api.void-run.com/api |
| `kosa8` | `KOSA8_API_KEY` | REST api.kosa8.com/v1 |
| `primeintellect` | `PRIME_API_KEY` (with the `sandbox` scope; `PRIME_TEAM_ID` optional) | REST api.primeintellect.ai/api/v1/sandbox + the sandbox gateway (Connect stream for commands) |
| `sandboxer` | `SANDBOXER_API_KEY` | REST sandboxer.com/api/v1 |
| `cyqle` | `CYQLE_API_KEY` (`options.slotId` for a paid desktop) | REST api.cyqle.in/v1, then the desktop's region (api-us / api-eu) |
| `islo` | `ISLO_API_KEY` | REST api.islo.dev/auth/token (key for a session token) + ca.compute.islo.dev |
| `hyperbrowser` | `HYPERBROWSER_API_KEY` | REST api.hyperbrowser.ai/api + each sandbox's runtime URL and token |
| `offstage` | `OFFSTAGE_API_KEY` | REST api.offstage.cloud/v1 |
| `machine0` | `MACHINE0_API_KEY` (`MACHINE0_SSH_KEY_ID` optional) | MCP app.machine0.io/mcp (JSON-RPC `tools/call` over HTTP) |
| `lightcone` | `TZAFON_API_KEY` | REST api.tzafon.ai |
| `openci` | `OPENCI_URL`, `OPENCI_TOKEN` | REST /v1/sandboxes |
| `opensandbox` | `OPEN_SANDBOX_DOMAIN`, optional `OPEN_SANDBOX_API_KEY` | REST /v1/sandboxes + execd in the sandbox |
| `cloudrun` | `GOOGLE_CLOUD_PROJECT`, `CLOUD_RUN_REGION`, `CLOUD_RUN_SANDBOX_IMAGE` + `GOOGLE_OAUTH_ACCESS_TOKEN` or `GOOGLE_APPLICATION_CREDENTIALS(_JSON)` | REST run.googleapis.com/v2 (instances), plus execd (templates/cloud-run-sandbox) |
| `gke-agent-sandbox` | `AGENT_SANDBOX_K8S_API`, `AGENT_SANDBOX_ROUTER_URL`, `AGENT_SANDBOX_WARM_POOL` + `AGENT_SANDBOX_K8S_TOKEN` or Google credentials | Kubernetes API (SandboxClaim) + sandbox-router (gRPC-Web, REST) |
| `azure-sandboxes` | `AZURE_SUBSCRIPTION_ID`, `AZURE_RESOURCE_GROUP`, `AZURE_SANDBOX_GROUP`, `AZURE_REGION` + `AZURE_ACCESS_TOKEN` or `AZURE_TENANT_ID`/`AZURE_CLIENT_ID`/`AZURE_CLIENT_SECRET` | REST management.{region}.azuredevcompute.io |
| `docker` | none (`SBR_DOCKER=0` turns it off) | `docker` CLI |

`npm install sandboxrouting` is all every provider needs but four: the adapters speak each
provider's HTTP, Connect, gRPC or WebSocket API themselves, with no provider SDK installed.
The four still marked "SDK" in the table load an SDK that is an optional peer dependency,
because the provider has no API but gRPC through it (`modal`, `@boxd-sh/sdk`, both with
install scripts), it is a native binding (`@boxlite-ai/boxlite`), or it is large and its API
undocumented (`@beamcloud/beam-js`). Install one only for that provider, e.g.
`npm install sandboxrouting modal`; a provider whose key is set but whose SDK is missing is
skipped with an install hint.

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
- it runs another operating system than the request's `os` (`linux` unless the request says
  `macos`; `offstage` is the macOS provider);
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
| 429 | The provider is cooled down for a minute, even when the body says "quota": that is nearly always a cap on how many run at once. Only a 429 that says money ran out ("credit", "billing", "insufficient balance") counts as used-up credit. |
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
anyway, the mark above catches it.

Some providers bill the vCPUs only while they are busy (`pricing.billing: "active-cpu"`:
Vercel, Cloudflare, Render, Upstash Box, Fly Sprites, boxd, SuperHQ Nanite, Tensorlake, Runtime,
DigitalOcean Harness Runtime, Railway, smol).
Strategies rank these by the expected cost, with the vCPUs busy `activeCpuShare` of the time
(default 0.3; set `routing.activeCpuShare` for your workload, or
`providers.<id>.pricing.activeCpuShare` for one provider), so `cheapest` compares them fairly.
Reservations and metering still count every vCPU busy, since the router can't see CPU time: a
busy box can't overrun a free tier or a budget, and the router stops using such a free tier a
little before the provider would. Details in [docs/routing.md](docs/routing.md#active-cpu-billing).

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
claude mcp add sandboxes -- npx -y sandboxrouting mcp
```

Other clients take the same command (`npx -y sandboxrouting mcp`) in their MCP config, with
your provider keys in its `env`. From a clone, `node /path/to/sandboxrouting/dist/cli.js mcp`
runs the local build instead. The server is listed in the MCP Registry as
`com.sandboxrouting/sandboxrouting`.

## AgentRun

`sandboxrouting/agentrun` is a computer provider for [AgentRun](https://agentrun.ai/): one provider that gives an
AgentRun server every sandboxrouting provider able to boot AgentRun's box image, routed free usage first, with
failover. It implements AgentRun's `MachineHost` with the router in-process, as a dial host (the machine's
`agentrun-dial` connects to the AgentRun server), and reports the provider it chose in the computer's labels.
AgentRun keeps durable runs, cost caps and the run timeline. Tested against fake providers only, not yet against
AgentRun's conformance suite or a live provider. See [docs/agentrun.md](docs/agentrun.md).

```ts
import { create } from "sandboxrouting/agentrun"; // needs @parcha/agentrun-computer too
const provider = create({ strategy: "free-first", providers: "daytona,modal,fly", dial });
```

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

`routing` also takes `weights` for `balanced`, `circuitBreaker` settings, and
`activeCpuShare`, the expected busy share of the vCPUs used to rank providers that bill only
active CPU (default 0.3). A provider's `pricing` override takes `vcpuSecondUsd`,
`gibSecondUsd`, `sandboxSecondUsd`, `billing` (`"wall"` or `"active-cpu"`) and
`activeCpuShare`. `jobs` takes
the checkpoint mode, limits and timeouts. Both are documented in
[docs/routing.md](docs/routing.md#4-configuration-reference). `policy` still works as the
old name for `routing.strategy`.

`sbr reset <provider>` clears a provider's quota, rate-limit and auth marks, and its health
history, after you top up or fix a key.

## Usage dashboard

A router can report what its ledger records to a dashboard that shows how your workloads
spread across providers: sandbox count, sandbox-hours and memory GiB-hours per day and
provider, spend against the free usage each provider has left, refusals and failed creates,
health and the circuit breaker, live sandboxes with their state as of now, and jobs with every
move and why. It is two packages in this repository, both MIT: [back/](back) (an ingest and
read API on Postgres) and [dashboard/](dashboard) (Next.js). Reporting is off unless you turn
it on.

### Self-hosting

```bash
cp deploy/.env.example deploy/.env          # set POSTGRES_PASSWORD and SBR_ADMIN_TOKEN
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
```

That runs Postgres, back on port 8787 and the dashboard on port 3000. Sign in with
`SBR_ADMIN_TOKEN`, then make an ingest key for each router under API keys (or set
`SBR_INGEST_TOKEN` too). Each image is configured only by environment variables:

| back | |
|---|---|
| `DATABASE_URL` | `postgres://…` (required). Migrations run at startup and only move forward. |
| `SBR_ADMIN_TOKEN`, `SBR_INGEST_TOKEN` | Optional keys for the first account, made if missing and never brought back once revoked. At least 24 characters. |
| `SBR_SWEEP_TOKEN` | Lets a cron call `POST /v1/sweep` for every account. |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | Optional, together: GitHub sign-in instead of admin keys. A first sign-in makes that person's account (one per GitHub user). The OAuth app's callback is `<dashboard>/api/auth/github/callback`. |
| `SBR_SECRETS_KEY` | Optional: 32 bytes, base64. Seals the provider keys people save for the hosted router (envelope encryption, a data key per row). `SBR_SECRETS_OLD_KEYS` lists keys rotated out that still open older rows. `SBR_KMS_KEY` (a Cloud KMS key name) seals with Cloud KMS instead. Neither: saving provider keys is off. |
| `PORT` | Default 8787. |

| dashboard | |
|---|---|
| `BACK_URL` | back as the dashboard's server reaches it (required). |
| `BACK_PUBLIC_URL` | back as routers reach it, for the setup snippet. |
| `DASHBOARD_PUBLIC_URL` | The dashboard as browsers reach it, for GitHub's callback. Default: the forwarded host. |
| `ROUTER_PUBLIC_URL` | The hosted router as router keys reach it, for the setup snippet. Unset: no router keys offered. |
| `PORT` | Default 3000. |

| hosted router (back's image, `node back/dist/hosted.js`; the compose file's `router` profile) | |
|---|---|
| `DATABASE_URL` | back's database (required). It never migrates; it refuses to start while one is pending. |
| `SBR_SECRETS_KEY` or `SBR_KMS_KEY` | The same key back seals saved provider keys with (required): this service opens them. |
| `SBR_SWEEP_TOKEN` | Lets a cron call `POST /internal/sweep`: deletes sandboxes past deadlines their provider doesn't enforce, and boxes the ledger closed that still run. Run it every few minutes. |
| `SBR_HOSTED_MAX_LIVE` | Live sandboxes an account may have at once. Default 10. |
| `PORT` | Default 8788. |

The hosted router serves `POST /mcp` (MCP over streamable HTTP, stateless) and the router's REST
API under `/v1` (no jobs: they need a process that stays up), to router keys made on the API keys
page. Each request runs a router for that account alone: the providers it saved keys for (the
audited list on the Provider keys page), its Routing config, and a ledger in Postgres whose every
write updates the dashboard in the same transaction. Its MCP server adds `list_connections`,
`connect_provider`, `remove_provider`, `get_config` and `set_config`. Every outgoing connection
goes through a guard that refuses private, loopback, link-local and metadata addresses.

Nothing has to run in the background: whatever changes with time (a sandbox past its deadline,
a mark that lapsed, a job whose runner stopped) is worked out when the dashboard reads it, with
the database's clock. The sweep only rolls up closed days so reads stay cheap; run it from any
cron (`curl -X POST -H "authorization: Bearer $SBR_SWEEP_TOKEN" http://back:8787/v1/sweep`) or
with the compose file's `sweep` profile. Without Docker, `cd back && npm run build &&
DATABASE_URL=… node dist/main.js` and `cd dashboard && npm run build && BACK_URL=… npm start`;
`node back/dist/cli.js account create <name>` makes an account and prints its admin key.

### Turning on the reporter

```bash
export SBR_REPORT_URL=http://localhost:8787
export SBR_REPORT_TOKEN=sbrk_…                # an ingest key
```

or in config:

```jsonc
{ "report": { "url": "https://back.example", "token": "sbrk_…", "metadataKeys": ["team"] } }
```

`SBR_REPORT=0` turns it off for one run. `createRouter` (and so the CLI, REST server and MCP
server) reports when it is on; for a router you construct yourself, wrap its ledger with
`reportingLedger`. Only ids, provider ids, sizes, times, states and prices leave the machine,
plus the metadata keys you list. Never commands, env, file contents, provider error messages
or keys.

After every ledger write, and when a router starts, the reporter compares the ledger with what
it last queued and queues an event for each thing that changed, in an outbox at
`$SBR_HOME/report/outbox.json` (written whole, under a lock, like the ledger). Each event keeps
its id until back acknowledges it, and back keeps the newest state of each sandbox, job and
mark whatever order events arrive in, so a resend never counts twice. Routing never waits on
back: a send times out after 4 s, and a failure backs off (recorded in the outbox, so other
processes don't each retry a back end that is down) until the next router to start, or the
same long-running one, delivers what is queued. Several quick changes may reach back as one
state; the billing segments in it are complete.

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
  fail over correctly. If the provider uses a status that means something else (a spent
  allowance as 429 or 409, a plan limit as 403), declare it with `refusals()` in
  `src/providers/util.ts`.
- If the provider bills the vCPUs only while they are busy, set `billing: "active-cpu"` in
  `pricing` (and `activeCpuFloor` if it bills a minimum share), so strategies rank it by its
  expected cost.
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
- **Google Cloud Run sandboxes** have no API of their own. Build the image in
  [templates/cloud-run-sandbox](templates/cloud-run-sandbox) and set `CLOUD_RUN_SANDBOX_IMAGE`;
  the region must offer Cloud Run instances (not `us-central1`, `us-east1` or `europe-west1`).
- **GKE Agent Sandbox** needs [agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox)
  installed with its extensions, a `SandboxWarmPool` whose pods run sandboxd, and the
  sandbox-router exposed outside the cluster. A cluster CA that Node doesn't trust goes in
  `NODE_EXTRA_CA_CERTS`.
- **Azure Container Apps Sandboxes** need a sandbox group (`Microsoft.App/sandboxGroups`).
  The default image is the public `ubuntu` disk image; `options.image` names another public
  one, and a template (`--template azure-sandboxes=<disk image id>`) uses your own.
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
- **Nirvana Labs** runs sandboxes on a sandbox cluster you create first (dashboard, or
  `POST /v1/sandbox_clusters` with an instance type, node count and region). Its nodes are
  billed by the hour from then on, sandboxes or not. Set `NIRVANA_SANDBOX_CLUSTER_ID` once
  its status is `ready`.
- **Workpaper, Rayrun and tama** keep a stopped or idle machine instead of deleting
  it (Workpaper pauses after an idle hour, Rayrun cold-stops at `max_lifetime_seconds`, tama
  stops at its idle `ttl`), so they declare `enforcesTimeout: false` too. A new Rayrun sandbox
  has no network by default: the adapter opens egress, and `options.egress: "closed"` keeps
  it shut. Its default image is `ubuntu@1` (`options.agent` or a template names another).

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

back/ and dashboard/ are npm workspaces with their own checks: `npm run lint|typecheck|test|build
-w back` (or `-w dashboard`). back's tests run on PGlite, a real Postgres in WebAssembly;
`TEST_DATABASE_URL=postgres://…` runs them on a Postgres server instead, each test in its own
database. `cd back && DATABASE_URL=pglite:memory npm run dev` starts back with nothing to set up.

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

The sandboxrouting name and logo are not covered by the MIT license.
