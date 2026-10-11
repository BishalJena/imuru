import { describe, expect, it } from "vitest";
import { WooClient, WooError } from "../src/woo.js";

function client(fetchImpl: typeof fetch, timeoutMs = 1000) {
  return new WooClient({
    baseUrl: "http://wordpress.store.svc",
    signingUrl: "http://store.example.test",
    consumerKey: "ck_x",
    consumerSecret: "cs_y",
    timeoutMs,
    fetch: fetchImpl,
  });
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

describe("WooClient", () => {
  it("sends to the in-cluster URL and returns the X-WP-Total count", async () => {
    let seen = "";
    const woo = client(async (url) => {
      seen = String(url);
      return json(200, [{ id: 1 }], { "x-wp-total": "7" });
    });
    const res = await woo.get("/orders", { per_page: 5, status: undefined });
    expect(seen.startsWith("http://wordpress.store.svc/wp-json/wc/v3/orders?")).toBe(true);
    expect(seen).toContain("oauth_signature=");
    expect(seen).not.toContain("status=");
    expect(res.total).toBe(7);
  });

  it("maps 401 to a credentials error without echoing the body", async () => {
    const woo = client(async () =>
      json(401, { code: "woocommerce_rest_authentication_error", message: "secret detail" }),
    );
    await expect(woo.get("/orders")).rejects.toThrow("Store rejected the MCP server's credentials");
  });

  it("maps 404 to Not found", async () => {
    const woo = client(async () =>
      json(404, { code: "woocommerce_rest_shop_order_invalid_id", message: "Invalid ID." }),
    );
    await expect(woo.get("/orders/99")).rejects.toMatchObject({ status: 404 });
  });

  it("passes 400 validation messages through, without HTML", async () => {
    const woo = client(async () =>
      json(400, { code: "rest_invalid_param", message: "Invalid parameter(s): <b>status</b>" }),
    );
    await expect(woo.put("/orders/1", { status: "nope" })).rejects.toThrow(
      "Invalid parameter(s): status",
    );
  });

  it("times out with a clear message", async () => {
    const woo = client(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
      50,
    );
    await expect(woo.get("/orders")).rejects.toThrow("Store did not respond within 0.05s");
  });

  it("reports a network failure as unreachable", async () => {
    const woo = client(async () => {
      throw new TypeError("fetch failed");
    });
    const err = await woo.get("/orders").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WooError);
    expect((err as Error).message).toBe("Store is unreachable");
  });

  it("maps a non-JSON success body to a clear error (W5)", async () => {
    const woo = client(async () => new Response("<br>PHP Notice: something", { status: 200 }));
    await expect(woo.get("/orders")).rejects.toThrow("Store returned an invalid response");
  });

  it("maps a body that stalls past the timeout to the timeout error (W5)", async () => {
    const woo = client(
      async (_url, init) =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("["));
              init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason));
            },
          }),
          { status: 200 },
        ),
      50,
    );
    await expect(woo.get("/orders")).rejects.toThrow("Store did not respond within 0.05s");
  });
});
