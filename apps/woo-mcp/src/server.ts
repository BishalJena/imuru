import { createHash, timingSafeEqual } from "node:crypto";
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { McpServer } from "@modelcontextprotocol/server";
import type { Express, NextFunction, Request, Response } from "express";
import type { Config } from "./config.js";
import { zoneOf } from "./dates.js";
import { registerTools, type StoreInfo } from "./tools.js";
import { WooClient } from "./woo.js";

const STORE_INFO_TTL_MS = 5 * 60 * 1000;

// Compare digests so the comparison is constant-time and length-independent.
function tokenMatches(presented: string, expected: string): boolean {
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export function createApp(
  config: Config,
  woo = new WooClient({
    baseUrl: config.WOO_BASE_URL,
    signingUrl: config.WOO_SIGNING_URL,
    consumerKey: config.WOO_CONSUMER_KEY,
    consumerSecret: config.WOO_CONSUMER_SECRET,
    timeoutMs: config.WOO_TIMEOUT_MS,
  }),
): Express {
  // The pending fetch is cached too, so concurrent callers after expiry share
  // one request instead of each hitting the store.
  let cached: { info: Promise<StoreInfo>; at: number } | undefined;
  const fetchStoreInfo = async (): Promise<StoreInfo> => {
    const [site, currency] = await Promise.all([
      woo.siteInfo(),
      woo.get<{ code: string }>("/data/currencies/current"),
    ]);
    return {
      name: site.name,
      url: site.home,
      timezone: zoneOf(site.timezone_string, Number(site.gmt_offset) || 0),
      currency: currency.data.code,
    };
  };
  const storeInfo = (): Promise<StoreInfo> => {
    if (cached && Date.now() - cached.at < STORE_INFO_TTL_MS) return cached.info;
    const entry = { info: fetchStoreInfo(), at: Date.now() };
    // A failed fetch must not be cached for the whole TTL.
    entry.info.catch(() => {
      if (cached === entry) cached = undefined;
    });
    cached = entry;
    return entry.info;
  };

  // Binds 0.0.0.0 inside the pod; Host validation still rejects names not in the allowlist.
  const app = createMcpExpressApp({ host: "0.0.0.0", allowedHosts: config.ALLOWED_HOSTS });

  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });

  // Diagnostic only, not a probe: whether the store answers an authenticated
  // request. Readiness must not depend on the store, or woo-mcp could never
  // become ready before the bootstrap Job registers its REST key.
  app.get("/store-health", async (_req, res) => {
    try {
      await woo.get("/data/currencies/current");
      res.json({ status: "ready" });
    } catch (err) {
      res.status(503).json({ status: "unavailable", reason: (err as Error).message });
    }
  });

  const requireBearer = (req: Request, res: Response, next: NextFunction) => {
    const header = req.header("authorization") ?? "";
    // Auth schemes are case-insensitive (RFC 7235).
    const token = /^bearer\s+/i.test(header) ? header.replace(/^bearer\s+/i, "") : "";
    if (!token || !tokenMatches(token, config.MCP_BEARER_TOKEN)) {
      res
        .status(401)
        .set("WWW-Authenticate", "Bearer")
        .json({
          jsonrpc: "2.0",
          error: { code: -32001, message: "Unauthorized" },
          id: null,
        });
      return;
    }
    next();
  };

  // Stateless: each POST gets its own server and transport, so no session state
  // is held between requests and any replica can answer any request.
  app.post("/mcp", requireBearer, async (req, res) => {
    const server = new McpServer({ name: "woocommerce", version: "0.1.0" });
    registerTools(server, woo, storeInfo);
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  // Stateless servers have no standalone SSE stream and no sessions to delete.
  const methodNotAllowed = (_req: Request, res: Response) => {
    res
      .status(405)
      .set("Allow", "POST")
      .json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method not allowed" },
        id: null,
      });
  };
  app.get("/mcp", requireBearer, methodNotAllowed);
  app.delete("/mcp", requireBearer, methodNotAllowed);

  return app;
}
