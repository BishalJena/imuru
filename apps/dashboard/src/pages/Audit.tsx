import { useState } from "react";
import { api, type Me } from "../api.js";
import { useLoad } from "../hooks.js";

const OUTCOMES = [
  "",
  "ok",
  "tool_error",
  "timeout",
  "unreachable",
  "unknown_tool",
  "denied",
  "auth_rejected",
];

export function AuditPage({ me }: { me: Me }) {
  const [filter, setFilter] = useState({ server: "", outcome: "" });
  const query: Record<string, string> = { limit: "200" };
  if (filter.server) query.server = filter.server;
  if (filter.outcome) query.outcome = filter.outcome;
  const { data: rows, error } = useLoad(() => api.audit(query), 3000, [
    filter.server,
    filter.outcome,
  ]);

  return (
    <section>
      <header className="page-head">
        <h2>Audit log</h2>
        <span className="muted small">
          {me.role === "admin" ? "All users" : "Your calls"} · refreshes every 3s
        </span>
      </header>
      <div className="inline">
        <input
          placeholder="server slug"
          value={filter.server}
          onChange={(e) => setFilter({ ...filter, server: e.target.value })}
        />
        <select
          value={filter.outcome}
          onChange={(e) => setFilter({ ...filter, outcome: e.target.value })}
        >
          {OUTCOMES.map((o) => (
            <option key={o} value={o}>
              {o || "any outcome"}
            </option>
          ))}
        </select>
      </div>
      {error && <p className="error">{error}</p>}
      <table>
        <thead>
          <tr>
            <th>When</th>
            <th>User</th>
            <th>Via</th>
            <th>Server</th>
            <th>Tool</th>
            <th>Duration</th>
            <th>Outcome</th>
          </tr>
        </thead>
        <tbody>
          {rows?.map((r) => (
            <tr key={r.id}>
              <td>{new Date(r.ts).toLocaleString()}</td>
              <td>{r.user_email ?? "unknown"}</td>
              <td>{r.via}</td>
              <td>{r.server_slug ?? "-"}</td>
              <td className="mono">{r.tool ?? "-"}</td>
              <td>{r.duration_ms === null ? "-" : `${r.duration_ms} ms`}</td>
              <td>
                <span
                  className={`badge ${r.outcome === "ok" ? "connected" : "unreachable"}`}
                  title={r.error ?? ""}
                >
                  {r.outcome}
                </span>
                {r.error && <div className="muted small">{r.error}</div>}
              </td>
            </tr>
          ))}
          {rows?.length === 0 && (
            <tr>
              <td colSpan={7} className="muted">
                No calls yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  );
}
