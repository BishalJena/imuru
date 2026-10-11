import type { Request, Response } from "express";
import type * as z from "zod/v4";

/** The one error body every API route returns: { error: { code, message } }. */
export const fail = (res: Response, status: number, code: string, message: string) =>
  res.status(status).json({ error: { code, message } });

/**
 * Validates the JSON body; on failure answers 400 with "field: problem" for
 * each issue and returns undefined.
 */
export function parseBody<T extends z.ZodType>(
  schema: T,
  req: Request,
  res: Response,
): z.infer<T> | undefined {
  const r = schema.safeParse(req.body ?? {});
  if (r.success) return r.data;
  fail(
    res,
    400,
    "invalid",
    r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "),
  );
  return undefined;
}
