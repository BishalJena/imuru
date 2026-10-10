import { createHash, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

export interface Principal {
  userId: string;
  keyId: string;
}

/** The authenticated caller, set by bearerAuth. */
export function principalOf(res: Response): Principal {
  const p = res.locals.principal as Principal | undefined;
  if (!p) throw new Error("principal missing: route is not behind bearerAuth");
  return p;
}

const digest = (s: string) => createHash("sha256").update(s).digest();

/**
 * Bearer API key check. Walking-skeleton version: a single key from a Secret,
 * compared by SHA-256 digest in constant time. Replaced by per-user hashed keys.
 */
export function bearerAuth(apiKey: string) {
  const expected = digest(apiKey);
  return (req: Request, res: Response, next: NextFunction) => {
    const header = req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token || !timingSafeEqual(digest(token), expected)) {
      res
        .status(401)
        .set("WWW-Authenticate", "Bearer")
        .json({
          jsonrpc: "2.0",
          error: { code: -32001, message: "Invalid or revoked API key" },
          id: null,
        });
      return;
    }
    res.locals.principal = { userId: "skeleton-user", keyId: "skeleton" } satisfies Principal;
    next();
  };
}
