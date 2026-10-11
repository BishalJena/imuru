import express, { type Router } from "express";
import { rejectNonUuid } from "./api.js";
import * as z from "zod/v4";
import { requireJson, sessionAuth, userOf } from "./auth.js";
import { safeEqual, sha256 } from "./crypto.js";
import type { Repo } from "./repo.js";
import type { ServerService } from "./servers.js";
import { parseBody } from "./validate.js";
import { STORE_SLUG, storeServerSlug, type StoreService } from "./stores.js";

/** Dashboard API: /api/stores. Users manage their own stores; admins see all. */
export function storesRouter(repo: Repo, stores: StoreService): Router {
  const r = express.Router();
  r.param("id", rejectNonUuid);
  r.use(requireJson, sessionAuth(repo));

  r.get("/", async (_req, res) => {
    const me = userOf(res);
    res.json(await stores.list(me.role === "admin" ? undefined : me.id));
  });

  r.post("/", async (req, res) => {
    const body = parseBody(
      z
        .object({
          slug: z
            .string()
            .regex(STORE_SLUG, "lowercase letters, digits and dashes; 2-20 characters"),
        })
        .refine((b) => !b.slug.includes("--"), { message: "cannot contain --", path: ["slug"] }),
      req,
      res,
    );
    if (!body) return;
    const result = await stores.create(userOf(res).id, body.slug);
    if ("error" in result) {
      res.status(result.error === "limit" ? 429 : 409).json({
        error: {
          code: result.error,
          message:
            result.error === "limit"
              ? "Store limit reached for your account"
              : "That store name is taken",
        },
      });
      return;
    }
    res.status(202).json(result.store);
  });

  r.delete("/:id", async (req, res) => {
    const me = userOf(res);
    const store = await stores.get(String(req.params.id));
    if (!store || (store.owner_id !== me.id && me.role !== "admin")) {
      res.status(404).json({ error: { code: "not_found", message: "No such store" } });
      return;
    }
    res.status(202).json(await stores.requestDelete(store.id));
  });

  return r;
}

/**
 * Internal API for the provisioner. Not routed by the Ingress, reachable only
 * from the provisioner pod (NetworkPolicy), and authenticated with a shared token.
 */
export function internalRouter(
  token: string,
  stores: StoreService,
  servers: ServerService,
): Router {
  const expected = sha256(token);
  const r = express.Router();
  r.param("id", rejectNonUuid);
  r.use((req, res, next) => {
    const h = req.header("authorization") ?? "";
    const presented = /^bearer\s+/i.test(h) ? h.replace(/^bearer\s+/i, "") : "";
    if (!presented || !safeEqual(sha256(presented), expected)) {
      res.status(401).json({ error: { code: "unauthorized", message: "Unauthorized" } });
      return;
    }
    next();
  });

  r.get("/stores", async (_req, res) => {
    res.json(await stores.pending());
  });

  r.patch("/stores/:id", async (req, res) => {
    const parsed = z
      .object({
        status: z.enum(["provisioning", "ready", "failed", "deleting"]),
        reason: z.string().max(2000).nullable().optional(),
        url: z.url().nullable().optional(),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: { code: "invalid", message: "status, reason, url" } });
      return;
    }
    const current = await stores.get(String(req.params.id));
    if (!current) {
      res.status(404).json({ error: { code: "not_found", message: "No such store" } });
      return;
    }
    // A deletion requested while the provisioner worked must win over "ready".
    if (current.desired === "absent" && parsed.data.status !== "deleting") {
      res
        .status(409)
        .json({ error: { code: "deleting", message: "Store deletion was requested" } });
      return;
    }
    const row = await stores.report(current.id, {
      status: parsed.data.status,
      reason: parsed.data.reason ?? null,
      url: parsed.data.url ?? null,
    });
    if (!row) res.status(404).json({ error: { code: "not_found", message: "No such store" } });
    else res.json(row);
  });

  r.delete("/stores/:id", async (req, res) => {
    res.status((await stores.purge(String(req.params.id))) ? 204 : 404).end();
  });

  r.put("/servers/:slug", async (req, res) => {
    const slug = String(req.params.slug);
    const parsed = z
      .object({ name: z.string().min(1).max(60), url: z.url(), credential: z.string().min(16) })
      .safeParse(req.body ?? {});
    if (!slug.startsWith("store-") || !parsed.success) {
      res
        .status(400)
        .json({ error: { code: "invalid", message: "store-<slug>, name, url, credential" } });
      return;
    }
    const store = await stores.bySlug(slug.slice("store-".length));
    if (!store || store.desired !== "present") {
      res.status(409).json({
        error: { code: "deleting", message: "No such store, or its deletion was requested" },
      });
      return;
    }
    const row = await servers.upsertManaged({ slug, ...parsed.data });
    if (!row) {
      res.status(409).json({
        error: {
          code: "conflict",
          message: "A server with that slug is not managed by the provisioner",
        },
      });
      return;
    }
    res.json({ slug: row.slug });
  });

  r.delete("/servers/:slug", async (req, res) => {
    const slug = String(req.params.slug);
    if (!slug.startsWith("store-")) {
      res.status(400).end();
      return;
    }
    await servers.removeBySlug(slug);
    res.status(204).end();
  });

  return r;
}

export { storeServerSlug };
