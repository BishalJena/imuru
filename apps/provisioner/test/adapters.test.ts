import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { GatewayClient, StoreCancelledError } from "../src/gateway.js";
import { HelmCli } from "../src/helm.js";
import { InClusterKube } from "../src/k8s.js";

describe("GatewayClient", () => {
  let server: Server;
  let base: string;
  const seen: { method: string; url: string; auth: string; body: string }[] = [];
  const replies: Record<string, [number, unknown]> = {
    "GET /internal/stores": [
      200,
      [{ id: "s1", slug: "a", desired: "present", status: "provisioning", created_at: "x" }],
    ],
    "PATCH /internal/stores/s1": [200, {}],
    "PATCH /internal/stores/gone": [409, { error: { code: "deleting" } }],
    "PUT /internal/servers/store-a": [200, {}],
    "PUT /internal/servers/store-gone": [409, { error: { code: "deleting" } }],
    "PUT /internal/servers/store-taken": [
      409,
      {
        error: {
          code: "conflict",
          message: "A server with that slug is not managed by the provisioner",
        },
      },
    ],
    "DELETE /internal/servers/store-a": [204, null],
    "DELETE /internal/stores/missing": [404, null],
    "DELETE /internal/stores/broken": [500, {}],
  };

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen.push({
          method: req.method!,
          url: req.url!,
          auth: req.headers.authorization ?? "",
          body,
        });
        const [status, payload] = replies[`${req.method} ${req.url}`] ?? [404, null];
        res
          .writeHead(status, { "content-type": "application/json" })
          .end(payload === null ? "" : JSON.stringify(payload));
      });
    });
    server.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    server.close();
  });

  const client = () => new GatewayClient(base, "internal-token");

  it("authenticates every call and reads pending work", async () => {
    const work = await client().pending();
    expect(work[0]).toMatchObject({ id: "s1", desired: "present" });
    expect(seen.at(-1)!.auth).toBe("Bearer internal-token");
  });

  it("sends status reports and server registrations as JSON", async () => {
    await client().report("s1", "ready", { url: "http://a", reason: null });
    expect(JSON.parse(seen.at(-1)!.body)).toEqual({
      status: "ready",
      url: "http://a",
      reason: null,
    });
    await client().registerServer("store-a", {
      name: "A",
      url: "http://w",
      credential: "c".repeat(20),
    });
    expect(seen.at(-1)).toMatchObject({ method: "PUT", url: "/internal/servers/store-a" });
  });

  it("turns 409 into StoreCancelledError (deletion requested meanwhile)", async () => {
    await expect(client().report("gone", "ready")).rejects.toBeInstanceOf(StoreCancelledError);
    await expect(
      client().registerServer("store-gone", {
        name: "G",
        url: "http://w",
        credential: "c".repeat(20),
      }),
    ).rejects.toBeInstanceOf(StoreCancelledError);
  });

  it("a 409 for any other reason is a failure with the gateway's message, not a cancellation", async () => {
    const err = await client()
      .registerServer("store-taken", { name: "T", url: "http://w", credential: "c".repeat(20) })
      .catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(StoreCancelledError);
    expect((err as Error).message).toMatch(/not managed by the provisioner/);
  });

  it("treats 404 on delete as done and other failures as errors", async () => {
    await expect(client().purge("missing")).resolves.toBeUndefined();
    await expect(client().purge("broken")).rejects.toThrow("HTTP 500");
  });
});

describe("HelmCli", () => {
  // A fake helm on PATH: records its arguments, answers `status`, fails on demand.
  const dir = mkdtempSync(path.join(tmpdir(), "fake-helm-"));
  const log = path.join(dir, "calls.log");
  writeFileSync(
    path.join(dir, "helm"),
    `#!/bin/sh
echo "$@" >> "${log}"
case "$1 $2" in
  "status known") echo '{"info":{"status":"pending-install"}}' ;;
  "status missing") echo 'Error: release: not found' >&2; exit 1 ;;
  "upgrade --install") case "$*" in *broken*) echo "line one" >&2; echo "Error: timed out waiting for the condition" >&2; exit 1 ;; esac ;;
esac
`,
  );
  chmodSync(path.join(dir, "helm"), 0o755);
  const originalPath = process.env.PATH;
  beforeAll(() => {
    process.env.PATH = `${dir}:${originalPath}`;
  });
  afterAll(() => {
    process.env.PATH = originalPath;
  });

  it("passes strings with --set-string and booleans with --set", async () => {
    await new HelmCli().upgradeInstall(
      "store-a",
      "/charts/store",
      "store-a",
      { "store.title": "0123", "guardrails.enabled": true },
      "10m",
    );
    const last = readFileSync(log, "utf8").trim().split("\n").at(-1)!;
    expect(last).toBe(
      "upgrade --install store-a /charts/store -n store-a --set-string store.title=0123 --set guardrails.enabled=true --wait --timeout 10m",
    );
  });

  it("reports helm's last error lines as the failure reason", async () => {
    await expect(new HelmCli().upgradeInstall("broken", "/c", "broken", {}, "1m")).rejects.toThrow(
      "line one Error: timed out waiting for the condition",
    );
  });

  it("reads release status, and null for a missing release", async () => {
    expect(await new HelmCli().status("known", "known")).toBe("pending-install");
    expect(await new HelmCli().status("missing", "missing")).toBeNull();
  });
});

describe("loadConfig", () => {
  it("names the missing variables", () => {
    expect(() => loadConfig({})).toThrow(
      /GATEWAY_INTERNAL_URL.*INTERNAL_TOKEN.*DOMAIN.*WOO_MCP_IMAGE_REPOSITORY.*WOO_MCP_IMAGE_TAG/,
    );
  });

  it("applies defaults", () => {
    const c = loadConfig({
      GATEWAY_INTERNAL_URL: "http://gateway:8080",
      INTERNAL_TOKEN: "t".repeat(32),
      DOMAIN: "x.test",
      WOO_MCP_IMAGE_REPOSITORY: "urumi/woo-mcp",
      WOO_MCP_IMAGE_TAG: "abc",
    });
    expect(c).toMatchObject({
      CHART_PATH: "/charts/store",
      HOST_SUFFIX: "-shop",
      CONCURRENCY: 3,
      TLS_ENABLED: "false",
    });
  });
});

describe("InClusterKube", () => {
  let server: Server;
  let base: string;
  const seen: { method: string; url: string; auth: string; body: string }[] = [];
  const replies: Record<string, [number, unknown]> = {
    "GET /api/v1/namespaces/store-a": [200, { status: { phase: "Active" } }],
    "GET /api/v1/namespaces/store-t": [200, { status: { phase: "Terminating" } }],
    "GET /api/v1/namespaces/store-x": [404, { message: "not found" }],
    "POST /api/v1/namespaces": [409, { message: "already exists" }],
    "POST /apis/rbac.authorization.k8s.io/v1/namespaces/store-a/rolebindings": [201, {}],
    "DELETE /api/v1/namespaces/store-a": [202, {}],
    "GET /api/v1/namespaces/store-a/secrets/woo-mcp": [
      200,
      { data: { "bearer-token": Buffer.from("tok-123").toString("base64") } },
    ],
    "GET /api/v1/namespaces/store-a/secrets/forbidden": [403, { message: "secrets is forbidden" }],
  };
  const dir = mkdtempSync(path.join(tmpdir(), "fake-sa-"));
  writeFileSync(path.join(dir, "token"), "sa-token\n");

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen.push({
          method: req.method!,
          url: req.url!,
          auth: req.headers.authorization ?? "",
          body,
        });
        const [status, payload] = replies[`${req.method} ${req.url}`] ?? [
          500,
          { message: "unexpected" },
        ];
        res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(payload));
      });
    });
    server.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    server.close();
  });

  const kube = () => new InClusterKube(base, path.join(dir, "token"));

  it("reads the namespace phase, null when absent, with the ServiceAccount token", async () => {
    expect(await kube().namespacePhase("store-a")).toBe("Active");
    expect(await kube().namespacePhase("store-t")).toBe("Terminating");
    expect(await kube().namespacePhase("store-x")).toBeNull();
    expect(seen.at(-1)!.auth).toBe("Bearer sa-token");
  });

  it("treats an existing namespace as created and labels new ones", async () => {
    await expect(
      kube().createNamespace("store-a", { "urumi.io/store": "true" }),
    ).resolves.toBeUndefined();
    expect(JSON.parse(seen.at(-1)!.body)).toEqual({
      metadata: { name: "store-a", labels: { "urumi.io/store": "true" } },
    });
  });

  it("binds the store role to the provisioner's ServiceAccount", async () => {
    await kube().ensureRoleBinding("store-a", "provisioner", "urumi-store-manager", {
      name: "provisioner",
      namespace: "platform",
    });
    expect(JSON.parse(seen.at(-1)!.body)).toMatchObject({
      roleRef: { kind: "ClusterRole", name: "urumi-store-manager" },
      subjects: [{ kind: "ServiceAccount", name: "provisioner", namespace: "platform" }],
    });
  });

  it("decodes Secret data and surfaces API errors with their message", async () => {
    expect(await kube().readSecret("store-a", "woo-mcp")).toEqual({ "bearer-token": "tok-123" });
    await expect(kube().readSecret("store-a", "forbidden")).rejects.toThrow(
      "HTTP 403 secrets is forbidden",
    );
  });
});
