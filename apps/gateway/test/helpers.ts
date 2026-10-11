import type { AddressInfo } from "node:net";
import type { Server as HttpServer } from "node:http";
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

export async function listen(app: { listen: (port: number, host: string) => HttpServer }) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

/** A real Streamable HTTP MCP server with an `echo` tool and optional extras. */
export async function fakeUpstream(opts: {
  name: string;
  delayMs?: number;
  token?: string;
  /** Delay before answering `initialize` (slow handshake). */
  initDelayMs?: number;
}) {
  const app = createMcpExpressApp();
  app.post("/mcp", async (req, res) => {
    if (opts.initDelayMs && (req.body as { method?: string })?.method === "initialize") {
      await new Promise((r) => setTimeout(r, opts.initDelayMs));
    }
    if (opts.token && req.header("authorization") !== `Bearer ${opts.token}`) {
      res.status(401).end();
      return;
    }
    const server = new McpServer({ name: opts.name, version: "1.0.0" });
    server.registerTool(
      "echo",
      { description: `echo from ${opts.name}`, inputSchema: z.object({ text: z.string() }) },
      async ({ text }) => {
        if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
        return { content: [{ type: "text", text: `${opts.name}:${text}` }] };
      },
    );
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => void server.close());
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  const { server, url } = await listen(app);
  return { server, url: `${url}/mcp` };
}

/** Polls until `cond` holds; `refresh` (optional) runs before each check. */
export async function until(cond: () => boolean, ms = 3000, refresh?: () => Promise<void>) {
  const end = Date.now() + ms;
  while ((await refresh?.(), !cond())) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 20));
  }
}
