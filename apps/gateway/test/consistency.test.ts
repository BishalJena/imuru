import type { Server as HttpServer } from "node:http";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LlmProvider } from "../src/llm.js";
import { fakeUpstream, until } from "./helpers.js";
import { ADMIN, startGateway } from "./harness.js";

/** Answers immediately and records how much history it was given. */
class Recorder implements LlmProvider {
  lastHistory: { role: string; text: string }[] = [];
  start(input: Parameters<LlmProvider["start"]>[0]) {
    this.lastHistory = input.history;
    return { step: async () => ({ text: "ok", calls: [] }), addToolResults: () => undefined };
  }
}

let gw: Awaited<ReturnType<typeof startGateway>>;
let upstream: HttpServer;
let upstreamUrl: string;
let asAdmin: Awaited<ReturnType<typeof gw.login>>;
const recorder = new Recorder();

beforeAll(async () => {
  gw = await startGateway({ provider: recorder });
  const a = await fakeUpstream({ name: "alpha" });
  upstream = a.server;
  upstreamUrl = a.url;
  asAdmin = await gw.login(ADMIN.email, ADMIN.password);
});
afterAll(async () => {
  await gw.stop();
  upstream.close();
});

describe("chat history limits", () => {
  it("accepts a long conversation and keeps the most recent turns within bounds", async () => {
    const messages = Array.from({ length: 60 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      text: i === 59 ? "latest question" : "x".repeat(i === 1 ? 20000 : 10),
    }));
    const res = await asAdmin("/api/chat", { method: "POST", body: JSON.stringify({ messages }) });
    expect(res.status).toBe(200);
    await res.text();
    expect(recorder.lastHistory.length).toBeLessThanOrEqual(40);
    expect(recorder.lastHistory.at(-1)!.text).toBe("latest question");
    expect(recorder.lastHistory.every((m) => m.text.length <= 8000)).toBe(true);
  });
});

describe("registry", () => {
  it("concurrent replaces of the same server settle on one connection without errors", async () => {
    const base = {
      slug: "racing",
      name: "R",
      url: upstreamUrl,
      enabled: true,
      timeoutMs: 1000,
      connectTimeoutMs: 1000,
    };
    await Promise.all([
      gw.registry.replace({ ...base, name: "first" }),
      gw.registry.replace({ ...base, name: "second" }),
      gw.registry.replace({ ...base, name: "third" }),
    ]);
    expect(gw.registry.list().filter((u) => u.config.slug === "racing")).toHaveLength(1);
    expect(gw.registry.get("racing")!.config.name).toBe("third");
    await gw.registry.remove("racing");
  });
});

describe("server credentials", () => {
  it("requires a credential for bearer or header auth", async () => {
    const post = (b: object) =>
      asAdmin("/api/servers", {
        method: "POST",
        body: JSON.stringify({ name: "X", url: "https://example.com/mcp", ...b }),
      });
    expect((await post({ slug: "nocred", auth_type: "bearer" })).status).toBe(400);
    const created = await (await post({ slug: "plain", auth_type: "none" })).json();
    const patched = await asAdmin(`/api/servers/${created.id}`, {
      method: "PATCH",
      body: JSON.stringify({ auth_type: "bearer" }),
    });
    expect(patched.status).toBe(400);
  });
});

describe("seeds", () => {
  it("a Helm seed never takes over a server an admin created", async () => {
    await gw.servers.create({
      slug: "docs",
      name: "Admin docs",
      url: "https://example.com/mcp",
      auth_type: "none",
    });
    await gw.servers.seed([
      {
        slug: "docs",
        name: "Seed docs",
        url: "http://seed.internal/mcp",
        auth_type: "none",
        credential: null,
      },
    ]);
    const row = (await gw.servers.list()).find((s) => s.slug === "docs")!;
    expect(row).toMatchObject({
      name: "Admin docs",
      url: "https://example.com/mcp",
      managed: false,
    });
  });

  it("removing a managed server works without a prior seed in this process", async () => {
    await gw.db.query(
      "INSERT INTO servers (slug, name, url, auth_type, managed) VALUES ('legacy-managed', 'L', 'http://x/mcp', 'none', true)",
    );
    const row = (await gw.servers.list()).find((s) => s.slug === "legacy-managed")!;
    expect(await gw.servers.remove(row.id)).toBe(true);
  });
});

describe("managed servers", () => {
  it("an admin cannot remove a platform-managed server; the store lifecycle does", async () => {
    const row = await gw.servers.upsertManaged({
      slug: "store-kept",
      name: "Kept",
      url: "http://store-kept.svc:3000/mcp",
      credential: "t".repeat(32),
    });
    const res = await asAdmin(`/api/servers/${row!.id}`, { method: "DELETE" });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("managed");
    expect((await gw.servers.get(row!.id))?.slug).toBe("store-kept");
  });
});

describe("role changes", () => {
  it("push tools/list_changed to the user's open sessions", async () => {
    const adminId = (await gw.repo.userByEmailWithHash(ADMIN.email))!.id;
    const inv = await gw.repo.createInvite({
      email: "promote@test.dev",
      name: "P",
      role: "member",
      createdBy: adminId,
    });
    if ("error" in inv) throw new Error("invite");
    const user = (await gw.repo.acceptInvite(inv.token, "promote-password-1"))!;
    const { key } = await gw.repo.createApiKey(user.id, "k", user.id);
    let notified = 0;
    const c = new Client({ name: "t", version: "1" });
    c.setNotificationHandler("notifications/tools/list_changed", async () => void notified++);
    await c.connect(
      new StreamableHTTPClientTransport(new URL(`${gw.url}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${key}` } },
      }),
    );
    await new Promise((r) => setTimeout(r, 100));
    expect(
      (
        await asAdmin(`/api/users/${user.id}`, {
          method: "PATCH",
          body: JSON.stringify({ role: "admin" }),
        })
      ).status,
    ).toBe(200);
    await until(() => notified > 0);
    await c.close();
  });
});

describe("validation errors", () => {
  it("every router reports 400s in one shape: { error: { code, message } } with the field path", async () => {
    const bodies = await Promise.all([
      asAdmin("/api/policies", { method: "POST", body: JSON.stringify({ role: "member" }) }),
      asAdmin("/api/stores", { method: "POST", body: JSON.stringify({}) }),
      asAdmin("/api/servers", { method: "POST", body: JSON.stringify({}) }),
    ]).then((rs) => Promise.all(rs.map((r) => r.json())));
    for (const b of bodies) {
      expect(b.error.code).toBe("invalid");
      expect(b.error.message).toMatch(/^(server_slug|tool_pattern|slug|name|url|auth_type): /);
    }
  });
});
