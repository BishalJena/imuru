-- Desired state for provisioned stores. The provisioner reconciles it.
CREATE TABLE stores (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug       text NOT NULL UNIQUE CHECK (slug ~ '^[a-z][a-z0-9-]{1,19}$' AND position('--' in slug) = 0),
  owner_id   uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  desired    text NOT NULL DEFAULT 'present' CHECK (desired IN ('present', 'absent')),
  status     text NOT NULL DEFAULT 'provisioning' CHECK (status IN ('provisioning', 'ready', 'failed', 'deleting')),
  reason     text,
  url        text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stores_owner_idx ON stores (owner_id);
