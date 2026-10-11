/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In development, /api and /mcp go to the gateway in the local cluster, so the
// browser sees one origin exactly as it does behind the Ingress.
const target = process.env.GATEWAY_URL ?? "http://app.127.0.0.1.nip.io";

export default defineConfig({
  plugins: [react()],
  test: { environment: "jsdom" },
  server: {
    proxy: {
      "/api": { target, changeOrigin: true },
      "/mcp": { target, changeOrigin: true },
    },
  },
});
