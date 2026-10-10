import type { Db } from "./db.js";
import { generateApiKey, hashPassword, randomToken, sha256 } from "./crypto.js";

export type Role = "admin" | "member";

export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  status: "invited" | "active" | "disabled";
  created_at: string;
}

const USER_COLS = "id, email, name, role, status, created_at";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export class Repo {
  constructor(readonly db: Db) {}

  // Users ---------------------------------------------------------------

  async ensureAdmin(email: string, name: string, password: string): Promise<void> {
    const existing = await this.db.query("SELECT 1 FROM users WHERE role = 'admin' LIMIT 1");
    if (existing.rowCount) return;
    await this.db.query(
      "INSERT INTO users (email, name, role, password_hash, status) VALUES ($1, $2, 'admin', $3, 'active') ON CONFLICT (email) DO NOTHING",
      [email.toLowerCase(), name, await hashPassword(password)],
    );
  }

  async userByEmailWithHash(
    email: string,
  ): Promise<(User & { password_hash: string | null }) | null> {
    const r = await this.db.query(
      `SELECT ${USER_COLS}, password_hash FROM users WHERE email = $1`,
      [email.toLowerCase()],
    );
    return r.rows[0] ?? null;
  }

  async userById(id: string): Promise<User | null> {
    const r = await this.db.query(`SELECT ${USER_COLS} FROM users WHERE id = $1`, [id]);
    return r.rows[0] ?? null;
  }

  async listUsers(): Promise<User[]> {
    return (await this.db.query(`SELECT ${USER_COLS} FROM users ORDER BY created_at`)).rows;
  }

  async updateUser(
    id: string,
    patch: { role?: Role | undefined; status?: "active" | "disabled" | undefined },
  ): Promise<User | null> {
    const r = await this.db.query(
      `UPDATE users SET role = COALESCE($2, role), status = COALESCE($3, status) WHERE id = $1 RETURNING ${USER_COLS}`,
      [id, patch.role ?? null, patch.status ?? null],
    );
    if (patch.status === "disabled")
      await this.db.query("DELETE FROM sessions WHERE user_id = $1", [id]);
    return r.rows[0] ?? null;
  }

  async countActiveAdmins(): Promise<number> {
    const r = await this.db.query(
      "SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND status = 'active'",
    );
    return r.rows[0].n;
  }

  // Sessions (dashboard cookie) ------------------------------------------

  async createSession(userId: string): Promise<{ token: string; expiresAt: Date }> {
    const token = randomToken(32);
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await this.db.query("INSERT INTO sessions (id_hash, user_id, expires_at) VALUES ($1, $2, $3)", [
      sha256(token),
      userId,
      expiresAt,
    ]);
    return { token, expiresAt };
  }

  async userBySession(token: string): Promise<User | null> {
    const r = await this.db.query(
      `SELECT ${USER_COLS.split(", ")
        .map((c) => `u.${c}`)
        .join(", ")} FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id_hash = $1 AND s.expires_at > now() AND u.status = 'active'`,
      [sha256(token)],
    );
    return r.rows[0] ?? null;
  }

  async deleteSession(token: string): Promise<void> {
    await this.db.query("DELETE FROM sessions WHERE id_hash = $1", [sha256(token)]);
  }

  // Invites -------------------------------------------------------------

  async createInvite(input: { email: string; name: string; role: Role; createdBy: string }) {
    const email = input.email.toLowerCase();
    const existing = await this.db.query("SELECT id, status FROM users WHERE email = $1", [email]);
    if (existing.rows[0] && existing.rows[0].status !== "invited")
      return { error: "exists" as const };
    const userId: string =
      existing.rows[0]?.id ??
      (
        await this.db.query(
          "INSERT INTO users (email, name, role, status) VALUES ($1, $2, $3, 'invited') RETURNING id",
          [email, input.name, input.role],
        )
      ).rows[0].id;
    const token = randomToken(32);
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
    await this.db.query(
      "INSERT INTO invites (user_id, token_hash, expires_at, created_by) VALUES ($1, $2, $3, $4)",
      [userId, sha256(token), expiresAt, input.createdBy],
    );
    return { token, expiresAt, userId };
  }

  async inviteInfo(token: string): Promise<{ email: string; name: string } | null> {
    const r = await this.db.query(
      `SELECT u.email, u.name FROM invites i JOIN users u ON u.id = i.user_id
       WHERE i.token_hash = $1 AND i.accepted_at IS NULL AND i.expires_at > now() AND u.status = 'invited'`,
      [sha256(token)],
    );
    return r.rows[0] ?? null;
  }

  async acceptInvite(token: string, password: string, name?: string): Promise<User | null> {
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      const r = await client.query(
        `UPDATE invites SET accepted_at = now()
         WHERE token_hash = $1 AND accepted_at IS NULL AND expires_at > now() RETURNING user_id`,
        [sha256(token)],
      );
      if (!r.rowCount) {
        await client.query("ROLLBACK");
        return null;
      }
      const u = await client.query(
        `UPDATE users SET password_hash = $2, status = 'active', name = COALESCE($3, name)
         WHERE id = $1 AND status = 'invited' RETURNING ${USER_COLS}`,
        [r.rows[0].user_id, await hashPassword(password), name ?? null],
      );
      if (!u.rowCount) {
        await client.query("ROLLBACK");
        return null;
      }
      await client.query("COMMIT");
      return u.rows[0];
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  // API keys ------------------------------------------------------------

  async createApiKey(userId: string, name: string, createdBy: string) {
    const { key, keyId, secretHash } = generateApiKey();
    const r = await this.db.query(
      `INSERT INTO api_keys (user_id, key_id, secret_hash, name, created_by) VALUES ($1, $2, $3, $4, $5)
       RETURNING id, key_id, name, created_at`,
      [userId, keyId, secretHash, name, createdBy],
    );
    return { ...r.rows[0], key } as {
      id: string;
      key_id: string;
      name: string;
      created_at: string;
      key: string;
    };
  }

  async listApiKeys(userId?: string) {
    const r = await this.db.query(
      `SELECT k.id, k.key_id, k.name, k.user_id, u.email AS user_email, k.created_at, k.last_used_at, k.revoked_at
       FROM api_keys k JOIN users u ON u.id = k.user_id
       ${userId ? "WHERE k.user_id = $1" : ""} ORDER BY k.created_at DESC`,
      userId ? [userId] : [],
    );
    return r.rows;
  }

  async revokeApiKey(id: string, userId?: string): Promise<boolean> {
    const r = await this.db.query(
      `UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL ${userId ? "AND user_id = $2" : ""}`,
      userId ? [id, userId] : [id],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async apiKeyByKeyId(keyId: string) {
    const r = await this.db.query(
      `SELECT k.id, k.user_id, k.secret_hash, k.revoked_at, u.email, u.role, u.status
       FROM api_keys k JOIN users u ON u.id = k.user_id WHERE k.key_id = $1`,
      [keyId],
    );
    return (r.rows[0] ?? null) as {
      id: string;
      user_id: string;
      secret_hash: Buffer;
      revoked_at: string | null;
      email: string;
      role: Role;
      status: string;
    } | null;
  }

  async touchApiKey(id: string): Promise<void> {
    // At most one write per key per minute.
    await this.db.query(
      "UPDATE api_keys SET last_used_at = now() WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')",
      [id],
    );
  }

  // Audit ---------------------------------------------------------------

  async audit(row: {
    userId: string | null;
    userEmail: string | null;
    apiKeyId: string | null;
    via: "mcp" | "chat";
    server: string | null;
    tool: string | null;
    durationMs: number | null;
    outcome: string;
    error?: string | null;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO audit_log (user_id, user_email, api_key_id, via, server_slug, tool, duration_ms, outcome, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        row.userId,
        row.userEmail,
        row.apiKeyId,
        row.via,
        row.server,
        row.tool,
        row.durationMs,
        row.outcome,
        row.error ?? null,
      ],
    );
  }

  async listAudit(filter: {
    userId?: string;
    server?: string;
    outcome?: string;
    since?: string;
    limit: number;
  }) {
    const where: string[] = [];
    const args: unknown[] = [];
    const add = (sql: string, v: unknown) => {
      args.push(v);
      where.push(sql.replace("?", `$${args.length}`));
    };
    if (filter.userId) add("user_id = ?", filter.userId);
    if (filter.server) add("server_slug = ?", filter.server);
    if (filter.outcome) add("outcome = ?", filter.outcome);
    if (filter.since) add("ts >= ?", filter.since);
    args.push(filter.limit);
    const r = await this.db.query(
      `SELECT id, ts, user_id, user_email, via, server_slug, tool, duration_ms, outcome, error FROM audit_log
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY ts DESC, id DESC LIMIT $${args.length}`,
      args,
    );
    return r.rows;
  }
}
