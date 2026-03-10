import { defineConfig } from "vitest/config";

// When OPENCLAW_PLUGIN_SDK_PATH is set, alias openclaw/plugin-sdk to local
// source for development. Otherwise let Node resolve from node_modules.
const alias: Record<string, string> = {};
if (process.env.OPENCLAW_PLUGIN_SDK_PATH) {
  alias["openclaw/plugin-sdk"] = process.env.OPENCLAW_PLUGIN_SDK_PATH;
}

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/types.ts", "src/**/*.d.ts"],
      reporter: ["text", "json-summary"],
      thresholds: { lines: 85, functions: 85, branches: 79, statements: 85 },
    },
  },
  resolve: { alias },
});
