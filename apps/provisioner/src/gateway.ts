export interface StoreWork {
  id: string;
  slug: string;
  desired: "present" | "absent";
  status: "provisioning" | "ready" | "failed" | "deleting";
  created_at: string;
}

export interface Gateway {
  pending(): Promise<StoreWork[]>;
  report(
    id: string,
    status: StoreWork["status"],
    fields?: { reason?: string | null; url?: string | null },
  ): Promise<void>;
  purge(id: string): Promise<void>;
  registerServer(
    slug: string,
    input: { name: string; url: string; credential: string },
  ): Promise<void>;
  removeServer(slug: string): Promise<void>;
}

/** The gateway refused because the store was deleted while we worked on it. */
export class StoreCancelledError extends Error {
  constructor(what: string) {
    super(`${what}: store deletion requested`);
    this.name = "StoreCancelledError";
  }
}

/** Client for the gateway's internal API. */
export class GatewayClient implements Gateway {
  constructor(
    private readonly base: string,
    private readonly token: string,
  ) {}

  private async call(method: string, path: string, body?: unknown): Promise<Response> {
    const res = await fetch(`${this.base}/internal${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: body === undefined ? null : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 409) throw new StoreCancelledError(`${method} ${path}`);
    if (!res.ok && res.status !== 404)
      throw new Error(`gateway ${method} ${path}: HTTP ${res.status}`);
    return res;
  }

  async pending() {
    return (await (await this.call("GET", "/stores")).json()) as StoreWork[];
  }
  async report(
    id: string,
    status: StoreWork["status"],
    fields: { reason?: string | null; url?: string | null } = {},
  ) {
    await this.call("PATCH", `/stores/${id}`, { status, ...fields });
  }
  async purge(id: string) {
    await this.call("DELETE", `/stores/${id}`);
  }
  async registerServer(slug: string, input: { name: string; url: string; credential: string }) {
    await this.call("PUT", `/servers/${slug}`, input);
  }
  async removeServer(slug: string) {
    await this.call("DELETE", `/servers/${slug}`);
  }
}
