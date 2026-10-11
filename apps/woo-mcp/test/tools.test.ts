import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/server.js";
import { WooClient } from "../src/woo.js";

const TOKEN = "t".repeat(40);
const sent: { method: string; path: string; body: any; query: URLSearchParams }[] = [];

const order = (id: number, status = "processing") => ({
  id,
  number: String(id),
  status,
  total: "499.00",
  currency: "INR",
  date_created: "2026-10-11T10:00:00",
  payment_method_title: "Cash on delivery",
  billing: { first_name: "Asha", last_name: "Rao", email: "asha@example.com" },
  line_items: [{ product_id: 3, name: "Mug", quantity: 2, total: "598.00" }],
});

const fakeStore: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  sent.push({ method: init?.method ?? "GET", path: url.pathname, body, query: url.searchParams });
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  const path = url.pathname.replace("/wp-json/wc/v3", "");
  if (url.pathname === "/wp-json/")
    return json({ name: "S", home: "http://s", timezone_string: "Asia/Kolkata", gmt_offset: 5.5 });
  if (path === "/data/currencies/current") return json({ code: "INR" });
  if (path === "/products" && init?.method === "POST")
    return json(
      {
        id: 99,
        name: body.name,
        sku: "",
        price: body.regular_price,
        regular_price: body.regular_price,
        status: body.status,
        permalink: "http://s/p/99",
      },
      201,
    );
  if (path === "/orders" && (init?.method ?? "GET") === "GET") return json([order(5)]);
  if (path === "/orders/404")
    return json({ code: "woocommerce_rest_shop_order_invalid_id", message: "Invalid ID." }, 404);
  if (path === "/orders/5" && init?.method === "PUT") return json(order(5, body.status));
  if (path === "/orders/5") return json(order(5));
  return json({ code: "rest_no_route" }, 404);
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
    consumerKey: "ck_x",
    consumerSecret: "cs_y",
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

async function call(name: string, args: object) {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const text = await res.text();
  return JSON.parse(
    text
      .split("\n")
      .find((l) => l.startsWith("data:"))!
      .slice(5),
  ).result as any;
}

describe("create_product", () => {
  it("creates a published simple product and returns the contract shape", async () => {
    const r = await call("create_product", { name: "Demo Hoodie", regular_price: "999" });
    expect(r.structuredContent).toEqual({
      id: 99,
      name: "Demo Hoodie",
      sku: "",
      price: "999",
      regular_price: "999",
      status: "publish",
      permalink: "http://s/p/99",
    });
    expect(sent.at(-1)).toMatchObject({
      method: "POST",
      path: "/wp-json/wc/v3/products",
      body: { type: "simple", name: "Demo Hoodie", regular_price: "999", status: "publish" },
    });
    expect(sent.at(-1)!.body).not.toHaveProperty("description");
  });

  it("rejects prices that are not decimal strings before calling the store", async () => {
    const before = sent.length;
    const r = await call("create_product", { name: "X", regular_price: "nine" });
    expect(r.isError).toBe(true);
    expect(sent.length).toBe(before);
  });
});

describe("get_order", () => {
  it("returns the order with customer and line items", async () => {
    const r = await call("get_order", { id: 5 });
    expect(r.structuredContent).toMatchObject({
      id: 5,
      customer: "Asha Rao",
      email: "asha@example.com",
      item_count: 2,
      payment_method: "Cash on delivery",
      line_items: [{ name: "Mug", quantity: 2 }],
    });
  });

  it("reports a missing order by id", async () => {
    const r = await call("get_order", { id: 404 });
    expect(r).toMatchObject({ isError: true, content: [{ text: "Order 404 not found" }] });
  });
});

describe("update_order_status", () => {
  it("sends the new status and returns the updated order", async () => {
    const r = await call("update_order_status", { id: 5, status: "completed" });
    expect(sent.at(-1)).toMatchObject({
      method: "PUT",
      path: "/wp-json/wc/v3/orders/5",
      body: { status: "completed" },
    });
    expect(r.structuredContent.status).toBe("completed");
  });

  it("only accepts WooCommerce's order statuses", async () => {
    const r = await call("update_order_status", { id: 5, status: "shipped" });
    expect(r.isError).toBe(true);
  });
});

describe("list_orders", () => {
  it("passes status and paging through and reports the range it used", async () => {
    const r = await call("list_orders", {
      after: "2026-10-01T00:00:00",
      status: "processing",
      page: 2,
      per_page: 5,
    });
    const q = sent.filter((s) => s.path.endsWith("/orders")).at(-1)!.query;
    expect(
      Object.fromEntries(["after", "status", "page", "per_page"].map((k) => [k, q.get(k)])),
    ).toEqual({ after: "2026-10-01T00:00:00", status: "processing", page: "2", per_page: "5" });
    expect(q.get("before")).toBeNull();
    expect(r.structuredContent.range).toEqual({
      after: "2026-10-01T00:00:00",
      before: null,
      timezone: "Asia/Kolkata",
    });
  });
});

describe("list_orders input checks", () => {
  it("rejects a date that does not exist without calling the store", async () => {
    const before = sent.length;
    const r = await call("list_orders", { date: "2026-13-40" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/not a calendar date: 2026-13-40/);
    expect(sent.length).toBe(before);
  });

  it("rejects date combined with after or before instead of dropping them", async () => {
    const before = sent.length;
    const r = await call("list_orders", { date: "2026-10-11", after: "2026-10-01T00:00:00" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/either date or after\/before/);
    expect(sent.length).toBe(before);
  });
});

describe("loadConfig", () => {
  it("names every missing or invalid variable", () => {
    expect(() => loadConfig({ WOO_BASE_URL: "not a url", WOO_CONSUMER_KEY: "nope" })).toThrow(
      /WOO_BASE_URL.*WOO_SIGNING_URL.*WOO_CONSUMER_KEY.*WOO_CONSUMER_SECRET.*MCP_BEARER_TOKEN/,
    );
  });

  it("parses a valid environment with defaults", () => {
    const c = loadConfig({
      WOO_BASE_URL: "http://wordpress",
      WOO_SIGNING_URL: "http://store.test",
      WOO_CONSUMER_KEY: "ck_a",
      WOO_CONSUMER_SECRET: "cs_b",
      MCP_BEARER_TOKEN: "x".repeat(32),
      ALLOWED_HOSTS: "woo-mcp, localhost ,",
    });
    expect(c).toMatchObject({
      PORT: 3000,
      WOO_TIMEOUT_MS: 15000,
      ALLOWED_HOSTS: ["woo-mcp", "localhost"],
    });
  });
});
