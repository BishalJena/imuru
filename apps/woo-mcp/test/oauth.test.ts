import { describe, expect, it } from "vitest";
import { rfc3986, signOAuth } from "../src/oauth.js";

describe("signOAuth", () => {
  // Reference value from an implementation verified against a live WooCommerce.
  it("matches WooCommerce's signature for a query with reserved characters", () => {
    const signed = signOAuth({
      method: "GET",
      url: "http://store.example.test/wp-json/wc/v3/orders",
      query: { after: "2026-10-10T00:00:00", per_page: "20" },
      consumerKey: "ck_test",
      consumerSecret: "cs_secret",
      nonce: "abc123",
      timestamp: 1791600000,
    });
    expect(signed.oauth_signature).toBe("buKe8QvegZp2GGbYNNgDJ8pArfIVUhJiP6ECtfjbGVQ=");
    expect(signed).toMatchObject({ after: "2026-10-10T00:00:00", oauth_consumer_key: "ck_test" });
  });

  it("never includes the consumer secret in the output", () => {
    const signed = signOAuth({
      method: "GET",
      url: "http://x.test/",
      query: {},
      consumerKey: "ck_a",
      consumerSecret: "cs_do_not_leak",
    });
    expect(JSON.stringify(signed)).not.toContain("cs_do_not_leak");
  });

  it("uses a fresh nonce per request", () => {
    const opts = {
      method: "GET",
      url: "http://x.test/",
      query: {},
      consumerKey: "k",
      consumerSecret: "s",
    };
    expect(signOAuth(opts).oauth_nonce).not.toBe(signOAuth(opts).oauth_nonce);
  });
});

describe("rfc3986", () => {
  it("encodes the characters encodeURIComponent leaves alone, like PHP rawurlencode", () => {
    expect(rfc3986("a b!'()*~")).toBe("a%20b%21%27%28%29%2A~");
  });
});
