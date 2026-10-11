-- Store slugs become namespace and release names (store-<slug>): they must not end with a dash.
ALTER TABLE stores DROP CONSTRAINT stores_slug_check;
ALTER TABLE stores ADD CONSTRAINT stores_slug_check
  CHECK (slug ~ '^[a-z][a-z0-9-]{0,18}[a-z0-9]$' AND position('--' in slug) = 0);
