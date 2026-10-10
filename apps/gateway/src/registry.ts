import { EventEmitter } from "node:events";
import type { CallToolResult, Tool } from "@modelcontextprotocol/server";
import { Upstream, UpstreamError, type UpstreamConfig } from "./upstream.js";

/** Separator between server slug and tool name. Slugs cannot contain it. */
export const SEPARATOR = "__";
export const SLUG_PATTERN = /^[a-z][a-z0-9-]{1,30}$/;

export type CallOutcome = "ok" | "tool_error" | "timeout" | "unreachable" | "unknown_tool";

export interface CallResult {
  result: CallToolResult;
  outcome: CallOutcome;
  server: string | null;
  tool: string;
}

/** Splits `<slug>__<tool>` on the first separator; tool names may themselves contain `__`. */
export function splitToolName(name: string): { slug: string; tool: string } | null {
  const i = name.indexOf(SEPARATOR);
  if (i <= 0) return null;
  return { slug: name.slice(0, i), tool: name.slice(i + SEPARATOR.length) };
}

const errorResult = (text: string): CallToolResult => ({
  content: [{ type: "text", text }],
  isError: true,
});

export class Registry extends EventEmitter<{ toolsChanged: [] }> {
  private readonly upstreams = new Map<string, Upstream>();
  private timer: NodeJS.Timeout | undefined;

  add(config: UpstreamConfig): Upstream {
    if (!SLUG_PATTERN.test(config.slug)) throw new Error(`invalid server slug: ${config.slug}`);
    if (this.upstreams.has(config.slug)) throw new Error(`duplicate server slug: ${config.slug}`);
    const upstream = new Upstream(config);
    upstream.on("changed", () => this.emit("toolsChanged"));
    this.upstreams.set(config.slug, upstream);
    void upstream.check();
    return upstream;
  }

  async remove(slug: string): Promise<void> {
    const upstream = this.upstreams.get(slug);
    if (!upstream) return;
    this.upstreams.delete(slug);
    upstream.removeAllListeners();
    await upstream.close();
    this.emit("toolsChanged");
  }

  /** Replace a server's connection settings: closes the old client and connects anew. */
  async replace(config: UpstreamConfig): Promise<Upstream> {
    await this.remove(config.slug);
    return this.add(config);
  }

  get(slug: string): Upstream | undefined {
    return this.upstreams.get(slug);
  }

  list(): Upstream[] {
    return [...this.upstreams.values()];
  }

  /** Every connected server's tools, namespaced. Served from cache: never waits on an upstream. */
  tools(): Tool[] {
    return this.list()
      .filter((u) => u.status === "connected")
      .flatMap((u) =>
        u.tools.map((t) => ({
          ...t,
          name: `${u.config.slug}${SEPARATOR}${t.name}`,
          description: `[${u.config.name}] ${t.description ?? ""}`.trim(),
        })),
      );
  }

  async call(name: string, args: Record<string, unknown>): Promise<CallResult> {
    const parts = splitToolName(name);
    const upstream = parts ? this.upstreams.get(parts.slug) : undefined;
    if (
      !parts ||
      !upstream ||
      !upstream.config.enabled ||
      !upstream.tools.some((t) => t.name === parts.tool)
    ) {
      return {
        result: errorResult(`Tool ${name} is not available`),
        outcome: "unknown_tool",
        server: parts?.slug ?? null,
        tool: parts?.tool ?? name,
      };
    }
    try {
      const result = await upstream.callTool(parts.tool, args);
      return {
        result,
        outcome: result.isError ? "tool_error" : "ok",
        server: parts.slug,
        tool: parts.tool,
      };
    } catch (err) {
      const outcome = err instanceof UpstreamError ? err.outcome : "unreachable";
      return {
        result: errorResult((err as Error).message),
        outcome,
        server: parts.slug,
        tool: parts.tool,
      };
    }
  }

  start(intervalMs: number): void {
    this.timer = setInterval(() => {
      for (const u of this.upstreams.values()) void u.check();
    }, intervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    await Promise.all(this.list().map((u) => u.close()));
  }
}
