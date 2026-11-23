// The hosted router: router keys, and one ledger per account.
//
// A router key calls the hosted router (its REST API and MCP server) for its account. It can't
// read the dashboard's data or manage keys: that stays with admin keys and sign-ins.
//
// router_ledgers holds what a router on someone's machine keeps in ~/.sandboxrouting/ledger.json:
// the sandboxes it made and their lifecycle, marks on providers, health samples. One row per
// account, rewritten whole under the account's lock (back/src/hosted-router/ledger.ts). `report`
// is what that ledger last reported to the dashboard's tables, the reporter's outbox minus the
// queue: the hosted router applies each write's changes to them in the same transaction, so
// nothing waits to be delivered.

export const name = "hosted_router";

export const sql = /* sql */ `
ALTER TABLE api_keys DROP CONSTRAINT api_keys_scope_check;
ALTER TABLE api_keys ADD CONSTRAINT api_keys_scope_check CHECK (scope IN ('ingest', 'admin', 'router'));

CREATE TABLE router_ledgers (
  account_id uuid PRIMARY KEY REFERENCES accounts (id),
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object' AND data->>'version' = '1'),
  report jsonb NOT NULL CHECK (jsonb_typeof(report) = 'object'),
  version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
`;
