import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { createApp } from "../src/server.js";
import { WooClient } from "../src/woo.js";

const TOKEN = "t".repeat(40);
let siteCalls = 0;
let siteFails = false;

const fakeStore: typeof fetch = async (input) => {
  const url = new URL(String(input));
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), {
      status,
      headers: { "content-type": "application/json", "x-wp-total": "1" },
    });
  if (url.pathname === "/wp-json/") {
    siteCalls++;
    await new Promise((r) => setTimeout(r, 30));
    if (siteFails) return json({ code: "boom" }, 500);
    return json({
      name: "Offset Store",
      home: "http://store.test",
      timezone_string: "",
      gmt_offset: 5.5,
    });
  }
  if (url.pathname.endsWith("/data/currencies/current")) return json({ code: "INR" });
  if (url.pathname.endsWith("/orders"))
    return json([
      {
        id: 7,
        number: "7",
        status: "processing",
        total: "10.00",
        currency: "INR",
        date_created: "2026-10-11T00:00:00",
        payment_method_title: "COD",
        billing: { first_name: "A", last_name: "B", email: "a@b.c" },
        line_items: [],
      },
    ]);
  return json({});
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

async function call(name: string, args: object, auth = `Bearer ${TOKEN}`) {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: auth,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const text = await res.text();
  const data =
    text
      .split("\n")
      .find((l) => l.startsWith("data:"))
      ?.slice(5) ?? text;
  return { status: res.status, body: JSON.parse(data || "{}") as any };
}

describe("store info", () => {
  it("reports a manual UTC offset as the store timezone (W1)", async () => {
    const { body } = await call("get_store_info", {});
    expect(body.result.structuredContent.timezone).toBe("UTC+05:30");
  });

  it("fetches site info once for concurrent callers (W4)", async () => {
    siteCalls = 0;
    await new Promise((r) => setTimeout(r, 1)); // cache warm from the previous test
    const fresh = createApp(
      config,
      new WooClient({
        baseUrl: config.WOO_BASE_URL,
        signingUrl: config.WOO_SIGNING_URL,
        consumerKey: "ck_x",
        consumerSecret: "cs_y",
        timeoutMs: 1000,
        fetch: fakeStore,
      }),
    );
    const s2 = fresh.listen(0, "127.0.0.1");
    await new Promise((r) => s2.once("listening", r));
    const url = `http://127.0.0.1:${(s2.address() as AddressInfo).port}/mcp`;
    await Promise.all(
      Array.from({ length: 5 }, () =>
        fetch(url, {
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
            params: { name: "get_store_info", arguments: {} },
          }),
        }).then((r) => r.text()),
      ),
    );
    s2.close();
    expect(siteCalls).toBe(1);
  });

  it("list_orders still answers when site info fails (W3)", async () => {
    siteFails = true;
    const fresh = createApp(
      config,
      new WooClient({
        baseUrl: config.WOO_BASE_URL,
        signingUrl: config.WOO_SIGNING_URL,
        consumerKey: "ck_x",
        consumerSecret: "cs_y",
        timeoutMs: 1000,
        fetch: fakeStore,
      }),
    );
    const s3 = fresh.listen(0, "127.0.0.1");
    await new Promise((r) => s3.once("listening", r));
    const res = await fetch(`http://127.0.0.1:${(s3.address() as AddressInfo).port}/mcp`, {
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
        params: { name: "list_orders", arguments: { date: "2026-10-11" } },
      }),
    });
    const text = await res.text();
    s3.close();
    siteFails = false;
    const body = JSON.parse(
      text
        .split("\n")
        .find((l) => l.startsWith("data:"))!
        .slice(5),
    );
    expect(body.result.isError).toBeFalsy();
    expect(body.result.structuredContent.items).toHaveLength(1);
    expect(body.result.structuredContent.range.timezone).toBe("unknown");
  });
});

describe("auth scheme (W6)", () => {
  it("accepts the bearer scheme case-insensitively", async () => {
    const { status } = await call("get_store_info", {}, `bearer ${TOKEN}`);
    expect(status).toBe(200);
  });
});
