import path from "node:path";
import { inject } from "vitest";
import { createApp } from "../src/app.js";
import type { Principal } from "../src/auth.js";
import type { Config } from "../src/config.js";
import { Sealer, TokenSigner } from "../src/crypto.js";
import { createPool, migrate, type Db } from "../src/db.js";
import { Registry } from "../src/registry.js";
import { Repo } from "../src/repo.js";
import { ServerService } from "../src/servers.js";
import { UrlGuard } from "../src/ssrf.js";
import { StoreService } from "../src/stores.js";
import type { LlmProvider } from "../src/llm.js";
import { Policies } from "../src/policies.js";
import { listen } from "./helpers.js";

export const ADMIN = { email: "admin@test.dev", password: "admin-password-1" };

/** A gateway on a random port backed by a fresh Postgres schema. */
export async function startGateway(
  opts: {
    isAllowed?: (p: Principal, s: string, t: string) => boolean;
    provider?: LlmProvider;
  } = {},
) {
  const schema = `t_${Math.random().toString(36).slice(2, 10)}`;
  const base = inject("databaseUrl");
  const admin = createPool(base);
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();
  const db: Db = createPool(`${base}?options=-c%20search_path%3D${schema}`);
  await migrate(db, path.resolve(import.meta.dirname, "../migrations"));

  const config: Config = {
    PORT: 0,
    DATABASE_URL: base,
    MIGRATIONS_DIR: "migrations",
    PUBLIC_URL: "http://app.test",
    ADMIN_EMAIL: ADMIN.email,
    ADMIN_PASSWORD: ADMIN.password,
    SESSION_SECRET: "s".repeat(40),
    CREDENTIAL_KEY: "c".repeat(40),
    SEED_UPSTREAMS: [],
    UPSTREAM_TIMEOUT_MS: 300,
    UPSTREAM_CONNECT_TIMEOUT_MS: 500,
    HEALTH_INTERVAL_MS: 60_000,
    SESSION_IDLE_MS: 60_000,
    ALLOWED_HOSTS: ["127.0.0.1", "localhost"],
    UPSTREAM_ALLOWED_HOSTS: ["127.0.0.1"],
    SELF_MCP_URL: "http://127.0.0.1:0/mcp",
    LLM_PROVIDER: "none",
    LLM_MODEL: "test",
    CHAT_MAX_STEPS: 8,
    INTERNAL_TOKEN: "i".repeat(40),
    MAX_STORES_PER_USER: 2,
  };
  const repo = new Repo(db);
  await repo.ensureAdmin(ADMIN.email, "Admin", ADMIN.password);
  const registry = new Registry();
  const sealer = new Sealer(config.CREDENTIAL_KEY);
  const urlGuard = new UrlGuard(config.UPSTREAM_ALLOWED_HOSTS);
  const servers = new ServerService(db, sealer, registry, config.UPSTREAM_CONNECT_TIMEOUT_MS);
  const signer = new TokenSigner(config.SESSION_SECRET);
  let notify = () => {};
  const policies = new Policies(db, () => notify());
  await policies.load();
  const stores = new StoreService(db, config.MAX_STORES_PER_USER);
  const app = createApp({
    stores,
    policies,
    config,
    registry,
    repo,
    servers,
    signer,
    urlGuard,
    ...(opts.isAllowed ? { isAllowed: opts.isAllowed } : {}),
    ...(opts.provider ? { provider: opts.provider } : {}),
  });
  notify = app.locals.notifyToolsChanged as () => void;
  const { server, url } = await listen(app);
  config.SELF_MCP_URL = `${url}/mcp`;

  /** Logged-in fetch for the dashboard API. */
  const login = async (email: string, password: string) => {
    const res = await fetch(`${url}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const cookie = res.headers.get("set-cookie")?.split(";")[0] ?? "";
    return async (p: string, init: RequestInit = {}) => {
      const headers: Record<string, string> = {
        cookie,
        ...(init.headers as Record<string, string>),
      };
      if (init.body) headers["content-type"] = "application/json";
      return fetch(`${url}${p}`, { ...init, headers });
    };
  };

  return {
    url,
    db,
    repo,
    registry,
    servers,
    sealer,
    policies,
    stores,
    internalToken: config.INTERNAL_TOKEN!,
    signer,
    login,
    async stop() {
      await registry.stop();
      server.close();
      await db.end();
    },
  };
}
