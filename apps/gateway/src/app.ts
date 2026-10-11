import { createMcpExpressApp } from "@modelcontextprotocol/express";
import type { Express, NextFunction, Request, Response } from "express";
import { apiRouter } from "./api.js";
import { chatRouter } from "./chat-route.js";
import type { LlmProvider } from "./llm.js";
import type { Policies } from "./policies.js";
import { policyRouter } from "./policy-route.js";
import type { StoreService } from "./stores.js";
import { internalRouter, storesRouter } from "./stores-route.js";
import { mcpAuth, type Principal } from "./auth.js";
import type { Config } from "./config.js";
import type { TokenSigner } from "./crypto.js";
import { mcpRouter } from "./mcp-endpoint.js";
import { Metrics } from "./metrics.js";
import type { Registry } from "./registry.js";
import type { Repo } from "./repo.js";
import type { ServerService } from "./servers.js";
import type { UrlGuard } from "./ssrf.js";

export interface AppDeps {
  config: Config;
  registry: Registry;
  repo: Repo;
  servers: ServerService;
  signer: TokenSigner;
  urlGuard: UrlGuard;
  isAllowed?: (principal: Principal, server: string, tool: string) => boolean;
  policies?: Policies;
  stores?: StoreService;
  provider?: LlmProvider | null;
  extraApi?: (app: Express) => void;
}

export function createApp(deps: AppDeps): Express {
  const { config, registry, repo } = deps;
  // Binds all interfaces inside the pod; only the public host and in-cluster
  // Service names are accepted in the Host header (DNS-rebinding defence).
  const app = createMcpExpressApp({
    host: "0.0.0.0",
    allowedHosts: config.ALLOWED_HOSTS,
    jsonLimit: "1mb",
  });
  app.set("trust proxy", 1);

  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });
  app.get("/readyz", async (_req, res) => {
    try {
      await repo.db.query("SELECT 1");
      res.json({ status: "ready" });
    } catch {
      res.status(503).json({ status: "database unavailable" });
    }
  });

  // The getter is called at scrape time, after mcp is assigned below.
  const metrics = new Metrics(registry, () => mcp.sessionCount());

  // Not routed by the Ingress (the app host sends "/" to the dashboard) and the
  // gateway NetworkPolicy admits only Traefik and the provisioner, so this is
  // reachable through `kubectl port-forward` or an in-cluster scraper you allow.
  app.get("/metrics", (_req, res) => {
    res.type("text/plain; version=0.0.4").send(metrics.render());
  });

  const mcp = mcpRouter(registry, {
    sessionIdleMs: config.SESSION_IDLE_MS,
    ...(deps.isAllowed
      ? { isAllowed: deps.isAllowed }
      : deps.policies
        ? { isAllowed: deps.policies.isAllowed }
        : {}),
    onCall: (e) => {
      // Label by known servers only: made-up tool names must not create series.
      const label = e.server && registry.get(e.server) ? e.server : "unknown";
      metrics.recordCall(label, e.outcome, e.principal.via, e.durationMs);
      void repo
        .audit({
          userId: e.principal.userId,
          userEmail: e.principal.email,
          apiKeyId: e.principal.apiKeyId,
          via: e.principal.via,
          server: e.server,
          tool: e.tool,
          durationMs: e.durationMs,
          outcome: e.outcome,
          error: e.error,
        })
        .catch((err: unknown) => console.error("audit write failed", err));
    },
  });
  app.locals.notifyToolsChanged = mcp.notifyAll;
  app.use("/mcp", mcpAuth(repo, deps.signer), mcp);

  app.use(
    "/api/chat",
    chatRouter({
      repo,
      signer: deps.signer,
      provider: deps.provider ?? null,
      mcpUrl: () => config.SELF_MCP_URL,
      maxSteps: config.CHAT_MAX_STEPS,
    }),
  );
  if (deps.policies) app.use("/api/policies", policyRouter(repo, deps.policies));
  if (deps.stores && config.INTERNAL_TOKEN) {
    app.use("/api/stores", storesRouter(repo, deps.stores));
    app.use("/internal", internalRouter(config.INTERNAL_TOKEN, deps.stores, deps.servers));
  }
  deps.extraApi?.(app);
  app.use(
    "/api",
    apiRouter({
      repo,
      servers: deps.servers,
      urlGuard: deps.urlGuard,
      publicUrl: config.PUBLIC_URL,
      secureCookies: config.PUBLIC_URL.startsWith("https://"),
    }),
  );

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error(err);
    if (!res.headersSent)
      res.status(500).json({ error: { code: "internal", message: "Internal error" } });
  });

  return app;
}
