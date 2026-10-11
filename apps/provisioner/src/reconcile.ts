import type { Config } from "./config.js";
import { StoreCancelledError, type Gateway, type StoreWork } from "./gateway.js";
import type { Helm } from "./helm.js";
import type { Kube } from "./k8s.js";

export const STORE_LABEL = "urumi.io/store";
/** Chart version a store namespace was last installed or upgraded with. */
export const REVISION_LABEL = "urumi.io/chart-revision";

// WordPress runs as root in its image, so "restricted" cannot be enforced yet.
// Baseline blocks privileged and host-level pods; restricted is reported as warnings.
const STORE_NAMESPACE_LABELS: Record<string, string> = {
  "app.kubernetes.io/part-of": "urumi",
  "pod-security.kubernetes.io/enforce": "baseline",
  "pod-security.kubernetes.io/enforce-version": "latest",
  "pod-security.kubernetes.io/warn": "restricted",
};
const namespaceOf = (slug: string) => `store-${slug}`;

/**
 * Drives every store toward its desired state. Every step is idempotent, so a
 * store interrupted by a restart is picked up again on the next tick: it
 * either completes or fails with the reason helm or the API reported.
 *
 * Installs and deletions run in separate lanes of CONCURRENCY slots each, and
 * a tick only starts work: a slow install never delays other stores, and
 * deletions waiting for a namespace to terminate never starve new stores.
 */
export class Reconciler {
  private readonly inFlight = new Map<string, Promise<void>>();
  private labelsBackfilled = false;

  constructor(
    private readonly cfg: Config,
    private readonly gateway: Gateway,
    private readonly kube: Kube,
    private readonly helm: Helm,
    private readonly log: (msg: string) => void = (m) => console.log(m),
  ) {}

  /**
   * Brings store namespaces created by an older provisioner up to date: missing
   * labels are added, and releases installed from an older chart are upgraded.
   * Returns false when any namespace failed, so the next tick retries it.
   */
  private async backfillStores(): Promise<boolean> {
    let complete = true;
    for (const ns of await this.kube.storeNamespaces()) {
      if (ns.phase === "Terminating") continue;
      const missing = Object.fromEntries(
        Object.entries(STORE_NAMESPACE_LABELS).filter(([k]) => ns.labels[k] === undefined),
      );
      if (Object.keys(missing).length) await this.kube.labelNamespace(ns.name, missing);
      if (ns.labels[REVISION_LABEL] === this.cfg.STORE_CHART_REVISION) continue;
      const slug = ns.name.replace(/^store-/, "");
      try {
        await this.recoverInterrupted(ns.name);
        await this.helm.upgradeInstall(
          ns.name,
          this.cfg.CHART_PATH,
          ns.name,
          this.storeSets(slug),
          this.cfg.HELM_TIMEOUT,
        );
        await this.kube.labelNamespace(ns.name, {
          [REVISION_LABEL]: this.cfg.STORE_CHART_REVISION,
        });
        this.log(`upgraded ${slug} to chart ${this.cfg.STORE_CHART_REVISION}`);
      } catch (err) {
        complete = false;
        this.log(`upgrade ${slug} will retry: ${(err as Error).message}`);
      }
    }
    return complete;
  }

  /** Starts work for pending stores without waiting for it to finish. */
  async tick(): Promise<void> {
    // Retried on the next tick if it fails: the flag is set only after success.
    if (!this.labelsBackfilled) this.labelsBackfilled = await this.backfillStores();
    const work = await this.gateway.pending();
    for (const lane of ["present", "absent"] as const) {
      const busy = [...this.inFlight.keys()].filter((id) => this.lanes.get(id) === lane).length;
      work
        .filter((w) => w.desired === lane && !this.inFlight.has(w.id))
        .slice(0, Math.max(0, this.cfg.CONCURRENCY - busy))
        .forEach((w) => this.start(w));
    }
  }

  /** Resolves once everything started so far has finished (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.inFlight.size) await Promise.allSettled([...this.inFlight.values()]);
  }

  private readonly lanes = new Map<string, "present" | "absent">();

  private start(store: StoreWork): void {
    this.lanes.set(store.id, store.desired);
    const run = (store.desired === "absent" ? this.teardown(store) : this.provision(store)).finally(
      () => {
        this.inFlight.delete(store.id);
        this.lanes.delete(store.id);
      },
    );
    this.inFlight.set(store.id, run);
  }

  /** Helm values that every store release is installed or upgraded with. */
  private storeSets(slug: string): Record<string, string | boolean> {
    const sets: Record<string, string | boolean> = {
      "global.domain": this.cfg.DOMAIN,
      "global.tls.enabled": this.cfg.TLS_ENABLED === "true",
      "store.hostOverride": this.storeHost(slug),
      "store.title": `Store ${slug}`,
      "wooMcp.image.repository": this.cfg.WOO_MCP_IMAGE_REPOSITORY,
      "wooMcp.image.tag": this.cfg.WOO_MCP_IMAGE_TAG,
      "guardrails.enabled": true,
      "networkPolicy.gateway.namespace": this.cfg.GATEWAY_NAMESPACE,
    };
    if (this.cfg.CLUSTER_ISSUER) sets["global.tls.clusterIssuer"] = this.cfg.CLUSTER_ISSUER;
    if (this.cfg.STORAGE_CLASS) sets["global.storageClass"] = this.cfg.STORAGE_CLASS;
    return sets;
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
      await this.kube.createNamespace(ns, { [STORE_LABEL]: "true", ...STORE_NAMESPACE_LABELS });
      await this.kube.ensureRoleBinding(ns, "provisioner", this.cfg.STORE_CLUSTER_ROLE, {
        name: this.cfg.SERVICE_ACCOUNT,
        namespace: this.cfg.POD_NAMESPACE,
      });
      await this.recoverInterrupted(ns);
      await this.helm.upgradeInstall(
        ns,
        this.cfg.CHART_PATH,
        ns,
        this.storeSets(store.slug),
        this.cfg.HELM_TIMEOUT,
      );
      await this.kube.labelNamespace(ns, { [REVISION_LABEL]: this.cfg.STORE_CHART_REVISION });

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
      if (err instanceof StoreCancelledError) {
        // Deleted while installing: the teardown lane cleans up on a later tick.
        this.log(`cancelled ${store.slug}: deletion requested during provisioning`);
        return;
      }
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
      const phase = await this.kube.namespacePhase(ns);
      // Already terminating: only wait; repeating uninstall/delete achieves nothing.
      if (phase === "Terminating") return;
      if (phase === "Active") {
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
