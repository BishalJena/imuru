import { readFile } from "node:fs/promises";

const SA_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";

export interface Kube {
  /** "Active", "Terminating", or null when the namespace does not exist. */
  namespacePhase(name: string): Promise<"Active" | "Terminating" | null>;
  createNamespace(name: string, labels: Record<string, string>): Promise<void>;
  deleteNamespace(name: string): Promise<void>;
  ensureRoleBinding(
    ns: string,
    name: string,
    clusterRole: string,
    sa: { name: string; namespace: string },
  ): Promise<void>;
  readSecret(ns: string, name: string): Promise<Record<string, string> | null>;
}

/**
 * Minimal Kubernetes API client over fetch, using the pod's ServiceAccount
 * token. The cluster CA comes from NODE_EXTRA_CA_CERTS (set in the Deployment).
 */
export class InClusterKube implements Kube {
  constructor(
    private readonly base = `https://${process.env.KUBERNETES_SERVICE_HOST}:${process.env.KUBERNETES_SERVICE_PORT}`,
    private readonly tokenFile = `${SA_DIR}/token`,
  ) {}

  private async call(method: string, path: string, body?: unknown): Promise<Response> {
    // Re-read per call: projected tokens are rotated by the kubelet.
    const token = (await readFile(this.tokenFile, "utf8")).trim();
    return fetch(`${this.base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: body === undefined ? null : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  }

  private async expect(res: Response, ok: number[], what: string): Promise<void> {
    if (!ok.includes(res.status)) {
      const detail = ((await res.json().catch(() => ({}))) as { message?: string }).message ?? "";
      throw new Error(`${what}: HTTP ${res.status} ${detail}`.trim());
    }
  }

  async namespacePhase(name: string): Promise<"Active" | "Terminating" | null> {
    const res = await this.call("GET", `/api/v1/namespaces/${name}`);
    if (res.status === 404) return null;
    await this.expect(res, [200], `get namespace ${name}`);
    const phase = ((await res.json()) as { status?: { phase?: string } }).status?.phase;
    return phase === "Terminating" ? "Terminating" : "Active";
  }

  async createNamespace(name: string, labels: Record<string, string>): Promise<void> {
    const res = await this.call("POST", "/api/v1/namespaces", { metadata: { name, labels } });
    await this.expect(res, [201, 409], `create namespace ${name}`);
  }

  async deleteNamespace(name: string): Promise<void> {
    const res = await this.call("DELETE", `/api/v1/namespaces/${name}`);
    await this.expect(res, [200, 202, 404], `delete namespace ${name}`);
  }

  async ensureRoleBinding(
    ns: string,
    name: string,
    clusterRole: string,
    sa: { name: string; namespace: string },
  ) {
    const res = await this.call(
      "POST",
      `/apis/rbac.authorization.k8s.io/v1/namespaces/${ns}/rolebindings`,
      {
        metadata: { name },
        roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "ClusterRole", name: clusterRole },
        subjects: [{ kind: "ServiceAccount", name: sa.name, namespace: sa.namespace }],
      },
    );
    await this.expect(res, [201, 409], `create rolebinding in ${ns}`);
  }

  async readSecret(ns: string, name: string): Promise<Record<string, string> | null> {
    const res = await this.call("GET", `/api/v1/namespaces/${ns}/secrets/${name}`);
    if (res.status === 404) return null;
    await this.expect(res, [200], `read secret ${ns}/${name}`);
    const data = ((await res.json()) as { data?: Record<string, string> }).data ?? {};
    return Object.fromEntries(
      Object.entries(data).map(([k, v]) => [k, Buffer.from(v, "base64").toString("utf8")]),
    );
  }
}
