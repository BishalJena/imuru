import type { Registry } from "./registry.js";

/** Latency buckets in seconds; upstream calls range from milliseconds to the 30 s timeout. */
const BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];

const escape = (v: string) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
const labels = (l: Record<string, string>) =>
  `{${Object.entries(l)
    .map(([k, v]) => `${k}="${escape(v)}"`)
    .join(",")}}`;

interface Histogram {
  counts: number[];
  sum: number;
  count: number;
}

/**
 * In-process metrics in the Prometheus text format. Counters reset on restart,
 * as Prometheus counters do; the per-server stats in the dashboard come from
 * the audit log instead, which survives restarts.
 */
export class Metrics {
  private readonly calls = new Map<string, number>();
  private readonly latency = new Map<string, Histogram>();
  private readonly startedAt = Date.now();

  constructor(
    private readonly registry: Registry,
    private readonly sessions: () => number = () => 0,
  ) {}

  recordCall(server: string | null, outcome: string, via: string, durationMs: number): void {
    const s = server ?? "none";
    const key = JSON.stringify([s, outcome, via]);
    this.calls.set(key, (this.calls.get(key) ?? 0) + 1);
    // Latency only for calls that reached an upstream.
    if (outcome === "denied" || outcome === "unknown_tool" || outcome === "auth_rejected") return;
    const h = this.latency.get(s) ?? { counts: BUCKETS.map(() => 0), sum: 0, count: 0 };
    const seconds = durationMs / 1000;
    BUCKETS.forEach((b, i) => {
      if (seconds <= b) h.counts[i]!++;
    });
    h.sum += seconds;
    h.count++;
    this.latency.set(s, h);
  }

  render(): string {
    const out: string[] = [];
    const metric = (name: string, type: string, help: string) =>
      out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);

    metric(
      "urumi_gateway_tool_calls_total",
      "counter",
      "Tool calls through the gateway by server, outcome and channel.",
    );
    for (const [key, n] of this.calls) {
      const [server, outcome, via] = JSON.parse(key) as [string, string, string];
      out.push(`urumi_gateway_tool_calls_total${labels({ server, outcome, via })} ${n}`);
    }

    metric(
      "urumi_gateway_tool_call_duration_seconds",
      "histogram",
      "Upstream tool call latency by server.",
    );
    for (const [server, h] of this.latency) {
      BUCKETS.forEach((b, i) =>
        out.push(
          `urumi_gateway_tool_call_duration_seconds_bucket${labels({ server, le: String(b) })} ${h.counts[i]}`,
        ),
      );
      out.push(
        `urumi_gateway_tool_call_duration_seconds_bucket${labels({ server, le: "+Inf" })} ${h.count}`,
      );
      out.push(`urumi_gateway_tool_call_duration_seconds_sum${labels({ server })} ${h.sum}`);
      out.push(`urumi_gateway_tool_call_duration_seconds_count${labels({ server })} ${h.count}`);
    }

    metric(
      "urumi_gateway_upstream_up",
      "gauge",
      "1 if the upstream is connected, 0 if unreachable or disabled.",
    );
    for (const u of this.registry.list()) {
      const l = labels({ server: u.config.slug, status: u.status });
      out.push(`urumi_gateway_upstream_up${l} ${u.status === "connected" ? 1 : 0}`);
    }
    metric("urumi_gateway_upstream_tools", "gauge", "Tools currently exposed by the upstream.");
    for (const u of this.registry.list()) {
      out.push(
        `urumi_gateway_upstream_tools${labels({ server: u.config.slug })} ${u.tools.length}`,
      );
    }

    metric("urumi_gateway_mcp_sessions", "gauge", "Open MCP sessions on this replica.");
    out.push(`urumi_gateway_mcp_sessions ${this.sessions()}`);

    metric("urumi_gateway_uptime_seconds", "gauge", "Seconds since the gateway process started.");
    out.push(`urumi_gateway_uptime_seconds ${Math.round((Date.now() - this.startedAt) / 1000)}`);

    return `${out.join("\n")}\n`;
  }
}
