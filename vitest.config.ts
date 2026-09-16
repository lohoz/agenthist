import { fileURLToPath, URL } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@desktop": fileURLToPath(new URL("./src/desktop", import.meta.url)),
    },
  },
  test: {
    // Shared CI runners have fewer effective cores than reported; avoid jsdom
    // workers starving each other's timers during multi-page interactions.
    maxWorkers: process.env.CI ? 2 : undefined,
    testTimeout: 15_000,
    environment: "jsdom",
    setupFiles: ["./tests/desktop/setup.ts"],
    include: ["tests/desktop/**/*.test.{ts,tsx}"],
    restoreMocks: true,
    clearMocks: true,
  },
});
