import { randomUUID } from "node:crypto";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { isInitializeRequest, Server } from "@modelcontextprotocol/server";
import type { Request, Response, Router } from "express";
import express from "express";
import { principalOf, type Principal } from "./auth.js";
import type { Registry } from "./registry.js";

interface Session {
  transport: NodeStreamableHTTPServerTransport;
  server: Server;
  principal: Principal;
  lastSeen: number;
}

export interface McpEndpointOptions {
  sessionIdleMs: number;
  onCall?: (event: {
    principal: Principal;
    server: string | null;
    tool: string;
    outcome: string;
    durationMs: number;
  }) => void;
}

/**
 * The gateway's own MCP server. Stateful: each client gets a session, which
 * lets the gateway push notifications/tools/list_changed when servers are
 * enabled, disabled or go down.
 */
export function mcpRouter(registry: Registry, opts: McpEndpointOptions): Router {
  const sessions = new Map<string, Session>();

  const buildServer = (principal: Principal): Server => {
    const server = new Server(
      { name: "urumi-gateway", version: "0.1.0" },
      { capabilities: { tools: { listChanged: true } } },
    );
    server.setRequestHandler("tools/list", async () => ({ tools: registry.tools() }));
    server.setRequestHandler("tools/call", async (request) => {
      const started = performance.now();
      const res = await registry.call(request.params.name, request.params.arguments ?? {});
      opts.onCall?.({
        principal,
        server: res.server,
        tool: res.tool,
        outcome: res.outcome,
        durationMs: Math.round(performance.now() - started),
      });
      return res.result;
    });
    return server;
  };

  registry.on("toolsChanged", () => {
    for (const s of sessions.values()) {
      void s.server.sendToolListChanged().catch(() => undefined);
    }
  });

  const sweep = setInterval(() => {
    const cutoff = Date.now() - opts.sessionIdleMs;
    for (const [id, s] of sessions) {
      if (s.lastSeen < cutoff) {
        sessions.delete(id);
        void s.transport.close();
      }
    }
  }, 60_000);
  sweep.unref();

  const rpcError = (res: Response, status: number, message: string) =>
    res.status(status).json({ jsonrpc: "2.0", error: { code: -32000, message }, id: null });

  const route = async (req: Request, res: Response) => {
    const principal = principalOf(res);
    const sessionId = req.header("mcp-session-id");

    if (sessionId) {
      const session = sessions.get(sessionId);
      // A session belongs to the key that opened it. Another key presenting the
      // same id gets the same answer as an unknown id.
      if (!session || session.principal.keyId !== principal.keyId) {
        rpcError(res, 404, "Session not found");
        return;
      }
      session.lastSeen = Date.now();
      await session.transport.handleRequest(req, res, req.body);
      return;
    }

    if (req.method !== "POST" || !isInitializeRequest(req.body)) {
      rpcError(res, 400, "Bad Request: Mcp-Session-Id header required");
      return;
    }

    const server = buildServer(principal);
    const transport: NodeStreamableHTTPServerTransport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, server, principal, lastSeen: Date.now() });
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  };

  const router = express.Router();
  router.post("/", route);
  router.get("/", route);
  router.delete("/", route);
  return router;
}
