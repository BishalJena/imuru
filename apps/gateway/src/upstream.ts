import { EventEmitter } from "node:events";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { CallToolResult, Tool } from "@modelcontextprotocol/server";

export type UpstreamStatus = "connected" | "unreachable" | "disabled";

export interface UpstreamConfig {
  slug: string;
  name: string;
  url: string;
  /** Static credential sent on every request; never exposed to clients. */
  auth?: { type: "bearer"; token: string } | { type: "header"; header: string; value: string };
  enabled: boolean;
  timeoutMs: number;
  connectTimeoutMs: number;
  /** fetch used for every request to this upstream (e.g. the SSRF-guarded one). */
  fetch?: typeof fetch;
}

/**
 * One long-lived MCP client to one upstream server. Tool lists are cached so
 * listing never waits on the network; a background health check keeps status
 * and the cache current.
 */
export class Upstream extends EventEmitter<{ changed: [] }> {
  status: UpstreamStatus;
  lastError: string | null = null;
  tools: Tool[] = [];
  private client: Client | undefined;
  private connecting: Promise<void> | undefined;
  /**
   * Bumped whenever the connection is torn down (disable, close, failure).
   * A connect that started under an older epoch is stale: when it finishes it
   * closes its own client instead of installing it.
   */
  private epoch = 0;
  private closed = false;

  constructor(readonly config: UpstreamConfig) {
    super();
    this.status = config.enabled ? "unreachable" : "disabled";
  }

  async setEnabled(enabled: boolean): Promise<void> {
    if (enabled === this.config.enabled) return;
    this.config.enabled = enabled;
    if (!enabled) {
      await this.disconnect();
      this.update("disabled", null, []);
    } else {
      this.update("unreachable", null, []);
      await this.check();
    }
  }

  /** Health check: connect if needed, then ping. Safe to call concurrently. */
  async check(): Promise<void> {
    if (!this.config.enabled || this.closed) return;
    try {
      if (!this.client) {
        this.connecting ??= this.connect().finally(() => (this.connecting = undefined));
        await this.connecting;
      } else {
        await this.client.ping({ timeout: this.config.connectTimeoutMs });
      }
    } catch (err) {
      await this.disconnect();
      this.update("unreachable", describe(err), []);
    }
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    if (!this.client || this.status !== "connected") {
      throw new UpstreamError("unreachable", `${this.config.name} is unreachable`);
    }
    try {
      return (await this.client.callTool(
        { name, arguments: args },
        { timeout: this.config.timeoutMs },
      )) as CallToolResult;
    } catch (err) {
      if (isTimeout(err)) {
        throw new UpstreamError(
          "timeout",
          `${this.config.name} did not respond within ${this.config.timeoutMs / 1000}s`,
        );
      }
      // The upstream answered, with an error of its own (bad arguments, unknown
      // tool, invalid result): that is a tool failure, not an outage.
      const upstreamError = upstreamErrorMessage(err);
      if (upstreamError) {
        return {
          content: [{ type: "text", text: `${this.config.name}: ${upstreamError}` }],
          isError: true,
        };
      }
      // A transport failure is a strong hint the upstream went away; re-check
      // now instead of waiting for the next health tick.
      void this.check();
      throw new UpstreamError("unreachable", `${this.config.name} is unreachable`);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.disconnect();
  }

  private async connect(): Promise<void> {
    const headers: Record<string, string> = {};
    const auth = this.config.auth;
    if (auth?.type === "bearer") headers.Authorization = `Bearer ${auth.token}`;
    if (auth?.type === "header") headers[auth.header] = auth.value;

    const epoch = this.epoch;
    const client = new Client({ name: "urumi-gateway", version: "0.1.0" });
    client.setNotificationHandler("notifications/tools/list_changed", async () => {
      await this.refreshTools(client).catch((err: unknown) => {
        if (client === this.client) this.lastError = describe(err);
      });
    });
    // Redirects are refused outright: an upstream must not be able to bounce
    // the gateway (and its credential) to another host.
    const transport = new StreamableHTTPClientTransport(new URL(this.config.url), {
      requestInit: { headers, redirect: "error" },
      ...(this.config.fetch ? { fetch: this.config.fetch } : {}),
    });
    try {
      await withTimeout(client.connect(transport), this.config.connectTimeoutMs, "connect");
    } catch (err) {
      // The handshake may still complete in the background; never leak it.
      void client.close().catch(() => undefined);
      throw err;
    }
    if (epoch !== this.epoch || !this.config.enabled || this.closed) {
      await client.close().catch(() => undefined);
      return;
    }
    this.client = client;
    await this.refreshTools(client);
  }

  private async refreshTools(client: Client): Promise<void> {
    if (client !== this.client) return;
    const tools: Tool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : {}, {
        timeout: this.config.connectTimeoutMs,
      });
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    // The connection may have been torn down while listing.
    if (client !== this.client) return;
    this.update("connected", null, tools);
  }

  private async disconnect(): Promise<void> {
    this.epoch++;
    const client = this.client;
    this.client = undefined;
    await client?.close().catch(() => undefined);
  }

  private update(status: UpstreamStatus, error: string | null, tools: Tool[]): void {
    // Compare whole definitions: a changed schema or description must reach clients too.
    const changed = status !== this.status || JSON.stringify(tools) !== JSON.stringify(this.tools);
    this.status = status;
    this.lastError = error;
    this.tools = tools;
    if (changed) this.emit("changed");
  }
}

export class UpstreamError extends Error {
  constructor(
    readonly outcome: "timeout" | "unreachable",
    message: string,
  ) {
    super(message);
  }
}

/** The SDK's own request timeout (not an upstream error that mentions "timed out"). */
function isTimeout(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  return code === "REQUEST_TIMEOUT" || code === -32001;
}

/**
 * The message of an error the upstream itself returned: a JSON-RPC error
 * (numeric code) or a result that failed the client's schema validation.
 * Null for transport failures.
 */
function upstreamErrorMessage(err: unknown): string | null {
  const e = err as { code?: unknown; message?: unknown };
  if (typeof e?.code === "number" || e?.code === "INVALID_RESULT") {
    return String(e.message ?? "error").slice(0, 500);
  }
  return null;
}

/**
 * Why an upstream failed, in words an admin can act on. Node and the SDK
 * report network failures as "fetch failed" with the real code buried in
 * err.cause, and HTTP failures inside the message text.
 */
export function describe(err: unknown): string {
  const e = err as { message?: unknown };
  const msg = String(e?.message ?? err);
  // Collect codes and messages along the cause chain; Node nests one error per
  // attempted address in AggregateError.errors.
  const codes: string[] = [];
  const causes: string[] = [];
  const walk = (x: unknown, depth: number): void => {
    if (!x || typeof x !== "object" || depth > 4) return;
    const c = x as { code?: unknown; message?: unknown; cause?: unknown; errors?: unknown[] };
    if (c.code) codes.push(String(c.code));
    if (depth > 0 && c.message) causes.push(String(c.message));
    walk(c.cause, depth + 1);
    c.errors?.forEach((y) => walk(y, depth + 1));
  };
  walk(err, 0);
  const code = codes.join(" ");
  const status = /HTTP (\d{3})/.exec(msg)?.[1];

  if (msg.includes("blocked by SSRF guard")) return msg.slice(0, 300);
  if (causes.includes("bad port"))
    return "Port blocked by the HTTP client (a reserved port such as 9 or 25)";
  if (/ECONNREFUSED/.test(code + msg))
    return "Connection refused: nothing is listening at that address";
  if (/ENOTFOUND|EAI_AGAIN/.test(code + msg))
    return "DNS lookup failed: the hostname does not resolve";
  if (/ECONNRESET/.test(code) || /socket hang up|ECONNRESET/.test(msg))
    return "Connection reset by the upstream";
  if (/EHOSTUNREACH|ENETUNREACH/.test(code)) return "Network unreachable: no route to the upstream";
  if (/CERT|certificate|self[- ]signed/i.test(code + msg))
    return "TLS certificate error: the upstream's certificate is not trusted";
  if (/redirect/i.test(msg)) return "Upstream answered with a redirect; redirects are refused";
  if (status === "401" || status === "403")
    return `Upstream rejected the credential (HTTP ${status})`;
  if (status === "404") return "MCP endpoint not found (HTTP 404): check the URL path";
  if (status && status.startsWith("5")) return `Upstream server error (HTTP ${status})`;
  if (/timed? ?out/i.test(msg) || /UND_ERR_CONNECT_TIMEOUT|ETIMEDOUT/.test(code))
    return `Timed out: ${msg.slice(0, 200)}`;
  return msg.slice(0, 300);
}

async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
