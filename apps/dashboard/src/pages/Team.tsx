import { useState } from "react";
import { api, type Me, type Role } from "../api.js";
import { fmtTime, useLoad } from "../hooks.js";
import { KeyTable } from "./Keys.js";

export function TeamPage({ me }: { me: Me }) {
  const { data: users, reload: reloadUsers } = useLoad(api.users);
  const { data: keys, reload: reloadKeys } = useLoad(api.allKeys);
  const [invite, setInvite] = useState({ email: "", name: "", role: "member" as Role });
  const [inviteUrl, setInviteUrl] = useState<string>();
  const [issued, setIssued] = useState<{ email: string; key: string }>();
  const [error, setError] = useState<string>();

  const run = async (fn: () => Promise<unknown>) => {
    try {
      setError(undefined);
      await fn();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <section>
      <header className="page-head">
        <h2>Team</h2>
      </header>
      <form
        className="inline"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            setInviteUrl((await api.invite(invite.email, invite.name, invite.role)).invite_url);
            setInvite({ email: "", name: "", role: "member" });
            await reloadUsers();
          });
        }}
      >
        <input
          type="email"
          placeholder="email"
          value={invite.email}
          onChange={(e) => setInvite({ ...invite, email: e.target.value })}
          required
        />
        <input
          placeholder="name"
          value={invite.name}
          onChange={(e) => setInvite({ ...invite, name: e.target.value })}
          required
        />
        <select
          value={invite.role}
          onChange={(e) => setInvite({ ...invite, role: e.target.value as Role })}
        >
          <option value="member">member</option>
          <option value="admin">admin</option>
        </select>
        <button>Invite</button>
      </form>
      {inviteUrl && (
        <div className="card reveal">
          <strong>Send this single-use link to the new member (valid 7 days):</strong>
          <pre className="mono">{inviteUrl}</pre>
          <button className="secondary" onClick={() => setInviteUrl(undefined)}>
            Done
          </button>
        </div>
      )}
      {issued && (
        <div className="card reveal">
          <strong>Key for {issued.email}. Shown once; hand it over securely.</strong>
          <pre className="mono">{issued.key}</pre>
          <button className="secondary" onClick={() => setIssued(undefined)}>
            Done
          </button>
        </div>
      )}
      {error && <p className="error">{error}</p>}
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Email</th>
            <th>Role</th>
            <th>Status</th>
            <th>Joined</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {users?.map((u) => (
            <tr key={u.id} className={u.status === "disabled" ? "dim" : ""}>
              <td>{u.name}</td>
              <td>{u.email}</td>
              <td>
                <select
                  value={u.role}
                  disabled={u.id === me.id || u.status !== "active"}
                  onChange={(e) =>
                    void run(
                      async () => (
                        await api.updateUser(u.id, { role: e.target.value as Role }),
                        reloadUsers()
                      ),
                    )
                  }
                >
                  <option value="member">member</option>
                  <option value="admin">admin</option>
                </select>
              </td>
              <td>{u.status}</td>
              <td>{fmtTime(u.created_at)}</td>
              <td className="actions">
                {u.status === "active" && (
                  <button
                    className="secondary small"
                    onClick={() =>
                      void run(async () => {
                        setIssued({
                          email: u.email,
                          key: (await api.issueKey(u.id, `issued by ${me.name}`)).key,
                        });
                        await reloadKeys();
                      })
                    }
                  >
                    Issue key
                  </button>
                )}
                {u.id !== me.id && u.status !== "invited" && (
                  <button
                    className="secondary small"
                    onClick={() =>
                      void run(
                        async () => (
                          await api.updateUser(u.id, {
                            status: u.status === "active" ? "disabled" : "active",
                          }),
                          reloadUsers()
                        ),
                      )
                    }
                  >
                    {u.status === "active" ? "Disable" : "Enable"}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3>All API keys</h3>
      <KeyTable
        showUser
        keys={keys ?? []}
        onRevoke={(id) => {
          const k = keys?.find((x) => x.id === id);
          return run(async () => (k && (await api.revokeUserKey(k.user_id, id)), reloadKeys()));
        }}
      />
    </section>
  );
}
