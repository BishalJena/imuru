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
    if (!this.config.enabled) return;
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
      // A failed call is a strong hint the upstream went away; re-check now
      // instead of waiting for the next health tick.
      void this.check();
      throw new UpstreamError("unreachable", `${this.config.name} is unreachable`);
    }
  }

  async close(): Promise<void> {
    await this.disconnect();
  }

  private async connect(): Promise<void> {
    const headers: Record<string, string> = {};
    const auth = this.config.auth;
    if (auth?.type === "bearer") headers.Authorization = `Bearer ${auth.token}`;
    if (auth?.type === "header") headers[auth.header] = auth.value;

    const client = new Client({ name: "urumi-gateway", version: "0.1.0" });
    client.setNotificationHandler("notifications/tools/list_changed", async () => {
      await this.refreshTools(client).catch((err: unknown) => {
        this.lastError = describe(err);
      });
    });
    // Redirects are refused outright: an upstream must not be able to bounce
    // the gateway (and its credential) to another host.
    const transport = new StreamableHTTPClientTransport(new URL(this.config.url), {
      requestInit: { headers, redirect: "error" },
      ...(this.config.fetch ? { fetch: this.config.fetch } : {}),
    });
    await withTimeout(client.connect(transport), this.config.connectTimeoutMs, "connect");
    this.client = client;
    await this.refreshTools(client);
  }

  private async refreshTools(client: Client): Promise<void> {
    const tools: Tool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : {}, {
        timeout: this.config.connectTimeoutMs,
      });
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    this.update("connected", null, tools);
  }

  private async disconnect(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    await client?.close().catch(() => undefined);
  }

  private update(status: UpstreamStatus, error: string | null, tools: Tool[]): void {
    const changed =
      status !== this.status ||
      JSON.stringify(tools.map((t) => t.name)) !== JSON.stringify(this.tools.map((t) => t.name));
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

function isTimeout(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown };
  return e?.code === -32001 || /timed? ?out/i.test(String(e?.message ?? ""));
}

function describe(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
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
