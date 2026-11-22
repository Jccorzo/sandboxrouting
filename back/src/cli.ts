// Account administration from a shell, against DATABASE_URL:
//
//   node dist/cli.js account create <name>    makes an account and prints its first admin key
//   node dist/cli.js migrate                  runs pending migrations and exits
//
// account create migrates first, or with SBR_MIGRATE_ON_START=0 only checks, as the server does.

import { openDb } from "./db.js";
import { createAccount } from "./keys.js";
import { migrate, prepareSchema } from "./migrate.js";

const [cmd, sub, ...rest] = process.argv.slice(2);
const url = process.env["DATABASE_URL"];
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}
const db = await openDb(url);
try {
  if (cmd === "account" && sub === "create" && rest.length) {
    await prepareSchema(db);
    const { accountId, adminToken } = await createAccount(db, rest.join(" "));
    console.log(`account ${accountId}\nadmin key (shown once): ${adminToken}`);
  } else if (cmd === "migrate") {
    const applied = await migrate(db);
    console.log(applied.length ? `applied migration${applied.length === 1 ? "" : "s"} ${applied.join(", ")}` : "migrations are up to date");
  } else {
    console.error("usage: cli account create <name> | cli migrate");
    process.exitCode = 2;
  }
} finally {
  await db.close();
}
