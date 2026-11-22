// The first schema. Migrations only move forward and are never edited once released: a change
// is a new file. test/schema.test.ts checks that every CHECK list here names exactly the states
// the router defines (src/report/wire.ts), so a state added to the router needs a migration.
//
// Every status column has a CHECK listing all its states, and further CHECKs tie the other
// columns to the status, so a row can't claim a combination the router can't produce.

export const name = "init";

export const sql = /* sql */ `
CREATE TABLE accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  disabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Bumped by every ingest that changes a sandbox; a rollup only commits if it is unchanged.
  change_seq bigint NOT NULL DEFAULT 0,
  -- The earliest created_at of a sandbox changed since the last rollup: days from then on are
  -- computed live until the next sweep rolls them up again.
  rollup_dirty_from timestamptz,
  -- The last UTC day whose rollup is complete.
  rolled_through date,
  CHECK ((status = 'disabled') = (disabled_at IS NOT NULL))
);

CREATE TABLE api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts (id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  -- ingest: a router sends events. admin: the dashboard reads and manages keys.
  scope text NOT NULL CHECK (scope IN ('ingest', 'admin')),
  -- The key's first characters, to tell keys apart in a list. The key itself is never stored.
  prefix text NOT NULL,
  hash bytea NOT NULL UNIQUE,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  last_used_at timestamptz,
  CHECK ((state = 'revoked') = (revoked_at IS NOT NULL))
);
CREATE INDEX api_keys_account ON api_keys (account_id, created_at);

-- A router installation (one outbox, one ledger) sending to an account.
CREATE TABLE installs (
  account_id uuid NOT NULL REFERENCES accounts (id),
  id text NOT NULL CHECK (id ~ '^[A-Za-z0-9_-]{8,64}$'),
  router_version text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, id)
);

-- Every event taken, by its id: a resend is recognised here. Pruned by the sweep after 30 days;
-- an older resend still can't overwrite anything, since each row below keeps its own version.
CREATE TABLE ingest_events (
  account_id uuid NOT NULL,
  event_id text NOT NULL,
  install_id text NOT NULL,
  seq bigint NOT NULL CHECK (seq > 0),
  type text NOT NULL CHECK (type IN ('sandbox', 'mark', 'health', 'job', 'provider')),
  entity text NOT NULL,
  observed_at timestamptz NOT NULL,
  -- applied: it changed its row. stale: its row already held a newer state.
  outcome text NOT NULL CHECK (outcome IN ('applied', 'stale')),
  received_at timestamptz NOT NULL DEFAULT now(),
  payload jsonb NOT NULL,
  PRIMARY KEY (account_id, event_id),
  FOREIGN KEY (account_id, install_id) REFERENCES installs (account_id, id)
);
CREATE INDEX ingest_events_entity ON ingest_events (account_id, entity, observed_at);
CREATE INDEX ingest_events_received ON ingest_events (received_at);

-- The newest state of each sandbox, as the router recorded it. "expired" is never stored: it is
-- derived on read with the database's now(), by the router's effectiveState.
CREATE TABLE sandboxes (
  account_id uuid NOT NULL,
  id text NOT NULL,
  install_id text NOT NULL,
  provider text NOT NULL,
  state text NOT NULL CHECK (state IN ('creating', 'running', 'paused', 'stopped', 'failed')),
  cpu double precision NOT NULL CHECK (cpu >= 0),
  memory_mib integer NOT NULL CHECK (memory_mib >= 0),
  billing text CHECK (billing IN ('free', 'self-hosted', 'paid')),
  created_at timestamptz NOT NULL,
  timeout_sec double precision CHECK (timeout_sec >= 0),
  provider_sandbox_id text,
  expires_at timestamptz,
  ended_at timestamptz,
  stop_reason text CHECK (stop_reason IN ('killed', 'expired', 'gone')),
  segments jsonb NOT NULL CHECK (jsonb_typeof(segments) = 'array'),
  open_segments integer GENERATED ALWAYS AS (jsonb_array_length(jsonb_path_query_array(segments, '$[*] ? (!exists(@.end))'))) STORED,
  metadata jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(metadata) = 'object'),
  -- The version: newer (observed_at, seq) wins, older never overwrites.
  observed_at timestamptz NOT NULL,
  seq bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, id),
  FOREIGN KEY (account_id, install_id) REFERENCES installs (account_id, id),
  CHECK (state = 'creating' OR timeout_sec IS NULL),
  CHECK (state <> 'creating' OR (provider_sandbox_id IS NULL AND expires_at IS NULL AND segments = '[]'::jsonb)),
  CHECK (state NOT IN ('running', 'paused', 'stopped') OR provider_sandbox_id IS NOT NULL),
  CHECK (state <> 'running' OR expires_at IS NOT NULL),
  CHECK (state NOT IN ('stopped', 'failed') OR expires_at IS NULL),
  CHECK ((state IN ('stopped', 'failed')) = (ended_at IS NOT NULL)),
  CHECK ((state = 'stopped') = (stop_reason IS NOT NULL)),
  -- A segment is open exactly while the sandbox is running.
  CHECK ((state = 'running') = (open_segments = 1) AND open_segments <= 1)
);
CREATE INDEX sandboxes_created ON sandboxes (account_id, created_at DESC);
CREATE INDEX sandboxes_provider ON sandboxes (account_id, install_id, provider);
CREATE INDEX sandboxes_live ON sandboxes (account_id) WHERE state IN ('creating', 'running', 'paused');

-- A provider's refusal mark as the router holds it now. "cleared" when the router dropped it.
-- Whether it is in force, half-open or lapsed is derived on read (the router's quotaState).
CREATE TABLE marks (
  account_id uuid NOT NULL,
  install_id text NOT NULL,
  provider text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('quota', 'rate_limit', 'auth')),
  status text NOT NULL CHECK (status IN ('set', 'cleared')),
  at timestamptz,
  until timestamptz,
  refusals integer CHECK (refusals >= 1),
  observed_at timestamptz NOT NULL,
  seq bigint NOT NULL,
  PRIMARY KEY (account_id, install_id, provider, kind),
  FOREIGN KEY (account_id, install_id) REFERENCES installs (account_id, id),
  CHECK ((status = 'set') = (at IS NOT NULL)),
  CHECK ((status = 'set') = (until IS NOT NULL)),
  CHECK (status = 'set' OR refusals IS NULL),
  CHECK (kind = 'quota' OR refusals IS NULL)
);

-- Every refusal that set a mark: a fact, kept even after the mark is cleared.
CREATE TABLE refusals (
  account_id uuid NOT NULL,
  install_id text NOT NULL,
  provider text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('quota', 'rate_limit', 'auth')),
  at timestamptz NOT NULL,
  until timestamptz NOT NULL,
  refusals integer CHECK (refusals >= 1),
  PRIMARY KEY (account_id, install_id, provider, kind, at),
  FOREIGN KEY (account_id, install_id) REFERENCES installs (account_id, id),
  CHECK (kind = 'quota' OR refusals IS NULL)
);

-- Infrastructure outcomes per provider. Health and the circuit breaker are derived on read.
CREATE TABLE health_samples (
  account_id uuid NOT NULL,
  install_id text NOT NULL,
  provider text NOT NULL,
  sample_key text NOT NULL,
  at timestamptz NOT NULL,
  op text NOT NULL CHECK (op IN ('create', 'lost')),
  ok boolean NOT NULL,
  ms double precision CHECK (ms >= 0),
  kind text CHECK (kind IN ('quota', 'rate_limit', 'auth', 'not_found', 'unsupported', 'invalid', 'conflict', 'transient')),
  PRIMARY KEY (account_id, install_id, provider, sample_key),
  FOREIGN KEY (account_id, install_id) REFERENCES installs (account_id, id),
  CHECK (op <> 'lost' OR NOT ok),
  CHECK (ms IS NULL OR (ok AND op = 'create')),
  CHECK (NOT ok OR kind IS NULL)
);
CREATE INDEX health_samples_at ON health_samples (account_id, install_id, provider, at);

-- The newest state of each job. "orphaned" is never stored: derived on read from lease_until.
CREATE TABLE jobs (
  account_id uuid NOT NULL,
  id text NOT NULL,
  install_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('queued', 'placing', 'preparing', 'running', 'migrating', 'succeeded', 'failed', 'cancelled')),
  version integer NOT NULL CHECK (version >= 1),
  cursor integer NOT NULL CHECK (cursor >= 0),
  steps integer NOT NULL CHECK (steps >= 1),
  migrations integer NOT NULL CHECK (migrations >= 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  ended_at timestamptz,
  lease_until timestamptz,
  box jsonb,
  reason text CHECK (reason IN ('lost', 'stopped', 'provider-refused', 'unhealthy', 'deadline', 'free-credit', 'circuit-open', 'rebalance', 'oom', 'prepare-failed', 'orphaned')),
  placements jsonb NOT NULL CHECK (jsonb_typeof(placements) = 'array'),
  observed_at timestamptz NOT NULL,
  seq bigint NOT NULL,
  PRIMARY KEY (account_id, id),
  FOREIGN KEY (account_id, install_id) REFERENCES installs (account_id, id),
  CHECK (cursor <= steps),
  CHECK ((state IN ('placing', 'preparing', 'running', 'migrating')) = (lease_until IS NOT NULL)),
  CHECK ((state IN ('succeeded', 'failed', 'cancelled')) = (ended_at IS NOT NULL)),
  CHECK ((state = 'migrating') = (reason IS NOT NULL)),
  CHECK (state NOT IN ('preparing', 'running') OR box IS NOT NULL),
  CHECK (state IN ('preparing', 'running', 'migrating') OR box IS NULL)
);
CREATE INDEX jobs_created ON jobs (account_id, created_at DESC);

-- What each install knows about a provider: its free tier, prices and breaker settings, as the
-- router's config has them. Spend and free usage left are derived from these on read.
CREATE TABLE install_providers (
  account_id uuid NOT NULL,
  install_id text NOT NULL,
  provider text NOT NULL,
  snapshot jsonb NOT NULL CHECK (snapshot->'freeTier'->>'kind' IN ('none', 'one-time-credit', 'monthly-credit', 'monthly-hours', 'unlimited')),
  observed_at timestamptz NOT NULL,
  seq bigint NOT NULL,
  PRIMARY KEY (account_id, install_id, provider),
  FOREIGN KEY (account_id, install_id) REFERENCES installs (account_id, id),
  CHECK (snapshot->>'id' = provider)
);

-- Usage per closed UTC day, written by the sweep. Days not rolled up (or changed since) are
-- computed live by the same function.
CREATE TABLE usage_daily (
  account_id uuid NOT NULL REFERENCES accounts (id),
  day date NOT NULL,
  install_id text NOT NULL,
  provider text NOT NULL,
  sandboxes integer NOT NULL CHECK (sandboxes >= 0),
  sandbox_seconds double precision NOT NULL CHECK (sandbox_seconds >= 0),
  gib_seconds double precision NOT NULL CHECK (gib_seconds >= 0),
  usd double precision CHECK (usd >= 0),
  PRIMARY KEY (account_id, day, install_id, provider)
);

-- Usage for a private plugin (billing) to consume, delivered at least once: written in the
-- ingest's own transaction, claimed with a lease, marked delivered after the hook returns.
CREATE TABLE usage_events (
  id bigserial PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts (id),
  kind text NOT NULL CHECK (kind IN ('events.ingested')),
  quantity bigint NOT NULL CHECK (quantity > 0),
  at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivering', 'delivered')),
  lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  delivered_at timestamptz,
  CHECK ((status = 'delivering') = (lease_until IS NOT NULL)),
  CHECK ((status = 'delivered') = (delivered_at IS NOT NULL))
);
CREATE INDEX usage_events_undelivered ON usage_events (id) WHERE status <> 'delivered';
`;
