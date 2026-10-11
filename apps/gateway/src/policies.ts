import type { Principal } from "./auth.js";
import type { Db } from "./db.js";
import type { Role } from "./repo.js";

export interface PolicyRule {
  id: string;
  role: Role;
  server_slug: string;
  tool_pattern: string;
  created_at: string;
}

const compiled = new Map<string, RegExp>();

/** `*` matches any run of characters; patterns are compiled once and reused. */
export function matches(pattern: string, value: string): boolean {
  let re = compiled.get(pattern);
  if (!re) {
    re = toRegExp(pattern);
    compiled.set(pattern, re);
  }
  return re.test(value);
}

function toRegExp(pattern: string): RegExp {
  return new RegExp(
    `^${pattern
      .split("*")
      .map((p) => p.replace(/[.+?^${}()|[\]\\-]/g, "\\$&"))
      .join(".*")}$`,
  );
}

/**
 * Tool permissions as deny rules per role, cached in memory and reloaded on
 * change. With no rules every tool is allowed, which is the default the core
 * flow relies on.
 */
export class Policies {
  private rules: PolicyRule[] = [];

  constructor(
    private readonly db: Db,
    private readonly onChange: () => void,
  ) {}

  async load(): Promise<void> {
    this.rules = (
      await this.db.query<PolicyRule>(
        "SELECT id, role, server_slug, tool_pattern, created_at FROM tool_policies ORDER BY created_at",
      )
    ).rows;
  }

  list(): PolicyRule[] {
    return this.rules;
  }

  isAllowed = (principal: Principal, server: string, tool: string): boolean =>
    !this.rules.some(
      (r) =>
        r.role === principal.role &&
        matches(r.server_slug, server) &&
        matches(r.tool_pattern, tool),
    );

  async add(rule: {
    role: Role;
    server_slug: string;
    tool_pattern: string;
    createdBy: string;
  }): Promise<PolicyRule> {
    const r = await this.db.query<PolicyRule>(
      `INSERT INTO tool_policies (role, server_slug, tool_pattern, created_by) VALUES ($1, $2, $3, $4)
       ON CONFLICT (role, server_slug, tool_pattern) DO UPDATE SET role = EXCLUDED.role
       RETURNING id, role, server_slug, tool_pattern, created_at`,
      [rule.role, rule.server_slug, rule.tool_pattern, rule.createdBy],
    );
    await this.load();
    this.onChange();
    return r.rows[0]!;
  }

  async remove(id: string): Promise<boolean> {
    const r = await this.db.query("DELETE FROM tool_policies WHERE id = $1", [id]);
    await this.load();
    this.onChange();
    return (r.rowCount ?? 0) > 0;
  }
}
