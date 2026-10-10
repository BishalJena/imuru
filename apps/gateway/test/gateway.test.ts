import type { Server as HttpServer } from "node:http";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { Config } from "../src/config.js";
import { Registry, splitToolName } from "../src/registry.js";
import { fakeUpstream, listen, until } from "./helpers.js";

const KEY = "k".repeat(40);
const config: Config = {
  PORT: 0,
  GATEWAY_API_KEY: KEY,
  SEED_UPSTREAMS: [],
  UPSTREAM_TIMEOUT_MS: 300,
  UPSTREAM_CONNECT_TIMEOUT_MS: 500,
  HEALTH_INTERVAL_MS: 60_000,
  SESSION_IDLE_MS: 60_000,
  ALLOWED_HOSTS: ["127.0.0.1", "localhost"],
};

const servers: HttpServer[] = [];
let registry: Registry;
let gatewayUrl: string;

async function connectClient(key = KEY, onListChanged?: () => void) {
  const client = new Client({ name: "test", version: "1" });
  if (onListChanged)
    client.setNotificationHandler("notifications/tools/list_changed", async () => onListChanged());
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${gatewayUrl}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${key}` } },
    }),
  );
  return client;
}

beforeAll(async () => {
  const a = await fakeUpstream({ name: "alpha", token: "alpha-secret" });
  const b = await fakeUpstream({ name: "beta" });
  const slow = await fakeUpstream({ name: "slow", delayMs: 2000 });
  servers.push(a.server, b.server, slow.server);

  registry = new Registry();
  const base = { enabled: true, timeoutMs: 300, connectTimeoutMs: 500 };
  registry.add({
    ...base,
    slug: "alpha",
    name: "Alpha",
    url: a.url,
    auth: { type: "bearer", token: "alpha-secret" },
  });
  registry.add({ ...base, slug: "beta", name: "Beta", url: b.url });
  registry.add({ ...base, slug: "slow", name: "Slow", url: slow.url });
  // Nothing listens on port 9: connection refused.
  registry.add({ ...base, slug: "dead", name: "Dead", url: "http://127.0.0.1:9/mcp" });

  const gw = await listen(createApp(config, registry));
  servers.push(gw.server);
  gatewayUrl = gw.url;
  await until(() =>
    registry.list().every((u) => u.status !== "unreachable" || u.config.slug === "dead"),
  );
});

afterAll(async () => {
  await registry.stop();
  for (const s of servers) s.close();
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
  it("rejects a missing or wrong API key before any MCP processing", async () => {
    await expect(connectClient("wrong".repeat(10))).rejects.toThrow();
    const res = await fetch(`${gatewayUrl}/mcp`, { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("namespaces tools so identical upstream names do not collide", async () => {
    const client = await connectClient();
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["alpha__echo", "beta__echo", "slow__echo"]);
    const alpha = (await client.listTools()).tools.find((t) => t.name === "alpha__echo");
    expect(alpha?.description).toBe("[Alpha] echo from alpha");
    await client.close();
  });

  it("lists tools without waiting on a dead upstream", async () => {
    expect(registry.get("dead")?.status).toBe("unreachable");
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
    expect(slow.content).toEqual([{ type: "text", text: "Slow did not respond within 0.3s" }]);
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
    const client = await connectClient(KEY, () => notified++);
    // Open the standalone SSE stream so server-initiated notifications can arrive.
    await new Promise((r) => setTimeout(r, 100));
    await registry.get("beta")!.setEnabled(false);
    await until(() => notified > 0);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain("beta__echo");
    const call = await client.callTool({ name: "beta__echo", arguments: { text: "z" } });
    expect(call.isError).toBe(true);
    await registry.get("beta")!.setEnabled(true);
    await until(() => registry.get("beta")!.status === "connected");
    await client.close();
  });

  it("never exposes upstream URLs or credentials through the API", async () => {
    const res = await fetch(`${gatewayUrl}/api/servers`, {
      headers: { Authorization: `Bearer ${KEY}` },
    });
    const text = await res.text();
    expect(text).not.toContain("alpha-secret");
    expect(text).not.toContain("127.0.0.1");
  });
});
