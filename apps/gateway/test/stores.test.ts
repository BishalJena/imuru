import type { Server as HttpServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fakeUpstream, until } from "./helpers.js";
import { ADMIN, startGateway } from "./harness.js";

let gw: Awaited<ReturnType<typeof startGateway>>;
let upstream: HttpServer;
let upstreamUrl: string;

const internal = (path: string, init: RequestInit = {}, token = gw.internalToken) =>
  fetch(`${gw.url}/internal${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init.headers as Record<string, string>),
    },
  });

beforeAll(async () => {
  gw = await startGateway();
  const u = await fakeUpstream({ name: "shop", token: "t".repeat(32) });
  upstream = u.server;
  upstreamUrl = u.url;
});
afterAll(async () => {
  await gw.stop();
  upstream.close();
});

describe("stores API", () => {
  it("creates a store as provisioning and is idempotent on retry", async () => {
    const asAdmin = await gw.login(ADMIN.email, ADMIN.password);
    const a = await (
      await asAdmin("/api/stores", { method: "POST", body: JSON.stringify({ slug: "alpha" }) })
    ).json();
    expect(a).toMatchObject({ slug: "alpha", status: "provisioning", desired: "present" });
    const again = await (
      await asAdmin("/api/stores", { method: "POST", body: JSON.stringify({ slug: "alpha" }) })
    ).json();
    expect(again.id).toBe(a.id);
  });

  it("enforces the per-user limit", async () => {
    const asAdmin = await gw.login(ADMIN.email, ADMIN.password);
    expect(
      (await asAdmin("/api/stores", { method: "POST", body: JSON.stringify({ slug: "beta" }) }))
        .status,
    ).toBe(202);
    expect(
      (await asAdmin("/api/stores", { method: "POST", body: JSON.stringify({ slug: "gamma" }) }))
        .status,
    ).toBe(429);
  });

  it("validates slugs", async () => {
    const asAdmin = await gw.login(ADMIN.email, ADMIN.password);
    // Must be a valid DNS label once prefixed: no trailing dash (C6).
    for (const slug of ["A", "x", "has space", "a--b", "a".repeat(25), "shop-", "-shop"]) {
      expect(
        (await asAdmin("/api/stores", { method: "POST", body: JSON.stringify({ slug }) })).status,
      ).toBe(400);
    }
  });
});

describe("internal API", () => {
  it("rejects calls without the internal token", async () => {
    expect((await internal("/stores", {}, "wrong".repeat(10))).status).toBe(401);
  });

  it("hands out pending work, records status, and registers the store's MCP server", async () => {
    const pending = await (await internal("/stores")).json();
    const alpha = pending.find((s: { slug: string }) => s.slug === "alpha");
    expect(alpha.status).toBe("provisioning");
    const reg = await internal("/servers/store-alpha", {
      method: "PUT",
      body: JSON.stringify({ name: "Store alpha", url: upstreamUrl, credential: "t".repeat(32) }),
    });
    expect(reg.status).toBe(200);
    await until(() => gw.registry.get("store-alpha")?.status === "connected");
    expect(gw.registry.tools().map((t) => t.name)).toContain("store-alpha__echo");
    const done = await internal(`/stores/${alpha.id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "ready", url: "http://alpha-shop.test" }),
    });
    expect(await done.json()).toMatchObject({ status: "ready", url: "http://alpha-shop.test" });
    const stillPending = await (await internal("/stores")).json();
    expect(stillPending.some((s: { slug: string }) => s.slug === "alpha")).toBe(false);
  });

  it("deletes: request -> pending absent -> deregister -> purge", async () => {
    const asAdmin = await gw.login(ADMIN.email, ADMIN.password);
    const list = await (await asAdmin("/api/stores")).json();
    const alpha = list.find((s: { slug: string }) => s.slug === "alpha");
    expect((await asAdmin(`/api/stores/${alpha.id}`, { method: "DELETE" })).status).toBe(202);
    const pending = await (await internal("/stores")).json();
    expect(pending.find((s: { id: string }) => s.id === alpha.id)).toMatchObject({
      desired: "absent",
      status: "deleting",
    });
    expect((await internal("/servers/store-alpha", { method: "DELETE" })).status).toBe(204);
    expect(gw.registry.get("store-alpha")).toBeUndefined();
    expect((await internal(`/stores/${alpha.id}`, { method: "DELETE" })).status).toBe(204);
    expect(
      (await (await asAdmin("/api/stores")).json()).some((s: { id: string }) => s.id === alpha.id),
    ).toBe(false);
  });

  it("only registers store-* servers", async () => {
    const res = await internal("/servers/woo", {
      method: "PUT",
      body: JSON.stringify({ name: "x", url: upstreamUrl, credential: "t".repeat(32) }),
    });
    expect(res.status).toBe(400);
  });
});

describe("store lifecycle guards", () => {
  it("refuses to register or mark ready a store whose deletion was requested (P3)", async () => {
    const asAdmin = await gw.login(ADMIN.email, ADMIN.password);
    const created = await (
      await asAdmin("/api/stores", { method: "POST", body: JSON.stringify({ slug: "racer" }) })
    ).json();
    await asAdmin(`/api/stores/${created.id}`, { method: "DELETE" });
    const reg = await internal("/servers/store-racer", {
      method: "PUT",
      body: JSON.stringify({ name: "x", url: upstreamUrl, credential: "t".repeat(32) }),
    });
    expect(reg.status).toBe(409);
    const ready = await internal(`/stores/${created.id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "ready", url: "http://x.test" }),
    });
    expect(ready.status).toBe(409);
    expect(gw.registry.get("store-racer")).toBeUndefined();
  });

  it("refuses to register a server for a store that does not exist", async () => {
    const res = await internal("/servers/store-ghost", {
      method: "PUT",
      body: JSON.stringify({ name: "x", url: upstreamUrl, credential: "t".repeat(32) }),
    });
    expect(res.status).toBe(409);
  });

  it("reserves store-* slugs for provisioned stores (G3)", async () => {
    const asAdmin = await gw.login(ADMIN.email, ADMIN.password);
    const res = await asAdmin("/api/servers", {
      method: "POST",
      body: JSON.stringify({
        slug: "store-mine",
        name: "X",
        url: "https://example.com/mcp",
        auth_type: "none",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("the provisioner path never deletes a server it does not manage (G3)", async () => {
    await gw.servers.create({
      slug: "store-legacy",
      name: "Admin's",
      url: upstreamUrl,
      auth_type: "none",
    });
    expect(await gw.servers.removeBySlug("store-legacy")).toBe(false);
    expect((await gw.servers.list()).some((s) => s.slug === "store-legacy")).toBe(true);
  });
});
