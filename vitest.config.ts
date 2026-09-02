import { defineConfig } from "vitest/config";

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
});
