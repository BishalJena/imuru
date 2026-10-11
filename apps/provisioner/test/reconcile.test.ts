import { describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import type { Gateway, StoreWork } from "../src/gateway.js";
import type { Helm } from "../src/helm.js";
import type { Kube } from "../src/k8s.js";
import { StoreCancelledError } from "../src/gateway.js";
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

function fakes(
  work: StoreWork[],
  opts: {
    helmFails?: string;
    releaseStatus?: string;
    /** Installs for these slugs wait until release(slug) is called. */
    holdInstall?: string[];
    terminating?: string[];
    cancelled?: string[];
  } = {},
) {
  const calls: string[] = [];
  const namespaces = new Set<string>();
  const held = new Map<string, () => void>();
  const released = new Set<string>();
  // Release may arrive before the install reaches its hold point.
  const release = (slug: string) => (released.add(slug), held.get(slug)?.());
  const gateway: Gateway = {
    pending: async () => work,
    report: async (id, status, f) =>
      void calls.push(`report ${id} ${status} ${f?.reason ?? ""} ${f?.url ?? ""}`.trim()),
    purge: async (id) => void calls.push(`purge ${id}`),
    registerServer: async (slug, i) => {
      if (opts.cancelled?.some((c) => slug === `store-${c}`)) throw new StoreCancelledError(slug);
      calls.push(`register ${slug} ${i.url} ${i.credential}`);
    },
    removeServer: async (slug) => void calls.push(`remove ${slug}`),
  };
  const kube: Kube = {
    namespacePhase: async (n) =>
      opts.terminating?.includes(n) ? "Terminating" : namespaces.has(n) ? "Active" : null,
    createNamespace: async (n, labels) =>
      void (namespaces.add(n), calls.push(`ns ${n} ${labels["urumi.io/store"]}`)),
    deleteNamespace: async (n) => void (namespaces.delete(n), calls.push(`delete-ns ${n}`)),
    ensureRoleBinding: async (n, _name, role) => void calls.push(`rb ${n} ${role}`),
    readSecret: async () => ({ "bearer-token": "tok" }),
  };
  const helm: Helm = {
    upgradeInstall: async (release_, _c, ns, sets) => {
      calls.push(
        `helm install ${release_} ${ns} ${sets["store.hostOverride"]} guardrails=${sets["guardrails.enabled"]} tls=${sets["global.tls.enabled"]}`,
      );
      if (opts.helmFails) throw new Error(opts.helmFails);
      const slug = release_.replace(/^store-/, "");
      if (opts.holdInstall?.includes(slug) && !released.has(slug))
        await new Promise<void>((r) => held.set(slug, r));
      calls.push(`installed ${release_}`);
    },
    uninstall: async (release) => void calls.push(`helm uninstall ${release}`),
    status: async () => opts.releaseStatus ?? null,
    rollback: async (release) => void calls.push(`helm rollback ${release}`),
  };
  return {
    calls,
    namespaces,
    release,
    r: new Reconciler(cfg, gateway, kube, helm, () => undefined),
  };
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
    await r.idle();
    expect(calls).toEqual([
      "ns store-alpha true",
      "rb store-alpha urumi-store-manager",
      "helm install store-alpha store-alpha alpha-shop.127.0.0.1.nip.io guardrails=true tls=false",
      "installed store-alpha",
      "register store-alpha http://woo-mcp.store-alpha.svc:3000/mcp tok",
      "report s1 ready  http://alpha-shop.127.0.0.1.nip.io",
    ]);
  });

  it("fails cleanly with helm's reason", async () => {
    const { calls, r } = fakes([store({})], { helmFails: "timed out waiting for the condition" });
    await r.tick();
    await r.idle();
    expect(calls.at(-1)).toBe("report s1 failed timed out waiting for the condition");
    expect(calls.some((c) => c.startsWith("register"))).toBe(false);
  });

  it("tears down: deregister, uninstall, delete namespace, then purge once the namespace is gone", async () => {
    const work = [store({ desired: "absent", status: "deleting" })];
    const { calls, namespaces, r } = fakes(work);
    namespaces.add("store-alpha");
    await r.tick();
    await r.idle();
    expect(calls).toEqual([
      "remove store-alpha",
      "helm uninstall store-alpha",
      "delete-ns store-alpha",
    ]);
    await r.tick();
    await r.idle();
    expect(calls.slice(3)).toEqual(["remove store-alpha", "purge s1"]);
  });

  it("clears an install interrupted by a restart, then completes", async () => {
    const { calls, r } = fakes([store({})], { releaseStatus: "pending-install" });
    await r.tick();
    await r.idle();
    expect(calls.slice(2, 4)).toEqual([
      "helm uninstall store-alpha",
      expect.stringMatching(/^helm install store-alpha/),
    ]);
    expect(calls.at(-1)).toMatch(/^report s1 ready/);
  });

  it("rolls back an interrupted upgrade before upgrading again", async () => {
    const { calls, r } = fakes([store({})], { releaseStatus: "pending-upgrade" });
    await r.tick();
    await r.idle();
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
    await r.idle();
    expect(calls.filter((c) => c.startsWith("report") && c.includes("ready"))).toHaveLength(3);
  });

  it("does not let one slow install block other stores", async () => {
    const work = [store({ id: "a", slug: "slow" })];
    const { calls, r, release } = fakes(work, { holdInstall: ["slow"] });
    await r.tick();
    work.push(store({ id: "b", slug: "fast" }));
    await r.tick();
    await new Promise((res) => setTimeout(res, 10));
    expect(calls).toContain("register store-fast http://woo-mcp.store-fast.svc:3000/mcp tok");
    expect(calls).not.toContain("installed store-slow");
    release("slow");
    await r.idle();
    expect(calls).toContain("installed store-slow");
  });

  it("does not start the same store twice while it is in flight", async () => {
    const { calls, r, release } = fakes([store({ id: "a", slug: "slow" })], {
      holdInstall: ["slow"],
    });
    await r.tick();
    await r.tick();
    release("slow");
    await r.idle();
    expect(calls.filter((c) => c.startsWith("helm install"))).toHaveLength(1);
  });

  it("deletions waiting on a terminating namespace never starve provisioning", async () => {
    const deleting = ["d1", "d2", "d3", "d4"].map((slug, i) =>
      store({ id: `del${i}`, slug, desired: "absent", status: "deleting" }),
    );
    const { calls, r } = fakes([...deleting, store({ id: "new", slug: "fresh" })], {
      terminating: deleting.map((d) => `store-${d.slug}`),
    });
    await r.tick();
    await r.idle();
    expect(calls).toContain("register store-fresh http://woo-mcp.store-fresh.svc:3000/mcp tok");
    // A terminating namespace is only polled: no repeated uninstall/delete calls.
    expect(
      calls.filter((c) => c.startsWith("helm uninstall") || c.startsWith("delete-ns")),
    ).toEqual([]);
  });

  it("a delete requested mid-install wins: no registration, no 'ready'", async () => {
    const { calls, r } = fakes([store({ slug: "gone" })], { cancelled: ["gone"] });
    await r.tick();
    await r.idle();
    expect(calls.some((c) => c.startsWith("register"))).toBe(false);
    expect(calls.some((c) => c.startsWith("report") && c.includes("ready"))).toBe(false);
    expect(calls.some((c) => c.includes("failed"))).toBe(false);
  });
});
