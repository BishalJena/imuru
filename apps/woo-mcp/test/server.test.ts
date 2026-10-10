import type { AddressInfo } from "node:net";
import { request, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { createApp } from "../src/server.js";
import { WooClient } from "../src/woo.js";

const TOKEN = "t".repeat(40);

const fakeStore: typeof fetch = async (input) => {
  const url = new URL(String(input));
  const body = (() => {
    if (url.pathname === "/wp-json/")
      return { name: "Test Store", home: "http://store.test", timezone_string: "Asia/Kolkata" };
    if (url.pathname.endsWith("/data/currencies/current")) return { code: "INR" };
    if (url.pathname.endsWith("/products"))
      return [
        {
          id: 1,
          name: "Mug",
          sku: "M",
          price: "299",
          regular_price: "299",
          status: "publish",
          permalink: "http://store.test/mug",
        },
      ];
    return { code: "rest_no_route" };
  })();
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", "x-wp-total": "1" },
  });
};

const config: Config = {
  PORT: 0,
  WOO_BASE_URL: "http://wordpress.store.svc",
  WOO_SIGNING_URL: "http://store.test",
  WOO_CONSUMER_KEY: "ck_x",
  WOO_CONSUMER_SECRET: "cs_y",
  WOO_TIMEOUT_MS: 1000,
  MCP_BEARER_TOKEN: TOKEN,
  ALLOWED_HOSTS: ["127.0.0.1", "localhost"],
};

let server: Server;
let base: string;

beforeAll(async () => {
  const woo = new WooClient({
    baseUrl: config.WOO_BASE_URL,
    signingUrl: config.WOO_SIGNING_URL,
    consumerKey: config.WOO_CONSUMER_KEY,
    consumerSecret: config.WOO_CONSUMER_SECRET,
    timeoutMs: 1000,
    fetch: fakeStore,
  });
  server = createApp(config, woo).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
});

async function rpc(method: string, params: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${TOKEN}`,
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await res.text();
  // Responses may be framed as a single SSE event.
  const data =
    text.startsWith("event:") || text.startsWith("data:")
      ? (text
          .split("\n")
          .find((l) => l.startsWith("data:"))
          ?.slice(5) ?? "{}")
      : text || "{}";
  return { status: res.status, body: JSON.parse(data) as Record<string, any> };
}

describe("woo-mcp HTTP", () => {
  it("rejects requests without the bearer token", async () => {
    const res = await rpc("tools/list", {}, { authorization: "" });
    expect(res.status).toBe(401);
  });

  it("rejects a wrong bearer token", async () => {
    const res = await rpc("tools/list", {}, { authorization: `Bearer ${"x".repeat(40)}` });
    expect(res.status).toBe(401);
  });

  // fetch() drops a custom Host header, so this uses node:http directly.
  it("rejects Host headers outside the allowlist", async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(`${base}/mcp`, {
        method: "POST",
        headers: {
          host: "evil.example",
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
        },
      });
      req.on("response", (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
    });
    expect(status).toBe(403);
  });

  it("completes initialize", async () => {
    const res = await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    expect(res.status).toBe(200);
    expect(res.body.result.serverInfo.name).toBe("woocommerce");
  });

  it("lists the six store tools", async () => {
    const res = await rpc("tools/list", {});
    const names = (res.body.result.tools as { name: string }[]).map((t) => t.name).sort();
    expect(names).toEqual([
      "create_product",
      "get_order",
      "get_store_info",
      "list_orders",
      "list_products",
      "update_order_status",
    ]);
  });

  it("calls a tool and returns structured content", async () => {
    const res = await rpc("tools/call", { name: "list_products", arguments: {} });
    expect(res.body.result.isError).toBeFalsy();
    expect(res.body.result.structuredContent).toMatchObject({
      total: 1,
      items: [{ name: "Mug", price: "299" }],
    });
  });

  it("returns store-local today from get_store_info", async () => {
    const res = await rpc("tools/call", { name: "get_store_info", arguments: {} });
    expect(res.body.result.structuredContent).toMatchObject({
      timezone: "Asia/Kolkata",
      currency: "INR",
    });
    expect(res.body.result.structuredContent.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("rejects invalid arguments as a tool error", async () => {
    const res = await rpc("tools/call", {
      name: "create_product",
      arguments: { name: "X", regular_price: "abc" },
    });
    expect(res.body.result?.isError ?? Boolean(res.body.error)).toBe(true);
  });
});
