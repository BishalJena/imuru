import type { NextFunction, Request, Response } from "express";
import { parseApiKey, safeEqual, sha256, type TokenSigner } from "./crypto.js";
import type { Repo, Role, User } from "./repo.js";

export const SESSION_COOKIE = "urumi_session";

/** Caller of the MCP endpoint. */
export interface Principal {
  userId: string;
  email: string;
  role: Role;
  apiKeyId: string | null;
  via: "mcp" | "chat";
  /** Identity an MCP session is bound to: the API key, or the user for chat tokens. */
  sessionOwner: string;
}

export function principalOf(res: Response): Principal {
  const p = res.locals.principal as Principal | undefined;
  if (!p) throw new Error("principal missing: route is not behind mcpAuth");
  return p;
}

export function userOf(res: Response): User {
  const u = res.locals.user as User | undefined;
  if (!u) throw new Error("user missing: route is not behind sessionAuth");
  return u;
}

export function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.header("cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

const unauthorized = (res: Response, message: string) =>
  res
    .status(401)
    .set("WWW-Authenticate", "Bearer")
    .json({ jsonrpc: "2.0", error: { code: -32001, message }, id: null });

/**
 * API keys (urk_...) for external MCP clients and short-lived chat tokens
 * (uct_...) for the dashboard's agent. Checked on every request, so revocation
 * takes effect on the next call, even inside an open MCP session.
 */
export function mcpAuth(repo: Repo, signer: TokenSigner) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const header = req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";

    if (token.startsWith("uct_")) {
      const claims = signer.verify(token);
      const user = claims ? await repo.userById(claims.uid) : null;
      if (!user || user.status !== "active") {
        unauthorized(res, "Invalid or expired chat token");
        return;
      }
      res.locals.principal = {
        userId: user.id,
        email: user.email,
        role: user.role,
        apiKeyId: null,
        via: "chat",
        sessionOwner: `chat:${user.id}`,
      } satisfies Principal;
      next();
      return;
    }

    const parsed = parseApiKey(token);
    const row = parsed ? await repo.apiKeyByKeyId(parsed.keyId) : null;
    const valid =
      parsed !== null &&
      row !== null &&
      safeEqual(sha256(parsed.secret), row.secret_hash) &&
      row.revoked_at === null &&
      row.status === "active";
    if (!valid) {
      // A recognised key id is attributed to its owner even when revoked, so
      // the audit log shows who tried to use a dead key.
      if (row) {
        await repo
          .audit({
            userId: row.user_id,
            userEmail: row.email,
            apiKeyId: row.id,
            via: "mcp",
            server: null,
            tool: null,
            durationMs: null,
            outcome: "auth_rejected",
            error: row.revoked_at
              ? "key revoked"
              : row.status !== "active"
                ? "user disabled"
                : "wrong secret",
          })
          .catch(() => undefined);
      }
      unauthorized(res, "Invalid or revoked API key");
      return;
    }
    void repo.touchApiKey(row.id).catch(() => undefined);
    res.locals.principal = {
      userId: row.user_id,
      email: row.email,
      role: row.role,
      apiKeyId: row.id,
      via: "mcp",
      sessionOwner: `key:${row.id}`,
    } satisfies Principal;
    next();
  };
}

/** Dashboard session from the httpOnly cookie. */
export function sessionAuth(repo: Repo) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const token = readCookie(req, SESSION_COOKIE);
    const user = token ? await repo.userBySession(token) : null;
    if (!user) {
      res.status(401).json({ error: { code: "unauthenticated", message: "Log in first" } });
      return;
    }
    res.locals.user = user;
    next();
  };
}

export function requireAdmin(_req: Request, res: Response, next: NextFunction) {
  if (userOf(res).role !== "admin") {
    res.status(403).json({ error: { code: "forbidden", message: "Admins only" } });
    return;
  }
  next();
}

/**
 * Cookie-authenticated writes must be JSON. An HTML form can only send
 * urlencoded, multipart or text bodies, and a cross-site fetch with a JSON
 * content type needs a CORS preflight this API never grants. Forms cannot
 * send DELETE at all. Together with SameSite=Lax this blocks CSRF.
 */
export function requireJson(req: Request, res: Response, next: NextFunction) {
  if (["POST", "PUT", "PATCH"].includes(req.method) && !req.is("application/json")) {
    res
      .status(415)
      .json({ error: { code: "unsupported_media_type", message: "Use application/json" } });
    return;
  }
  next();
}

/** Fixed-window limiter, in memory (single replica). */
export function rateLimit(opts: { windowMs: number; max: number; key: (req: Request) => string }) {
  const hits = new Map<string, { n: number; reset: number }>();
  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    const k = opts.key(req);
    const h = hits.get(k);
    if (!h || h.reset < now) hits.set(k, { n: 1, reset: now + opts.windowMs });
    else if (++h.n > opts.max) {
      res
        .status(429)
        .json({ error: { code: "rate_limited", message: "Too many attempts, try again later" } });
      return;
    }
    if (hits.size > 10_000) for (const [key, v] of hits) if (v.reset < now) hits.delete(key);
    next();
  };
}
