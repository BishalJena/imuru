import { createMcpExpressApp } from "@modelcontextprotocol/express";
import express, { type Express } from "express";
import { bearerAuth } from "./auth.js";
import type { Config } from "./config.js";
import { mcpRouter } from "./mcp-endpoint.js";
import type { Registry } from "./registry.js";

export function createApp(config: Config, registry: Registry): Express {
  // Binds all interfaces inside the pod; only the public host and in-cluster
  // Service names are accepted in the Host header (DNS-rebinding defence).
  const app = createMcpExpressApp({ host: "0.0.0.0", allowedHosts: config.ALLOWED_HOSTS });
  const auth = bearerAuth(config.GATEWAY_API_KEY);

  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });
  app.get("/readyz", (_req, res) => {
    res.json({ status: "ready" });
  });

  app.use(
    "/mcp",
    auth,
    mcpRouter(registry, {
      sessionIdleMs: config.SESSION_IDLE_MS,
      onCall: (e) => {
        console.log(
          JSON.stringify({
            event: "tool_call",
            user: e.principal.userId,
            server: e.server,
            tool: e.tool,
            outcome: e.outcome,
            duration_ms: e.durationMs,
          }),
        );
      },
    }),
  );

  const api = express.Router();
  api.use(auth);
  // Status and tool names only: URLs and credentials stay server-side.
  api.get("/servers", (_req, res) => {
    res.json(
      registry.list().map((u) => ({
        slug: u.config.slug,
        name: u.config.name,
        enabled: u.config.enabled,
        status: u.status,
        last_error: u.lastError,
        tools: u.tools.map((t) => t.name),
      })),
    );
  });
  api.patch("/servers/:slug", async (req, res) => {
    const upstream = registry.get(req.params.slug ?? "");
    const enabled = (req.body as { enabled?: unknown }).enabled;
    if (!upstream || typeof enabled !== "boolean") {
      res.status(upstream ? 400 : 404).json({
        error: {
          code: upstream ? "invalid" : "not_found",
          message: upstream ? "enabled must be a boolean" : "No such server",
        },
      });
      return;
    }
    await upstream.setEnabled(enabled);
    res.json({
      slug: upstream.config.slug,
      enabled: upstream.config.enabled,
      status: upstream.status,
    });
  });
  app.use("/api", api);

  return app;
}
