import { loadConfig, readChartVersion } from "./config.js";
import { GatewayClient } from "./gateway.js";
import { HelmCli } from "./helm.js";
import { InClusterKube } from "./k8s.js";
import { Reconciler } from "./reconcile.js";

const loaded = loadConfig();
const cfg = { ...loaded, STORE_CHART_REVISION: readChartVersion(loaded.CHART_PATH) };
const reconciler = new Reconciler(
  cfg,
  new GatewayClient(cfg.GATEWAY_INTERNAL_URL, cfg.INTERNAL_TOKEN),
  new InClusterKube(),
  new HelmCli(),
);

let stopping = false;
let healthy = false;

async function loop(): Promise<void> {
  while (!stopping) {
    try {
      await reconciler.tick();
      healthy = true;
    } catch (err) {
      healthy = false;
      console.error(`reconcile tick failed: ${(err as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, cfg.INTERVAL_MS));
  }
}

// Liveness/readiness: a tiny HTTP endpoint reporting whether the last tick reached the gateway.
const { createServer } = await import("node:http");
createServer((req, res) => {
  const ok = req.url === "/healthz" || healthy;
  res.writeHead(ok ? 200 : 503).end(ok ? "ok" : "gateway unreachable");
}).listen(8081);

process.on("SIGTERM", () => {
  stopping = true;
  // In-flight helm runs are abandoned on purpose: the next pod recovers them.
  // helm may be mid-install; the next pod resumes it (upgrade --install is idempotent).
  setTimeout(() => process.exit(0), 1000);
});

console.log("provisioner started");
await loop();
