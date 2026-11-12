import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Claude Code keeps session worktrees under .claude/worktrees, each with its own copy of the tests.
    exclude: [...configDefaults.exclude, ".claude/**"],
  },
});
