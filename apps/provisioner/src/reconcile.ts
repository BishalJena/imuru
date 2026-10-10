import type { Config } from "./config.js";
import type { Gateway, StoreWork } from "./gateway.js";
import type { Helm } from "./helm.js";
import type { Kube } from "./k8s.js";

export const STORE_LABEL = "urumi.io/store";
const namespaceOf = (slug: string) => `store-${slug}`;

/**
 * Drives every store toward its desired state. Every step is idempotent, so a
 * store interrupted by a restart is simply picked up again on the next tick:
 * it either completes or fails with the reason helm or the API reported.
 */
export class Reconciler {
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly cfg: Config,
    private readonly gateway: Gateway,
    private readonly kube: Kube,
    private readonly helm: Helm,
    private readonly log: (msg: string) => void = (m) => console.log(m),
  ) {}

  async tick(): Promise<void> {
    const work = await this.gateway.pending();
    const runnable = work
      .filter((w) => !this.inFlight.has(w.id))
      .slice(0, this.cfg.CONCURRENCY - this.inFlight.size);
    await Promise.all(runnable.map((w) => this.run(w)));
  }

  private async run(store: StoreWork): Promise<void> {
    this.inFlight.add(store.id);
    try {
      if (store.desired === "absent") await this.teardown(store);
      else await this.provision(store);
    } finally {
      this.inFlight.delete(store.id);
    }
  }

  storeHost(slug: string): string {
    return `${slug}${this.cfg.HOST_SUFFIX}.${this.cfg.DOMAIN}`;
  }

  private async provision(store: StoreWork): Promise<void> {
    const ns = namespaceOf(store.slug);
    const host = this.storeHost(store.slug);
    const scheme = this.cfg.TLS_ENABLED === "true" ? "https" : "http";
    try {
      this.log(`provisioning ${store.slug}`);
      await this.kube.createNamespace(ns, {
        [STORE_LABEL]: "true",
        "app.kubernetes.io/part-of": "urumi",
      });
      await this.kube.ensureRoleBinding(ns, "provisioner", this.cfg.STORE_CLUSTER_ROLE, {
        name: this.cfg.SERVICE_ACCOUNT,
        namespace: this.cfg.POD_NAMESPACE,
      });
      const sets: Record<string, string | boolean> = {
        "global.domain": this.cfg.DOMAIN,
        "global.tls.enabled": this.cfg.TLS_ENABLED === "true",
        "store.hostOverride": host,
        "store.title": `Store ${store.slug}`,
        "wooMcp.image.repository": this.cfg.WOO_MCP_IMAGE_REPOSITORY,
        "wooMcp.image.tag": this.cfg.WOO_MCP_IMAGE_TAG,
        "guardrails.enabled": true,
        "networkPolicy.gateway.namespace": this.cfg.GATEWAY_NAMESPACE,
      };
      if (this.cfg.CLUSTER_ISSUER) sets["global.tls.clusterIssuer"] = this.cfg.CLUSTER_ISSUER;
      if (this.cfg.STORAGE_CLASS) sets["global.storageClass"] = this.cfg.STORAGE_CLASS;
      await this.recoverInterrupted(ns);
      await this.helm.upgradeInstall(ns, this.cfg.CHART_PATH, ns, sets, this.cfg.HELM_TIMEOUT);

      const secret = await this.kube.readSecret(ns, "woo-mcp");
      const token = secret?.["bearer-token"];
      if (!token) throw new Error("woo-mcp token secret missing after install");
      await this.gateway.registerServer(`store-${store.slug}`, {
        name: `Store ${store.slug}`,
        url: `http://woo-mcp.${ns}.svc:3000/mcp`,
        credential: token,
      });
      await this.gateway.report(store.id, "ready", { url: `${scheme}://${host}`, reason: null });
      this.log(`ready ${store.slug}`);
    } catch (err) {
      const reason = (err as Error).message.slice(0, 1500);
      this.log(`failed ${store.slug}: ${reason}`);
      await this.gateway.report(store.id, "failed", { reason }).catch(() => undefined);
    }
  }

  /**
   * A helm process killed mid-operation (provisioner restart) leaves the
   * release locked in a pending state, and helm refuses further operations.
   * This provisioner is the only actor on store releases (one replica,
   * Recreate), so a pending state seen here is always an interrupted attempt:
   * clear it, then the normal upgrade --install continues from there.
   */
  private async recoverInterrupted(release: string): Promise<void> {
    const status = await this.helm.status(release, release);
    if (status === "pending-install") {
      this.log(`recovering ${release}: interrupted install, reinstalling`);
      await this.helm.uninstall(release, release);
    } else if (status === "pending-upgrade" || status === "pending-rollback") {
      this.log(`recovering ${release}: interrupted ${status}, rolling back`);
      await this.helm.rollback(release, release);
    }
  }

  private async teardown(store: StoreWork): Promise<void> {
    const ns = namespaceOf(store.slug);
    try {
      this.log(`deleting ${store.slug}`);
      // Deregister first, so the tools disappear before the backend does.
      await this.gateway.removeServer(`store-${store.slug}`);
      if (await this.kube.namespaceExists(ns)) {
        await this.helm
          .uninstall(ns, ns)
          .catch((err: Error) => this.log(`uninstall ${ns}: ${err.message}`));
        // Deleting the namespace removes everything left: PVCs, kept Secrets, the RoleBinding.
        await this.kube.deleteNamespace(ns);
        return; // Namespace deletion is asynchronous; purge on a later tick once it is gone.
      }
      await this.gateway.purge(store.id);
      this.log(`deleted ${store.slug}`);
    } catch (err) {
      this.log(`delete ${store.slug} will retry: ${(err as Error).message}`);
    }
  }
}
