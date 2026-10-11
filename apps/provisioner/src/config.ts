import { readFileSync } from "node:fs";
import * as z from "zod/v4";

const schema = z.object({
  GATEWAY_INTERNAL_URL: z.url(),
  INTERNAL_TOKEN: z.string().min(32),
  CHART_PATH: z.string().default("/charts/store"),
  // Set from the chart's Chart.yaml at startup (see index.ts), not from the environment.
  STORE_CHART_REVISION: z.string().default(""),
  // Public hostname of a store: <slug><HOST_SUFFIX>.<DOMAIN>
  DOMAIN: z.string().min(1),
  HOST_SUFFIX: z.string().default("-shop"),
  TLS_ENABLED: z.enum(["true", "false"]).default("false"),
  CLUSTER_ISSUER: z.string().default(""),
  STORAGE_CLASS: z.string().default(""),
  WOO_MCP_IMAGE_REPOSITORY: z.string(),
  WOO_MCP_IMAGE_TAG: z.string(),
  GATEWAY_NAMESPACE: z.string().default("platform"),
  // The provisioner's own identity, bound into each store namespace.
  SERVICE_ACCOUNT: z.string().default("provisioner"),
  POD_NAMESPACE: z.string().default("platform"),
  STORE_CLUSTER_ROLE: z.string().default("urumi-store-manager"),
  HELM_TIMEOUT: z.string().default("10m"),
  INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  CONCURRENCY: z.coerce.number().int().min(1).max(10).default(3),
});

export type Config = z.infer<typeof schema>;

/** The `version` field of a chart's Chart.yaml. */
export function readChartVersion(chartPath: string): string {
  const text = readFileSync(`${chartPath}/Chart.yaml`, "utf8");
  const match = /^version:\s*"?([^"\s]+)"?\s*$/m.exec(text);
  if (!match) throw new Error(`no version in ${chartPath}/Chart.yaml`);
  return match[1]!;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new Error(
      `invalid configuration: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`,
    );
  }
  return parsed.data;
}
