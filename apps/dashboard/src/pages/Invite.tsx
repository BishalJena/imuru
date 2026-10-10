import { useEffect, useState } from "react";
import { api, type Me } from "../api.js";

export function InvitePage({ token, onDone }: { token: string; onDone: (me: Me) => void }) {
  const [info, setInfo] = useState<{ email: string; name: string } | null>();
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string>();

  useEffect(() => {
    api.inviteInfo(token).then(
      (i) => (setInfo(i), setName(i.name)),
      () => setInfo(null),
    );
  }, [token]);

  if (info === undefined) return <div className="center muted">Loading…</div>;
  if (info === null)
    return <div className="center error">This invite is invalid, already used or expired.</div>;

  return (
    <div className="center">
      <form
        className="card auth"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            onDone(await api.acceptInvite(token, password, name));
          } catch (err) {
            setError((err as Error).message);
          }
        }}
      >
        <h1>Join the team</h1>
        <p className="muted">{info.email}</p>
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
        <label>
          Choose a password (10+ characters)
          <input
            type="password"
            autoComplete="new-password"
            minLength={10}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        {error && <p className="error">{error}</p>}
        <button>Create account</button>
      </form>
    </div>
  );
}
