import type { Server as HttpServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CHAT_RUN_TIMEOUT_MS, CHAT_TOKEN_TTL_MS } from "../src/agent.js";
import { fakeUpstream, until } from "./helpers.js";
import { ADMIN, startGateway } from "./harness.js";

let gw: Awaited<ReturnType<typeof startGateway>>;
let upstream: HttpServer;
let asAdmin: Awaited<ReturnType<typeof gw.login>>;

beforeAll(async () => {
  gw = await startGateway();
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

describe("chat agent limits (G4)", () => {
  it("the chat token outlives the longest allowed agent run", () => {
    expect(CHAT_TOKEN_TTL_MS).toBeGreaterThan(CHAT_RUN_TIMEOUT_MS);
  });
});

describe("login (G6)", () => {
  it("spends the same password-hashing work on unknown emails as on known ones", async () => {
    const time = async (email: string) => {
      const t = performance.now();
      await fetch(`${gw.url}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password: "wrong-password-123" }),
      });
      return performance.now() - t;
    };
    const unknown = await time("nobody-here@test.dev");
    const known = await time(ADMIN.email);
    // scrypt at these parameters costs tens of milliseconds; a skipped hash costs ~1 ms.
    expect(unknown).toBeGreaterThan(known * 0.4);
  });
});

describe("server edits (G10)", () => {
  it("rejects clearing the header name of a header-authenticated server", async () => {
    const created = await (
      await asAdmin("/api/servers", {
        method: "POST",
        body: JSON.stringify({
          slug: "hdr",
          name: "H",
          url: "http://127.0.0.1:59998/mcp",
          auth_type: "header",
          auth_header_name: "X-Key",
          credential: "secret-value",
        }),
      })
    ).json();
    const res = await asAdmin(`/api/servers/${created.id}`, {
      method: "PATCH",
      body: JSON.stringify({ auth_header_name: null }),
    });
    expect(res.status).toBe(400);
  });
});

describe("invites (G11)", () => {
  it("re-inviting updates role and name and invalidates the earlier link", async () => {
    const invite = async (role: string, name: string) =>
      (
        await (
          await asAdmin("/api/invites", {
            method: "POST",
            body: JSON.stringify({ email: "twice@test.dev", name, role }),
          })
        ).json()
      ).invite_url.split("/invite/")[1];
    const first = await invite("member", "First");
    const second = await invite("admin", "Second");
    expect((await fetch(`${gw.url}/api/invites/${first}`)).status).toBe(404);
    const info = await (await fetch(`${gw.url}/api/invites/${second}`)).json();
    expect(info.name).toBe("Second");
    const user = (await (await asAdmin("/api/users")).json()).find(
      (u: { email: string }) => u.email === "twice@test.dev",
    );
    expect(user.role).toBe("admin");
  });
});

describe("input validation (G13)", () => {
  it("returns 404 for malformed ids instead of a server error", async () => {
    expect(
      (
        await asAdmin("/api/servers/not-a-uuid", {
          method: "PATCH",
          body: JSON.stringify({ name: "x" }),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await asAdmin("/api/users/not-a-uuid", {
          method: "PATCH",
          body: JSON.stringify({ role: "member" }),
        })
      ).status,
    ).toBe(404);
    expect((await asAdmin("/api/keys/not-a-uuid", { method: "DELETE" })).status).toBe(404);
  });

  it("clamps the audit limit instead of failing on negative or huge values", async () => {
    expect((await asAdmin("/api/audit?limit=-5")).status).toBe(200);
    expect((await asAdmin("/api/audit?limit=999999")).status).toBe(200);
  });
});

describe("metrics format (G12)", () => {
  it("groups each metric's samples under its own HELP/TYPE header", async () => {
    const body = await (await fetch(`${gw.url}/metrics`)).text();
    const lines = body.split("\n");
    const toolsHeader = lines.indexOf(
      "# HELP urumi_gateway_upstream_tools Tools currently exposed by the upstream.",
    );
    const upLines = lines
      .map((l, i) => [l, i] as const)
      .filter(([l]) => l.startsWith("urumi_gateway_upstream_up{"));
    expect(upLines.length).toBeGreaterThan(0);
    expect(upLines.every(([, i]) => i < toolsHeader)).toBe(true);
  });
});

describe("auth scheme (W6, gateway side)", () => {
  it("accepts the bearer scheme case-insensitively", async () => {
    const adminId = (await gw.repo.userByEmailWithHash(ADMIN.email))!.id;
    const { key } = await gw.repo.createApiKey(adminId, "case", adminId);
    const res = await fetch(`${gw.url}/mcp`, {
      method: "POST",
      headers: {
        authorization: `bearer ${key}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "t", version: "1" },
        },
      }),
    });
    expect(res.status).toBe(200);
  });
});

describe("managed servers (G2)", () => {
  it("their URL comes from Helm values or the provisioner and cannot be repointed through the API", async () => {
    await gw.servers.seed([
      {
        slug: "seeded",
        name: "Seeded",
        url: "http://127.0.0.1:59997/mcp",
        auth_type: "none",
        credential: null,
      },
    ]);
    const row = (await gw.servers.list()).find((s) => s.slug === "seeded")!;
    const res = await asAdmin(`/api/servers/${row.id}`, {
      method: "PATCH",
      body: JSON.stringify({ url: "http://169.254.169.254/latest/meta-data" }),
    });
    expect(res.status).toBe(409);
    const ok = await asAdmin(`/api/servers/${row.id}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "Renamed", enabled: false }),
    });
    expect(ok.status).toBe(200);
  });
});
