import * as z from "zod/v4";

const seedUpstream = z.object({
  slug: z.string(),
  name: z.string(),
  url: z.url(),
  auth: z.enum(["none", "bearer", "header"]).default("none"),
  authHeader: z.string().optional(),
  // Name of the environment variable holding the credential, so the value
  // itself comes from a Secret and never appears in values or config.
  credentialEnv: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
});

const schema = z.object({
  PORT: z.coerce.number().int().default(8080),
  GATEWAY_API_KEY: z.string().min(32),
  SEED_UPSTREAMS: z
    .string()
    .default("[]")
    .transform((s) => JSON.parse(s) as unknown)
    .pipe(z.array(seedUpstream)),
  UPSTREAM_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  UPSTREAM_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  HEALTH_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  SESSION_IDLE_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(30 * 60 * 1000),
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
export type SeedUpstream = z.infer<typeof seedUpstream>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`invalid configuration: ${fields}`);
  }
  return parsed.data;
}
