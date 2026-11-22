// Provider keys and routing config that people save for the hosted router.
//
// A provider's credentials are "active" (sealed values present) or "removed" (nothing kept but the
// row's version). Each save bumps the version and is a compare-and-set on the version the person
// saw, so two tabs can't silently overwrite each other; the version is also sealed into the
// ciphertext's associated data. The config works the same way, one row per account.

export const name = "vault";

export const sql = /* sql */ `
CREATE TABLE provider_credentials (
  account_id uuid NOT NULL REFERENCES accounts (id),
  provider text NOT NULL CHECK (provider ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  state text NOT NULL CHECK (state IN ('active', 'removed')),
  version integer NOT NULL CHECK (version >= 1),
  -- AES-256-GCM under a per-row data key; the data key wrapped by the KEK named in kek_id.
  ciphertext bytea,
  wrapped_key bytea,
  kek_id text,
  -- What a list may show: a secret's last 4 characters, a setting in full.
  hints jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(hints) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- "session:<id>" or "key:<id>": who saved it.
  updated_by text NOT NULL,
  PRIMARY KEY (account_id, provider),
  CHECK ((state = 'active') = (ciphertext IS NOT NULL)),
  CHECK ((state = 'active') = (wrapped_key IS NOT NULL)),
  CHECK ((state = 'active') = (kek_id IS NOT NULL)),
  CHECK (state = 'active' OR hints = '{}'::jsonb)
);

CREATE TABLE account_router_config (
  account_id uuid PRIMARY KEY REFERENCES accounts (id),
  config jsonb NOT NULL CHECK (jsonb_typeof(config) = 'object'),
  version integer NOT NULL CHECK (version >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL
);
`;
