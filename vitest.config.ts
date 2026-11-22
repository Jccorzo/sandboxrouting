import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  // hushrun's test-file plugin, only when `hushrun run` asks for it (HUSHRUN_VITEST); otherwise nothing.
  plugins: [process.env.HUSHRUN_VITEST && import(process.env.HUSHRUN_VITEST).then((m) => m.default())],
  test: {
    // Claude Code keeps session worktrees under .claude/worktrees, each with its own copy of the tests.
    // web/ runs its own tests (web/vitest.config.ts).
    exclude: [...configDefaults.exclude, ".claude/**", "web/**"],
  },
});
