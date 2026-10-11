-- Managed (Helm-seeded) servers an admin deleted; seeding skips them so they stay deleted.
CREATE TABLE IF NOT EXISTS removed_seeds (slug text PRIMARY KEY);
