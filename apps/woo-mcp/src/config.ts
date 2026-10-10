import * as z from "zod/v4";

const schema = z.object({
  PORT: z.coerce.number().int().default(3000),
  // Where requests are sent: the in-cluster WordPress Service.
  WOO_BASE_URL: z.url(),
  // What requests are signed for: WooCommerce verifies OAuth signatures against
  // the site's home URL, which is the public store URL.
  WOO_SIGNING_URL: z.url(),
  WOO_CONSUMER_KEY: z.string().startsWith("ck_"),
  WOO_CONSUMER_SECRET: z.string().startsWith("cs_"),
  WOO_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
  MCP_BEARER_TOKEN: z.string().min(32),
  ALLOWED_HOSTS: z
    .string()
    .default("localhost,127.0.0.1")
    .transform((v) =>
      v
        .split(",")
        .map((h) => h.trim())
        .filter(Boolean),
    ),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`invalid configuration: ${fields}`);
  }
  return parsed.data;
}
