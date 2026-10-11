import { useState } from "react";
import { api } from "../api.js";
import { fmtTime, useLoad } from "../hooks.js";

export function KeysPage() {
  const { data: keys, reload } = useLoad(api.myKeys);
  const { data: config } = useLoad(api.config);
  const [name, setName] = useState("");
  const [created, setCreated] = useState<string>();
  const [error, setError] = useState<string>();

  const url = config?.mcp_url ?? "";
  const snippet = created
    ? JSON.stringify(
        {
          mcpServers: {
            urumi: { type: "http", url, headers: { Authorization: `Bearer ${created}` } },
          },
        },
        null,
        2,
      )
    : "";

  return (
    <section>
      <header className="page-head">
        <h2>My API keys</h2>
      </header>
      <p className="muted">
        Use one key per MCP client. The gateway endpoint is <code>{url}</code>.
      </p>
      <form
        className="inline"
        onSubmit={async (e) => {
          e.preventDefault();
          setError(undefined);
          try {
            setCreated((await api.createKey(name)).key);
            setName("");
            await reload();
          } catch (err) {
            setError((err as Error).message);
          }
        }}
      >
        <input
          placeholder="Key name, e.g. laptop-claude-code"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <button>Generate key</button>
      </form>
      {error && <p className="error">{error}</p>}
      {created && (
        <div className="card reveal">
          <strong>Copy this key now. It is shown only once.</strong>
          <pre className="mono">{created}</pre>
          <div className="muted small">Claude Code:</div>
          <pre className="mono">{`claude mcp add --transport http urumi ${url} --header "Authorization: Bearer ${created}"`}</pre>
          <div className="muted small">Cursor / .mcp.json:</div>
          <pre className="mono">{snippet}</pre>
          <button className="secondary" onClick={() => setCreated(undefined)}>
            Done
          </button>
        </div>
      )}
      <KeyTable keys={keys ?? []} onRevoke={async (id) => (await api.revokeKey(id), reload())} />
    </section>
  );
}

export function KeyTable({
  keys,
  onRevoke,
  showUser,
}: {
  keys: {
    id: string;
    key_id: string;
    name: string;
    user_email: string;
    created_at: string;
    last_used_at: string | null;
    revoked_at: string | null;
  }[];
  onRevoke: (id: string) => Promise<unknown>;
  showUser?: boolean;
}) {
  return (
    <table>
      <thead>
        <tr>
          <th>Name</th>
          {showUser && <th>User</th>}
          <th>Key</th>
          <th>Created</th>
          <th>Last used</th>
          <th>Status</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {keys.map((k) => (
          <tr key={k.id} className={k.revoked_at ? "dim" : ""}>
            <td>{k.name}</td>
            {showUser && <td>{k.user_email}</td>}
            <td className="mono">urk_{k.key_id}_…</td>
            <td>{fmtTime(k.created_at)}</td>
            <td>{fmtTime(k.last_used_at)}</td>
            <td>{k.revoked_at ? `revoked ${fmtTime(k.revoked_at)}` : "active"}</td>
            <td>
              {!k.revoked_at && (
                <button
                  className="danger small"
                  onClick={() => {
                    // Revocation cannot be undone, and the client using this key stops working.
                    if (!window.confirm(`Revoke "${k.name}"? Clients using it will stop working.`))
                      return;
                    void onRevoke(k.id).catch((err: unknown) =>
                      window.alert((err as Error).message),
                    );
                  }}
                >
                  Revoke
                </button>
              )}
            </td>
          </tr>
        ))}
        {keys.length === 0 && (
          <tr>
            <td colSpan={7} className="muted">
              No keys yet.
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}
