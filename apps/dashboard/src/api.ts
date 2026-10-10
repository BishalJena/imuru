export type Role = "admin" | "member";

export interface Me {
  id: string;
  email: string;
  name: string;
  role: Role;
}

export interface ServerTool {
  name: string;
  description: string;
}

export interface Server {
  id: string;
  slug: string;
  name: string;
  enabled: boolean;
  status: "connected" | "unreachable" | "disabled";
  tools: ServerTool[];
  // Admin-only fields.
  url?: string;
  auth_type?: "none" | "bearer" | "header";
  auth_header_name?: string | null;
  has_credential?: boolean;
  managed?: boolean;
  timeout_ms?: number;
  last_error?: string | null;
}

export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  status: "invited" | "active" | "disabled";
  created_at: string;
}

export interface ApiKey {
  id: string;
  key_id: string;
  name: string;
  user_id: string;
  user_email: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface AuditRow {
  id: number;
  ts: string;
  user_email: string | null;
  via: "mcp" | "chat";
  server_slug: string | null;
  tool: string | null;
  duration_ms: number | null;
  outcome: string;
  error: string | null;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? null : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => ({}))) as {
    error?: { code: string; message: string };
  };
  if (!res.ok) {
    throw new ApiError(
      res.status,
      data.error?.code ?? "error",
      data.error?.message ?? `HTTP ${res.status}`,
    );
  }
  return data as T;
}

export const api = {
  me: () => request<Me>("GET", "/me"),
  config: () => request<{ mcp_url: string }>("GET", "/config"),
  login: (email: string, password: string) =>
    request<Me>("POST", "/auth/login", { email, password }),
  logout: () => request<void>("POST", "/auth/logout", {}),
  inviteInfo: (token: string) =>
    request<{ email: string; name: string }>("GET", `/invites/${encodeURIComponent(token)}`),
  acceptInvite: (token: string, password: string, name?: string) =>
    request<Me>("POST", "/invites/accept", { token, password, ...(name ? { name } : {}) }),
  invite: (email: string, name: string, role: Role) =>
    request<{ invite_url: string; expires_at: string }>("POST", "/invites", { email, name, role }),

  servers: () => request<Server[]>("GET", "/servers"),
  createServer: (s: Record<string, unknown>) => request<Server>("POST", "/servers", s),
  updateServer: (id: string, s: Record<string, unknown>) =>
    request<Server>("PATCH", `/servers/${id}`, s),
  deleteServer: (id: string) => request<void>("DELETE", `/servers/${id}`),

  users: () => request<User[]>("GET", "/users"),
  updateUser: (id: string, patch: { role?: Role; status?: "active" | "disabled" }) =>
    request<User>("PATCH", `/users/${id}`, patch),

  myKeys: () => request<ApiKey[]>("GET", "/keys"),
  createKey: (name: string) => request<ApiKey & { key: string }>("POST", "/keys", { name }),
  revokeKey: (id: string) => request<void>("DELETE", `/keys/${id}`),
  allKeys: () => request<ApiKey[]>("GET", "/all-keys"),
  issueKey: (userId: string, name: string) =>
    request<ApiKey & { key: string }>("POST", `/users/${userId}/keys`, { name }),
  revokeUserKey: (userId: string, keyId: string) =>
    request<void>("DELETE", `/users/${userId}/keys/${keyId}`),

  audit: (q: Record<string, string>) =>
    request<AuditRow[]>("GET", `/audit?${new URLSearchParams(q).toString()}`),
};
