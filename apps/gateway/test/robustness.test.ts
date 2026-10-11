import type { Server as HttpServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LlmProvider, ToolCallResult } from "../src/llm.js";
import { UrlGuard } from "../src/ssrf.js";
import { Upstream } from "../src/upstream.js";
import { fakeUpstream, until } from "./helpers.js";
import { ADMIN, startGateway } from "./harness.js";

/** One echo call, then an answer; optionally waits for the run's abort signal on step 2. */
class Scripted implements LlmProvider {
  abortedSeen: boolean | null = null;
  constructor(private readonly waitForAbort = false) {}
  start() {
    let n = 0;
    return {
      step: async (signal?: AbortSignal) => {
        n++;
        if (n === 1)
          return { text: null, calls: [{ id: "c1", name: "alpha__echo", args: { text: "x" } }] };
        if (this.waitForAbort) {
          this.abortedSeen = await new Promise<boolean>((resolve) => {
            if (signal?.aborted) return resolve(true);
            signal?.addEventListener("abort", () => resolve(true));
            setTimeout(() => resolve(false), 3000);
          });
        }
        return { text: "done", calls: [] };
      },
      addToolResults: (_r: ToolCallResult[]) => undefined,
    };
  }
}

let gw: Awaited<ReturnType<typeof startGateway>>;
let upstream: HttpServer;
const provider = new Scripted(true);
let asAdmin: Awaited<ReturnType<typeof gw.login>>;

beforeAll(async () => {
  gw = await startGateway({ provider });
  const a = await fakeUpstream({ name: "alpha" });
  upstream = a.server;
  await gw.servers.create({ slug: "alpha", name: "Alpha", url: a.url, auth_type: "none" });
  await until(() => gw.registry.get("alpha")?.status === "connected");
  asAdmin = await gw.login(ADMIN.email, ADMIN.password);
});
afterAll(async () => {
  await gw.stop();
  upstream.close();
});

const sessions = async () =>
  Number(
    /urumi_gateway_mcp_sessions (\d+)/.exec(await (await fetch(`${gw.url}/metrics`)).text())![1],
  );

describe("chat run lifecycle", () => {
  it("aborts the model and tool calls when the browser disconnects, and leaves no MCP session behind", async () => {
    const ctrl = new AbortController();
    const req = asAdmin("/api/chat", {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", text: "go" }] }),
      signal: ctrl.signal,
    })
      .then((r) => r.text())
      .catch(() => "aborted");
    await new Promise((r) => setTimeout(r, 300));
    ctrl.abort();
    await req;
    await until(() => provider.abortedSeen !== null, 4000);
    expect(provider.abortedSeen).toBe(true);
    await until(() => true);
    await new Promise((r) => setTimeout(r, 200));
    expect(await sessions()).toBe(0);
  });
});

describe("stores", () => {
  it("two users racing for the same slug: one 202, one 409, never 500", async () => {
    const inv = await gw.repo.createInvite({
      email: "racer@test.dev",
      name: "R",
      role: "member",
      createdBy: (await gw.repo.userByEmailWithHash(ADMIN.email))!.id,
    });
    if ("error" in inv) throw new Error("invite");
    await gw.repo.acceptInvite(inv.token, "racer-password-1");
    const asMember = await gw.login("racer@test.dev", "racer-password-1");
    const body = JSON.stringify({ slug: "contested" });
    const statuses = (
      await Promise.all([
        asAdmin("/api/stores", { method: "POST", body }),
        asMember("/api/stores", { method: "POST", body }),
      ])
    )
      .map((r) => r.status)
      .sort();
    expect(statuses).toEqual([202, 409]);
  });
});

describe("metrics cardinality", () => {
  it("does not create a series per made-up server name", async () => {
    const adminId = (await gw.repo.userByEmailWithHash(ADMIN.email))!.id;
    const { key } = await gw.repo.createApiKey(adminId, "card", adminId);
    const { Client, StreamableHTTPClientTransport } = await import("@modelcontextprotocol/client");
    const c = new Client({ name: "t", version: "1" });
    await c.connect(
      new StreamableHTTPClientTransport(new URL(`${gw.url}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${key}` } },
      }),
    );
    for (const n of ["r1", "r2", "r3"]) await c.callTool({ name: `${n}__x`, arguments: {} });
    await c.close();
    const body = await (await fetch(`${gw.url}/metrics`)).text();
    expect(body).not.toMatch(/server="r[123]"/);
    expect(body).toMatch(/server="unknown",outcome="unknown_tool"/);
  });
});

describe("tool list changes", () => {
  it("emits a change when a tool's schema changes, not only its name", () => {
    const u = new Upstream({
      slug: "u",
      name: "U",
      url: "http://x/mcp",
      enabled: true,
      timeoutMs: 1000,
      connectTimeoutMs: 1000,
    });
    let changes = 0;
    u.on("changed", () => changes++);
    const update = (
      u as unknown as { update: (s: string, e: null, t: unknown[]) => void }
    ).update.bind(u);
    update("connected", null, [{ name: "t", inputSchema: { type: "object", properties: {} } }]);
    const before = changes;
    update("connected", null, [
      {
        name: "t",
        inputSchema: { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
      },
    ]);
    expect(changes).toBe(before + 1);
  });
});

describe("cookies", () => {
  it("a malformed session cookie is treated as no session, not a server error", async () => {
    const res = await fetch(`${gw.url}/api/me`, { headers: { cookie: "urumi_session=%E0" } });
    expect(res.status).toBe(401);
    const out = await fetch(`${gw.url}/api/auth/logout`, {
      method: "POST",
      headers: { cookie: "urumi_session=%E0", "content-type": "application/json" },
      body: "{}",
    });
    expect(out.status).toBe(204);
  });
});

describe("audit filters", () => {
  it.each([["user=alice"], ["since=not-a-date"]])("rejects %s with 400", async (q) => {
    expect((await asAdmin(`/api/audit?${q}`)).status).toBe(400);
  });
  it("accepts a valid user id and date", async () => {
    expect(
      (await asAdmin("/api/audit?user=00000000-0000-0000-0000-000000000000&since=2026-01-01"))
        .status,
    ).toBe(200);
  });
});

describe("SSRF guard", () => {
  const guard = new UrlGuard([], async () => ["93.184.216.34"]);
  it.each([
    "http://metadata.google.internal./computeMetadata/v1",
    "http://kubernetes.default.svc.cluster.local./",
    "http://[64:ff9b::a9fe:a9fe]/latest/meta-data",
    "http://[2002:a9fe:a9fe::1]/",
  ])("blocks %s", async (url) => {
    expect(await guard.check(url)).not.toBeNull();
  });
});
