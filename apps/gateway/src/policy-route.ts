import express, { type Router } from "express";
import * as z from "zod/v4";
import { requireAdmin, requireJson, sessionAuth, userOf } from "./auth.js";
import type { Policies } from "./policies.js";
import type { Repo } from "./repo.js";

const rule = z.object({
  role: z.enum(["admin", "member"]),
  server_slug: z.string().regex(/^[a-z0-9*-]{1,31}$/, "server slug or *"),
  tool_pattern: z.string().regex(/^[A-Za-z0-9_.*-]{1,128}$/, "tool name, * as wildcard"),
});

/** Admin-only CRUD for tool deny rules: /api/policies. */
export function policyRouter(repo: Repo, policies: Policies): Router {
  const r = express.Router();
  r.use(requireJson, sessionAuth(repo), requireAdmin);
  r.get("/", (_req, res) => {
    res.json(policies.list());
  });
  r.post("/", async (req, res) => {
    const parsed = rule.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: { code: "invalid", message: parsed.error.issues.map((i) => i.message).join("; ") },
      });
      return;
    }
    res.status(201).json(await policies.add({ ...parsed.data, createdBy: userOf(res).id }));
  });
  r.delete("/:id", async (req, res) => {
    if (await policies.remove(String(req.params.id))) res.status(204).end();
    else res.status(404).json({ error: { code: "not_found", message: "No such rule" } });
  });
  return r;
}
