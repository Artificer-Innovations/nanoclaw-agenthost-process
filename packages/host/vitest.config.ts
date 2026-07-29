import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      [path.join(root, "src/agenthosts.js")]: path.join(
        root,
        "type-fixtures/agenthosts.ts",
      ),
      [path.join(root, "src/log.js")]: path.join(root, "type-fixtures/log.ts"),
      [path.join(root, "src/config.js")]: path.join(
        root,
        "type-fixtures/config.ts",
      ),
      [path.join(root, "src/session-manager.js")]: path.join(
        root,
        "type-fixtures/session-manager.ts",
      ),
      [path.join(root, "src/db/agent-groups.js")]: path.join(
        root,
        "type-fixtures/db/agent-groups.ts",
      ),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 70,
        statements: 80,
      },
    },
  },
});
