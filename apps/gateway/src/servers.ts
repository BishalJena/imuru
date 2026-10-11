import type { Sealer } from "./crypto.js";
import type { Db } from "./db.js";
import { SLUG_PATTERN, type Registry } from "./registry.js";
import type { UpstreamConfig } from "./upstream.js";

export type AuthType = "none" | "bearer" | "header";

export interface ServerRow {
  id: string;
  slug: string;
  name: string;
  url: string;
  auth_type: AuthType;
  auth_header_name: string | null;
  credential_enc: Buffer | null;
  enabled: boolean;
  managed: boolean;
  timeout_ms: number;
  position: number;
  created_at: string;
  updated_at: string;
}

export interface ServerInput {
  slug: string;
  name: string;
  url: string;
  auth_type: AuthType;
  auth_header_name?: string | null | undefined;
  /** Plain credential; undefined = keep the stored one, null = clear it. */
  credential?: string | null | undefined;
  enabled?: boolean | undefined;
  timeout_ms?: number | undefined;
}

export interface SeedServer extends ServerInput {
  credential: string | null;
}

export class ServerService {
  constructor(
    private readonly db: Db,
    private readonly sealer: Sealer,
    private readonly registry: Registry,
    private readonly connectTimeoutMs: number,
    /** fetch for admin-added servers; managed (Helm-seeded) servers use the default. */
    private readonly guardedFetch?: typeof fetch,
  ) {}

  async list(): Promise<ServerRow[]> {
    return (await this.db.query<ServerRow>("SELECT * FROM servers ORDER BY position, created_at"))
      .rows;
  }

  async get(id: string): Promise<ServerRow | null> {
    return (
      (await this.db.query<ServerRow>("SELECT * FROM servers WHERE id = $1", [id])).rows[0] ?? null
    );
  }

  /**
   * Servers from Helm values. Inserted when absent; an existing managed row
   * keeps the admin's enabled/name edits but takes URL and credential from
   * values, which are the source of truth for in-cluster wiring. A managed
   * server the admin deleted stays deleted (tombstone).
   */
  async seed(seeds: SeedServer[]): Promise<void> {
    await this.db.query("CREATE TABLE IF NOT EXISTS removed_seeds (slug text PRIMARY KEY)");
    for (const [i, s] of seeds.entries()) {
      const removed = await this.db.query("SELECT 1 FROM removed_seeds WHERE slug = $1", [s.slug]);
      if (removed.rowCount) continue;
      await this.db.query(
        `INSERT INTO servers (slug, name, url, auth_type, auth_header_name, credential_enc, managed, timeout_ms, position)
         VALUES ($1, $2, $3, $4, $5, $6, true, $7, $8)
         ON CONFLICT (slug) DO UPDATE SET url = EXCLUDED.url, auth_type = EXCLUDED.auth_type,
           auth_header_name = EXCLUDED.auth_header_name, credential_enc = EXCLUDED.credential_enc,
           timeout_ms = EXCLUDED.timeout_ms, managed = true, updated_at = now()`,
        [
          s.slug,
          s.name,
          s.url,
          s.auth_type,
          s.auth_header_name ?? null,
          s.credential ? this.sealer.seal(s.credential) : null,
          s.timeout_ms ?? 30000,
          i,
        ],
      );
    }
  }

  /** Load every server into the live registry (startup). */
  async loadAll(): Promise<void> {
    for (const row of await this.list()) await this.registry.replace(this.toUpstream(row));
  }

  async create(input: ServerInput): Promise<ServerRow> {
    const r = await this.db.query<ServerRow>(
      `INSERT INTO servers (slug, name, url, auth_type, auth_header_name, credential_enc, enabled, timeout_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [
        input.slug,
        input.name,
        input.url,
        input.auth_type,
        input.auth_type === "header" ? input.auth_header_name : null,
        input.credential ? this.sealer.seal(input.credential) : null,
        input.enabled ?? true,
        input.timeout_ms ?? 30000,
      ],
    );
    const row = r.rows[0]!;
    await this.registry.replace(this.toUpstream(row));
    return row;
  }

  async update(
    id: string,
    patch: { [K in keyof ServerInput]?: ServerInput[K] | undefined },
  ): Promise<ServerRow | null> {
    const current = await this.get(id);
    if (!current) return null;
    const next = {
      name: patch.name ?? current.name,
      url: patch.url ?? current.url,
      auth_type: patch.auth_type ?? current.auth_type,
      auth_header_name:
        patch.auth_header_name !== undefined ? patch.auth_header_name : current.auth_header_name,
      credential_enc:
        patch.credential === undefined
          ? current.credential_enc
          : patch.credential === null
            ? null
            : this.sealer.seal(patch.credential),
      enabled: patch.enabled ?? current.enabled,
      timeout_ms: patch.timeout_ms ?? current.timeout_ms,
    };
    if (next.auth_type !== "header") next.auth_header_name = null;
    if (next.auth_type === "none") next.credential_enc = null;
    const r = await this.db.query<ServerRow>(
      `UPDATE servers SET name = $2, url = $3, auth_type = $4, auth_header_name = $5, credential_enc = $6,
         enabled = $7, timeout_ms = $8, updated_at = now() WHERE id = $1 RETURNING *`,
      [
        id,
        next.name,
        next.url,
        next.auth_type,
        next.auth_header_name,
        next.credential_enc,
        next.enabled,
        next.timeout_ms,
      ],
    );
    const row = r.rows[0]!;
    const connectionChanged =
      row.url !== current.url ||
      row.auth_type !== current.auth_type ||
      row.auth_header_name !== current.auth_header_name ||
      patch.credential !== undefined ||
      row.timeout_ms !== current.timeout_ms ||
      row.name !== current.name;
    const live = this.registry.get(row.slug);
    if (connectionChanged || !live) {
      await this.registry.replace(this.toUpstream(row));
    } else if (row.enabled !== current.enabled) {
      await live.setEnabled(row.enabled);
    }
    return row;
  }

  async remove(id: string): Promise<boolean> {
    const r = await this.db.query<{ slug: string; managed: boolean }>(
      "DELETE FROM servers WHERE id = $1 RETURNING slug, managed",
      [id],
    );
    const row = r.rows[0];
    if (!row) return false;
    if (row.managed) {
      await this.db.query("INSERT INTO removed_seeds (slug) VALUES ($1) ON CONFLICT DO NOTHING", [
        row.slug,
      ]);
    }
    await this.registry.remove(row.slug);
    return true;
  }

  /**
   * Register or update a provisioned store's server by slug. Only rows the
   * provisioner owns (managed) are overwritten; returns null on a conflict
   * with an admin-created server.
   */
  async upsertManaged(input: {
    slug: string;
    name: string;
    url: string;
    credential: string;
  }): Promise<ServerRow | null> {
    const r = await this.db.query<ServerRow>(
      `INSERT INTO servers (slug, name, url, auth_type, credential_enc, managed)
       VALUES ($1, $2, $3, 'bearer', $4, true)
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, url = EXCLUDED.url, auth_type = 'bearer',
         credential_enc = EXCLUDED.credential_enc, updated_at = now()
       WHERE servers.managed
       RETURNING *`,
      [input.slug, input.name, input.url, this.sealer.seal(input.credential)],
    );
    const row = r.rows[0];
    if (!row) return null;
    const live = this.registry.get(row.slug);
    if (
      !live ||
      live.config.url !== row.url ||
      live.config.auth?.type !== "bearer" ||
      live.config.auth.token !== input.credential
    ) {
      await this.registry.replace(this.toUpstream(row));
    }
    return row;
  }

  /** Remove a provisioned store's server; admin-created servers are never touched. */
  async removeBySlug(slug: string): Promise<boolean> {
    const r = await this.db.query("DELETE FROM servers WHERE slug = $1 AND managed", [slug]);
    if (!r.rowCount) return false;
    await this.registry.remove(slug);
    return true;
  }

  /** API view: status from the live registry; never the URL's credential. */
  view(row: ServerRow, opts: { admin: boolean }) {
    const live = this.registry.get(row.slug);
    const base = {
      id: row.id,
      slug: row.slug,
      name: row.name,
      enabled: row.enabled,
      status: live?.status ?? (row.enabled ? "unreachable" : "disabled"),
      tools: (live?.tools ?? []).map((t) => ({ name: t.name, description: t.description ?? "" })),
    };
    if (!opts.admin) return base;
    return {
      ...base,
      url: row.url,
      auth_type: row.auth_type,
      auth_header_name: row.auth_header_name,
      has_credential: row.credential_enc !== null,
      managed: row.managed,
      timeout_ms: row.timeout_ms,
      last_error: live?.lastError ?? null,
      updated_at: row.updated_at,
    };
  }

  private toUpstream(row: ServerRow): UpstreamConfig {
    const cred = row.credential_enc ? this.sealer.open(row.credential_enc) : null;
    const auth: UpstreamConfig["auth"] =
      row.auth_type === "bearer" && cred
        ? { type: "bearer", token: cred }
        : row.auth_type === "header" && cred && row.auth_header_name
          ? { type: "header", header: row.auth_header_name, value: cred }
          : undefined;
    return {
      slug: row.slug,
      name: row.name,
      url: row.url,
      ...(auth ? { auth } : {}),
      enabled: row.enabled,
      timeoutMs: row.timeout_ms,
      connectTimeoutMs: this.connectTimeoutMs,
      ...(!row.managed && this.guardedFetch ? { fetch: this.guardedFetch } : {}),
    };
  }
}

export { SLUG_PATTERN };
