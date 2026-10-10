import type { Server as HttpServer } from "node:http";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { splitToolName } from "../src/registry.js";
import { fakeUpstream, until } from "./helpers.js";
import { startGateway } from "./harness.js";

let gw: Awaited<ReturnType<typeof startGateway>>;
const upstreams: HttpServer[] = [];
let key: string;
let adminId: string;

async function connectClient(token = key, onListChanged?: () => void) {
  const client = new Client({ name: "test", version: "1" });
  if (onListChanged)
    client.setNotificationHandler("notifications/tools/list_changed", async () => onListChanged());
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${gw.url}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}

beforeAll(async () => {
  gw = await startGateway();
  const a = await fakeUpstream({ name: "alpha", token: "alpha-secret" });
  const b = await fakeUpstream({ name: "beta" });
  const slow = await fakeUpstream({ name: "slow", delayMs: 2000 });
  upstreams.push(a.server, b.server, slow.server);
  const base = { auth_type: "none" as const, timeout_ms: 1000 };
  await gw.servers.create({
    ...base,
    slug: "alpha",
    name: "Alpha",
    url: a.url,
    auth_type: "bearer",
    credential: "alpha-secret",
  });
  await gw.servers.create({ ...base, slug: "beta", name: "Beta", url: b.url });
  await gw.servers.create({ ...base, slug: "slow", name: "Slow", url: slow.url });
  // Nothing listens on port 9: connection refused.
  await gw.servers.create({ ...base, slug: "dead", name: "Dead", url: "http://127.0.0.1:9/mcp" });
  await until(() =>
    ["alpha", "beta", "slow"].every((s) => gw.registry.get(s)?.status === "connected"),
  );
  adminId = (await gw.repo.userByEmailWithHash("admin@test.dev"))!.id;
  key = (await gw.repo.createApiKey(adminId, "test", adminId)).key;
});

afterAll(async () => {
  await gw.stop();
  for (const s of upstreams) s.close();
});

describe("splitToolName", () => {
  it("splits on the first separator only", () => {
    expect(splitToolName("woo__list_orders")).toEqual({ slug: "woo", tool: "list_orders" });
    expect(splitToolName("gh__a__b")).toEqual({ slug: "gh", tool: "a__b" });
    expect(splitToolName("nosep")).toBeNull();
    expect(splitToolName("__x")).toBeNull();
  });
});

describe("gateway /mcp", () => {
  it("rejects a missing or malformed API key before any MCP processing", async () => {
    await expect(connectClient("urk_nope")).rejects.toThrow();
    expect((await fetch(`${gw.url}/mcp`, { method: "POST" })).status).toBe(401);
  });

  it("namespaces tools so identical upstream names do not collide", async () => {
    const client = await connectClient();
    const tools = (await client.listTools()).tools;
    expect(tools.map((t) => t.name).sort()).toEqual(["alpha__echo", "beta__echo", "slow__echo"]);
    expect(tools.find((t) => t.name === "alpha__echo")?.description).toBe(
      "[Alpha] echo from alpha",
    );
    await client.close();
  });

  it("lists tools without waiting on a dead upstream", async () => {
    await until(() => gw.registry.get("dead")?.status === "unreachable");
    const client = await connectClient();
    const started = Date.now();
    await client.listTools();
    expect(Date.now() - started).toBeLessThan(200);
    await client.close();
  });

  it("routes calls to the right upstream with its credential", async () => {
    const client = await connectClient();
    const a = await client.callTool({ name: "alpha__echo", arguments: { text: "hi" } });
    const b = await client.callTool({ name: "beta__echo", arguments: { text: "hi" } });
    expect(a.content).toEqual([{ type: "text", text: "alpha:hi" }]);
    expect(b.content).toEqual([{ type: "text", text: "beta:hi" }]);
    await client.close();
  });

  it("times out a slow upstream with a clear error while others keep working", async () => {
    const client = await connectClient();
    const [slow, fast] = await Promise.all([
      client.callTool({ name: "slow__echo", arguments: { text: "x" } }),
      client.callTool({ name: "beta__echo", arguments: { text: "y" } }),
    ]);
    expect(slow.isError).toBe(true);
    expect(slow.content).toEqual([{ type: "text", text: "Slow did not respond within 1s" }]);
    expect(fast.isError).toBeFalsy();
    await client.close();
  });

  it("returns a tool error for unknown tools and dead servers", async () => {
    const client = await connectClient();
    const unknown = await client.callTool({ name: "nope__echo", arguments: {} });
    const dead = await client.callTool({ name: "dead__echo", arguments: {} });
    expect(unknown).toMatchObject({
      isError: true,
      content: [{ text: "Tool nope__echo is not available" }],
    });
    expect(dead).toMatchObject({ isError: true });
    await client.close();
  });

  it("pushes tools/list_changed and drops a disabled server's tools", async () => {
    let notified = 0;
    const client = await connectClient(key, () => notified++);
    await new Promise((r) => setTimeout(r, 100));
    const beta = (await gw.servers.list()).find((s) => s.slug === "beta")!;
    await gw.servers.update(beta.id, { enabled: false });
    await until(() => notified > 0);
    expect((await client.listTools()).tools.map((t) => t.name)).not.toContain("beta__echo");
    expect((await client.callTool({ name: "beta__echo", arguments: { text: "z" } })).isError).toBe(
      true,
    );
    await gw.servers.update(beta.id, { enabled: true });
    await until(() => gw.registry.get("beta")?.status === "connected");
    await client.close();
  });

  it("rejects a revoked key on the next call, inside an open session, and audits it", async () => {
    const k = await gw.repo.createApiKey(adminId, "to-revoke", adminId);
    const client = await connectClient(k.key);
    await client.callTool({ name: "beta__echo", arguments: { text: "before" } });
    await gw.repo.revokeApiKey(k.id);
    await expect(
      client.callTool({ name: "beta__echo", arguments: { text: "after" } }),
    ).rejects.toThrow();
    const rows = await gw.repo.listAudit({ userId: adminId, limit: 20 });
    expect(rows.some((r) => r.outcome === "auth_rejected" && r.error === "key revoked")).toBe(true);
  });

  it("binds a session to the key that opened it", async () => {
    const other = await gw.repo.createApiKey(adminId, "other", adminId);
    const client = await connectClient();
    const sessionId = (client.transport as StreamableHTTPClientTransport).sessionId!;
    const res = await fetch(`${gw.url}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${other.key}`,
        "mcp-session-id": sessionId,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" }),
    });
    expect(res.status).toBe(404);
    await client.close();
  });

  it("writes an audit row for every call with user, server, tool, duration and outcome", async () => {
    const client = await connectClient();
    await client.callTool({ name: "alpha__echo", arguments: { text: "audit" } });
    await client.close();
    await until(() => true);
    const rows = await gw.repo.listAudit({ server: "alpha", limit: 5 });
    expect(rows[0]).toMatchObject({
      user_email: "admin@test.dev",
      via: "mcp",
      server_slug: "alpha",
      tool: "echo",
      outcome: "ok",
    });
    expect(typeof rows[0].duration_ms).toBe("number");
  });
});
