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

const csv = z
  .string()
  .default("")
  .transform((v) =>
    v
      .split(",")
      .map((h) => h.trim())
      .filter(Boolean),
  );

const schema = z.object({
  PORT: z.coerce.number().int().default(8080),
  DATABASE_URL: z.string().startsWith("postgres"),
  MIGRATIONS_DIR: z.string().default("migrations"),
  PUBLIC_URL: z.url(),
  ADMIN_EMAIL: z.email(),
  ADMIN_PASSWORD: z.string().min(10),
  SESSION_SECRET: z.string().min(32),
  CREDENTIAL_KEY: z.string().min(32),
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
  ALLOWED_HOSTS: csv.transform((h) => (h.length ? h : ["localhost", "127.0.0.1"])),
  UPSTREAM_ALLOWED_HOSTS: csv,
  // URL the chat agent uses to reach this gateway's own /mcp.
  SELF_MCP_URL: z.url().default("http://127.0.0.1:8080/mcp"),
  LLM_PROVIDER: z.enum(["gemini", "none"]).default("gemini"),
  LLM_MODEL: z.string().default("gemini-flash-latest"),
  GEMINI_API_KEY: z.string().optional(),
  // Shared with the provisioner; enables /internal and the stores API when set.
  INTERNAL_TOKEN: z.string().min(32).optional(),
  MAX_STORES_PER_USER: z.coerce.number().int().min(0).default(2),
  CHAT_MAX_STEPS: z.coerce.number().int().min(1).max(20).default(8),
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
