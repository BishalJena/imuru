import { signOAuth } from "./oauth.js";

/** An error whose message is safe to show to an MCP client and a model. */
export class WooError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "WooError";
  }
}

export interface WooClientOptions {
  baseUrl: string;
  signingUrl: string;
  consumerKey: string;
  consumerSecret: string;
  timeoutMs: number;
  fetch?: typeof fetch;
}

type Query = Record<string, string | number | undefined>;

export class WooClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: WooClientOptions) {
    this.fetchImpl = opts.fetch ?? fetch;
  }

  get<T>(path: string, query: Query = {}): Promise<{ data: T; total?: number }> {
    return this.request<T>("GET", path, query);
  }

  post<T>(path: string, body: unknown): Promise<{ data: T }> {
    return this.request<T>("POST", path, {}, body);
  }

  put<T>(path: string, body: unknown): Promise<{ data: T }> {
    return this.request<T>("PUT", path, {}, body);
  }

  /** Unauthenticated WordPress REST index (site name, URL, timezone). */
  async siteInfo(): Promise<{
    name: string;
    home: string;
    timezone_string: string;
    gmt_offset: number | string;
  }> {
    const res = await this.send(
      new URL("/wp-json/?_fields=name,home,timezone_string,gmt_offset", this.opts.baseUrl),
      { method: "GET" },
    );
    return this.readJson(res);
  }

  private async request<T>(
    method: string,
    path: string,
    query: Query,
    body?: unknown,
  ): Promise<{ data: T; total?: number }> {
    const route = `/wp-json/wc/v3${path}`;
    const plainQuery: Record<string, string> = {};
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) plainQuery[k] = String(v);
    }
    const signed = signOAuth({
      method,
      url: new URL(route, this.opts.signingUrl).toString(),
      query: plainQuery,
      consumerKey: this.opts.consumerKey,
      consumerSecret: this.opts.consumerSecret,
    });
    const url = new URL(route, this.opts.baseUrl);
    url.search = new URLSearchParams(signed).toString();

    const init: RequestInit = { method, headers: { Accept: "application/json" } };
    if (body !== undefined) {
      init.headers = { ...init.headers, "Content-Type": "application/json" };
      init.body = JSON.stringify(body);
    }
    const res = await this.send(url, init);
    const total = res.headers.get("x-wp-total");
    const data = await this.readJson<T>(res);
    return total === null ? { data } : { data, total: Number(total) };
  }

  /**
   * The body is read while the request's abort signal is still running, so a
   * body that stalls past the timeout fails here; both that and a non-JSON
   * body (a PHP notice before the JSON) become clear errors.
   */
  private async readJson<T>(res: Response): Promise<T> {
    try {
      return (await res.json()) as T;
    } catch (err) {
      const name = (err as { name?: string }).name;
      if (name === "TimeoutError" || name === "AbortError") {
        throw new WooError(`Store did not respond within ${this.opts.timeoutMs / 1000}s`);
      }
      throw new WooError("Store returned an invalid response");
    }
  }

  private async send(url: URL, init: RequestInit): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === "TimeoutError") {
        throw new WooError(`Store did not respond within ${this.opts.timeoutMs / 1000}s`);
      }
      throw new WooError("Store is unreachable");
    }
    if (res.ok) return res;

    let code = "";
    let message = "";
    try {
      const body = (await res.json()) as { code?: string; message?: string };
      code = body.code ?? "";
      message = body.message ?? "";
    } catch {
      // Non-JSON error page; fall through to the status-based message.
    }
    if (res.status === 401 || res.status === 403) {
      throw new WooError("Store rejected the MCP server's credentials", res.status);
    }
    if (res.status === 404 || code.endsWith("_invalid_id")) {
      throw new WooError("Not found", 404);
    }
    if (res.status === 400 && message) {
      throw new WooError(stripHtml(message), 400);
    }
    throw new WooError(`Store returned HTTP ${res.status}`, res.status);
  }
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]*>/g, "").slice(0, 300);
}
