import type { Server as HttpServer } from "node:http";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { describe as describeError } from "../src/upstream.js";
import { fakeUpstream, until } from "./helpers.js";
import { ADMIN, startGateway } from "./harness.js";

let gw: Awaited<ReturnType<typeof startGateway>>;
let upstream: HttpServer;

beforeAll(async () => {
  gw = await startGateway();
  const a = await fakeUpstream({ name: "alpha" });
  upstream = a.server;
  await gw.servers.create({ slug: "alpha", name: "Alpha", url: a.url, auth_type: "none" });
  await gw.servers.create({
    slug: "dead",
    name: "Dead",
    url: "http://127.0.0.1:59999/mcp",
    auth_type: "none",
  });
  await until(() => gw.registry.get("alpha")?.status === "connected");
  const adminId = (await gw.repo.userByEmailWithHash(ADMIN.email))!.id;
  const key = (await gw.repo.createApiKey(adminId, "obs", adminId)).key;
  const client = new Client({ name: "t", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${gw.url}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${key}` } },
    }),
  );
  await client.callTool({ name: "alpha__echo", arguments: { text: "a" } });
  await client.callTool({ name: "alpha__echo", arguments: { text: "b" } });
  await client.callTool({ name: "nope__echo", arguments: {} });
  await client.close();
  // Audit rows are written asynchronously.
  await until(() => true);
  await new Promise((r) => setTimeout(r, 200));
});

afterAll(async () => {
  await gw.stop();
  upstream.close();
});

describe("/metrics", () => {
  it("exposes call counters, latency histograms and upstream status in Prometheus format", async () => {
    const res = await fetch(`${gw.url}/metrics`);
    expect(res.headers.get("content-type")).toMatch(/text\/plain/);
    const body = await res.text();
    expect(body).toContain(
      'urumi_gateway_tool_calls_total{server="alpha",outcome="ok",via="mcp"} 2',
    );
    expect(body).toContain(
      // Made-up server names are labelled "unknown" (bounded cardinality).
      'urumi_gateway_tool_calls_total{server="unknown",outcome="unknown_tool",via="mcp"} 1',
    );
    expect(body).toContain('urumi_gateway_tool_call_duration_seconds_count{server="alpha"} 2');
    expect(body).toMatch(/urumi_gateway_upstream_up\{server="alpha",status="connected"\} 1/);
    expect(body).toMatch(/urumi_gateway_upstream_up\{server="dead",status="unreachable"\} 0/);
    expect(body).toContain("# TYPE urumi_gateway_tool_call_duration_seconds histogram");
  });
});

describe("/api/servers/stats", () => {
  it("aggregates calls, errors and latency per server from the audit log", async () => {
    const asAdmin = await gw.login(ADMIN.email, ADMIN.password);
    const { servers } = await (await asAdmin("/api/servers/stats?hours=1")).json();
    const alpha = servers.find((s: { server_slug: string }) => s.server_slug === "alpha");
    expect(alpha).toMatchObject({ calls: 2, upstream_errors: 0, refused: 0, error_rate: 0 });
    expect(typeof alpha.p95_ms).toBe("number");
    const nope = servers.find((s: { server_slug: string }) => s.server_slug === "nope");
    expect(nope).toMatchObject({ calls: 1, refused: 1, p50_ms: null });
  });

  it("is admin-only", async () => {
    const inv = await gw.repo.createInvite({
      email: "obs@test.dev",
      name: "O",
      role: "member",
      createdBy: (await gw.repo.userByEmailWithHash(ADMIN.email))!.id,
    });
    if ("error" in inv) throw new Error("invite failed");
    await gw.repo.acceptInvite(inv.token, "member-password-1");
    const asMember = await gw.login("obs@test.dev", "member-password-1");
    expect((await asMember("/api/servers/stats")).status).toBe(403);
  });
});

describe("failure reasons", () => {
  const fetchFailed = (code: string) =>
    Object.assign(new TypeError("fetch failed"), { cause: { code } });

  it("explains network failures hidden in err.cause", () => {
    expect(describeError(fetchFailed("ECONNREFUSED"))).toMatch(/^Connection refused/);
    expect(describeError(fetchFailed("ENOTFOUND"))).toMatch(/^DNS lookup failed/);
    expect(describeError(fetchFailed("ECONNRESET"))).toMatch(/^Connection reset/);
  });

  it("finds the code in nested and aggregated causes", () => {
    const aggregated = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(
        new AggregateError([Object.assign(new Error("x"), { code: "ECONNREFUSED" })]),
        {},
      ),
    });
    expect(describeError(aggregated)).toMatch(/^Connection refused/);
    const badPort = Object.assign(new TypeError("fetch failed"), { cause: new Error("bad port") });
    expect(describeError(badPort)).toMatch(/^Port blocked/);
  });

  it("explains HTTP failures reported in the message", () => {
    expect(describeError(new Error("Error POSTing to endpoint (HTTP 401): unauthorized"))).toBe(
      "Upstream rejected the credential (HTTP 401)",
    );
    expect(describeError(new Error("Error POSTing to endpoint (HTTP 404): Not Found"))).toMatch(
      /check the URL path/,
    );
    expect(describeError(new Error("Error POSTing to endpoint (HTTP 503)"))).toBe(
      "Upstream server error (HTTP 503)",
    );
  });

  it("keeps SSRF guard and timeout messages, and falls back to the raw text", () => {
    expect(
      describeError(new Error("blocked by SSRF guard: URL resolves to a private address")),
    ).toMatch(/SSRF guard/);
    expect(describeError(new Error("connect timed out after 5000ms"))).toMatch(/^Timed out/);
    expect(describeError(new Error("something odd"))).toBe("something odd");
  });

  it("is what the dashboard shows for a dead upstream", () => {
    expect(gw.registry.get("dead")?.lastError).toMatch(/^Connection refused/);
  });
});
