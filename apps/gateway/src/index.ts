import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { Sealer, TokenSigner } from "./crypto.js";
import { createPool, migrate } from "./db.js";
import { GeminiProvider, OpenAiCompatProvider, type LlmProvider } from "./llm.js";
import { Policies } from "./policies.js";
import { Registry } from "./registry.js";
import { Repo } from "./repo.js";
import { ServerService, type SeedServer } from "./servers.js";
import { UrlGuard } from "./ssrf.js";
import { StoreService } from "./stores.js";

const config = loadConfig();
const db = createPool(config.DATABASE_URL);
const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  config.MIGRATIONS_DIR,
);

async function connectWithRetry(): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await db.query("SELECT 1");
      return;
    } catch (err) {
      if (attempt >= 30) throw err;
      console.log(`database not ready (${(err as Error).message}); retrying`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

await connectWithRetry();
const applied = await migrate(db, migrationsDir);
if (applied.length) console.log(`applied migrations: ${applied.join(", ")}`);

const repo = new Repo(db);
await repo.ensureAdmin(config.ADMIN_EMAIL, "Admin", config.ADMIN_PASSWORD);

const registry = new Registry();
const urlGuard = new UrlGuard(config.UPSTREAM_ALLOWED_HOSTS);
const servers = new ServerService(
  db,
  new Sealer(config.CREDENTIAL_KEY),
  registry,
  config.UPSTREAM_CONNECT_TIMEOUT_MS,
  urlGuard.fetch(),
);

const seeds: SeedServer[] = config.SEED_UPSTREAMS.map((s) => {
  const credential = s.credentialEnv ? (process.env[s.credentialEnv] ?? null) : null;
  if (s.auth !== "none" && !credential)
    console.warn(`upstream ${s.slug}: no credential in ${s.credentialEnv}`);
  return {
    slug: s.slug,
    name: s.name,
    url: s.url,
    auth_type: s.auth,
    auth_header_name: s.authHeader ?? null,
    credential,
    timeout_ms: s.timeoutMs ?? config.UPSTREAM_TIMEOUT_MS,
  };
});
await servers.seed(seeds);
await servers.loadAll();
registry.start(config.HEALTH_INTERVAL_MS);

const signer = new TokenSigner(config.SESSION_SECRET);
let provider: LlmProvider | null = null;
if (config.LLM_PROVIDER === "gemini" && config.GEMINI_API_KEY) {
  provider = new GeminiProvider(config.GEMINI_API_KEY, config.LLM_MODEL);
} else if (config.LLM_PROVIDER === "openai-compatible" && config.LLM_BASE_URL) {
  provider = new OpenAiCompatProvider(config.LLM_BASE_URL, config.LLM_MODEL, config.LLM_API_KEY);
}
if (!provider) console.warn("chat agent disabled: no LLM API key configured");
// Policy changes push tools/list_changed so clients re-list with the new rules.
let notifyToolsChanged = () => {};
const policies = new Policies(db, () => notifyToolsChanged());
await policies.load();
const stores = new StoreService(db, config.MAX_STORES_PER_USER);
const app = createApp({
  config,
  registry,
  repo,
  servers,
  signer,
  urlGuard,
  provider,
  policies,
  stores,
});
notifyToolsChanged = app.locals.notifyToolsChanged as () => void;

const server = app.listen(config.PORT, "0.0.0.0", () => {
  console.log(`gateway listening on :${config.PORT}`);
});

// Stop accepting connections, give in-flight requests a moment, then cut the
// long-lived ones (MCP GET streams, chat SSE): server.close() alone would wait
// for them until Kubernetes kills the pod. Clients reconnect to the new pod.
const SHUTDOWN_GRACE_MS = 5000;
process.on("SIGTERM", () => {
  const finish = () =>
    void registry
      .stop()
      .then(() => db.end())
      .finally(() => process.exit(0));
  server.close(finish);
  server.closeIdleConnections();
  setTimeout(() => server.closeAllConnections(), SHUTDOWN_GRACE_MS).unref();
});
