import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/types.ts", "src/**/*.d.ts"],
      reporter: ["text", "json-summary"],
      thresholds: { lines: 85, functions: 85, branches: 82, statements: 85 },
    },
  },
  resolve: {
    alias: {
      // Resolve openclaw/plugin-sdk to local source for testing.
      // Set OPENCLAW_PLUGIN_SDK_PATH to override the default location.
      "openclaw/plugin-sdk": process.env.OPENCLAW_PLUGIN_SDK_PATH ??
        path.resolve(
          process.env.HOME ?? "~",
          "Work/basecamp/openclaw/src/plugin-sdk/index.ts",
        ),
    },
  },
});
