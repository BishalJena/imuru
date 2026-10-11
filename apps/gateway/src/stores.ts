import type { Db } from "./db.js";

export type StoreStatus = "provisioning" | "ready" | "failed" | "deleting";

export interface StoreRow {
  id: string;
  slug: string;
  owner_id: string;
  owner_email?: string;
  desired: "present" | "absent";
  status: StoreStatus;
  reason: string | null;
  url: string | null;
  created_at: string;
  updated_at: string;
}

/** 2-20 chars; prefixed with "store-" it must still be a DNS label (no trailing dash). */
export const STORE_SLUG = /^[a-z][a-z0-9-]{0,18}[a-z0-9]$/;
/** Server slug under which a store's MCP server is registered. */
export const storeServerSlug = (slug: string) => `store-${slug}`;

export class StoreService {
  constructor(
    private readonly db: Db,
    private readonly maxPerUser: number,
  ) {}

  async list(ownerId?: string): Promise<StoreRow[]> {
    const r = await this.db.query<StoreRow>(
      `SELECT s.*, u.email AS owner_email FROM stores s JOIN users u ON u.id = s.owner_id
       ${ownerId ? "WHERE s.owner_id = $1" : ""} ORDER BY s.created_at`,
      ownerId ? [ownerId] : [],
    );
    return r.rows;
  }

  async bySlug(slug: string): Promise<StoreRow | null> {
    return (
      (await this.db.query<StoreRow>("SELECT * FROM stores WHERE slug = $1", [slug])).rows[0] ??
      null
    );
  }

  async get(id: string): Promise<StoreRow | null> {
    return (
      (await this.db.query<StoreRow>("SELECT * FROM stores WHERE id = $1", [id])).rows[0] ?? null
    );
  }

  /**
   * Creating is idempotent per owner and slug: retrying a create returns the
   * existing store (and re-queues it if it had failed) instead of a duplicate.
   */
  async create(
    ownerId: string,
    slug: string,
  ): Promise<{ store: StoreRow } | { error: "limit" | "taken" }> {
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      // Serialise creates per owner so two parallel requests cannot both pass the limit check.
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [ownerId]);
      const existing = (
        await client.query<StoreRow>("SELECT * FROM stores WHERE slug = $1", [slug])
      ).rows[0];
      if (existing) {
        await client.query("ROLLBACK");
        if (existing.owner_id !== ownerId || existing.desired === "absent")
          return { error: "taken" };
        if (existing.status === "failed") {
          const r = await this.db.query<StoreRow>(
            "UPDATE stores SET status = 'provisioning', reason = NULL, updated_at = now() WHERE id = $1 RETURNING *",
            [existing.id],
          );
          return { store: r.rows[0]! };
        }
        return { store: existing };
      }
      const count = (
        await client.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM stores WHERE owner_id = $1 AND desired = 'present'",
          [ownerId],
        )
      ).rows[0]!.n;
      if (count >= this.maxPerUser) {
        await client.query("ROLLBACK");
        return { error: "limit" };
      }
      const r = await client.query<StoreRow>(
        "INSERT INTO stores (slug, owner_id) VALUES ($1, $2) RETURNING *",
        [slug, ownerId],
      );
      await client.query("COMMIT");
      return { store: r.rows[0]! };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async requestDelete(id: string): Promise<StoreRow | null> {
    const r = await this.db.query<StoreRow>(
      "UPDATE stores SET desired = 'absent', status = 'deleting', updated_at = now() WHERE id = $1 RETURNING *",
      [id],
    );
    return r.rows[0] ?? null;
  }

  /** Work for the provisioner: stores that are not yet in their desired state. */
  async pending(): Promise<StoreRow[]> {
    return (
      await this.db.query<StoreRow>(
        `SELECT * FROM stores WHERE (desired = 'present' AND status = 'provisioning') OR desired = 'absent'
         ORDER BY updated_at`,
      )
    ).rows;
  }

  async report(
    id: string,
    patch: { status: StoreStatus; reason?: string | null; url?: string | null },
  ) {
    const r = await this.db.query<StoreRow>(
      `UPDATE stores SET status = $2, reason = $3, url = COALESCE($4, url), updated_at = now()
       WHERE id = $1 RETURNING *`,
      [id, patch.status, patch.reason ?? null, patch.url ?? null],
    );
    return r.rows[0] ?? null;
  }

  async purge(id: string): Promise<boolean> {
    const r = await this.db.query("DELETE FROM stores WHERE id = $1 AND desired = 'absent'", [id]);
    return (r.rowCount ?? 0) > 0;
  }
}
