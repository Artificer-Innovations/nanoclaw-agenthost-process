import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(root, "type-fixtures");

export default defineConfig({
  resolve: {
    // Match relative import specifiers used by src/* (Vite aliases on the
    // specifier string, not absolute filesystem paths).
    alias: {
      "./agenthosts.js": path.join(fixtures, "agenthosts.ts"),
      "./log.js": path.join(fixtures, "log.ts"),
      "./config.js": path.join(fixtures, "config.ts"),
      "./session-manager.js": path.join(fixtures, "session-manager.ts"),
      "./db/agent-groups.js": path.join(fixtures, "db/agent-groups.ts"),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "json-summary"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        // Compile-time stubs for tsc against NanoClaw imports; not runtime package code.
        "type-fixtures/**",
      ],
      thresholds: {
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
      },
    },
  },
});
