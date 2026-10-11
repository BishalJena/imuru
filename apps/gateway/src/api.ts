import express, { type Request, type Response, type Router } from "express";
import * as z from "zod/v4";
import { hashPassword, randomToken, verifyPassword } from "./crypto.js";
import {
  rateLimit,
  readCookie,
  requireAdmin,
  requireJson,
  SESSION_COOKIE,
  sessionAuth,
  userOf,
} from "./auth.js";
import type { Repo } from "./repo.js";
import { SLUG_PATTERN, type ServerService } from "./servers.js";
import type { UrlGuard } from "./ssrf.js";

export interface ApiDeps {
  repo: Repo;
  servers: ServerService;
  urlGuard: UrlGuard;
  publicUrl: string;
  secureCookies: boolean;
}

const fail = (res: Response, status: number, code: string, message: string) =>
  res.status(status).json({ error: { code, message } });

let dummy: Promise<string> | undefined;
const dummyHash = () => (dummy ??= hashPassword(randomToken(16)));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Express param handler: an id that is not a UUID cannot exist. */
export function rejectNonUuid(_req: Request, res: Response, next: () => void, value: string) {
  if (UUID.test(value)) next();
  else res.status(404).json({ error: { code: "not_found", message: "Not found" } });
}

/** Route parameter as a string (Express types allow string[] for repeated params). */
const param = (req: Request, name: string): string => String(req.params[name] ?? "");

function parse<T extends z.ZodType>(
  schema: T,
  req: Request,
  res: Response,
): z.infer<T> | undefined {
  const r = schema.safeParse(req.body ?? {});
  if (!r.success) {
    fail(
      res,
      400,
      "invalid",
      r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "),
    );
    return undefined;
  }
  return r.data;
}

const role = z.enum(["admin", "member"]);
const password = z.string().min(10, "at least 10 characters").max(200);
const keyName = z.string().trim().min(1).max(60);
const serverBase = {
  name: z.string().trim().min(1).max(60),
  url: z.url().max(500),
  auth_type: z.enum(["none", "bearer", "header"]),
  auth_header_name: z
    .string()
    .regex(/^[A-Za-z0-9-]{1,60}$/, "header name: letters, digits and dashes")
    .nullable()
    .optional(),
  credential: z.string().min(1).max(4000).nullable().optional(),
  enabled: z.boolean().optional(),
  timeout_ms: z.number().int().min(1000).max(120000).optional(),
};
const createServer = z
  .object({
    slug: z.string().regex(SLUG_PATTERN, "lowercase letters, digits, dashes; 2-31 chars"),
    ...serverBase,
  })
  .refine((s) => s.slug.indexOf("__") === -1, "slug cannot contain __")
  .refine((s) => !s.slug.startsWith("store-"), "store-* slugs are reserved for provisioned stores")
  .refine(
    (s) => s.auth_type !== "header" || !!s.auth_header_name,
    "auth_header_name is required for header auth",
  );
const patchServer = z.object(serverBase).partial();

export function apiRouter(deps: ApiDeps): Router {
  const { repo, servers } = deps;
  const r = express.Router();
  // Ids are UUIDs; anything else cannot exist and must not reach Postgres as a cast error.
  for (const name of ["id", "keyId"]) r.param(name, rejectNonUuid);
  const auth = sessionAuth(repo);

  r.use(requireJson);

  const setSession = async (res: Response, userId: string) => {
    const s = await repo.createSession(userId);
    res.cookie(SESSION_COOKIE, s.token, {
      httpOnly: true,
      sameSite: "lax",
      secure: deps.secureCookies,
      path: "/",
      expires: s.expiresAt,
    });
  };

  // Auth ------------------------------------------------------------------

  r.post(
    "/auth/login",
    rateLimit({ windowMs: 15 * 60 * 1000, max: 20, key: (req) => `login:${req.ip}` }),
    async (req, res) => {
      const body = parse(z.object({ email: z.email(), password: z.string() }), req, res);
      if (!body) return;
      const user = await repo.userByEmailWithHash(body.email);
      // Unknown emails and invited users still pay for a hash, so response time
      // does not reveal which accounts exist.
      const ok = await verifyPassword(body.password, user?.password_hash ?? (await dummyHash()));
      if (!user || !ok || user.status !== "active") {
        fail(res, 401, "invalid_credentials", "Wrong email or password");
        return;
      }
      await setSession(res, user.id);
      res.json({ id: user.id, email: user.email, name: user.name, role: user.role });
    },
  );

  r.post("/auth/logout", async (req, res) => {
    const token = readCookie(req, SESSION_COOKIE);
    if (token) await repo.deleteSession(token);
    res.clearCookie(SESSION_COOKIE, { path: "/" });
    res.status(204).end();
  });

  r.get("/me", auth, (_req, res) => {
    const u = userOf(res);
    res.json({ id: u.id, email: u.email, name: u.name, role: u.role });
  });

  r.get("/config", auth, (_req, res) => {
    res.json({ mcp_url: `${deps.publicUrl}/mcp` });
  });

  // Invites ---------------------------------------------------------------

  r.post("/invites", auth, requireAdmin, async (req, res) => {
    const body = parse(
      z.object({ email: z.email(), name: z.string().trim().min(1).max(80), role }),
      req,
      res,
    );
    if (!body) return;
    const inv = await repo.createInvite({ ...body, createdBy: userOf(res).id });
    if ("error" in inv) {
      fail(res, 409, "exists", "A user with that email already exists");
      return;
    }
    res
      .status(201)
      .json({ invite_url: `${deps.publicUrl}/invite/${inv.token}`, expires_at: inv.expiresAt });
  });

  r.get("/invites/:token", async (req, res) => {
    const info = await repo.inviteInfo(param(req, "token"));
    if (!info) {
      fail(res, 404, "not_found", "Invite is invalid, used or expired");
      return;
    }
    res.json(info);
  });

  r.post(
    "/invites/accept",
    rateLimit({ windowMs: 15 * 60 * 1000, max: 20, key: (req) => `invite:${req.ip}` }),
    async (req, res) => {
      const body = parse(
        z.object({
          token: z.string().min(10),
          password,
          name: z.string().trim().min(1).max(80).optional(),
        }),
        req,
        res,
      );
      if (!body) return;
      const user = await repo.acceptInvite(body.token, body.password, body.name);
      if (!user) {
        fail(res, 404, "not_found", "Invite is invalid, used or expired");
        return;
      }
      await setSession(res, user.id);
      res.json({ id: user.id, email: user.email, name: user.name, role: user.role });
    },
  );

  // Users -----------------------------------------------------------------

  r.get("/users", auth, requireAdmin, async (_req, res) => {
    res.json(await repo.listUsers());
  });

  r.patch("/users/:id", auth, requireAdmin, async (req, res) => {
    const body = parse(
      z.object({ role: role.optional(), status: z.enum(["active", "disabled"]).optional() }),
      req,
      res,
    );
    if (!body) return;
    const me = userOf(res);
    const target = await repo.userById(param(req, "id"));
    if (!target) {
      fail(res, 404, "not_found", "No such user");
      return;
    }
    if (target.status === "invited" && body.status) {
      fail(res, 409, "invited", "User has not accepted the invite yet");
      return;
    }
    const demotesAdmin =
      target.role === "admin" &&
      target.status === "active" &&
      (body.role === "member" || body.status === "disabled");
    if (demotesAdmin && (target.id === me.id || (await repo.countActiveAdmins()) <= 1)) {
      fail(res, 409, "last_admin", "You cannot demote or disable yourself or the last admin");
      return;
    }
    res.json(await repo.updateUser(target.id, body));
  });

  // API keys --------------------------------------------------------------

  r.get("/keys", auth, async (_req, res) => {
    res.json(await repo.listApiKeys(userOf(res).id));
  });

  r.post("/keys", auth, async (req, res) => {
    const body = parse(z.object({ name: keyName }), req, res);
    if (!body) return;
    const me = userOf(res);
    res.status(201).json(await repo.createApiKey(me.id, body.name, me.id));
  });

  r.delete("/keys/:id", auth, async (req, res) => {
    const ok = await repo.revokeApiKey(param(req, "id"), userOf(res).id);
    if (!ok) fail(res, 404, "not_found", "No such active key");
    else res.status(204).end();
  });

  r.get("/all-keys", auth, requireAdmin, async (_req, res) => {
    res.json(await repo.listApiKeys());
  });

  r.post("/users/:id/keys", auth, requireAdmin, async (req, res) => {
    const body = parse(z.object({ name: keyName }), req, res);
    if (!body) return;
    const target = await repo.userById(param(req, "id"));
    if (!target || target.status !== "active") {
      fail(res, 404, "not_found", "No such active user");
      return;
    }
    res.status(201).json(await repo.createApiKey(target.id, body.name, userOf(res).id));
  });

  r.delete("/users/:id/keys/:keyId", auth, requireAdmin, async (req, res) => {
    const ok = await repo.revokeApiKey(param(req, "keyId"), param(req, "id"));
    if (!ok) fail(res, 404, "not_found", "No such active key");
    else res.status(204).end();
  });

  // Servers ---------------------------------------------------------------

  r.get("/servers", auth, async (_req, res) => {
    const admin = userOf(res).role === "admin";
    res.json((await servers.list()).map((row) => servers.view(row, { admin })));
  });

  // Admin-only: aggregates cover every user's calls.
  r.get("/servers/stats", auth, requireAdmin, async (req, res) => {
    const hours = Math.min(Math.max(Number(req.query.hours) || 24, 1), 24 * 30);
    res.json({ hours, servers: await repo.serverStats(hours) });
  });

  r.post("/servers", auth, requireAdmin, async (req, res) => {
    const body = parse(createServer, req, res);
    if (!body) return;
    const blocked = await deps.urlGuard.check(body.url);
    if (blocked) {
      fail(res, 400, "url_blocked", blocked);
      return;
    }
    try {
      const row = await servers.create({
        ...body,
        auth_header_name: body.auth_header_name ?? null,
        credential: body.auth_type === "none" ? null : (body.credential ?? null),
      });
      res.status(201).json(servers.view(row, { admin: true }));
    } catch (err) {
      if ((err as { code?: string }).code === "23505")
        fail(res, 409, "exists", "A server with that slug exists");
      else throw err;
    }
  });

  r.patch("/servers/:id", auth, requireAdmin, async (req, res) => {
    const body = parse(patchServer, req, res);
    if (!body) return;
    const current = await servers.get(param(req, "id"));
    if (!current) {
      fail(res, 404, "not_found", "No such server");
      return;
    }
    // Managed servers are wired by Helm values or the provisioner; their URL is
    // not editable here (and they connect without the SSRF guard).
    if (body.url !== undefined && body.url !== current.url && current.managed) {
      fail(
        res,
        409,
        "managed",
        "This server is managed by the platform; its URL cannot be changed here",
      );
      return;
    }
    if (body.url && body.url !== current.url) {
      const blocked = await deps.urlGuard.check(body.url);
      if (blocked) {
        fail(res, 400, "url_blocked", blocked);
        return;
      }
    }
    const authType = body.auth_type ?? current.auth_type;
    const headerName =
      body.auth_header_name !== undefined ? body.auth_header_name : current.auth_header_name;
    if (authType === "header" && !headerName) {
      fail(res, 400, "invalid", "auth_header_name is required for header auth");
      return;
    }
    const row = await servers.update(current.id, body);
    res.json(servers.view(row!, { admin: true }));
  });

  r.delete("/servers/:id", auth, requireAdmin, async (req, res) => {
    if (!(await servers.remove(param(req, "id")))) fail(res, 404, "not_found", "No such server");
    else res.status(204).end();
  });

  // Audit -----------------------------------------------------------------

  r.get("/audit", auth, async (req, res) => {
    const me = userOf(res);
    const q = req.query as Record<string, string | undefined>;
    if (q.user && !UUID.test(q.user)) {
      fail(res, 400, "invalid", "user must be a user id");
      return;
    }
    if (q.since && Number.isNaN(Date.parse(q.since))) {
      fail(res, 400, "invalid", "since must be a date");
      return;
    }
    const userId = me.role === "admin" ? q.user || undefined : me.id;
    const filter: Parameters<Repo["listAudit"]>[0] = {
      limit: Math.min(Math.max(Math.trunc(Number(q.limit)) || 200, 1), 1000),
    };
    if (userId) filter.userId = userId;
    if (q.server) filter.server = q.server;
    if (q.outcome) filter.outcome = q.outcome;
    if (q.since) filter.since = new Date(q.since).toISOString();
    res.json(await repo.listAudit(filter));
  });

  return r;
}
