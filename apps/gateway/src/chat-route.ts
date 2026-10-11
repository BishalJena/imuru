import express, { type Router } from "express";
import * as z from "zod/v4";
import { runAgent } from "./agent.js";
import { rateLimit, requireJson, sessionAuth, userOf } from "./auth.js";
import type { TokenSigner } from "./crypto.js";
import type { LlmProvider } from "./llm.js";
import type { Repo } from "./repo.js";

const body = z.object({
  messages: z
    .array(z.object({ role: z.enum(["user", "assistant"]), text: z.string().min(1).max(200_000) }))
    .min(1)
    .max(1000),
});

/** POST /api/chat: runs the agent and streams its steps as server-sent events. */
export function chatRouter(deps: {
  repo: Repo;
  signer: TokenSigner;
  provider: LlmProvider | null;
  mcpUrl: () => string;
  maxSteps: number;
}): Router {
  const r = express.Router();
  r.post(
    "/",
    requireJson,
    sessionAuth(deps.repo),
    rateLimit({
      windowMs: 60_000,
      max: 20,
      // Per authenticated user: varying the Cookie header must not reset the budget.
      key: (_req, res) => `chat:${userOf(res).id}`,
    }),
    async (req, res) => {
      if (!deps.provider) {
        res.status(503).json({
          error: {
            code: "chat_unconfigured",
            message: "Chat is not configured: set llm.apiKey in the platform values.",
          },
        });
        return;
      }
      const parsed = body.safeParse(req.body);
      if (!parsed.success) {
        res
          .status(400)
          .json({ error: { code: "invalid", message: "messages: 1-40 items of {role, text}" } });
        return;
      }
      const user = userOf(res);
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      const abort = new AbortController();
      res.on("close", () => abort.abort());
      const send = (event: string, data: unknown) =>
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      try {
        await runAgent({
          userId: user.id,
          // The model sees the most recent turns only, each clipped, so a long
          // conversation keeps working instead of failing validation.
          history: parsed.data.messages
            .slice(-40)
            .map((m) => ({ ...m, text: m.text.slice(0, 8000) })),
          provider: deps.provider,
          signer: deps.signer,
          mcpUrl: deps.mcpUrl(),
          maxSteps: deps.maxSteps,
          signal: abort.signal,
          emit: (e) => {
            const { type, ...data } = e;
            send(type, data);
          },
        });
      } catch (err) {
        console.error("chat failed", err);
        send("error", {
          message: "The model request failed. Check the LLM configuration and quota.",
        });
      }
      send("done", {});
      res.end();
    },
  );
  return r;
}
