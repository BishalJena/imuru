-- Deny rules per role. No rule = allowed, so the default is "everything allowed".
CREATE TABLE tool_policies (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role         text NOT NULL CHECK (role IN ('admin', 'member')),
  server_slug  text NOT NULL,
  tool_pattern text NOT NULL CHECK (tool_pattern ~ '^[A-Za-z0-9_.*-]{1,128}$'),
  created_by   uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (role, server_slug, tool_pattern)
);
