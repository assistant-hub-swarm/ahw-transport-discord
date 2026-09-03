import { defineConfig } from "vitest/config";

/** Unit test config (pure modules). Integration has its own config. */
export default defineConfig({
  test: {
    environment: "node",
    include: ["**/*.test.ts"],
    exclude: ["node_modules", "dist", "**/*.integration.test.ts", "**/.claude/worktrees/**"],
  },
});
