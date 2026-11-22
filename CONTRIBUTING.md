# Contributing to sandboxrouting

Thanks for helping. The most useful contributions are new providers, corrections to a
provider's free tier or prices (they change often), and bug reports with a failing test.

## Setup

You need Node 20 or newer. Docker is optional: the Docker tests run real containers when it
is up and skip otherwise.

```bash
npm install
npm run lint         # ESLint over the whole repository
npm run typecheck    # adapters are checked against the real provider SDK types
npm test             # Vitest
npm run simulate     # compare the routing strategies on a simulated month
```

No provider keys are needed: tests run against fake providers, mocked REST APIs, a local
shell provider and Docker. `sbr check` runs a live create, exec and kill against providers
you have keys for, which is worth doing for an adapter you touched.

## Pull requests

- Keep a change to one thing, and say in the description what it changes and why.
- Every bug fix comes with a test that fails before the fix. Run it on the old code to
  confirm that it does.
- Don't raise a test's timeout to make it pass. Make the test do less, or make the code
  faster.
- Update the docs a change touches: [README.md](README.md) for what users see, and
  [docs/routing.md](docs/routing.md) for routing, health, marks and jobs.
- A change to routing should come with `npm run simulate` numbers before and after, summed
  over several seeds (`--seed`). One seed is noisy.
- CI runs lint, typecheck and the tests (see below). All three have to pass.

## Adding or updating a provider

A provider is one file in `src/providers/`; [README.md](README.md#adding-a-provider) shows
the shape. Before you open the pull request:

- Give `freeTier` a `source` (the provider's pricing or limits page) and a `checked` date.
  `test/providers.test.ts` checks that every built-in has them.
- Claim only the capabilities the adapter implements.
- Make `create` throw errors with an HTTP `status`, so a 402 (credit used up) and a 429
  (rate limit) fail over correctly.
- Speak the provider's HTTP API with `fetch` (`http`/`httpJson` in `util.ts`) rather than
  loading its SDK, so users install only sandboxrouting. Use an SDK only where there is no HTTP
  equivalent; it then goes in `dependencies` unless it builds native code, runs an install
  script or is large, in which case it is an optional peer dependency (`sdkInstall` in
  `util.ts` reads which, and `test/fetch-providers.test.ts` checks package.json matches).
- Add a test with a mocked API (see `test/rest-providers.test.ts` and `test/restmock.ts`),
  or with the SDK mocked (`test/sdk-providers.test.ts`).
- Say in the pull request whether you ran it against the real service.

## How the code is built

These rules keep the router correct when the CLI, the REST server, the MCP server and jobs
share one ledger at the same time. Reviews check them.

- **State has one home.** A lifecycle (a sandbox, a job, a quota mark) has one
  representation and one function that decides its moves: `state.ts`, `jobs/state.ts`,
  `marks.ts`. Don't add a boolean or a nullable field that a second place has to keep in step.
- **Derived state is computed on read.** Health, the circuit breaker, free status and
  expiries are worked out when they are read, by one function every surface calls. Nothing
  stores a verdict that time could make stale.
- **The guard sits in the write.** A check-then-write re-checks its condition inside the
  ledger update (`ledger.update`), never on a snapshot read before it.
- **Every path converges.** Retries are idempotent, and the sweep reconciles whatever a crash
  left half done.

## Continuous integration

CI runs each check through [hushrun](https://hushrun.com), which skips work this exact code
already passed. The tests reuse by file: a test file that passed on the exact files it read
doesn't run again until one of them changes. Lint and typecheck cover the whole project and
run whenever anything changes. `hushrun.yaml` names the checks.

The npm scripts run the same way on your machine: hushrun is a dev dependency, and
`npm run lint`, `npm run typecheck` and `npm test` each skip when this exact code already
passed. `npm install` also adds a pre-push hook; `npx hushrun ready` says which checks CI would
still run. Coding agents follow [AGENTS.md](AGENTS.md).

## Reporting bugs and security issues

Open an issue with what you ran, what you expected and what happened, and the output of
`sbr route` if it is about routing. For a security issue, follow [SECURITY.md](SECURITY.md)
instead of opening a public issue.

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE).
