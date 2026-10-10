import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["test/global-setup.ts"],
    // Test files share one database; each creates its own schema.
    fileParallelism: false,
    testTimeout: 15000,
    hookTimeout: 60000,
  },
});
