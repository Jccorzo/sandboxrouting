# sandboxrouting as an AgentRun compute connector

[AgentRun](https://agentrun.ai/) ([source](https://github.com/Parcha-ai/agentrun), Apache-2.0) runs agents and gives
each one a computer from a "computer provider" (Docker, Daytona, Modal, E2B, Fly Machines, boxd, ...). The
`sandboxrouting/agentrun` export is one such provider: every computer goes to whichever of sandboxrouting's providers
the router picks, free usage first by default, with failover when one refuses. AgentRun keeps what belongs to the agent
layer: durable runs, cost caps, the run timeline, the computer's daemon and its deadline. The connector adds none of
them.

Status: tested here against fake providers only. It has not run AgentRun's conformance suite or any live provider.

## How it fits AgentRun's contract

AgentRun's providers are TypeScript, in `packages/computer` of its repository (npm `@parcha/agentrun-computer`). A
provider writes a `MachineHost` ([`src/host.ts`](https://github.com/Parcha-ai/agentrun/blob/main/packages/computer/src/host.ts),
[PROVIDERS.md](https://github.com/Parcha-ai/agentrun/blob/main/packages/computer/PROVIDERS.md)): a descriptor, static
facts, and `create`, `get`, `list`, `delete`, plus optional `exec`, `upload`, `errorCode`, `extend` and `check`.
AgentRun's `HostedProvider` turns the host into a whole provider.

AgentRun talks to its daemon (computerd) in each machine over one long-lived, two-way process. sandboxrouting's `exec`
answers once its command ends, and has no stdin, so the connector can't give AgentRun an `exec`. It is a **dial host**
instead (`facts.connect: "dial"`), as AgentRun's Fly Machines host is: each machine runs AgentRun's box image, whose
`agentrun-dial` fetches computerd from the AgentRun server and dials the server's attach route.

| AgentRun asks | The connector does |
| --- | --- |
| `create` | Asks the router for a sandbox of the box image (`needs: ["customImage"]`, `os: "linux"`), the computer's lifetime as `timeoutSec`, its labels as metadata. Then one exec starts `agentrun-dial` in a session of its own, with AgentRun's boot env as that process's environment only, and a second exec a second later checks that it is still running. |
| `get`, `list` | Read the router's ledger. The machine's id is the router's id (`sbr_…`). `list` runs the router's local sweep first, which ends sandboxes past their deadline on providers with no timer of their own. |
| `delete` | The router's `kill`: recorded first, safe twice, not found is done. |
| `extend` | The router's `setTimeout`, which checks that the longer life fits free credit or the paid budget before the provider grants it. Capped at AgentRun's max-deadline label. A provider without `setTimeout`, or a budget the longer life doesn't fit, is AgentRun's `limit`. |
| `exec`, `upload` | None: dial hosts have neither. Commands and files go through computerd over the socket the machine dialed. |
| pause, resume, snapshot | Not offered. AgentRun's shared adapter never stops a machine and keeps it (`release` is delete only), so a host declares no persistence. |
| GPUs, desktops, Archil mounts | Refused: `check()` refuses a GPU, the descriptor offers a Linux computer only, and dial hosts take no Archil mount. |

### Which provider was chosen

Every read of a machine carries two extra labels, which AgentRun's `list()` returns with the rest:

- `agentrun.computer.sandboxrouting.provider`: the provider holding the sandbox, such as `daytona`.
- `agentrun.computer.sandboxrouting.route`: how the router got there, such as
  `modal quota -> fly unfit -> daytona created (free)`.

They live in AgentRun's label namespace because, when AgentRun reads a machine back on a retry, it treats any other
label it didn't ask for as drift and refuses the computer.

### Failover

The router already fails over when a provider refuses to create (402, 429, 5xx, a full free tier). The connector adds a
second kind: a sandbox that the router made but that can't host a computer. The launch checks, before it starts
anything:

- `/usr/local/bin/agentrun-dial` is there (the provider really booted the box image);
- commands run as root, or with passwordless sudo;
- root can make a network namespace (`unshare -n`, else `unshare -Urn`), which AgentRun's init needs to fence the
  computer's programs;
- `agentrun-dial` is still running after the exec that started it returned (some providers end whatever a command
  leaves behind).

When one fails, or the provider's exec fails outright, the connector deletes that sandbox and asks the router again
without that provider, up to `launchAttempts` sandboxes (default 3). The error lists each one. When `agentrun-dial`
stops by itself, its log says why, and that is the server's problem, not the provider's, so there is no failover.
Whatever fails after the router made a sandbox, the sandbox is deleted before the error is thrown.

### What a provider needs

Only providers that run a custom OCI image are candidates: 37 of the 108 declare `customImage`, two of them
self-hosted (`docker`, `openci`). E2B is not among them: it starts from templates, and AgentRun publishes the box image
as a public E2B template, but the router doesn't yet let a native template answer a request for an image. What the router can't
know in advance, and the launch checks at create: that the provider runs commands as root, that root can make a network
namespace, that a background process outlives the exec, and that the machine can reach the AgentRun server over
HTTPS. The box image is built for amd64 only. A provider that ignores the image, runs on arm64, or blocks egress fails
the launch or never dials; AgentRun deletes a machine that doesn't dial within `createMs` (10 minutes here).

To keep computers on providers you have checked, list them: `providers: "daytona,modal,fly"`.

## Using it

Install both packages in the AgentRun server's project:

```bash
npm install sandboxrouting @parcha/agentrun-computer
```

```ts
import { create } from "sandboxrouting/agentrun";

const provider = create({
  strategy: "free-first",            // or cheapest, balanced, fastest, spread
  providers: "daytona,modal,fly",    // optional: route among these alone, in this order
  exclude: "vercel",                 // optional
  minIsolation: "microvm",           // optional: container, gvisor, microvm or vm
  allowPaid: false,                  // optional: overrides the config's allowPaid
  maxPaidUsdPerMonth: 20,            // optional
  dial: { url: process.env.AGENTRUN_PUBLIC_URL, tokens, hub }, // the server's, as for Fly
});
```

Options:

| Option | Default | Meaning |
| --- | --- | --- |
| `router` | made on first use | A `SandboxRouter` to use as it is. Without it, the connector makes one the way `sbr` does: config from `SBR_CONFIG` or `./sandboxrouting.json`, the ledger under `SBR_HOME`, every built-in provider. So `sbr`, the REST server and the connector on one machine share the free-tier metering. |
| `env` | `process.env` | Where the router reads its config path and its providers' keys (`DAYTONA_API_KEY`, ...). |
| `strategy`, `providers`, `exclude`, `minIsolation`, `region`, `needs` | the config's | Routing choices for every computer. Lists take an array or a comma-separated string. |
| `allowPaid`, `maxPaidUsdPerMonth` | the config's | The paid budget. Only for a router the connector makes. |
| `launchAttempts` | 3 | Sandboxes tried for one computer when one can't host it. |
| `image` | the box image | What `prepareImage()` answers. Default `ghcr.io/parcha-ai/agentrun-box:<recipe hash>` for the installed AgentRun package. |
| `maxLifetimeMs`, `timeouts`, `daemonPath`, `dial`, ... | AgentRun's | Passed to AgentRun's `HostedProvider`. `createMs` defaults to 10 minutes. |

The machine's isolation is declared as `microvm` when `minIsolation` is `microvm` or `vm`, otherwise `container`. It
is never `gvisor`: a request for gVisor may land on a stronger provider, and AgentRun's read-back holds a gVisor claim
to a gVisor kernel exactly.

### From AgentRun's server

AgentRun's server builds its providers from the descriptors built into `@parcha/agentrun-computer`
(`src/descriptors/index.ts`), so it lists this one in Settings only once the descriptor is in that file, which means
upstreaming it (below). Until then, use the provider from your own code, or from AgentRun's conformance CLI, which
takes a module path.

The descriptor (`SANDBOXROUTING` in `sandboxrouting/agentrun`) declares no keys of its own. Its `hostEnv` lists every
built-in provider's key and `SBR_CONFIG`, `SBR_HOME`, `SBR_ALLOW_PAID`, so a server passes those from its environment.
Its settings (`sandboxroutingStrategy`, `sandboxroutingProviders`, ...) default to empty, which leaves each choice to
sandboxrouting's config file.

## Tests

`test/agentrun.test.ts`, in this repository's suite (`npx vitest run test/agentrun.test.ts`), on fake providers in
the process: create, the launch and its check, get, list, delete twice, failover on a 402 and on a sandbox that can't
host a computer, the provider and route labels, cleanup when create fails after the router made a sandbox, extend, the
deadline as time passes, the launch script run through `sh`, and AgentRun's own `HostedProvider` over the host.

## Upstreaming it into AgentRun

The files are laid out to move with only their imports changed:

| Here | In AgentRun's `packages/computer` |
| --- | --- |
| `src/agentrun/index.ts` + `host.ts` | `src/sandboxrouting.ts` (and a `./sandboxrouting` export in its package.json) |
| `src/agentrun/descriptor.ts` | `src/descriptors/sandboxrouting.ts`, plus one line in `src/descriptors/index.ts` |
| `src/agentrun/conformance.ts` | `src/conformance/sandboxrouting.ts` |
| `src/agentrun/agentrun-computer.ts` | gone: relative imports of `host.js`, `hosted/provider.js`, `box-image.js`, `drift.js` (and AgentRun's own `HostError`) |
| `src/agentrun/sandboxrouting.ts` | the `sandboxrouting` npm package, loaded lazily through a pinned package constant, as `E2B_PACKAGE` is |
| `test/agentrun.test.ts` | `test/sandboxrouting-provider.test.mjs`, on `node:test` against `dist/` |

AgentRun's rules for that pull request (CONTRIBUTING.md, PROVIDERS.md, `.github/pull_request_template.md`): a
conformance report from a live run with the vendor's own keys, run for a dial host inside a public server
(`packages/serve/scripts/dial-conformance.mjs --provider sandboxrouting`), with the sweep's last line showing nothing
left over; the vendor's limits named; a `changes/<slug>.md` file. Apache-2.0, and no separate contributor agreement.
sandboxrouting must be published on npm first.
