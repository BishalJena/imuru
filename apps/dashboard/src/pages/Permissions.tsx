import { useState } from "react";
import { api, type Role } from "../api.js";
import { fmtTime, useLoad } from "../hooks.js";

export function PermissionsPage() {
  const { data: rules, reload } = useLoad(api.policies);
  const { data: servers } = useLoad(api.servers);
  const [form, setForm] = useState({ role: "member" as Role, server_slug: "", tool_pattern: "" });
  const [error, setError] = useState<string>();
  const tools = servers?.find((s) => s.slug === form.server_slug)?.tools ?? [];

  return (
    <section>
      <header className="page-head">
        <h2>Tool permissions</h2>
      </header>
      <p className="muted">
        Everything is allowed unless a rule below denies it. Denied tools are hidden from that
        role's tool list and rejected if called directly; attempts appear in the audit log as{" "}
        <code>denied</code>. Use <code>*</code> as a wildcard.
      </p>
      <form
        className="inline"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            setError(undefined);
            await api.addPolicy(form);
            setForm({ ...form, tool_pattern: "" });
            await reload();
          } catch (err) {
            setError((err as Error).message);
          }
        }}
      >
        <select
          value={form.role}
          onChange={(e) => setForm({ ...form, role: e.target.value as Role })}
        >
          <option value="member">members</option>
          <option value="admin">admins</option>
        </select>
        <span className="muted">may not call</span>
        <select
          value={form.server_slug}
          onChange={(e) => setForm({ ...form, server_slug: e.target.value })}
          required
        >
          <option value="">server…</option>
          <option value="*">any server (*)</option>
          {servers?.map((s) => (
            <option key={s.slug} value={s.slug}>
              {s.slug}
            </option>
          ))}
        </select>
        <input
          list="tool-names"
          placeholder="tool or pattern, e.g. create_*"
          value={form.tool_pattern}
          onChange={(e) => setForm({ ...form, tool_pattern: e.target.value })}
          required
        />
        <datalist id="tool-names">
          {tools.map((t) => (
            <option key={t.name} value={t.name} />
          ))}
        </datalist>
        <button>Add rule</button>
      </form>
      {error && <p className="error">{error}</p>}
      <table>
        <thead>
          <tr>
            <th>Role</th>
            <th>Denied tool</th>
            <th>Since</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rules?.map((r) => (
            <tr key={r.id}>
              <td>{r.role}</td>
              <td className="mono">
                {r.server_slug}__{r.tool_pattern}
              </td>
              <td>{fmtTime(r.created_at)}</td>
              <td>
                <button
                  className="danger small"
                  onClick={async () => (await api.removePolicy(r.id), reload())}
                >
                  Remove
                </button>
              </td>
            </tr>
          ))}
          {rules?.length === 0 && (
            <tr>
              <td colSpan={4} className="muted">
                No rules: every role can use every tool.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  );
}
