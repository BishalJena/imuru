CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE,
  name          text NOT NULL,
  role          text NOT NULL CHECK (role IN ('admin', 'member')),
  password_hash text,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('invited', 'active', 'disabled')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE invites (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash  bytea NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  accepted_at timestamptz,
  created_by  uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id_hash    bytea PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

CREATE TABLE api_keys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  key_id       text NOT NULL UNIQUE,
  secret_hash  bytea NOT NULL,
  name         text NOT NULL,
  created_by   uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);
CREATE INDEX api_keys_user_idx ON api_keys (user_id);

CREATE TABLE servers (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug             text NOT NULL UNIQUE CHECK (slug ~ '^[a-z][a-z0-9-]{1,30}$' AND position('__' in slug) = 0),
  name             text NOT NULL,
  url              text NOT NULL,
  auth_type        text NOT NULL DEFAULT 'none' CHECK (auth_type IN ('none', 'bearer', 'header')),
  auth_header_name text,
  credential_enc   bytea,
  enabled          boolean NOT NULL DEFAULT true,
  managed          boolean NOT NULL DEFAULT false,
  timeout_ms       integer NOT NULL DEFAULT 30000 CHECK (timeout_ms BETWEEN 1000 AND 120000),
  position         integer NOT NULL DEFAULT 100,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id          bigserial PRIMARY KEY,
  ts          timestamptz NOT NULL DEFAULT now(),
  user_id     uuid REFERENCES users (id) ON DELETE SET NULL,
  user_email  text,
  api_key_id  uuid REFERENCES api_keys (id) ON DELETE SET NULL,
  via         text NOT NULL CHECK (via IN ('mcp', 'chat')),
  server_slug text,
  tool        text,
  duration_ms integer,
  outcome     text NOT NULL CHECK (outcome IN ('ok', 'tool_error', 'timeout', 'unreachable', 'unknown_tool', 'denied', 'auth_rejected')),
  error       text
);
CREATE INDEX audit_log_ts_idx ON audit_log (ts DESC);
CREATE INDEX audit_log_user_idx ON audit_log (user_id, ts DESC);
