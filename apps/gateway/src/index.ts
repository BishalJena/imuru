import { createApp } from "./app.js";
import { loadConfig, type SeedUpstream } from "./config.js";
import { Registry } from "./registry.js";
import type { UpstreamConfig } from "./upstream.js";

const config = loadConfig();

function credential(seed: SeedUpstream): UpstreamConfig["auth"] {
  if (seed.auth === "none") return undefined;
  const value = seed.credentialEnv ? process.env[seed.credentialEnv] : undefined;
  if (!value) throw new Error(`missing credential for upstream ${seed.slug}`);
  if (seed.auth === "bearer") return { type: "bearer", token: value };
  if (!seed.authHeader) throw new Error(`authHeader required for upstream ${seed.slug}`);
  return { type: "header", header: seed.authHeader, value };
}

const registry = new Registry();
for (const seed of config.SEED_UPSTREAMS) {
  const auth = credential(seed);
  registry.add({
    slug: seed.slug,
    name: seed.name,
    url: seed.url,
    ...(auth ? { auth } : {}),
    enabled: true,
    timeoutMs: seed.timeoutMs ?? config.UPSTREAM_TIMEOUT_MS,
    connectTimeoutMs: config.UPSTREAM_CONNECT_TIMEOUT_MS,
  });
}
registry.start(config.HEALTH_INTERVAL_MS);

const server = createApp(config, registry).listen(config.PORT, "0.0.0.0", () => {
  console.log(`gateway listening on :${config.PORT}`);
});

process.on("SIGTERM", () => {
  server.close(() => {
    void registry.stop().finally(() => process.exit(0));
  });
});
