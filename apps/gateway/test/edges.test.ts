import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { ADMIN, startGateway } from "./harness.js";

let gw: Awaited<ReturnType<typeof startGateway>>;
let asAdmin: Awaited<ReturnType<typeof gw.login>>;

beforeAll(async () => {
  gw = await startGateway();
  asAdmin = await gw.login(ADMIN.email, ADMIN.password);
});
afterAll(async () => gw.stop());

describe("chat without a configured model", () => {
  it("answers 503 with a clear message instead of failing mid-stream", async () => {
    const res = await asAdmin("/api/chat", {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", text: "hi" }] }),
    });
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("chat_unconfigured");
  });
});

describe("policy input validation", () => {
  it.each([
    [{ role: "owner", server_slug: "woo", tool_pattern: "x" }],
    [{ role: "member", server_slug: "WOO", tool_pattern: "x" }],
    [{ role: "member", server_slug: "woo", tool_pattern: "a b" }],
    [{}],
  ])("rejects %j", async (body) => {
    expect(
      (await asAdmin("/api/policies", { method: "POST", body: JSON.stringify(body) })).status,
    ).toBe(400);
  });

  it("404s for an unknown rule", async () => {
    expect(
      (await asAdmin("/api/policies/00000000-0000-0000-0000-000000000000", { method: "DELETE" }))
        .status,
    ).toBe(404);
  });
});

describe("loadConfig", () => {
  const minimal = {
    DATABASE_URL: "postgres://u:p@db/g",
    PUBLIC_URL: "http://app.test",
    ADMIN_EMAIL: "admin@test.dev",
    ADMIN_PASSWORD: "p".repeat(12),
    SESSION_SECRET: "s".repeat(40),
    CREDENTIAL_KEY: "c".repeat(40),
  };

  it("names missing secrets", () => {
    expect(() => loadConfig({})).toThrow(
      /DATABASE_URL.*PUBLIC_URL.*ADMIN_EMAIL.*ADMIN_PASSWORD.*SESSION_SECRET.*CREDENTIAL_KEY/,
    );
  });

  it("rejects short secrets", () => {
    expect(() => loadConfig({ ...minimal, SESSION_SECRET: "short" })).toThrow(/SESSION_SECRET/);
  });

  it("parses seeds, host lists and defaults", () => {
    const c = loadConfig({
      ...minimal,
      SEED_UPSTREAMS: JSON.stringify([
        {
          slug: "woo",
          name: "W",
          url: "http://woo-mcp:3000/mcp",
          auth: "bearer",
          credentialEnv: "X",
        },
      ]),
      ALLOWED_HOSTS: "app.test, gateway",
      UPSTREAM_ALLOWED_HOSTS: "",
    });
    expect(c.SEED_UPSTREAMS[0]).toMatchObject({ slug: "woo", auth: "bearer", credentialEnv: "X" });
    expect(c.ALLOWED_HOSTS).toEqual(["app.test", "gateway"]);
    expect(c.UPSTREAM_ALLOWED_HOSTS).toEqual([]);
    expect(c).toMatchObject({
      PORT: 8080,
      LLM_PROVIDER: "gemini",
      MAX_STORES_PER_USER: 2,
      HEALTH_INTERVAL_MS: 5000,
    });
  });

  it("falls back to localhost when no Host allowlist is given", () => {
    expect(loadConfig(minimal).ALLOWED_HOSTS).toEqual(["localhost", "127.0.0.1"]);
  });
});
