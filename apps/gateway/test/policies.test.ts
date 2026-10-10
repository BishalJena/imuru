import type { Server as HttpServer } from "node:http";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { matches } from "../src/policies.js";
import { fakeUpstream, until } from "./helpers.js";
import { ADMIN, startGateway } from "./harness.js";

let gw: Awaited<ReturnType<typeof startGateway>>;
let upstream: HttpServer;
let memberKey: string;
let adminKey: string;

async function connect(key: string, onChanged?: () => void) {
  const c = new Client({ name: "t", version: "1" });
  if (onChanged)
    c.setNotificationHandler("notifications/tools/list_changed", async () => onChanged());
  await c.connect(
    new StreamableHTTPClientTransport(new URL(`${gw.url}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${key}` } },
    }),
  );
  return c;
}

beforeAll(async () => {
  gw = await startGateway();
  const a = await fakeUpstream({ name: "alpha" });
  upstream = a.server;
  await gw.servers.create({ slug: "alpha", name: "Alpha", url: a.url, auth_type: "none" });
  await until(() => gw.registry.get("alpha")?.status === "connected");
  const adminId = (await gw.repo.userByEmailWithHash(ADMIN.email))!.id;
  adminKey = (await gw.repo.createApiKey(adminId, "a", adminId)).key;
  const inv = await gw.repo.createInvite({
    email: "m@test.dev",
    name: "M",
    role: "member",
    createdBy: adminId,
  });
  if ("error" in inv) throw new Error("invite failed");
  const member = (await gw.repo.acceptInvite(inv.token, "member-password-1"))!;
  memberKey = (await gw.repo.createApiKey(member.id, "m", member.id)).key;
});
afterAll(async () => {
  await gw.stop();
  upstream.close();
});

describe("tool policies", () => {
  it("allows everything by default", async () => {
    const c = await connect(memberKey);
    expect((await c.listTools()).tools.map((t) => t.name)).toContain("alpha__echo");
    await c.close();
  });

  it("hides denied tools from the role, rejects direct calls, audits them, and pushes list_changed", async () => {
    let notified = 0;
    const c = await connect(memberKey, () => notified++);
    await new Promise((r) => setTimeout(r, 100));
    const asAdmin = await gw.login(ADMIN.email, ADMIN.password);
    const res = await asAdmin("/api/policies", {
      method: "POST",
      body: JSON.stringify({ role: "member", server_slug: "alpha", tool_pattern: "ech*" }),
    });
    expect(res.status).toBe(201);
    await until(() => notified > 0);
    expect((await c.listTools()).tools.map((t) => t.name)).not.toContain("alpha__echo");
    const call = await c.callTool({ name: "alpha__echo", arguments: { text: "x" } });
    expect(call).toMatchObject({ isError: true, content: [{ text: "Not permitted" }] });
    const rows = await gw.repo.listAudit({ outcome: "denied", limit: 5 });
    expect(rows[0]).toMatchObject({ user_email: "m@test.dev", server_slug: "alpha", tool: "echo" });
    await c.close();
  });

  it("does not affect other roles", async () => {
    const c = await connect(adminKey);
    expect((await c.listTools()).tools.map((t) => t.name)).toContain("alpha__echo");
    await c.close();
  });

  it("restores access when the rule is removed", async () => {
    const asAdmin = await gw.login(ADMIN.email, ADMIN.password);
    const rules = await (await asAdmin("/api/policies")).json();
    expect((await asAdmin(`/api/policies/${rules[0].id}`, { method: "DELETE" })).status).toBe(204);
    const c = await connect(memberKey);
    expect((await c.listTools()).tools.map((t) => t.name)).toContain("alpha__echo");
    await c.close();
  });

  it("is admin-only", async () => {
    const asMember = await gw.login("m@test.dev", "member-password-1");
    expect((await asMember("/api/policies")).status).toBe(403);
  });
});

describe("matches", () => {
  it("treats * as a wildcard and everything else literally", () => {
    expect(matches("*", "anything")).toBe(true);
    expect(matches("create_*", "create_product")).toBe(true);
    expect(matches("create_*", "list_products")).toBe(false);
    expect(matches("a.b", "aXb")).toBe(false);
  });
});
