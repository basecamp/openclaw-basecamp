import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
  },
  resolve: {
    alias: {
      // Resolve openclaw/plugin-sdk to local source for testing
      "openclaw/plugin-sdk": path.resolve(
        process.env.HOME ?? "~",
        "Work/basecamp/openclaw/src/plugin-sdk/index.ts",
      ),
    },
  },
});
