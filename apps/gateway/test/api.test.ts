import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN, startGateway } from "./harness.js";

let gw: Awaited<ReturnType<typeof startGateway>>;
let asAdmin: Awaited<ReturnType<Awaited<ReturnType<typeof startGateway>>["login"]>>;

beforeAll(async () => {
  gw = await startGateway();
  asAdmin = await gw.login(ADMIN.email, ADMIN.password);
});
afterAll(async () => gw.stop());

async function inviteMember(email: string) {
  const inv = await (
    await asAdmin("/api/invites", {
      method: "POST",
      body: JSON.stringify({ email, name: "Member", role: "member" }),
    })
  ).json();
  const token = inv.invite_url.split("/invite/")[1];
  const res = await fetch(`${gw.url}/api/invites/accept`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, password: "member-password-1" }),
  });
  expect(res.status).toBe(200);
  return gw.login(email, "member-password-1");
}

describe("auth", () => {
  it("rejects wrong passwords and unauthenticated calls", async () => {
    const res = await fetch(`${gw.url}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: ADMIN.email, password: "wrong-password" }),
    });
    expect(res.status).toBe(401);
    expect((await fetch(`${gw.url}/api/me`)).status).toBe(401);
  });

  it("sets an httpOnly SameSite cookie", async () => {
    const res = await fetch(`${gw.url}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ADMIN),
    });
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
  });

  it("rejects non-JSON writes (CSRF)", async () => {
    const res = await asAdmin("/api/keys", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(res.status).toBe(415);
  });

  it("invite links are single-use", async () => {
    const inv = await (
      await asAdmin("/api/invites", {
        method: "POST",
        body: JSON.stringify({ email: "once@test.dev", name: "Once", role: "member" }),
      })
    ).json();
    const token = inv.invite_url.split("/invite/")[1];
    const accept = () =>
      fetch(`${gw.url}/api/invites/accept`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, password: "once-password-1" }),
      });
    expect((await accept()).status).toBe(200);
    expect((await accept()).status).toBe(404);
  });
});

describe("roles", () => {
  it("members cannot manage servers, users or other people's keys", async () => {
    const asMember = await inviteMember("m1@test.dev");
    expect(
      (
        await asMember("/api/servers", {
          method: "POST",
          body: JSON.stringify({
            slug: "x1",
            name: "X",
            url: "https://example.com/mcp",
            auth_type: "none",
          }),
        })
      ).status,
    ).toBe(403);
    expect((await asMember("/api/users")).status).toBe(403);
    expect((await asMember("/api/all-keys")).status).toBe(403);
    expect(
      (
        await asMember("/api/invites", {
          method: "POST",
          body: JSON.stringify({ email: "x@test.dev", name: "X", role: "admin" }),
        })
      ).status,
    ).toBe(403);
  });

  it("a member creates and revokes their own key; the secret is shown once", async () => {
    const asMember = await inviteMember("m2@test.dev");
    const created = await (
      await asMember("/api/keys", { method: "POST", body: JSON.stringify({ name: "laptop" }) })
    ).json();
    expect(created.key).toMatch(/^urk_[A-Za-z0-9]{8}_[A-Za-z0-9_-]{43}$/);
    const listed = await (await asMember("/api/keys")).json();
    expect(JSON.stringify(listed)).not.toContain(created.key.split("_")[2]);
    expect((await asMember(`/api/keys/${created.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await asMember("/api/keys")).ok).toBe(true);
  });

  it("an admin issues and revokes a member's key", async () => {
    await inviteMember("m3@test.dev");
    const users = await (await asAdmin("/api/users")).json();
    const m3 = users.find((u: { email: string }) => u.email === "m3@test.dev");
    const k = await (
      await asAdmin(`/api/users/${m3.id}/keys`, {
        method: "POST",
        body: JSON.stringify({ name: "issued" }),
      })
    ).json();
    expect(k.key).toMatch(/^urk_/);
    expect((await asAdmin(`/api/users/${m3.id}/keys/${k.id}`, { method: "DELETE" })).status).toBe(
      204,
    );
    const all = await (await asAdmin("/api/all-keys")).json();
    expect(all.find((x: { id: string }) => x.id === k.id).revoked_at).not.toBeNull();
  });

  it("the last admin cannot be demoted or disabled", async () => {
    const me = await (await asAdmin("/api/me")).json();
    expect(
      (
        await asAdmin(`/api/users/${me.id}`, {
          method: "PATCH",
          body: JSON.stringify({ role: "member" }),
        })
      ).status,
    ).toBe(409);
  });

  it("members only see their own audit rows", async () => {
    const asMember = await inviteMember("m4@test.dev");
    const adminId = (await (await asAdmin("/api/me")).json()).id;
    await gw.repo.audit({
      userId: adminId,
      userEmail: ADMIN.email,
      apiKeyId: null,
      via: "mcp",
      server: "s",
      tool: "t",
      durationMs: 1,
      outcome: "ok",
    });
    const rows = await (await asMember("/api/audit")).json();
    expect(rows.every((r: { user_email: string }) => r.user_email === "m4@test.dev")).toBe(true);
    const all = await (await asAdmin("/api/audit")).json();
    expect(all.length).toBeGreaterThan(0);
  });
});

describe("servers", () => {
  it("stores credentials encrypted and never returns them", async () => {
    const res = await asAdmin("/api/servers", {
      method: "POST",
      body: JSON.stringify({
        slug: "ext",
        name: "External",
        url: "http://127.0.0.1:9/mcp",
        auth_type: "header",
        auth_header_name: "X-Api-Key",
        credential: "super-secret-value",
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.has_credential).toBe(true);
    expect(JSON.stringify(body)).not.toContain("super-secret-value");
    const raw = await gw.db.query("SELECT credential_enc FROM servers WHERE slug = 'ext'");
    expect(raw.rows[0].credential_enc.toString("utf8")).not.toContain("super-secret-value");
    expect(gw.sealer.open(raw.rows[0].credential_enc)).toBe("super-secret-value");
    const list = await (await asAdmin("/api/servers")).text();
    expect(list).not.toContain("super-secret-value");
  });

  it("members see status and tools but not URLs", async () => {
    const asMember = await inviteMember("m5@test.dev");
    const list = await (await asMember("/api/servers")).json();
    const ext = list.find((s: { slug: string }) => s.slug === "ext");
    expect(ext).toMatchObject({ slug: "ext", status: expect.any(String) });
    expect(ext.url).toBeUndefined();
  });

  it("validates slugs and blocks SSRF targets", async () => {
    const post = (b: object) =>
      asAdmin("/api/servers", {
        method: "POST",
        body: JSON.stringify({ name: "X", auth_type: "none", ...b }),
      });
    expect((await post({ slug: "Bad__Slug", url: "https://example.com/mcp" })).status).toBe(400);
    const meta = await post({ slug: "meta", url: "http://169.254.169.254/latest/meta-data" });
    expect(meta.status).toBe(400);
    expect((await meta.json()).error.code).toBe("url_blocked");
    expect(
      (await post({ slug: "internal", url: "http://postgres.platform.svc:5432" })).status,
    ).toBe(400);
  });

  it("edits, disables and removes a server", async () => {
    const list = await (await asAdmin("/api/servers")).json();
    const ext = list.find((s: { slug: string }) => s.slug === "ext");
    const patched = await (
      await asAdmin(`/api/servers/${ext.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name: "Renamed", enabled: false }),
      })
    ).json();
    expect(patched).toMatchObject({ name: "Renamed", enabled: false, status: "disabled" });
    expect((await asAdmin(`/api/servers/${ext.id}`, { method: "DELETE" })).status).toBe(204);
    expect(gw.registry.get("ext")).toBeUndefined();
  });
});
