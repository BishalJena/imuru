import { useEffect, useState } from "react";
import { api, type Me } from "./api.js";
import { AuditPage } from "./pages/Audit.js";
import { ChatPage } from "./pages/Chat.js";
import { InvitePage } from "./pages/Invite.js";
import { KeysPage } from "./pages/Keys.js";
import { LoginPage } from "./pages/Login.js";
import { ServersPage } from "./pages/Servers.js";
import { TeamPage } from "./pages/Team.js";
import { navigate, usePath } from "./router.js";

const NAV: { path: string; label: string; adminOnly?: boolean }[] = [
  { path: "/servers", label: "Servers" },
  { path: "/chat", label: "Chat" },
  { path: "/keys", label: "My API keys" },
  { path: "/team", label: "Team", adminOnly: true },
  { path: "/audit", label: "Audit log" },
];

export function App() {
  const path = usePath();
  const [me, setMe] = useState<Me | null | undefined>(undefined);

  useEffect(() => {
    api.me().then(setMe, () => setMe(null));
  }, []);

  if (path.startsWith("/invite/")) {
    return (
      <InvitePage
        token={path.slice("/invite/".length)}
        onDone={(u) => (setMe(u), navigate("/keys"))}
      />
    );
  }
  if (me === undefined) return <div className="center muted">Loading…</div>;
  if (me === null) return <LoginPage onLogin={(u) => (setMe(u), navigate("/servers"))} />;

  const page =
    NAV.find((n) => path.startsWith(n.path) && (!n.adminOnly || me.role === "admin"))?.path ??
    "/servers";

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">
          Urumi <span>MCP Gateway</span>
        </div>
        <nav>
          {NAV.filter((n) => !n.adminOnly || me.role === "admin").map((n) => (
            <a
              key={n.path}
              href={n.path}
              className={page === n.path ? "active" : ""}
              onClick={(e) => {
                e.preventDefault();
                navigate(n.path);
              }}
            >
              {n.label}
            </a>
          ))}
        </nav>
        <div className="whoami">
          <div>{me.name}</div>
          <div className="muted small">
            {me.email} · {me.role}
          </div>
          <button
            className="link"
            onClick={async () => {
              await api.logout();
              setMe(null);
              navigate("/");
            }}
          >
            Log out
          </button>
        </div>
      </aside>
      <main className="content">
        {page === "/servers" && <ServersPage me={me} />}
        {page === "/chat" && <ChatPage me={me} />}
        {page === "/keys" && <KeysPage />}
        {page === "/team" && <TeamPage me={me} />}
        {page === "/audit" && <AuditPage me={me} />}
      </main>
    </div>
  );
}
