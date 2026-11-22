// Lint for the router: sources, tests, the simulator and the templates. The workspaces (back/,
// dashboard/, web/) each lint themselves with their own config.
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // back/, dashboard/ and web/ are workspaces with their own lint configs.
  { ignores: ["dist/**", "node_modules/**", ".claude/**", "templates/**/node_modules/**", "back/**", "dashboard/**", "web/**"] },
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
