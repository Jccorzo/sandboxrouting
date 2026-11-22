// People and their sign-ins: a GitHub user owns one account and signs in to the dashboard with a
// session. Keys (api_keys) stay as they are, for routers and scripts.
//
// One GitHub user owns at most one account (the partial unique index): signing in again finds it,
// so a loop of sign-ins can't make a loop of accounts. A session is "active" or "revoked";
// whether an active one has expired is decided on read with the database's now(), never stored.

export const name = "users";

export const sql = /* sql */ `
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  github_id bigint NOT NULL UNIQUE CHECK (github_id > 0),
  login text NOT NULL CHECK (length(login) BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE account_members (
  account_id uuid NOT NULL REFERENCES accounts (id),
  user_id uuid NOT NULL REFERENCES users (id),
  role text NOT NULL CHECK (role IN ('owner')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, user_id)
);
CREATE UNIQUE INDEX account_members_one_owned ON account_members (user_id) WHERE role = 'owner';

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  user_id uuid NOT NULL,
  -- SHA-256 of the session token; the token itself is never stored.
  hash bytea NOT NULL UNIQUE,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_used_at timestamptz,
  -- A session belongs to a membership: removing someone from an account means revoking their
  -- sessions in the same transaction first.
  FOREIGN KEY (account_id, user_id) REFERENCES account_members (account_id, user_id),
  CHECK (expires_at > created_at),
  CHECK ((state = 'revoked') = (revoked_at IS NOT NULL))
);
CREATE INDEX sessions_user ON sessions (user_id, created_at);
`;
