import { describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import type { Gateway, StoreWork } from "../src/gateway.js";
import type { Helm } from "../src/helm.js";
import type { Kube } from "../src/k8s.js";
import { Reconciler } from "../src/reconcile.js";

const cfg = {
  GATEWAY_INTERNAL_URL: "http://gw",
  INTERNAL_TOKEN: "t".repeat(40),
  CHART_PATH: "/charts/store",
  DOMAIN: "127.0.0.1.nip.io",
  HOST_SUFFIX: "-shop",
  TLS_ENABLED: "false",
  CLUSTER_ISSUER: "",
  STORAGE_CLASS: "",
  WOO_MCP_IMAGE_REPOSITORY: "urumi/woo-mcp",
  WOO_MCP_IMAGE_TAG: "abc",
  GATEWAY_NAMESPACE: "platform",
  SERVICE_ACCOUNT: "provisioner",
  POD_NAMESPACE: "platform",
  STORE_CLUSTER_ROLE: "urumi-store-manager",
  HELM_TIMEOUT: "10m",
  INTERVAL_MS: 1000,
  CONCURRENCY: 3,
} satisfies Config;

function fakes(work: StoreWork[], opts: { helmFails?: string; releaseStatus?: string } = {}) {
  const calls: string[] = [];
  const namespaces = new Set<string>();
  const gateway: Gateway = {
    pending: async () => work,
    report: async (id, status, f) =>
      void calls.push(`report ${id} ${status} ${f?.reason ?? ""} ${f?.url ?? ""}`.trim()),
    purge: async (id) => void calls.push(`purge ${id}`),
    registerServer: async (slug, i) => void calls.push(`register ${slug} ${i.url} ${i.credential}`),
    removeServer: async (slug) => void calls.push(`remove ${slug}`),
  };
  const kube: Kube = {
    namespaceExists: async (n) => namespaces.has(n),
    createNamespace: async (n, labels) =>
      void (namespaces.add(n), calls.push(`ns ${n} ${labels["urumi.io/store"]}`)),
    deleteNamespace: async (n) => void (namespaces.delete(n), calls.push(`delete-ns ${n}`)),
    ensureRoleBinding: async (n, _name, role) => void calls.push(`rb ${n} ${role}`),
    readSecret: async () => ({ "bearer-token": "tok" }),
  };
  const helm: Helm = {
    upgradeInstall: async (release, _c, ns, sets) => {
      calls.push(
        `helm install ${release} ${ns} ${sets["store.hostOverride"]} guardrails=${sets["guardrails.enabled"]} tls=${sets["global.tls.enabled"]}`,
      );
      if (opts.helmFails) throw new Error(opts.helmFails);
    },
    uninstall: async (release) => void calls.push(`helm uninstall ${release}`),
    status: async () => opts.releaseStatus ?? null,
    rollback: async (release) => void calls.push(`helm rollback ${release}`),
  };
  return { calls, namespaces, r: new Reconciler(cfg, gateway, kube, helm, () => undefined) };
}

const store = (over: Partial<StoreWork>): StoreWork => ({
  id: "s1",
  slug: "alpha",
  desired: "present",
  status: "provisioning",
  created_at: new Date().toISOString(),
  ...over,
});

describe("Reconciler", () => {
  it("provisions: namespace, scoped RBAC, helm with guardrails, register upstream, ready", async () => {
    const { calls, r } = fakes([store({})]);
    await r.tick();
    expect(calls).toEqual([
      "ns store-alpha true",
      "rb store-alpha urumi-store-manager",
      "helm install store-alpha store-alpha alpha-shop.127.0.0.1.nip.io guardrails=true tls=false",
      "register store-alpha http://woo-mcp.store-alpha.svc:3000/mcp tok",
      "report s1 ready  http://alpha-shop.127.0.0.1.nip.io",
    ]);
  });

  it("fails cleanly with helm's reason", async () => {
    const { calls, r } = fakes([store({})], { helmFails: "timed out waiting for the condition" });
    await r.tick();
    expect(calls.at(-1)).toBe("report s1 failed timed out waiting for the condition");
    expect(calls.some((c) => c.startsWith("register"))).toBe(false);
  });

  it("tears down: deregister, uninstall, delete namespace, then purge once the namespace is gone", async () => {
    const work = [store({ desired: "absent", status: "deleting" })];
    const { calls, namespaces, r } = fakes(work);
    namespaces.add("store-alpha");
    await r.tick();
    expect(calls).toEqual([
      "remove store-alpha",
      "helm uninstall store-alpha",
      "delete-ns store-alpha",
    ]);
    await r.tick();
    expect(calls.slice(3)).toEqual(["remove store-alpha", "purge s1"]);
  });

  it("clears an install interrupted by a restart, then completes", async () => {
    const { calls, r } = fakes([store({})], { releaseStatus: "pending-install" });
    await r.tick();
    expect(calls.slice(2, 4)).toEqual([
      "helm uninstall store-alpha",
      expect.stringMatching(/^helm install store-alpha/),
    ]);
    expect(calls.at(-1)).toMatch(/^report s1 ready/);
  });

  it("rolls back an interrupted upgrade before upgrading again", async () => {
    const { calls, r } = fakes([store({})], { releaseStatus: "pending-upgrade" });
    await r.tick();
    expect(calls[2]).toBe("helm rollback store-alpha");
  });

  it("provisions several stores in parallel up to the concurrency limit", async () => {
    const { calls, r } = fakes([
      store({ id: "a", slug: "a1" }),
      store({ id: "b", slug: "b1" }),
      store({ id: "c", slug: "c1" }),
      store({ id: "d", slug: "d1" }),
    ]);
    await r.tick();
    expect(calls.filter((c) => c.startsWith("report") && c.includes("ready"))).toHaveLength(3);
  });
});
