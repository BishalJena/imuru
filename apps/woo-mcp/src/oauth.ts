import { createHmac, randomBytes } from "node:crypto";

// RFC 3986 percent-encoding, as PHP's rawurlencode().
export function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export interface OAuthInput {
  method: string;
  /** Absolute URL without query string, on the host WooCommerce considers its home URL. */
  url: string;
  query: Record<string, string>;
  consumerKey: string;
  consumerSecret: string;
  nonce?: string;
  timestamp?: number;
}

/**
 * OAuth 1.0a one-legged signature in the exact form WooCommerce verifies
 * (WC_REST_Authentication::check_oauth_signature): sorted params, each
 * `key=value` pair encoded twice, pairs joined by an encoded `&`, and the
 * consumer secret plus `&` as the HMAC key. Returns the query parameters to send.
 */
export function signOAuth(input: OAuthInput): Record<string, string> {
  const params: Record<string, string> = {
    ...input.query,
    oauth_consumer_key: input.consumerKey,
    oauth_nonce: input.nonce ?? randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA256",
    oauth_timestamp: String(input.timestamp ?? Math.floor(Date.now() / 1000)),
  };
  const pairs = Object.keys(params)
    .sort()
    .map((k) => rfc3986(`${rfc3986(k)}=${rfc3986(params[k] ?? "")}`));
  const base = `${input.method.toUpperCase()}&${rfc3986(input.url)}&${pairs.join("%26")}`;
  const signature = createHmac("sha256", `${input.consumerSecret}&`).update(base).digest("base64");
  return { ...params, oauth_signature: signature };
}
