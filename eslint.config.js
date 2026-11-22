// Lint for the whole repository: sources, tests, the simulator and the templates.
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // web/ is its own workspace with its own lint (Next.js rules): see web/eslint.config.mjs.
  { ignores: ["dist/**", "node_modules/**", ".claude/**", "templates/**/node_modules/**", "web/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      // A leading underscore marks a binding left unused on purpose, such as one destructured away.
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
);
