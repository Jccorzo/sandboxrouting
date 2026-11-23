// Starts the hosted router from environment variables only (a second service from back's image:
// node back/dist/hosted.js). It shares back's database and never changes its schema.
//
//   DATABASE_URL        postgres://… (required), or pglite:<dir> for a local try
//   SBR_KMS_KEY         projects/…/cryptoKeys/… — opens saved provider keys with Cloud KMS, or
//   SBR_SECRETS_KEY     32 bytes base64 (self-hosting; SBR_SECRETS_OLD_KEYS as in back). One is required.
//   PORT, HOST          default 8788, 0.0.0.0
//   SBR_SWEEP_TOKEN     lets a cron trigger call POST /internal/sweep
//   SBR_HOSTED_MAX_LIVE live sandboxes an account may have at once (default 10)
//   DATABASE_POOL_MAX   connections this process opens at most (default 10)
//
// Every outgoing connection goes through the egress guard (egress.ts), and it refuses to start
// if the guard doesn't hold. Only Cloud KMS and its metadata-server token bypass it.

import { Agent } from "undici";
import { openDb } from "../db.js";
import { checkMigrations } from "../migrate.js";
import { secretBoxFromEnv } from "../secrets.js";
import { installEgressGuard } from "./egress.js";
import { createHostedServer } from "./server.js";

declare const __SBR_ROUTER_VERSION__: string | undefined;
const version = typeof __SBR_ROUTER_VERSION__ === "string" ? __SBR_ROUTER_VERSION__ : "dev";

const env = process.env;
const fail = (msg: string): never => {
  console.error(`hosted: ${msg}`);
  process.exit(1);
};

installEgressGuard();
// The guard must hold on this Node: a connection to loopback has to be refused by it, not by the port.
const probe = await fetch("http://127.0.0.1/").then(
  () => "answered",
  (err: unknown) => String((err as { cause?: { code?: string } }).cause?.code ?? ""),
);
if (probe !== "ESBR_EGRESS") fail(`the egress guard didn't hold on Node ${process.version} (a loopback fetch gave "${probe}"); not starting`);

// KMS and the metadata server (169.254.169.254) are the only calls that skip the guard.
const direct = new Agent();
const directFetch = ((input: string | URL | Request, init?: RequestInit) => fetch(input, { ...init, dispatcher: direct } as unknown as RequestInit)) as typeof fetch;
const secrets = secretBoxFromEnv(env, { fetch: directFetch });
if (!secrets) fail("set SBR_KMS_KEY or SBR_SECRETS_KEY: the hosted router runs on the provider keys people save");

const url = env["DATABASE_URL"] ?? fail("DATABASE_URL is required");
const db = await openDb(url);
const pending = await checkMigrations(db);
if (pending.length) fail(`migration${pending.length === 1 ? "" : "s"} ${pending.join(", ")} not run yet: start back (or run "node back/dist/cli.js migrate") first`);

const maxLive = Number(env["SBR_HOSTED_MAX_LIVE"] ?? 10);
if (!Number.isInteger(maxLive) || maxLive < 1) fail("SBR_HOSTED_MAX_LIVE must be a whole number of at least 1");

const server = createHostedServer({ db, secrets: secrets!, sweepToken: env["SBR_SWEEP_TOKEN"] || undefined, maxLive, version });
// Long commands: Cloud Run's request timeout is the limit, not Node's.
server.requestTimeout = 0;
const port = Number(env["PORT"] ?? 8788);
server.listen(port, env["HOST"] ?? "0.0.0.0", () => console.log(`hosted: router ${version} listening on :${port}`));

const stop = () => {
  server.close(() => void db.close().finally(() => process.exit(0)));
  setTimeout(() => process.exit(0), 10_000).unref();
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
