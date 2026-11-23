import { defineConfig } from "vitest/config";

export default defineConfig({
  // hushrun's test-file plugin, only when `hushrun run` asks for it (HUSHRUN_VITEST); otherwise nothing.
  plugins: process.env.HUSHRUN_VITEST ? [import(process.env.HUSHRUN_VITEST).then((m) => m.default())] : [],
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["test/global-setup.ts"],
  },
});
