import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  // hushrun's test-file plugin, only when `hushrun run` asks for it (HUSHRUN_VITEST); otherwise nothing.
  plugins: process.env.HUSHRUN_VITEST ? [import(process.env.HUSHRUN_VITEST).then((m) => m.default())] : [],
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  test: { include: ["test/**/*.test.ts"] },
});
