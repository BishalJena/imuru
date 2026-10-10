import { useState } from "react";
import { api, type Me, type Server } from "../api.js";
import { useLoad } from "../hooks.js";

const STATUS_LABEL = {
  connected: "Connected",
  unreachable: "Unreachable",
  disabled: "Disabled",
} as const;

export function ServersPage({ me }: { me: Me }) {
  const { data: servers, error, reload } = useLoad(api.servers, 3000);
  const [editing, setEditing] = useState<Server | "new" | null>(null);
  const isAdmin = me.role === "admin";

  return (
    <section>
      <header className="page-head">
        <h2>MCP servers</h2>
        {isAdmin && <button onClick={() => setEditing("new")}>Add server</button>}
      </header>
      <p className="muted">
        Every enabled server's tools are available through one gateway endpoint as{" "}
        <code>&lt;server&gt;__&lt;tool&gt;</code>.
      </p>
      {error && <p className="error">{error}</p>}
      {editing && (
        <ServerForm
          server={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => (setEditing(null), void reload())}
        />
      )}
      <div className="cards">
        {servers?.map((s) => (
          <article key={s.id} className="card server">
            <div className="row">
              <div>
                <h3>
                  {s.name} <code className="muted">{s.slug}</code>
                </h3>
                {isAdmin && <div className="muted small mono">{s.url}</div>}
              </div>
              <span className={`badge ${s.status}`}>{STATUS_LABEL[s.status]}</span>
            </div>
            {isAdmin && s.status === "unreachable" && s.last_error && (
              <p className="error small">{s.last_error}</p>
            )}
            {isAdmin && (
              <div className="muted small">
                Auth: {s.auth_type}
                {s.auth_type === "header" && ` (${s.auth_header_name})`}
                {s.auth_type !== "none" &&
                  (s.has_credential ? " · credential set" : " · no credential")}
                {s.managed && " · managed by Helm"} · timeout {(s.timeout_ms ?? 0) / 1000}s
              </div>
            )}
            <details>
              <summary>{s.tools.length} tools</summary>
              <ul className="tools">
                {s.tools.map((t) => (
                  <li key={t.name}>
                    <code>
                      {s.slug}__{t.name}
                    </code>
                    <span className="muted small">{t.description}</span>
                  </li>
                ))}
              </ul>
            </details>
            {isAdmin && (
              <div className="actions">
                <button className="secondary" onClick={() => setEditing(s)}>
                  Edit
                </button>
                <button
                  className="secondary"
                  onClick={async () => {
                    await api.updateServer(s.id, { enabled: !s.enabled });
                    await reload();
                  }}
                >
                  {s.enabled ? "Disable" : "Enable"}
                </button>
                <button
                  className="danger"
                  onClick={async () => {
                    if (!window.confirm(`Remove ${s.name}? Its tools disappear for everyone.`))
                      return;
                    await api.deleteServer(s.id);
                    await reload();
                  }}
                >
                  Remove
                </button>
              </div>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}

function ServerForm({
  server,
  onClose,
  onSaved,
}: {
  server: Server | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState({
    slug: server?.slug ?? "",
    name: server?.name ?? "",
    url: server?.url ?? "",
    auth_type: server?.auth_type ?? "none",
    auth_header_name: server?.auth_header_name ?? "",
    credential: "",
    timeout_ms: String(server?.timeout_ms ?? 30000),
  });
  const [error, setError] = useState<string>();
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm({ ...form, [k]: e.target.value });

  return (
    <form
      className="card form"
      onSubmit={async (e) => {
        e.preventDefault();
        const body: Record<string, unknown> = {
          name: form.name,
          url: form.url,
          auth_type: form.auth_type,
          timeout_ms: Number(form.timeout_ms),
        };
        if (form.auth_type === "header") body.auth_header_name = form.auth_header_name;
        // Credentials are write-only: an empty field keeps the stored one.
        if (form.auth_type !== "none" && form.credential) body.credential = form.credential;
        try {
          if (server) await api.updateServer(server.id, body);
          else await api.createServer({ ...body, slug: form.slug });
          onSaved();
        } catch (err) {
          setError((err as Error).message);
        }
      }}
    >
      <h3>{server ? `Edit ${server.name}` : "Add an MCP server"}</h3>
      <div className="grid2">
        <label>
          Slug (tool prefix)
          <input
            value={form.slug}
            onChange={set("slug")}
            disabled={!!server}
            pattern="[a-z][a-z0-9-]{1,30}"
            required
          />
        </label>
        <label>
          Name
          <input value={form.name} onChange={set("name")} required />
        </label>
      </div>
      <label>
        Streamable HTTP URL
        <input
          value={form.url}
          onChange={set("url")}
          placeholder="https://example.com/mcp"
          required
        />
      </label>
      <div className="grid2">
        <label>
          Credential type
          <select value={form.auth_type} onChange={set("auth_type")}>
            <option value="none">None</option>
            <option value="bearer">Bearer token</option>
            <option value="header">Custom header</option>
          </select>
        </label>
        <label>
          Timeout (ms)
          <input
            type="number"
            min={1000}
            max={120000}
            value={form.timeout_ms}
            onChange={set("timeout_ms")}
          />
        </label>
      </div>
      {form.auth_type === "header" && (
        <label>
          Header name
          <input
            value={form.auth_header_name}
            onChange={set("auth_header_name")}
            placeholder="X-Api-Key"
            required
          />
        </label>
      )}
      {form.auth_type !== "none" && (
        <label>
          {server?.has_credential
            ? "Replace credential (leave empty to keep the current one)"
            : "Credential"}
          <input
            type="password"
            autoComplete="off"
            value={form.credential}
            onChange={set("credential")}
            required={!server?.has_credential}
          />
        </label>
      )}
      {error && <p className="error">{error}</p>}
      <div className="actions">
        <button>{server ? "Save" : "Add server"}</button>
        <button type="button" className="secondary" onClick={onClose}>
          Cancel
        </button>
      </div>
    </form>
  );
}
