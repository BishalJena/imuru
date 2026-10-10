import { loadConfig } from "./config.js";
import { createApp } from "./server.js";

const config = loadConfig();
const app = createApp(config);

const server = app.listen(config.PORT, "0.0.0.0", () => {
  console.log(`woo-mcp listening on :${config.PORT}`);
});

// Kubernetes sends SIGTERM on pod deletion; finish in-flight requests first.
process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
});
