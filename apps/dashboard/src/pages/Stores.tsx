import { useState } from "react";
import { api, type Me } from "../api.js";
import { fmtTime, useLoad } from "../hooks.js";

const BADGE = {
  provisioning: "disabled",
  ready: "connected",
  failed: "unreachable",
  deleting: "disabled",
} as const;
const LABEL = {
  provisioning: "Provisioning",
  ready: "Ready",
  failed: "Failed",
  deleting: "Deleting",
} as const;

export function StoresPage({ me }: { me: Me }) {
  const { data: stores, error, reload } = useLoad(api.stores, 3000);
  const [slug, setSlug] = useState("");
  const [formError, setFormError] = useState<string>();

  return (
    <section>
      <header className="page-head">
        <h2>Stores</h2>
      </header>
      <p className="muted">
        Each store gets its own namespace, database, volumes and host, and its WooCommerce MCP
        server is registered in the gateway as <code>store-&lt;name&gt;__&lt;tool&gt;</code> once it
        is ready.
      </p>
      <form
        className="inline"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            setFormError(undefined);
            await api.createStore(slug);
            setSlug("");
            await reload();
          } catch (err) {
            setFormError((err as Error).message);
          }
        }}
      >
        <input
          placeholder="store name, e.g. north"
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          pattern="[a-z][a-z0-9-]{1,19}"
          required
        />
        <button>Create store</button>
      </form>
      {(formError || error) && <p className="error">{formError ?? error}</p>}
      <table>
        <thead>
          <tr>
            <th>Store</th>
            {me.role === "admin" && <th>Owner</th>}
            <th>Status</th>
            <th>URL</th>
            <th>Created</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {stores?.map((s) => (
            <tr key={s.id}>
              <td>
                {s.slug}
                <div className="muted small mono">store-{s.slug}__*</div>
              </td>
              {me.role === "admin" && <td>{s.owner_email}</td>}
              <td>
                <span className={`badge ${BADGE[s.status]}`}>{LABEL[s.status]}</span>
                {s.reason && <div className="error small">{s.reason}</div>}
              </td>
              <td>{s.url && s.status === "ready" ? <a href={s.url}>{s.url}</a> : "-"}</td>
              <td>{fmtTime(s.created_at)}</td>
              <td className="actions">
                {s.status === "failed" && (
                  <button
                    className="secondary small"
                    onClick={async () => (await api.createStore(s.slug), reload())}
                  >
                    Retry
                  </button>
                )}
                {s.desired === "present" && (
                  <button
                    className="danger small"
                    onClick={async () => {
                      if (
                        !window.confirm(
                          `Delete store ${s.slug}? Its database, files and MCP tools are removed.`,
                        )
                      )
                        return;
                      await api.deleteStore(s.id);
                      await reload();
                    }}
                  >
                    Delete
                  </button>
                )}
              </td>
            </tr>
          ))}
          {stores?.length === 0 && (
            <tr>
              <td colSpan={6} className="muted">
                No stores yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  );
}
